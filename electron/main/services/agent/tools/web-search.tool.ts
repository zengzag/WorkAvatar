import type { ToolDefinition } from './types'
import { internetSearchService, SearchEngine, SearchResult } from '../../internet-search.service'
import DatabaseService from '../../database.service'

const SUPPORTED_ENGINES: SearchEngine[] = ['google', 'bing', 'baidu', 'duckduckgo']

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

export const webSearchTool: ToolDefinition = {
  id: 'web_search',
  name: 'web_search',
  title: '网络搜索',
  description:
    'Search the web and return titles, links and content snippets. A preferred engine is configured in settings; other engines are tried automatically when it is unavailable or returns nothing.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      engine: {
        type: 'string',
        description: 'Search engine: google, bing, baidu or duckduckgo. Defaults to the configured engine',
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

      const preferredEngine = (args.engine as SearchEngine) || getDefaultEngine()

      let results: SearchResult[] = []
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
      const lines = [`搜索结果（${engineName}）: ${query}\n`]
      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        lines.push(`${i + 1}. ${r.title}`)
        lines.push(`   链接: ${r.url}`)
        if (r.snippet) lines.push(`   摘要: ${r.snippet}`)
        lines.push('')
      }

      return { success: true, output: lines.join('\n'), engine: usedEngine }
    } catch (error: any) {
      return { success: false, error: `搜索失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}
