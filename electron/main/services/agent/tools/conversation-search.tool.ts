import DatabaseService from '../../database.service'
import type { ToolDefinition } from './types'

export function createConversationSearchTool(employeeId: string): ToolDefinition[] {
  const db = DatabaseService.getInstance().getDb()

  const searchConversations: ToolDefinition = {
    id: 'search_conversations',
    name: 'search_conversations',
    title: '搜索历史对话',
    description: '搜索与当前用户的历史对话记录。可检索之前讨论过的主题、决策和上下文。返回匹配的对话标题、摘要和相关内容片段。当需要回忆之前讨论过的内容时使用此工具。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词或主题描述',
        },
        limit: {
          type: 'number',
          description: '返回结果数量（1-5，默认3）',
          minimum: 1,
          maximum: 5,
        },
      },
      required: ['query'],
    },
    handler: (args: Record<string, any>) => {
      const query = String(args.query || '').trim()
      if (!query) {
        return { success: false, error: '查询不能为空' }
      }

      const limit = Math.min(Math.max(args.limit || 3, 1), 5)

      const cleanQuery = query.replace(/["*()^+\-]/g, '').trim()
      if (cleanQuery.length < 2) {
        return { success: false, error: '查询词太短' }
      }
      const ftsQuery = `"${cleanQuery.replace(/"/g, '""')}"`

      try {
        const results = db.prepare(`
          SELECT
            c.id,
            c.title,
            c.summary,
            c.last_message_at,
            c.message_count,
            snippet(conversations_fts, 2, '<highlight>', '</highlight>', '...', 30) as preview_snippet
          FROM conversations_fts f
          JOIN conversations c ON c.id = f.conversation_id
          WHERE f.employee_id = ?
            AND conversations_fts MATCH ?
            AND c.status = 'active'
          ORDER BY f.rank
          LIMIT ?
        `).all(employeeId, ftsQuery, limit) as any[]

        if (results.length === 0) {
          return {
            success: true,
            output: '未找到匹配的历史对话。',
            results: []
          }
        }

        const formatted = results.map((r, i) => {
          const date = r.last_message_at
            ? new Date(r.last_message_at * 1000).toLocaleDateString('zh-CN')
            : '未知'
          return `[${i + 1}] ${r.title || '无标题对话'} (${date}, ${r.message_count || 0}条消息)\n摘要: ${r.summary || '无摘要'}\n相关片段: ${r.preview_snippet || '无'}`
        }).join('\n\n---\n\n')

        return {
          success: true,
          output: `找到 ${results.length} 条相关历史对话：\n\n${formatted}`,
          results: results.map(r => ({
            conversationId: r.id,
            title: r.title,
            summary: r.summary,
            lastMessageAt: r.last_message_at,
            messageCount: r.message_count,
            previewSnippet: r.preview_snippet,
          })),
        }
      } catch (err: any) {
        return { success: false, error: `搜索失败: ${err?.message || err}` }
      }
    },
    source: 'builtin',
    permission: 'safe',
  }

  return [searchConversations]
}
