import {
  type EmployeeMemory,
  EXTRACTION_MAX_EXISTING_MEMORIES,
  CONSOLIDATION_CANDIDATE_MAX,
  MEMORY_MAX_CHARS,
  MEMORY_ALWAYS_ON_MAX_COUNT,
  MEMORY_ALWAYS_ON_MAX_CHARS,
  MEMORY_SEARCH_MAX_TERMS,
  MEMORY_BOUND_TOOL_IDS,
} from './employee-memory-types'

/** 重要性排序权重（critical 最靠前） */
const IMPORTANCE_ORDER: Record<EmployeeMemory['importance'], number> = {
  critical: 0,
  normal: 1,
  low: 2,
}

/**
 * 构建记忆 FTS5 MATCH 表达式：
 * - 用传入的分词函数（生产环境为 jieba）切词，逐词加短语引号，OR 连接
 * - OR（而非 AND）保证召回：单个描述性词缺失不会清零整条查询，由 BM25 排序 + 相对分数下限去噪
 * - 词元去重并截断到上限，避免超长 MATCH 拖慢 FTS
 *
 * 注：索引侧必须使用同一分词器预分词，否则中文 doc 会被 unicode61 视作单个 token 而无法命中。
 *
 * @returns MATCH 表达式；无可用词元时返回 null（调用方应视为空查询，直接返回空结果）
 */
export function buildMemoryMatchQuery(
  query: string,
  tokenize: (text: string) => string[]
): string | null {
  const raw = (query || '').trim()
  if (!raw) return null
  const tokens = tokenize(raw)
    .map(t => (t || '').trim())
    .filter(Boolean)
  if (tokens.length === 0) return null
  const seen = new Set<string>()
  const uniq: string[] = []
  for (const t of tokens) {
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(t)
    if (uniq.length >= MEMORY_SEARCH_MAX_TERMS) break
  }
  return uniq.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ')
}

/**
 * 按相对分数下限裁剪已按相关度降序排列的检索结果：
 * - 第 1 条恒保留（命中即权威，即使 BM25 无法区分）
 * - 其余保留得分 ≥ top*floorRatio 的项；floorRatio ≤ 0 时不过滤
 */
export function applyScoreFloor<T extends { score: number }>(
  sortedDesc: T[],
  floorRatio: number
): T[] {
  if (sortedDesc.length === 0) return []
  if (!(floorRatio > 0)) return sortedDesc
  const cutoff = sortedDesc[0].score * floorRatio
  return sortedDesc.filter((r, i) => i === 0 || r.score >= cutoff)
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
    if (IMPORTANCE_ORDER[a.importance] !== IMPORTANCE_ORDER[b.importance]) {
      return IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance]
    }
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

/**
 * 挑选"常驻注入"的记忆：置顶 + 关键（critical）。
 *
 * 全量快照注入会随记忆增长挤爆上下文，且超出字符上限的条目对 agent 永久不可见。
 * 因此只常驻高价值少量记忆，其余交给 search_memories 工具按需检索（渐进披露）。
 */
export function selectAlwaysOnMemories(
  memories: EmployeeMemory[],
  options?: { maxCount?: number }
): EmployeeMemory[] {
  const maxCount = options?.maxCount ?? MEMORY_ALWAYS_ON_MAX_COUNT
  if (maxCount <= 0) return []
  return memories
    .filter(m => m.is_pinned === 1 || m.importance === 'critical')
    .sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned
      if (IMPORTANCE_ORDER[a.importance] !== IMPORTANCE_ORDER[b.importance]) {
        return IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance]
      }
      return b.updated_at - a.updated_at
    })
    .slice(0, maxCount)
}

/**
 * 构建注入到任务上下文 <memory> 块的文本。
 *
 * - totalCount 为 0：无任何记忆，返回空串（不占用上下文）
 * - 有记忆但无常驻项：仅给检索提示，引导 agent 主动调用 search_memories
 * - 有常驻项：列出行 + 检索提示（说明本块只含置顶/关键记忆）
 */
export function buildMemoryPromptBlock(alwaysOn: EmployeeMemory[], totalCount: number): string {
  if (totalCount <= 0) return ''
  const lines = formatMemoriesForPrompt(alwaysOn, MEMORY_ALWAYS_ON_MAX_CHARS)
  const header = '核心记忆（跨任务持久事实，已自动注入）：'
  const hint = '以上仅为置顶与关键记忆；如需回忆其他偏好、约束、踩坑或结论，调用 search_memories 工具检索。'
  if (!lines) {
    return `${header}\n（暂无置顶/关键记忆）\n${hint}`
  }
  return `${header}\n${lines}\n${hint}`
}

/**
 * 记忆开关关闭时，隐藏与记忆绑定的工具所在分类（「对话记忆」4 个工具全部与
 * 「跨任务记忆」开关绑定，开关关闭时整类不可见）；开关开启时原样返回。
 * 运行时同样对这批工具强制 off，见 employee-agent.service 的 getEmployeeToolModes。
 */
export function hideMemoryBoundCategories<T extends { tool_ids: string[] }>(
  categories: T[],
  memoryEnabled: boolean
): T[] {
  if (memoryEnabled) return categories
  return categories.filter(cat => !cat.tool_ids.some(id => MEMORY_BOUND_TOOL_IDS.includes(id)))
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
