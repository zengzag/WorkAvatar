import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 搜索 API 服务单测：设置读取、服务商协议映射、错误处理与密钥读写。
 * 依赖通过 mock 注入：settings 表、SecureKeyStorage、全局 fetch。
 */
const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  keys: {} as Record<string, string>,
  fetchImpl: null as any,
}))

vi.mock('../../../electron/main/services/database.service', () => ({
  default: {
    getInstance: () => ({
      getDb: () => ({
        prepare: () => ({
          get: (key: string) => (state.settings[key] === undefined ? undefined : { value: state.settings[key] }),
          run: () => ({}),
          all: () => [],
        }),
      }),
    }),
  },
}))

vi.mock('../../../electron/main/services/secure-key-storage', () => ({
  SecureKeyStorage: class {
    async saveSearchApiKey(provider: string, apiKey: string) { state.keys[provider] = apiKey }
    async getSearchApiKey(provider: string) { return state.keys[provider] ?? null }
    async deleteSearchApiKey(provider: string) { delete state.keys[provider] }
  },
}))

const { searchApiService } = await import('../../../electron/main/services/search-api.service')

// 服务在调用时读取全局 fetch，统一指向测试桩，避免真实外网请求
vi.stubGlobal('fetch', (url: string, init: any) => state.fetchImpl(url, init))

function jsonResponse(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  }
}

interface CapturedRequest {
  url: string
  init: any
}

function captureFetch(response: any) {
  const calls: CapturedRequest[] = []
  state.fetchImpl = async (url: string, init: any) => {
    calls.push({ url, init })
    return response
  }
  return calls
}

beforeEach(() => {
  state.settings = {}
  state.keys = {}
  state.fetchImpl = async () => jsonResponse({ results: [] })
})

describe('search-api.service 配置读取', () => {
  it('未配置时回退 browser + deepseek', () => {
    expect(searchApiService.getMode()).toBe('browser')
    expect(searchApiService.getProvider()).toBe('deepseek')
  })

  it('识别合法设置，非法值回退默认', () => {
    state.settings.web_search_mode = 'api'
    state.settings.web_search_api_provider = 'brave'
    expect(searchApiService.getMode()).toBe('api')
    expect(searchApiService.getProvider()).toBe('brave')

    state.settings.web_search_mode = 'unknown'
    state.settings.web_search_api_provider = 'yahoo'
    expect(searchApiService.getMode()).toBe('browser')
    expect(searchApiService.getProvider()).toBe('deepseek')
  })

  it('getStatus 返回服务商列表与密钥状态', async () => {
    state.settings.web_search_mode = 'api'
    state.settings.web_search_api_provider = 'tavily'
    state.keys.tavily = 'tvly-1'

    const status = await searchApiService.getStatus()

    expect(status.mode).toBe('api')
    expect(status.provider).toBe('tavily')
    expect(status.providers.map(p => p.id)).toEqual(['deepseek', 'tavily', 'brave'])
    expect(status.providers.find(p => p.id === 'tavily')?.hasKey).toBe(true)
    expect(status.providers.find(p => p.id === 'deepseek')?.hasKey).toBe(false)
  })
})

describe('search-api.service 密钥管理', () => {
  it('保存时去除首尾空白，空值/非法服务商报错', async () => {
    await searchApiService.saveApiKey('deepseek', '  sk-1  ')
    expect(state.keys.deepseek).toBe('sk-1')

    await expect(searchApiService.saveApiKey('deepseek', '   ')).rejects.toThrow('API Key 不能为空')
    await expect(searchApiService.saveApiKey('yahoo', 'sk')).rejects.toThrow('不支持的搜索服务商')
  })

  it('清除密钥后不再返回', async () => {
    state.keys.brave = 'b'
    await searchApiService.clearApiKey('brave')
    expect(await searchApiService.getApiKey('brave')).toBeNull()
  })

  it('未配置密钥时搜索直接报错且不发请求', async () => {
    const calls = captureFetch(jsonResponse({ results: [] }))
    await expect(searchApiService.search('q', 5)).rejects.toThrow('未配置 DeepSeek 的 API Key')
    expect(calls).toHaveLength(0)
  })
})

