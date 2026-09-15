import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * web_search / web_fetch 的分支覆盖（SSRF 判定见 web-fetch-ssrf.test.ts）。
 * 依赖通过 mock 注入：搜索引擎服务、设置表、全局 fetch。
 */
const searchState = vi.hoisted(() => ({
  engineSetting: null as string | null,
  countSetting: null as string | null,
  settingsThrow: false,
  searchImpl: null as any,
}))

vi.mock('../../../electron/main/services/internet-search.service', () => ({
  internetSearchService: {
    search: (query: string, engine: string, count: number) => searchState.searchImpl(query, engine, count),
    getEngineName: (engine: string) => `名称:${engine}`,
  },
}))

vi.mock('../../../electron/main/services/database.service', () => ({
  default: {
    getInstance: () => ({
      getDb: () => ({
        prepare: () => ({
          get: (key: string) => {
            if (searchState.settingsThrow) throw new Error('settings unavailable')
            if (key === 'web_search_engine') return searchState.engineSetting === null ? undefined : { value: searchState.engineSetting }
            if (key === 'web_search_result_count') return searchState.countSetting === null ? undefined : { value: searchState.countSetting }
            return undefined
          },
        }),
      }),
    }),
  },
}))

const { webSearchTool } = await import('../../../electron/main/services/agent/tools/web-search.tool')
const { webFetchTool } = await import('../../../electron/main/services/agent/tools/web-fetch.tool')

const search = (args: any) => webSearchTool.handler!(args) as Promise<any>
const fetchUrl = (args: any) => webFetchTool.handler!(args) as Promise<any>

