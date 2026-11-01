import EmployeeMemoryService from '../../employee-memory.service'
import { MEMORY_SEARCH_DEFAULT_LIMIT, MEMORY_SEARCH_MAX_LIMIT } from '../../employee-memory-types'

/**
 * 长期记忆检索工具。
 *
 * 任务上下文里的 <memory> 区块只常驻"置顶 + 关键"记忆；其余记忆（历史偏好、约束、踩坑、
 * 结论）通过本工具按需检索，避免把所有记忆灌进每轮 prompt（省上下文与 KV cache）。
 *
 * 检索实现：jieba 分词 → FTS5 OR 匹配 → BM25 排序 → 相对分数下限去噪（见 employee-memory.service）。
 */

const SCOPE_VALUES = ['all', 'employee', 'global'] as const
type ScopeArg = (typeof SCOPE_VALUES)[number]

export function createMemorySearchTool(employeeId: string): import('./types').ToolDefinition[] {
  const memoryService = EmployeeMemoryService.getInstance()

  const searchMemories: import('./types').ToolDefinition = {
    id: 'search_memories',
    name: 'search_memories',
    title: '搜索长期记忆',
    summary: 'Search long-term cross-task memory (user preferences, hard constraints, pitfalls, conclusions).',
    description: [
      'Search the employee\'s cross-task long-term memory: durable facts captured from earlier conversations, including user preferences and working style, hard constraints and prohibitions, pitfalls with their fixes, and stable conclusions and environment facts.',
      '',
      'When to use:',
      '- The <memory> block holds only pinned and critical memories; use this tool when you need other preferences, constraints, pitfalls, or conclusions.',
      '- The user refers to something said earlier, or the task may depend on a previously recorded preference or constraint.',
      '- Never invent memories. If nothing is found, say so, or use search_conversations to retrieve the original conversation.',
      '',
      'Query guidance:',
      '- Terms are split and OR-matched, then ranked by BM25. A hit is authoritative: do not conclude that nothing was recorded just because a rephrased query misses.',
      '- Prefer 1-3 distinctive terms (feature names, tool names, explicit preference words). Avoid generic piles such as "config parameter database".',
      '- Results may be excerpts; use search_conversations / get_conversation_detail for the raw wording.',
      '- If a query returns 0 results, retry with fewer, more distinctive terms; if still empty, do not fabricate.',
      '',
      'Scope:',
      '- all (default): current employee + global memories',
      '- employee: current employee only',
      '- global: shared user-level memories only',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search terms; 1-3 distinctive words work best (e.g. "PPT animation", "weekly report format")',
        },
        limit: {
          type: 'number',
          description: `Results to return (1-${MEMORY_SEARCH_MAX_LIMIT}, default ${MEMORY_SEARCH_DEFAULT_LIMIT})`,
          minimum: 1,
          maximum: MEMORY_SEARCH_MAX_LIMIT,
        },
        scope: {
          type: 'string',
          enum: [...SCOPE_VALUES],
          description: 'Search scope: all (default, employee + global) / employee / global',
        },
      },
      required: ['query'],
    },
    handler: (args: Record<string, any>) => {
      const query = String(args.query || '').trim()
      if (!query) {
        return { success: false, error: '查询关键词不能为空' }
      }
      const rawScope = String(args.scope || 'all') as ScopeArg
      const scope: ScopeArg = (SCOPE_VALUES as readonly string[]).includes(rawScope) ? rawScope : 'all'
      const rawLimit = Math.floor(Number(args.limit))
      const limit = Number.isFinite(rawLimit) && rawLimit >= 1
        ? Math.min(rawLimit, MEMORY_SEARCH_MAX_LIMIT)
        : MEMORY_SEARCH_DEFAULT_LIMIT

      try {
        const results = memoryService.searchMemoriesForAgent(employeeId, query, { limit, scope })

        if (results.length === 0) {
          return {
            success: true,
            output: [
              `未检索到与「${query}」相关的记忆。`,
              '这不代表从未记录过。可尝试：',
              '1. 换用更少、更独特的关键词重试（查询按 OR 匹配，1-2 个罕见词比长句更有效）；',
              '2. 明确指定 scope（employee / global）重试；',
              '3. 若需要的是历史对话原文，改用 search_conversations 或 get_conversation_detail。',
            ].join('\n'),
            results: [],
            count: 0,
          }
        }

        const formatted = results.map((m, i) => {
          const tags: string[] = []
          if (m.is_pinned) tags.push('置顶')
          if (m.importance === 'critical') tags.push('关键')
          if (m.importance === 'low') tags.push('次要')
          tags.push(m.scope === 'global' ? '全局' : '员工')
          tags.push(m.source === 'manual' ? '手动' : '自动')
          return `[${i + 1}] ${m.topic}${tags.length ? `（${tags.join('/')}）` : ''} (key=${m.key})\n${m.content}`
        }).join('\n\n')

        return {
          success: true,
          output: `检索到 ${results.length} 条相关记忆（按相关度排序）：\n\n${formatted}`,
          count: results.length,
          results: results.map(m => ({
            id: m.id,
            key: m.key,
            topic: m.topic,
            content: m.content,
            scope: m.scope,
            importance: m.importance,
            isPinned: m.is_pinned === 1,
            source: m.source,
          })),
        }
      } catch (err: any) {
        return { success: false, error: `记忆检索失败: ${err?.message || err}` }
      }
    },
    source: 'builtin',
    onDemand: false,
    permission: 'safe',
  }

  return [searchMemories]
}
