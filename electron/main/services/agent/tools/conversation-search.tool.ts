import DatabaseService from '../../database.service'
import {
  buildConversationFtsMatch,
  buildConversationLikeTerms,
  buildConversationSnippet,
} from '../../conversation-fts'
import type { ToolDefinition } from './types'

export function createConversationSearchTool(employeeId: string): ToolDefinition[] {
  const db = DatabaseService.getInstance().getDb()

  const searchConversations: ToolDefinition = {
    id: 'search_conversations',
    name: 'search_conversations',
    title: '搜索历史对话',
    summary: 'Search the current user\'s conversation history for topics discussed earlier.',
    description: [
      'Search the current user\'s conversation history for previously discussed topics, decisions, and context. Returns matching conversation titles, summaries, and content snippets.',
      'Use it when you need to recall what was discussed earlier.',
      '',
      'Results are snippets, not full text. For the original wording (exact commands, phrasing), call get_conversation_detail with the returned conversationId; it supports incremental reads with max_chars + cursor.',
      '',
      'Difference from search_memories: this tool searches raw history; durable cross-task memories (preferences, constraints, pitfalls, conclusions) are searched with search_memories.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search terms or topic description',
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (1-5, default 3)',
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
        // Phase 1: FTS5 匹配（索引/查询两侧 jieba 预分词；AND 优先精确命中，OR 兜底保证召回）
        let results: any[] = []
        const ftsQueries = Array.from(new Set([
          buildConversationFtsMatch(query, 'all'),
          buildConversationFtsMatch(query, 'any'),
        ].filter((q): q is string => !!q)))
        for (const ftsQuery of ftsQueries) {
          if (results.length > 0) break
          results = db.prepare(`
            SELECT
              c.id,
              c.title,
              c.summary,
              c.last_message_at,
              c.message_count,
              COALESCE(f.content_raw, '') as preview_raw
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

        // Phase 2: FTS 无结果时降级为按词粒度的 LIKE 模糊搜索（标题 + 摘要 + 内容预览）
        if (results.length === 0) {
          const likeTokens = buildConversationLikeTerms(query)
          if (likeTokens.length > 0) {
            const tokenCond = `(c.title LIKE ? ESCAPE '\\' OR COALESCE(c.summary, '') LIKE ? ESCAPE '\\' OR EXISTS (
              SELECT 1 FROM conversations_fts f
              WHERE f.conversation_id = c.id AND f.content_raw LIKE ? ESCAPE '\\'
            ))`
            const andClause = likeTokens.map(() => tokenCond).join(' AND ')
            const tokenParams = likeTokens.flatMap((t) => {
              const p = `%${t.replace(/[%_]/g, (m) => '\\' + m)}%`
              return [p, p, p]
            })

            results = db.prepare(`
              SELECT
                c.id,
                c.title,
                c.summary,
                c.last_message_at,
                c.message_count,
                COALESCE((SELECT f.content_raw FROM conversations_fts f WHERE f.conversation_id = c.id), '') as preview_raw
              FROM conversations c
              WHERE c.employee_id = ?
                AND c.status = 'active'
                AND (c.parent_conversation_id = '' OR c.parent_conversation_id IS NULL)
                AND (${andClause})
              ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
              LIMIT ?
            `).all(employeeId, ...tokenParams, limit) as any[]
          }
        }

        if (results.length === 0) {
          return {
            success: true,
            output: '未找到匹配的历史对话。',
            results: []
          }
        }

        const withSnippets = results.map((r) => ({
          ...r,
          preview_snippet: buildConversationSnippet(r.preview_raw || '', query),
        }))

        const formatted = withSnippets.map((r, i) => {
          const date = r.last_message_at
            ? new Date(r.last_message_at * 1000).toLocaleDateString('zh-CN')
            : '未知'
          const snippet = r.preview_snippet || r.summary || ''
          return `[${i + 1}] ${r.title || '无标题对话'} (${date}, ${r.message_count || 0}条消息)\n摘要: ${r.summary || '无摘要'}\n相关片段: ${snippet || '无'}`
        }).join('\n\n---\n\n')

        return {
          success: true,
          output: `找到 ${results.length} 条相关历史对话：\n\n${formatted}`,
          results: withSnippets.map(r => ({
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
    onDemand: false,
    permission: 'safe',
  }

  return [searchConversations]
}