describe('agent/tools/web-search.tool', () => {
  beforeEach(() => {
    searchState.engineSetting = null
    searchState.countSetting = null
    searchState.settingsThrow = false
    searchState.searchImpl = async () => [{ title: 'T', url: 'https://e.com', snippet: 'S' }]
  })

  it('空查询报错，且不触发搜索', async () => {
    let called = false
    searchState.searchImpl = async () => { called = true; return [] }
    expect(await search({})).toMatchObject({ success: false, error: '搜索关键词不能为空' })
    expect(await search({ query: '   ' })).toMatchObject({ success: false, error: '搜索关键词不能为空' })
    expect(called).toBe(false)
  })

  it('默认引擎/结果数取自设置表', async () => {
    const calls: any[] = []
    searchState.engineSetting = 'bing'
    searchState.countSetting = '3'
    searchState.searchImpl = async (q: string, e: string, c: number) => { calls.push([q, e, c]); return [{ title: 'T', url: 'u' }] }
    await search({ query: 'hi' })
    expect(calls[0]).toEqual(['hi', 'bing', 3])
  })

  it('设置值非法时回退默认（engine→google，count→5）', async () => {
    const calls: any[] = []
    searchState.engineSetting = 'yahoo'
    searchState.countSetting = '99'
    searchState.searchImpl = async (q: string, e: string, c: number) => { calls.push([e, c]); return [{ title: 'T', url: 'u' }] }
    await search({ query: 'hi' })
    expect(calls[0]).toEqual(['google', 5])
  })

  it('count 设置值越界/非数字时回退 5', async () => {
    const calls: any[] = []
    searchState.searchImpl = async (_q: string, _e: string, c: number) => { calls.push(c); return [{ title: 'T', url: 'u' }] }
    for (const raw of ['0', '11', 'abc', '']) {
      searchState.countSetting = raw
      await search({ query: 'hi' })
    }
    expect(calls).toEqual([5, 5, 5, 5])
  })

  it('设置表不可用时静默回退默认值', async () => {
    const calls: any[] = []
    searchState.settingsThrow = true
    searchState.searchImpl = async (_q: string, e: string, c: number) => { calls.push([e, c]); return [{ title: 'T', url: 'u' }] }
    const res = await search({ query: 'hi' })
    expect(res.success).toBe(true)
    expect(calls[0]).toEqual(['google', 5])
  })

  it('显式 engine 参数优先于设置', async () => {
    const calls: any[] = []
    searchState.engineSetting = 'baidu'
    searchState.searchImpl = async (_q: string, e: string) => { calls.push(e); return [{ title: 'T', url: 'u' }] }
    await search({ query: 'hi', engine: 'duckduckgo' })
    expect(calls[0]).toBe('duckduckgo')
  })

  it('count 参数夹取到 1-10（不做取整）', async () => {
    const calls: any[] = []
    searchState.searchImpl = async (_q: string, _e: string, c: number) => { calls.push(c); return [{ title: 'T', url: 'u' }] }
    await search({ query: 'hi', count: 100 })
    await search({ query: 'hi', count: -5 })
    await search({ query: 'hi', count: 2.7 })
    await search({ query: 'hi', count: 0 })
    await search({ query: 'hi', count: '3' })
    expect(calls).toEqual([10, 1, 2.7, 5, 3])
  })

  it('首选引擎失败时按 google→bing→baidu→duckduckgo 顺序降级', async () => {
    const tried: string[] = []
    searchState.engineSetting = 'google'
    searchState.searchImpl = async (_q: string, e: string) => {
      tried.push(e)
      if (e !== 'baidu') throw new Error(`${e} down`)
      return [{ title: '标题', url: 'https://x', snippet: '摘要' }]
    }
    const res = await search({ query: 'hi' })
    expect(tried).toEqual(['google', 'bing', 'baidu'])
    expect(res.success).toBe(true)
    expect(res.engine).toBe('baidu')
    expect(res.output).toContain('搜索结果（名称:baidu）: hi')
    expect(res.output).toContain('1. 标题')
    expect(res.output).toContain('   链接: https://x')
    expect(res.output).toContain('   摘要: 摘要')
  })

  it('无 snippet 的条目不输出摘要行', async () => {
    searchState.searchImpl = async () => [{ title: 'T', url: 'https://x' }]
    const res = await search({ query: 'hi' })
    expect(res.output).not.toContain('摘要:')
  })

  it('全部引擎失败：success 仍为 true，输出最后一次错误', async () => {
    searchState.searchImpl = async (_q: string, e: string) => { throw new Error(`fail-${e}`) }
    const res = await search({ query: 'hi' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('所有搜索引擎均搜索失败（最后错误: fail-duckduckgo）')
  })

  it('引擎抛非 Error 值时用 String() 兜底', async () => {
    searchState.searchImpl = async () => { throw 'raw-string' }
    const res = await search({ query: 'hi' })
    expect(String(res.output)).toContain('最后错误: raw-string')
  })

  it('结果为空数组或 null 时给出无结果提示', async () => {
    searchState.searchImpl = async () => []
    expect((await search({ query: 'abc' })).output).toBe('未找到关于 "abc" 的搜索结果')
    searchState.searchImpl = async () => null
    expect((await search({ query: 'abc' })).output).toBe('未找到关于 "abc" 的搜索结果')
  })

  it('多结果时逐条编号输出', async () => {
    searchState.searchImpl = async () => [
      { title: 'A', url: 'u1', snippet: 's1' },
      { title: 'B', url: 'u2' },
    ]
    const res = await search({ query: 'hi' })
    expect(res.output).toContain('1. A')
    expect(res.output).toContain('2. B')
  })

  it('工具元信息：必填 query、60s 超时、常驻工具', () => {
    expect(webSearchTool.parameters.required).toEqual(['query'])
    expect(webSearchTool.timeoutMs).toBe(60000)
    expect(webSearchTool.onDemand).toBeFalsy()
  })
})

// ==================== web_fetch ====================

interface FakeChunk {
  bytes: Uint8Array
}

function makeFetchResponse(opts: {
  chunks?: FakeChunk[]
  body?: null
  ok?: boolean
  status?: number
  statusText?: string
  contentType?: string | null
  onCancel?: () => void
  onRead?: () => void
}) {
  let idx = 0
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? (opts.contentType === undefined ? 'text/html' : opts.contentType) : null,
    },
    body: opts.body === null
      ? null
      : {
          getReader: () => ({
            read: async () => {
              opts.onRead?.()
              const chunk = opts.chunks?.[idx++]
              if (!chunk) return { done: true, value: undefined }
              return { done: false, value: chunk.bytes }
            },
            cancel: async () => { opts.onCancel?.() },
          }),
        },
  }
}