describe('search-api.service 服务商协议', () => {
  it('DeepSeek：请求体与结果映射（summary 优先、去重、过滤非法 URL）', async () => {
    state.settings.web_search_api_provider = 'deepseek'
    state.keys.deepseek = 'sk-ds'
    const calls = captureFetch(jsonResponse({
      results: [
        { title: 'A', url: 'https://a.com', snippet: '短摘要', summary: '长摘要', date: '2026-01-01T00:00:00Z', site_name: '站点A' },
        { title: 'A duplicate', url: 'https://a.com', summary: '重复' },
        { title: 'bad', url: 'ftp://x' },
        { title: 'B', url: 'https://b.com', snippet: 'B 摘要' },
      ],
    }))

    const result = await searchApiService.search('查询', 5)

    expect(calls[0].url).toBe('https://api.deepseek.com/v1/tools/search')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk-ds')
    expect(JSON.parse(calls[0].init.body)).toEqual({ query: '查询', count: 5 })
    expect(result.providerName).toBe('DeepSeek')
    expect(result.results).toHaveLength(2)
    expect(result.results[0]).toEqual({
      title: 'A',
      url: 'https://a.com',
      snippet: '长摘要',
      publishedAt: '2026-01-01T00:00:00Z',
      siteName: '站点A',
    })
    expect(result.results[1]).toMatchObject({ title: 'B', snippet: 'B 摘要' })
  })

  it('Tavily：携带 Bearer 与 max_results', async () => {
    state.settings.web_search_api_provider = 'tavily'
    state.keys.tavily = 'tvly-1'
    const calls = captureFetch(jsonResponse({
      results: [{ title: 'T', url: 'https://t.com', content: '正文片段', published_date: '2026-02-02' }],
    }))

    const result = await searchApiService.search('q', 3)

    expect(calls[0].url).toBe('https://api.tavily.com/search')
    expect(calls[0].init.headers.Authorization).toBe('Bearer tvly-1')
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ query: 'q', max_results: 3, search_depth: 'basic' })
    expect(result.results[0]).toMatchObject({ title: 'T', url: 'https://t.com', snippet: '正文片段', publishedAt: '2026-02-02' })
  })

  it('Brave：GET 参数、订阅头与 HTML 摘要清洗', async () => {
    state.settings.web_search_api_provider = 'brave'
    state.keys.brave = 'brave-key'
    const calls = captureFetch(jsonResponse({
      web: {
        results: [
          { title: 'Brave 结果', url: 'https://brave.com/x', description: 'Hello <strong>world</strong> &amp; more', page_age: '2026-03-03', profile: { name: 'Brave' } },
        ],
      },
    }))

    const result = await searchApiService.search('a b', 4)

    expect(calls[0].url).toContain('https://api.search.brave.com/res/v1/web/search')
    expect(calls[0].url).toContain('q=a+b')
    expect(calls[0].url).toContain('count=4')
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.headers['X-Subscription-Token']).toBe('brave-key')
    expect(result.results[0]).toMatchObject({
      title: 'Brave 结果',
      snippet: 'Hello world & more',
      publishedAt: '2026-03-03',
      siteName: 'Brave',
    })
  })

  it('HTTP 错误：返回状态码与提示', async () => {
    state.settings.web_search_api_provider = 'deepseek'
    state.keys.deepseek = 'bad'
    captureFetch(jsonResponse({ error: { message: 'invalid key' } }, 401))

    await expect(searchApiService.search('q', 5)).rejects.toThrow('HTTP 401（API Key 无效或未授权）: invalid key')
  })

  it('响应体不是合法 JSON 时报错', async () => {
    state.settings.web_search_api_provider = 'tavily'
    state.keys.tavily = 'tvly-1'
    state.fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html>bad</html>' })

    await expect(searchApiService.search('q', 5)).rejects.toThrow('响应不是合法的 JSON')
  })
})
