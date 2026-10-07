/**
 * web_search 工具 + 真实 InternetSearchService 的端到端联通性测试。
 * 仅替换 electron 的 BrowserWindow 与设置表，验证工具能真正驱动服务完成一次搜索。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const windowInstances: any[] = []
  const state = {
    results: [] as any[],
    settings: {} as Record<string, string | null>,
    failFor: null as null | ((url: string) => boolean),
  }

  class FakeWindow {
    destroyed = false
    options: any
    show = vi.fn()
    focus = vi.fn()
    close = vi.fn(() => { this.destroyed = true })
    destroy = vi.fn(() => { this.destroyed = true })
    isDestroyed(): boolean { return this.destroyed }
    on = vi.fn()
    removeListener = vi.fn()

    loadURL = vi.fn(async (url: string) => {
      if (state.failFor && state.failFor(url)) {
        this.webContents.emit('did-fail-load', {}, -118, 'ERR_CONNECTION_TIMED_OUT', url, true)
        throw new Error('ERR_CONNECTION_TIMED_OUT')
      }
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
        executeJavaScript: vi.fn(async () => state.results),
      }
      return api
    })()

    constructor(options?: any) {
      this.options = options
      windowInstances.push(this)
    }
  }

  return { FakeWindow, windowInstances, state }
})

vi.mock('electron', () => ({ BrowserWindow: h.FakeWindow }))

vi.mock('../../../electron/main/services/database.service', () => ({
  default: {
    getInstance: () => ({
      getDb: () => ({
        prepare: () => ({
          get: (key: string) => {
            const value = h.state.settings[key]
            return value === undefined || value === null ? undefined : { value }
          },
        }),
      }),
    }),
  },
}))

const { webSearchTool } = await import('../../../electron/main/services/agent/tools/web-search.tool')
const { InternetSearchService } = await import('../../../electron/main/services/internet-search.service')

const search = (args: any) => webSearchTool.handler!(args) as Promise<any>

beforeEach(() => {
  h.windowInstances.length = 0
  h.state.results = []
  h.state.settings = {}
  h.state.failFor = null
  ;(InternetSearchService as any).instance = null
})

describe('web_search 端到端（工具 → 服务 → 隐藏窗口抓取）', () => {
  it('成功返回结果并格式化输出', async () => {
    h.state.results = [
      { title: '标题一', url: 'https://example.com/a', snippet: '摘要一' },
      { title: '标题二', url: 'https://example.com/b', snippet: '' },
    ]

    const res = await search({ query: '测试查询' })

    expect(res.success).toBe(true)
    expect(res.engine).toBe('google')
    expect(res.output).toContain('搜索结果（Google）: 测试查询')
    expect(res.output).toContain('1. 标题一')
    expect(res.output).toContain('   链接: https://example.com/a')
    expect(res.output).toContain('   摘要: 摘要一')
    expect(res.output).toContain('2. 标题二')
    expect(h.windowInstances).toHaveLength(1)
    expect(h.windowInstances[0].destroy).toHaveBeenCalled()
  })

  it('首选引擎不可用时自动降级到下一引擎', async () => {
    h.state.failFor = (url) => url.includes('google.com')
    h.state.results = [{ title: 'Bing结果', url: 'https://b.com/x', snippet: 's' }]

    const res = await search({ query: 'fallback' })

    expect(res.success).toBe(true)
    expect(res.engine).toBe('bing')
    expect(res.output).toContain('搜索结果（Bing）: fallback')
    expect(res.output).toContain('1. Bing结果')
  })

  it('重复相同查询命中服务级缓存，不再新建窗口', async () => {
    h.state.results = [{ title: 'A', url: 'https://a.com', snippet: '' }]

    await search({ query: 'same' })
    expect(h.windowInstances).toHaveLength(1)

    const again = await search({ query: 'same' })
    expect(again.output).toContain('1. A')
    expect(h.windowInstances).toHaveLength(1)
  })
})
