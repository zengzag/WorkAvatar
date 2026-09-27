/**
 * InternetSearchService 真实实例化测试：
 * 引擎清单、窗口复用/关闭、search 成功过滤/count、失败包装与 destroy 兜底。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

const { FakeWindow, windowInstances } = vi.hoisted(() => {
  const windowInstances: any[] = []

  class FakeWindow {
    destroyed = false
    loadURL = vi.fn(async () => {})
    show = vi.fn()
    focus = vi.fn()
    close = vi.fn(() => { this.destroyed = true })
    destroy = vi.fn(() => { this.destroyed = true })
    isDestroyed(): boolean { return this.destroyed }
    emitter = new EventEmitter()
    on = vi.fn((ev: string, cb: () => void) => this.emitter.on(ev, cb))
    webContents = {
      userAgent: '',
      once: vi.fn((ev: string, cb: () => void) => {
        if (ev === 'did-finish-load') setTimeout(cb, 0)
      }),
      executeJavaScript: vi.fn(async () => []),
    }
    constructor() {
      windowInstances.push(this)
    }
  }

  return { FakeWindow, windowInstances }
})

vi.mock('electron', () => ({ BrowserWindow: FakeWindow }))

import { InternetSearchService } from '../../../electron/main/services/internet-search.service'

beforeEach(() => {
  windowInstances.length = 0
  ;(InternetSearchService as any).instance = null
})

afterEach(() => vi.restoreAllMocks())

describe('InternetSearchService / 引擎信息', () => {
  it('getAvailableEngines 返回 4 个引擎且字段完整', () => {
    const svc = InternetSearchService.getInstance()
    const engines = svc.getAvailableEngines()
    expect(engines.map(e => e.id)).toEqual(['google', 'bing', 'baidu', 'duckduckgo'])
    expect(engines[0]).toEqual({
      id: 'google',
      name: 'Google',
      urlTemplate: expect.stringContaining('google.com'),
      homepage: 'https://www.google.com',
    })
  })

  it('getEngineName 返回显示名，未知引擎回退为 id', () => {
    const svc = InternetSearchService.getInstance()
    expect(svc.getEngineName('baidu')).toBe('百度')
    expect(svc.getEngineName('unknown' as any)).toBe('unknown')
  })
})

describe('InternetSearchService / openSearchWindow', () => {
  it('未知引擎抛错', async () => {
    const svc = InternetSearchService.getInstance()
    await expect(svc.openSearchWindow('x' as any)).rejects.toThrow('Unsupported search engine')
  })

  it('新引擎创建窗口并加载主页', async () => {
    const svc = InternetSearchService.getInstance()
    await svc.openSearchWindow('google')

    expect(windowInstances).toHaveLength(1)
    expect(windowInstances[0].loadURL).toHaveBeenCalledWith('https://www.google.com')
  })

  it('窗口未销毁时复用：show/focus，不新建', async () => {
    const svc = InternetSearchService.getInstance()
    await svc.openSearchWindow('google')
    await svc.openSearchWindow('google')

    expect(windowInstances).toHaveLength(1)
    expect(windowInstances[0].show).toHaveBeenCalledTimes(1)
    expect(windowInstances[0].focus).toHaveBeenCalledTimes(1)
  })

  it('closed 事件后记录被清除，再次调用新建窗口', async () => {
    const svc = InternetSearchService.getInstance()
    await svc.openSearchWindow('google')
    windowInstances[0].destroyed = true
    windowInstances[0].emitter.emit('closed')

    await svc.openSearchWindow('google')
    expect(windowInstances).toHaveLength(2)
  })

  it('closeSearchWindow 关闭并清除记录', async () => {
    const svc = InternetSearchService.getInstance()
    await svc.openSearchWindow('bing')
    svc.closeSearchWindow('bing')

    expect(windowInstances[0].close).toHaveBeenCalled()
  })
})

describe('InternetSearchService / search', () => {
  it('未知引擎抛错', async () => {
    const svc = InternetSearchService.getInstance()
    await expect(svc.search('q', 'x' as any)).rejects.toThrow('Unsupported search engine')
  })

  it('成功：executeJavaScript 结果过滤非 http(s)，返回有效结果', async () => {
    const svc = InternetSearchService.getInstance()
    setTimeout(() => {
      windowInstances[0].webContents.executeJavaScript.mockResolvedValue([
        { title: 'A', url: 'https://a.com', snippet: 's1' },
        { title: 'B', url: 'ftp://b.com', snippet: 's2' },
      ])
    }, 0)

    const results = await svc.search('query', 'google', 5)
    expect(results).toEqual([{ title: 'A', url: 'https://a.com', snippet: 's1' }])
    expect(windowInstances[0].destroy).toHaveBeenCalled()
  })

  it('count 限制结果数量', async () => {
    const svc = InternetSearchService.getInstance()
    setTimeout(() => {
      windowInstances[0].webContents.executeJavaScript.mockResolvedValue([
        { title: '1', url: 'https://1.com', snippet: '' },
        { title: '2', url: 'https://2.com', snippet: '' },
        { title: '3', url: 'https://3.com', snippet: '' },
      ])
    }, 0)

    const results = await svc.search('query', 'google', 2)
    expect(results).toHaveLength(2)
  })

  it('页面脚本失败：错误被包装为中文消息，窗口在 finally 中销毁', async () => {
    const svc = InternetSearchService.getInstance()
    setTimeout(() => {
      windowInstances[0].webContents.executeJavaScript.mockRejectedValue(new Error('boom'))
    }, 0)

    await expect(svc.search('q', 'google')).rejects.toThrow('Google搜索失败: boom')
    expect(windowInstances[0].destroy).toHaveBeenCalled()
  })
})
