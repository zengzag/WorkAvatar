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
    summary: '检索跨任务长期记忆（用户偏好、硬约束、踩坑经验、结论等），需要回忆此前记录时使用。',
    description: [
      '检索数字员工的跨任务长期记忆。记忆是此前对话中沉淀的持久事实：用户偏好与工作风格、硬性约束与禁忌、踩坑经验与解法、稳定结论与环境事实。',
      '',
      '何时使用：',
      '- 上下文 <memory> 区块只包含"置顶 + 关键"记忆；当你需要回忆其他偏好、约束、踩坑或结论时，用本工具检索。',
      '- 用户提到"之前说过/上次/我以前提过"，或任务涉及可能与历史相关的偏好与约束时。',
      '- 不要臆造记忆内容；查不到就如实说明，或改用 search_conversations 检索历史对话原文。',
      '',
      '查询写法（重要）：',
      '- 查询按词切分后 OR 匹配并按 BM25 相关度排序，命中即权威（一次命中就采信，不要因换个说法查不到就断定"没记录过"）。',
      '- 优先 1-3 个独特关键词（功能名、工具名、明确的偏好词），避免堆砌泛词（"配置 参数 数据库" 这类只会稀释结果）。',
      '- 命中结果可能只是片段（内容已在写入时精炼）：如需原始字面细节，用 search_conversations / get_conversation_detail 取历史对话原文。',
      '- 返回 0 条时：换用更少、更独特的词重试；仍然没有就不要编造。',
      '',
      '作用域 scope：',
      '- all（默认）：当前员工记忆 + 全局记忆',
      '- employee：仅当前数字员工的记忆',
      '- global：仅跨员工共享的全局记忆（用户角色、通用偏好等）',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词（1-3 个独特词效果最好），如 "PPT 动画"、"周报 格式"、"Excel 透视表 崩溃"',
        },
        limit: {
          type: 'number',
          description: `返回条数（1-${MEMORY_SEARCH_MAX_LIMIT}，默认 ${MEMORY_SEARCH_DEFAULT_LIMIT}）`,
          minimum: 1,
          maximum: MEMORY_SEARCH_MAX_LIMIT,
        },
        scope: {
          type: 'string',
          enum: [...SCOPE_VALUES],
          description: '检索范围：all（默认，员工+全局）/ employee（仅当前员工）/ global（仅全局记忆）',
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
    onDemand: true,
    permission: 'safe',
  }

  return [searchMemories]
}
