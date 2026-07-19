import {
  type EmployeeMemory,
  EXTRACTION_MAX_EXISTING_MEMORIES,
  CONSOLIDATION_CANDIDATE_MAX,
  MEMORY_MAX_CHARS,
} from './employee-memory-types'

/** 构建 FTS5 查询字符串 */
export function buildFtsQuery(query: string): string {
  const trimmed = query.trim()
  if (trimmed.length < 2) return ''
  const clean = trimmed.replace(/"/g, '""').replace(/[*()^\-+]/g, '')
  if (clean.length < 2) return ''
  return `"${clean}"`
}

/** 过滤消息为仅 content 部分（跳过 tool 消息、reasoning_content、toolCalls），
 *  按时间顺序格式化为对话文本，不截断——保留完整踩坑细节（工具名、报错信息、阈值）。
 *  用于增量记忆提取：每次只处理自上次提取以来的新消息，配合 conversations.summary
 *  作为运行式摘要压缩已提取的历史对话。
 */
export function formatContentOnlyMessages(
  messages: Array<{ role: string; content: string }>
): string {
  return messages
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim().length > 0)
    .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
    .join('\n')
}

/** 将记忆列表格式化为 prompt 文本，按重要性排序并限制总长度
 * 输出格式：`- content`（省去 [topic] 前缀以节省字符；topic 在调试视图可见）
 */
export function formatMemoriesForPrompt(memories: EmployeeMemory[], maxChars?: number): string {
  if (memories.length === 0) return ''

  const sorted = [...memories].sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned
    const impOrder = { critical: 0, normal: 1, low: 2 }
    if (impOrder[a.importance] !== impOrder[b.importance]) return impOrder[a.importance] - impOrder[b.importance]
    return b.updated_at - a.updated_at
  })

  const lines: string[] = []
  let totalLen = 0
  const limit = maxChars || MEMORY_MAX_CHARS

  for (const m of sorted) {
    const line = `- ${m.content}`
    if (totalLen + line.length > limit && !m.is_pinned) break
    lines.push(line)
    totalLen += line.length + 1
  }
  return lines.join('\n')
}

/** 根据对话文本相关性对现有记忆打分，返回最相关的子集 */
export function getExtractionRelevantMemories(
  allMemories: EmployeeMemory[],
  conversationText: string
): EmployeeMemory[] {
  if (allMemories.length <= EXTRACTION_MAX_EXISTING_MEMORIES) return allMemories

  const keywords = conversationText
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .slice(0, 10)

  const scored = allMemories.map(m => {
    let score = 0
    if (m.is_pinned) score += 100
    if (m.importance === 'critical') score += 50
    const combined = `${m.key} ${m.topic} ${m.content}`.toLowerCase()
    for (const kw of keywords) {
      if (combined.includes(kw.toLowerCase())) score += 10
    }
    score += Math.max(0, 10 - (Date.now() / 1000 - m.updated_at) / 86400)
    return { memory: m, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, EXTRACTION_MAX_EXISTING_MEMORIES).map(s => s.memory)
}

/** 从全部记忆中按优先级挑选合并整理候选 */
export function getConsolidationCandidates(allMemories: EmployeeMemory[]): EmployeeMemory[] {
  if (allMemories.length <= CONSOLIDATION_CANDIDATE_MAX) return allMemories

  const now = Math.floor(Date.now() / 1000)
  const recentThreshold = now - 30 * 86400

  const pinned: EmployeeMemory[] = []
  const recent: EmployeeMemory[] = []
  const old: EmployeeMemory[] = []

  for (const m of allMemories) {
    if (m.is_pinned) {
      pinned.push(m)
    } else if (m.updated_at > recentThreshold || m.importance === 'critical') {
      recent.push(m)
    } else {
      old.push(m)
    }
  }

  const candidates: EmployeeMemory[] = [...pinned]
  const remaining = CONSOLIDATION_CANDIDATE_MAX - candidates.length
  if (remaining > 0) {
    candidates.push(...recent.slice(0, remaining))
    const stillRemaining = CONSOLIDATION_CANDIDATE_MAX - candidates.length
    if (stillRemaining > 0) {
      candidates.push(...old.slice(0, stillRemaining))
    }
  }

  return candidates
}

/** 生成兜底摘要（LLM 不可用时） */
export function generateFallbackSummary(messages: Array<{ role: string; content: string }>): string {
  const userMessages = messages.filter(m => m.role === 'user')
  const assistantMessages = messages.filter(m => m.role === 'assistant')

  const topics: string[] = []
  for (const msg of userMessages) {
    const preview = msg.content.substring(0, 100).trim()
    if (preview) {
      topics.push(`- 用户询问: ${preview}${msg.content.length > 100 ? '...' : ''}`)
    }
  }

  const summaryParts: string[] = []
  if (topics.length > 0) {
    summaryParts.push(`讨论了 ${topics.length} 个话题：`)
    summaryParts.push(...topics.slice(0, 10))
  }
  summaryParts.push(`共 ${userMessages.length} 条用户消息，${assistantMessages.length} 条助手回复。`)

  return summaryParts.join('\n')
}
