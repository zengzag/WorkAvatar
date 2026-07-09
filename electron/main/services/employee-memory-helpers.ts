import {
  type EmployeeMemory,
  TRIVIAL_PATTERNS,
  EXTRACTION_USER_MIN_CHARS,
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

/** 判断是否为无意义的闲聊消息 */
export function isTrivialMessage(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < EXTRACTION_USER_MIN_CHARS) return true
  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(trimmed)) return true
  }
  return false
}

/** 从消息列表中提取最后一轮 user/assistant 对话 */
export function extractLastTurn(
  messages: Array<{ role: string; content: string }>
): { user: string; assistant: string } | null {
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastAssistant = i; break }
  }
  if (lastAssistant < 0) return null

  let lastUser = -1
  for (let i = lastAssistant - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUser = i; break }
  }
  if (lastUser < 0) return null

  return {
    user: messages[lastUser].content,
    assistant: messages[lastAssistant].content,
  }
}

/** 格式化单轮对话用于提取，超长截断 */
export function formatTurnForExtraction(turn: { user: string; assistant: string }): string {
  const maxLen = 600
  const truncate = (s: string) => s.length > maxLen ? s.substring(0, maxLen) + '...' : s
  return `用户: ${truncate(turn.user)}\n助手: ${truncate(turn.assistant)}`
}

/** 将记忆列表格式化为 prompt 文本，按重要性排序并限制总长度 */
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
    const line = `- [${m.topic}] ${m.content}`
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
