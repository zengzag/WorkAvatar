import type { ToolDefinition } from './types'

export const webFetchTool: ToolDefinition = {
  id: 'web_fetch',
  name: 'web_fetch',
  title: '网页获取',
  description: '获取指定URL的网页内容，提取为纯文本。支持限制最大字符数。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要获取的网页URL' },
      max_chars: { type: 'number', description: '最大字符数（默认10000）', minimum: 100, maximum: 50000 }
    },
    required: ['url']
  },
  handler: async (args: any) => {
    try {
      const url = String(args.url || '').trim()
      if (!url) return { success: false, error: 'URL不能为空' }
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return { success: false, error: 'URL必须以 http:// 或 https:// 开头' }
      }

      const maxChars = Math.min(Math.max(args.max_chars || 10000, 100), 50000)

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      })

      if (!response.ok) return { success: false, error: `请求失败: ${response.status} ${response.statusText}` }

      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const data = await response.json()
        const text = JSON.stringify(data, null, 2)
        return { success: true, output: text.length > maxChars ? text.substring(0, maxChars) + '\n\n(内容已截断)' : text, contentType: 'json' }
      }

      const html = await response.text()
      let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim()

      const truncated = text.length > maxChars
      const output = truncated ? text.substring(0, maxChars) + '\n\n(内容已截断)' : text
      return { success: true, output, truncated, contentType: 'html' }
    } catch (error: any) {
      return { success: false, error: `获取网页失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}