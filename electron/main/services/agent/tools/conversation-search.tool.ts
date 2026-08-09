import DatabaseService from '../../database.service'
import type { ToolDefinition } from './types'

/**
 * 构建 FTS5 MATCH 表达式：
 * - 将查询拆分为 token，用空格连接（FTS5 隐式 AND）
 * - 对英文 token 追加 * 实现前缀匹配
 * - 对中文逐字 token 不加 *（unicode61 逐字分词，前缀无意义）
 * 比 `"精确短语"` 更宽松：要求所有 token 出现但顺序不限。
 */
function buildFtsQuery(query: string): string {
  const cleaned = query.replace(/["*()^+\-]/g, '').trim()
  if (!cleaned) return ''
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0)
  return tokens
    .map((tok) => {
      // 纯 ASCII token 追加前缀通配符（英文前缀匹配）
      if (/^[a-zA-Z0-9]+$/.test(tok) && tok.length >= 2) {
        return `${tok}*`
      }
      return tok
    })
    .join(' ')
}

export function createConversationSearchTool(employeeId: string): ToolDefinition[] {
  const db = DatabaseService.getInstance().getDb()

  const searchConversations: ToolDefinition = {
    id: 'search_conversations',
    name: 'search_conversations',
    title: '搜索历史对话',
    summary: '搜索与当前用户的历史对话记录。回忆之前讨论过的内容时使用。',
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

      try {
        // Phase 1: FTS5 隐式 AND 匹配（所有 token 必须出现，顺序不限）
        let results: any[] = []
        const ftsQuery = buildFtsQuery(query)
        if (ftsQuery) {
          results = db.prepare(`
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
              AND (c.parent_conversation_id = '' OR c.parent_conversation_id IS NULL)
            ORDER BY f.rank
            LIMIT ?
          `).all(employeeId, ftsQuery, limit) as any[]
        }

        // Phase 2: FTS 无结果时降级为 LIKE 模糊搜索（标题 + 摘要 + 内容预览）
        if (results.length === 0) {
          const likePattern = `%${query.replace(/[%_]/g, (m) => '\\' + m)}%`
          results = db.prepare(`
            SELECT
              c.id,
              c.title,
              c.summary,
              c.last_message_at,
              c.message_count,
              '' as preview_snippet
            FROM conversations c
            WHERE c.employee_id = ?
              AND c.status = 'active'
              AND (c.parent_conversation_id = '' OR c.parent_conversation_id IS NULL)
              AND (
                c.title LIKE ? ESCAPE '\\'
                OR COALESCE(c.summary, '') LIKE ? ESCAPE '\\'
                OR EXISTS (
                  SELECT 1 FROM conversations_fts f
                  WHERE f.conversation_id = c.id
                    AND f.content_preview LIKE ? ESCAPE '\\'
                )
              )
            ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
            LIMIT ?
          `).all(employeeId, likePattern, likePattern, likePattern, limit) as any[]
        }

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
          const snippet = r.preview_snippet || r.summary || ''
          return `[${i + 1}] ${r.title || '无标题对话'} (${date}, ${r.message_count || 0}条消息)\n摘要: ${r.summary || '无摘要'}\n相关片段: ${snippet || '无'}`
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
    onDemand: true,
    permission: 'safe',
  }

  return [searchConversations]
}
