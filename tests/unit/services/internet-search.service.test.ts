/**
 * InternetSearchService 真实实例化测试：
 * 引擎清单、窗口复用/关闭、search 加载等待/结果提取/超时/缓存/降级前置行为。
 *
 * FakeWindow 刻意模拟真实 Electron 的关键语义：did-finish-load 在 loadURL 的 Promise
 * resolve 之前触发——旧实现把监听注册在 loadURL 之后，导致每次搜索都白等 15s 固定超时。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

const h = vi.hoisted(() => {
  const windowInstances: any[] = []
  const windowState = {
    loadShouldFail: false,
    loadHangs: false,
    errorMessage: 'ERR_NAME_NOT_RESOLVED',
  }
  const scriptState = {
    results: [] as any[],
    calls: 0,
    impl: null as null | ((expr: string, call: number) => any),
  }

  class FakeWindow {
    destroyed = false
    options: any
    loadedUrls: string[] = []
    emitter = new EventEmitter()
    show = vi.fn()
    focus = vi.fn()
    close = vi.fn(() => { this.destroyed = true })
    destroy = vi.fn(() => { this.destroyed = true })
    isDestroyed(): boolean { return this.destroyed }
    on = vi.fn((ev: string, cb: any) => { this.emitter.on(ev, cb); return this })
    removeListener = vi.fn((ev: string, cb: any) => { this.emitter.removeListener(ev, cb); return this })

    loadURL = vi.fn(async (url: string) => {
      this.loadedUrls.push(url)
      if (windowState.loadHangs) {
        return new Promise<void>(() => {})
      }
      if (windowState.loadShouldFail) {
        // 真实 Electron：先派发 did-fail-load，随后 loadURL 的 Promise reject
        this.webContents.emit('did-fail-load', {}, -105, windowState.errorMessage, url, true)
        throw new Error(windowState.errorMessage)
      }
      // 关键：did-finish-load 先于 Promise resolve 触发
      this.webContents.emit('did-finish-load')
    })

    webContents: any = (() => {
      const listeners: Record<string, any[]> = {}
      const api: any = {
        userAgent: '',
        once(ev: string, cb: any) {
          const wrap = (...a: any[]) => { api.removeListener(ev, wrap); cb(...a) }
          ;(listeners[ev] ||= []).push(wrap)
          return api
        },
        on(ev: string, cb: any) { (listeners[ev] ||= []).push(cb); return api },
        removeListener(ev: string, cb: any) {
          listeners[ev] = (listeners[ev] || []).filter((x) => x !== cb)
          return api
        },
        emit(ev: string, ...a: any[]) { (listeners[ev] || []).slice().forEach((cb) => cb(...a)) },
        executeJavaScript: vi.fn(async (expr: string) => {
          scriptState.calls++
          if (scriptState.impl) return scriptState.impl(expr, scriptState.calls)
          return scriptState.results
        }),
      }
      return api
    })()

    constructor(options?: any) {
      this.options = options
      windowInstances.push(this)
    }
  }

  return { FakeWindow, windowInstances, windowState, scriptState }
})

vi.mock('electron', () => ({ BrowserWindow: h.FakeWindow }))

import { InternetSearchService } from '../../../electron/main/services/internet-search.service'

beforeEach(() => {
  h.windowInstances.length = 0
  h.windowState.loadShouldFail = false
  h.windowState.loadHangs = false
  h.windowState.errorMessage = 'ERR_NAME_NOT_RESOLVED'
  h.scriptState.results = []
  h.scriptState.calls = 0
  h.scriptState.impl = null
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

  it('Bing 地址固定中国市场且不带 ensearch（ensearch 会让中文查询返回无关英文结果）', () => {
    const svc = InternetSearchService.getInstance()
    const engines = svc.getAvailableEngines()
    expect(engines.find(e => e.id === 'bing')!.urlTemplate).toBe('https://cn.bing.com/search?q=%s&mkt=zh-CN')
    expect(engines.every(e => !e.urlTemplate.includes('ensearch'))).toBe(true)
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

    expect(h.windowInstances).toHaveLength(1)
    expect(h.windowInstances[0].loadURL).toHaveBeenCalledWith('https://www.google.com')
    expect(h.windowInstances[0].options.show).toBe(true)
  })

  it('窗口未销毁时复用：show/focus，不新建', async () => {
    const svc = InternetSearchService.getInstance()
    await svc.openSearchWindow('google')
    await svc.openSearchWindow('google')

    expect(h.windowInstances).toHaveLength(1)
    expect(h.windowInstances[0].show).toHaveBeenCalledTimes(1)
    expect(h.windowInstances[0].focus).toHaveBeenCalledTimes(1)
  })

  it('closed 事件后记录被清除，再次调用新建窗口', async () => {
    const svc = InternetSearchService.getInstance()
    await svc.openSearchWindow('google')
    h.windowInstances[0].destroyed = true
    h.windowInstances[0].emitter.emit('closed')

    await svc.openSearchWindow('google')
    expect(h.windowInstances).toHaveLength(2)
  })

  it('closeSearchWindow 关闭并清除记录', async () => {
    const svc = InternetSearchService.getInstance()
    await svc.openSearchWindow('bing')
    svc.closeSearchWindow('bing')

    expect(h.windowInstances[0].close).toHaveBeenCalled()
  })
})

describe('InternetSearchService / search', () => {
  it('未知引擎抛错', async () => {
    const svc = InternetSearchService.getInstance()
    await expect(svc.search('q', 'x' as any)).rejects.toThrow('Unsupported search engine')
  })

  it('成功搜索：页面加载完成后立即返回，不会固定空等超时', async () => {
    h.scriptState.results = [{ title: 'A', url: 'https://a.com', snippet: 's1' }]
    const svc = InternetSearchService.getInstance()

    const started = Date.now()
    const results = await svc.search('query', 'google', 5, { loadTimeoutMs: 1000, renderWaitMs: 500 })

    expect(results).toEqual([{ title: 'A', url: 'https://a.com', snippet: 's1' }])
    expect(Date.now() - started).toBeLessThan(1000)
    expect(h.windowInstances[0].destroy).toHaveBeenCalled()
  })

  it('隐藏窗口使用持久化会话分区（复用 Cookie/缓存）', async () => {
    h.scriptState.results = [{ title: 'A', url: 'https://a.com', snippet: '' }]
    const svc = InternetSearchService.getInstance()
    await svc.search('partition', 'google', 5)

    expect(h.windowInstances[0].options.show).toBe(false)
    expect(h.windowInstances[0].options.webPreferences.partition).toBe('persist:internet-search-v2')
  })

  it('UA 与平台匹配且 Chromium 版本号与真实运行时一致（过旧版本会触发百度反爬）', async () => {
    h.scriptState.results = [{ title: 'A', url: 'https://a.com', snippet: '' }]
    const svc = InternetSearchService.getInstance()
    await svc.search('ua', 'google', 5)

    const ua = h.windowInstances[0].webContents.userAgent
    // Electron 下取 process.versions.chrome，纯 Node 测试环境回退默认版本号
    expect(ua).toMatch(/Chrome\/\d+\.\d+\.\d+\.\d+/)
    if (process.platform === 'win32') {
      expect(ua).toContain('Windows NT')
    } else if (process.platform === 'darwin') {
      expect(ua).toContain('Macintosh')
    }
  })

  it('过滤非 http(s) 链接，并按 count 截断', async () => {
    h.scriptState.results = [
      { title: 'A', url: 'https://a.com', snippet: 's1' },
      { title: 'B', url: 'ftp://b.com', snippet: 's2' },
      { title: 'C', url: 'https://c.com', snippet: 's3' },
      { title: 'D', url: 'https://d.com', snippet: 's4' },
    ]
    const svc = InternetSearchService.getInstance()

    const all = await svc.search('filter', 'google', 5)
    expect(all.map(r => r.url)).toEqual(['https://a.com', 'https://c.com', 'https://d.com'])

    const limited = await svc.search('limit', 'google', 2)
    expect(limited).toHaveLength(2)
  })

  it('动态渲染：首次为空、随后出现结果时轮询取到', async () => {
    h.scriptState.impl = (_expr, call) =>
      call >= 2 ? [{ title: 'D', url: 'https://d.com', snippet: '' }] : []
    const svc = InternetSearchService.getInstance()

    const results = await svc.search('dynamic', 'baidu', 5, { renderWaitMs: 2000 })
    expect(results).toEqual([{ title: 'D', url: 'https://d.com', snippet: '' }])
    expect(h.scriptState.calls).toBeGreaterThanOrEqual(2)
  })

  it('渲染上限内始终无结果时返回空数组，且不写入缓存', async () => {
    h.scriptState.results = []
    const svc = InternetSearchService.getInstance()

    const first = await svc.search('empty', 'duckduckgo', 5, { renderWaitMs: 0 })
    expect(first).toEqual([])
    expect(h.scriptState.calls).toBe(1)

    await svc.search('empty', 'duckduckgo', 5, { renderWaitMs: 0 })
    expect(h.windowInstances).toHaveLength(2)
  })

  it('相同 query/engine/count 命中缓存：第二次不再创建窗口', async () => {
    h.scriptState.results = [{ title: 'A', url: 'https://a.com', snippet: '' }]
    const svc = InternetSearchService.getInstance()

    await svc.search('cached', 'google', 5)
    expect(h.windowInstances).toHaveLength(1)

    const again = await svc.search('cached', 'google', 5)
    expect(again).toEqual([{ title: 'A', url: 'https://a.com', snippet: '' }])
    expect(h.windowInstances).toHaveLength(1)
  })

  it('clearCache 后重新发起搜索', async () => {
    h.scriptState.results = [{ title: 'A', url: 'https://a.com', snippet: '' }]
    const svc = InternetSearchService.getInstance()

    await svc.search('clear', 'google', 5)
    svc.clearCache()
    await svc.search('clear', 'google', 5)
    expect(h.windowInstances).toHaveLength(2)
  })

  it('百度返回安全验证页（空结果）时识别为失败并抛错，供上层降级', async () => {
    h.scriptState.impl = (expr: string) => (expr === 'document.title' ? '百度安全验证' : [])
    const svc = InternetSearchService.getInstance()

    await expect(svc.search('captcha', 'baidu', 5, { renderWaitMs: 0 })).rejects.toThrow('百度搜索失败')
    expect(h.windowInstances[0].destroy).toHaveBeenCalled()
  })

  it('页面加载失败：错误被包装为中文消息，窗口在 finally 中销毁', async () => {
    h.windowState.loadShouldFail = true
    const svc = InternetSearchService.getInstance()

    await expect(svc.search('fail', 'google', 5)).rejects.toThrow('Google搜索失败')
    expect(h.windowInstances[0].destroy).toHaveBeenCalled()
  })

  it('页面加载超时：按失败处理并销毁窗口（不再无限等待）', async () => {
    h.windowState.loadHangs = true
    const svc = InternetSearchService.getInstance()

    await expect(svc.search('slow', 'bing', 5, { loadTimeoutMs: 80 })).rejects.toThrow(/Bing搜索失败: 加载超时/)
    expect(h.windowInstances[0].destroy).toHaveBeenCalled()
  })

  it('页面脚本失败：错误被包装为中文消息，窗口在 finally 中销毁', async () => {
    h.scriptState.impl = () => { throw new Error('boom') }
    const svc = InternetSearchService.getInstance()

    await expect(svc.search('boom', 'google', 5)).rejects.toThrow('Google搜索失败: boom')
    expect(h.windowInstances[0].destroy).toHaveBeenCalled()
  })
})