const enc = (s: string) => new TextEncoder().encode(s)

describe('agent/tools/web-fetch.tool / 参数校验与 SSRF 前置检查', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('空 URL / 协议不符 / 格式无效分别给出对应错误', async () => {
    expect(await fetchUrl({})).toMatchObject({ success: false, error: 'URL不能为空' })
    expect(await fetchUrl({ url: 'ftp://example.com/a' })).toMatchObject({ success: false, error: 'URL必须以 http:// 或 https:// 开头' })
    expect(await fetchUrl({ url: 'http://' })).toMatchObject({ success: false, error: 'URL格式无效' })
  })

  it('内网地址在发起请求前被拒绝（fetch 不被调用）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchUrl({ url: 'http://192.168.1.10/secret' })).toMatchObject({ success: false, error: '拒绝访问内网/本机地址' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('网络异常被收敛为可读错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    expect(await fetchUrl({ url: 'https://example.com' })).toMatchObject({ success: false, error: '获取网页失败: network down' })
  })

  it('HTTP 非 2xx 返回状态码错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({ ok: false, status: 404, statusText: 'Not Found', chunks: [] })))
    expect(await fetchUrl({ url: 'https://example.com' })).toMatchObject({ success: false, error: '请求失败: 404 Not Found' })
  })

  it('请求头声明浏览器 UA', async () => {
    const fetchMock = vi.fn(async () => makeFetchResponse({ chunks: [{ bytes: enc('hi') }] }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchUrl({ url: 'https://example.com' })
    expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toContain('Mozilla/5.0')
  })
})

describe('agent/tools/web-fetch.tool / HTML 与 JSON 内容处理', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('HTML：剥离 script/style/标签、解码实体、折叠空白', async () => {
    const html = '<html><head><style>p{color:red}</style><script>var a=1</script></head>'
      + '<body><h1>你好 &amp; 世界</h1><p>a &lt; b &gt; c &quot;q&quot; &nbsp;end</p></body></html>'
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({ chunks: [{ bytes: enc(html) }], contentType: 'text/html; charset=utf-8' })))
    const res = await fetchUrl({ url: 'https://example.com' })
    expect(res.success).toBe(true)
    expect(res.contentType).toBe('html')
    expect(res.truncated).toBe(false)
    expect(res.output).toBe('你好 & 世界 a < b > c "q" end')
  })

  it('HTML：超长内容按 max_chars 截断并标记 truncated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({ chunks: [{ bytes: enc('x'.repeat(500)) }] })))
    const res = await fetchUrl({ url: 'https://example.com', max_chars: 100 })
    expect(String(res.output).startsWith('x'.repeat(100))).toBe(true)
    expect(res.output).toContain('(内容已截断)')
    expect(res.truncated).toBe(true)
  })

  it('max_chars 夹取：下限 100，上限 50000', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({ chunks: [{ bytes: enc('y'.repeat(200)) }] })))
    const small = await fetchUrl({ url: 'https://example.com', max_chars: 1 })
    expect(String(small.output)).toContain('y'.repeat(100))

    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({ chunks: [{ bytes: enc('z'.repeat(60000)) }] })))
    const big = await fetchUrl({ url: 'https://example.com', max_chars: 99999 })
    // 正文截到 50000 字符，随后是 "\n\n" 与截断标记
    expect(String(big.output).indexOf('(内容已截断)')).toBe(50002)
    expect(big.truncated).toBe(true)
  })

  it('JSON：美化输出并按 max_chars 截断', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({
      chunks: [{ bytes: enc('{"a":1,"b":[2,3]}') }],
      contentType: 'application/json',
    })))
    const res = await fetchUrl({ url: 'https://example.com/api' })
    expect(res.contentType).toBe('json')
    expect(res.output).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2))

    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({
      chunks: [{ bytes: enc(JSON.stringify({ big: 'k'.repeat(300) })) }],
      contentType: 'application/json',
    })))
    const truncated = await fetchUrl({ url: 'https://example.com/api', max_chars: 100 })
    expect(String(truncated.output)).toContain('(内容已截断)')
  })

  it('JSON：非法 JSON 按原文返回（不报错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({
      chunks: [{ bytes: enc('not-json') }],
      contentType: 'application/json',
    })))
    const res = await fetchUrl({ url: 'https://example.com/api' })
    expect(res.success).toBe(true)
    expect(res.output).toBe('not-json')
  })

  it('非 HTML 文本（text/plain）原样返回，不做标签剥离', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({
      chunks: [{ bytes: enc('plain <b>bold</b> text') }],
      contentType: 'text/plain',
    })))
    const res = await fetchUrl({ url: 'https://example.com/file.txt' })
    expect(res.contentType).toBe('text')
    expect(res.output).toBe('plain <b>bold</b> text')
  })

  it('缺少 content-type 头时按 HTML 处理', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({ chunks: [{ bytes: enc('<p>hi</p>') }], contentType: null })))
    const res = await fetchUrl({ url: 'https://example.com' })
    expect(res.contentType).toBe('html')
    expect(res.output).toBe('hi')
  })

  it('响应无 body 时返回空内容而非报错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({ body: null })))
    const res = await fetchUrl({ url: 'https://example.com' })
    expect(res).toMatchObject({ success: true, output: '', truncated: false, contentType: 'html' })
  })
})

