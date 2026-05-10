import type { ToolDefinition } from '../tool.types'

export const webSearchTool: ToolDefinition = {
  id: 'web_search',
  name: 'web_search',
  title: '网络搜索',
  description: '使用DuckDuckGo进行网络搜索，返回搜索结果的标题、链接和摘要。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      count: { type: 'number', description: '返回结果数量（1-10，默认5）', minimum: 1, maximum: 10 }
    },
    required: ['query']
  },
  handler: async (args: any) => {
    try {
      const query = String(args.query || '').trim()
      if (!query) return { success: false, error: '搜索关键词不能为空' }
      const count = Math.min(Math.max(args.count || 5, 1), 10)

      const encodedQuery = encodeURIComponent(query)
      const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      })

      if (!response.ok) return { success: false, error: `搜索请求失败: ${response.status}` }

      const html = await response.text()
      const results: Array<{ title: string; url: string; snippet: string }> = []

      const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi
      const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi

      const titles: Array<{ url: string; title: string }> = []
      let match
      while ((match = resultRegex.exec(html)) !== null && titles.length < count) {
        const rawUrl = match[1]
        const title = match[2].replace(/<[^>]+>/g, '').trim()
        let url = rawUrl
        if (rawUrl.startsWith('//')) url = 'https:' + rawUrl
        else if (rawUrl.startsWith('/')) url = 'https://duckduckgo.com' + rawUrl
        titles.push({ url, title })
      }

      const snippets: string[] = []
      while ((match = snippetRegex.exec(html)) !== null && snippets.length < count) {
        snippets.push(match[1].replace(/<[^>]+>/g, '').trim())
      }

      for (let i = 0; i < titles.length; i++) {
        results.push({ title: titles[i].title, url: titles[i].url, snippet: snippets[i] || '' })
      }

      if (results.length === 0) return { success: true, output: `未找到关于 "${query}" 的搜索结果` }

      const lines = [`搜索结果: ${query}\n`]
      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        lines.push(`${i + 1}. ${r.title}`)
        lines.push(`   链接: ${r.url}`)
        if (r.snippet) lines.push(`   摘要: ${r.snippet}`)
        lines.push('')
      }

      return { success: true, output: lines.join('\n') }
    } catch (error: any) {
      return { success: false, error: `搜索失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}