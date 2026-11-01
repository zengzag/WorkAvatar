import type { ToolDefinition } from './types'
import { internetSearchService, SearchEngine } from '../../internet-search.service'
import { searchApiService } from '../../search-api.service'
import DatabaseService from '../../database.service'

const SUPPORTED_ENGINES: SearchEngine[] = ['google', 'bing', 'baidu', 'duckduckgo']

interface FormattableResult {
  title: string
  url: string
  snippet?: string
}

function getDefaultEngine(): SearchEngine {
  try {
    const db = DatabaseService.getInstance().getDb()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('web_search_engine') as any
    const engine = (row?.value || 'google') as SearchEngine
    if (SUPPORTED_ENGINES.includes(engine)) return engine
    return 'google'
  } catch {
    return 'google'
  }
}

function getDefaultResultCount(): number {
  try {
    const db = DatabaseService.getInstance().getDb()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('web_search_result_count') as any
    if (row?.value) {
      const count = parseInt(row.value, 10)
      if (count >= 1 && count <= 10) return count
    }
    return 5
  } catch {
    return 5
  }
}

function formatResults(header: string, results: FormattableResult[]): string {
  const lines = [header]
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   链接: ${r.url}`)
    if (r.snippet) lines.push(`   摘要: ${r.snippet}`)
    lines.push('')
  }
  return lines.join('\n')
}

async function runBrowserSearch(query: string, count: number, engineArg?: string): Promise<any> {
  const preferredEngine = (engineArg as SearchEngine) || getDefaultEngine()

  let results: FormattableResult[] = []
  let usedEngine: SearchEngine = preferredEngine
  let lastError: string | null = null

  const engineOrder = [preferredEngine, ...SUPPORTED_ENGINES.filter(e => e !== preferredEngine)]

  for (const engine of engineOrder) {
    try {
      const found = await internetSearchService.search(query, engine, count)
      lastError = null
      // 结果为空也继续降级：反爬/验证页会返回空，而非抛错
      if (found && found.length > 0) {
        results = found
        usedEngine = engine
        break
      }
    } catch (err: any) {
      lastError = err.message || String(err)
    }
  }

  if (!results || results.length === 0) {
    return {
      success: true,
      output: lastError
        ? `所有搜索引擎均搜索失败（最后错误: ${lastError}），请稍后重试`
        : `未找到关于 "${query}" 的搜索结果`
    }
  }

  const engineName = internetSearchService.getEngineName(usedEngine)
  return { success: true, output: formatResults(`搜索结果（${engineName}）: ${query}\n`, results), engine: usedEngine }
}

async function runApiSearch(query: string, count: number): Promise<any> {
  const provider = searchApiService.getProvider()
  const providerName = searchApiService.getProviderName(provider)

  const apiKey = await searchApiService.getApiKey(provider)
  if (!apiKey) {
    return {
      success: false,
      error: `搜索 API（${providerName}）未配置 API Key，请在 设置 → 网络搜索 中配置，或切换回本地浏览器搜索`
    }
  }

  try {
    const { results } = await searchApiService.search(query, count)
    if (results.length === 0) {
      return { success: true, output: `未找到关于 "${query}" 的搜索结果` }
    }
    return { success: true, output: formatResults(`搜索结果（${providerName} API）: ${query}\n`, results), engine: provider }
  } catch (error: any) {
    return { success: false, error: `搜索 API（${providerName}）调用失败: ${error?.message || error}` }
  }
}

export const webSearchTool: ToolDefinition = {
  id: 'web_search',
  name: 'web_search',
  title: '网络搜索',
  summary: 'Search the web and return titles, links, and snippets for external or real-time information.',
  description:
    'Search the web and return titles, links, and snippets. Use it for external or real-time information; follow up with web_fetch when a result needs full text. The backend is configured in settings: a local browser engine (google, bing, baidu, duckduckgo) or a search API (DeepSeek, Tavily, Brave).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      engine: {
        type: 'string',
        description: 'Search engine used by the local browser backend: google, bing, baidu or duckduckgo. Ignored by the search API backend',
        enum: SUPPORTED_ENGINES
      },
      count: {
        type: 'number',
        description: 'Number of results (1-10). Defaults to the configured value',
        minimum: 1,
        maximum: 10
      }
    },
    required: ['query']
  },
  timeoutMs: 60000,
  handler: async (args: any) => {
    try {
      const query = String(args.query || '').trim()
      if (!query) return { success: false, error: '搜索关键词不能为空' }

      const defaultCount = getDefaultResultCount()
      const count = args.count
        ? Math.min(Math.max(Number(args.count), 1), 10)
        : defaultCount

      if (searchApiService.getMode() === 'api') {
        return await runApiSearch(query, count)
      }
      return await runBrowserSearch(query, count, args.engine)
    } catch (error: any) {
      return { success: false, error: `搜索失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}