describe('agent/tools/web-fetch.tool / 2MB 读取上限', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('单块超过 2MB 时按剩余上限截断，不再整块丢弃导致空内容', async () => {
    let cancelled = false
    const big = new Uint8Array(3 * 1024 * 1024).fill(65)
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({
      chunks: [{ bytes: big }],
      onCancel: () => { cancelled = true },
    })))
    const res = await fetchUrl({ url: 'https://example.com', max_chars: 50000 })
    expect(res.success).toBe(true)
    expect(cancelled).toBe(true)
    expect(String(res.output).startsWith('A'.repeat(50000))).toBe(true)
    expect(res.truncated).toBe(true)
  })

  it('累计达到 2MB 后停止读取，不再消费后续数据块', async () => {
    let reads = 0
    let cancelled = false
    const oneMb = new Uint8Array(1024 * 1024).fill(66)
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({
      chunks: [{ bytes: oneMb }, { bytes: oneMb }, { bytes: oneMb }],
      onRead: () => { reads++ },
      onCancel: () => { cancelled = true },
    })))
    const res = await fetchUrl({ url: 'https://example.com', max_chars: 50000 })
    expect(res.success).toBe(true)
    expect(cancelled).toBe(true)
    expect(reads).toBe(2)
    expect(String(res.output).length).toBeGreaterThan(50000)
  })

  it('末尾跨块的多字节字符经最终 flush 输出，不再被静默丢弃', async () => {
    // 'a你' → 0x61 E4 BD A0；第二块只给到「你」的前 2 字节，流式解码无输出，
    // 必须靠循环结束后的 decoder.decode() flush 才能收尾
    const full = enc('a你')
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({
      chunks: [
        { bytes: full.slice(0, 1) },
        { bytes: full.slice(1, 3) },
      ],
    })))
    const res = await fetchUrl({ url: 'https://example.com' })
    expect(res.success).toBe(true)
    // 不完整字符被 flush 为替换字符（修复前该字符直接消失）
    expect(res.output).toBe('a\uFFFD')
  })

  it('跨块的多字节字符完整时必须还原为原字符', async () => {
    const full = enc('a你') // 0x61 E4 BD A0
    vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse({
      chunks: [
        { bytes: full.slice(0, 2) }, // 'a' + 「你」首字节
        { bytes: full.slice(2) }, // 「你」剩余 2 字节
      ],
    })))
    const res = await fetchUrl({ url: 'https://example.com' })
    expect(res.output).toBe('a你')
  })
})
