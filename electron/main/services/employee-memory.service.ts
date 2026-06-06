import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import { generateId } from './common-utils'
import { createLogger } from './logger'

const logger = createLogger('Memory')

const MEMORY_MAX_CHARS = 8000
const MEMORY_MAX_COUNT = 50
const MEMORY_CONSOLIDATION_THRESHOLD = 0.8
const STALE_MEMORY_DAYS = 90
const CONSOLIDATION_COOLDOWN_SECONDS = 3600
const EXTRACTION_MAX_EXISTING_MEMORIES = 15
const EXTRACTION_USER_MIN_CHARS = 10
const CONSOLIDATION_CANDIDATE_MAX = 20

const TRIVIAL_PATTERNS = [
  /^(你好|hi|hello|hey|谢谢|感谢|好的|ok|嗯|是|否|对|不|行|可以|再见|拜)/i,
  /^(请继续|继续|还有吗|then\?|and\?|next|go on)/i,
  /^(这段代码|这个|这是什么|什么意思|怎么用|帮我看看|解释一下|帮我改)/i,
  /^(运行|执行|测试|编译|构建|部署|安装|启动|停止|重启)(一下|这个)?$/i,
  /^(报错|出错|error|错误|失败)了?/i,
]

export interface EmployeeMemory {
  id: string
  employee_id: string
  key: string
  topic: string
  content: string
  is_pinned: number
  source: 'auto' | 'manual'
  importance: 'critical' | 'normal' | 'low'
  created_at: number
  updated_at: number
  last_referenced_at: number | null
}

export interface MemoryCreateParams {
  employee_id: string
  key: string
  topic: string
  content: string
  is_pinned?: boolean
  source?: 'auto' | 'manual'
  importance?: 'critical' | 'normal' | 'low'
}

export interface MemoryUpdateParams {
  key?: string
  topic?: string
  content?: string
  is_pinned?: boolean
  importance?: 'critical' | 'normal' | 'low'
}

interface ExtractedMemory {
  key: string
  topic: string
  content: string
}

interface ExtractionResult {
  memories: ExtractedMemory[]
  delete_keys: string[]
  update_memories: Array<{ key: string; content: string; topic?: string }>
  summary: string
}

interface ConsolidationResult {
  delete_keys: string[]
  merge_groups: Array<{ keys: string[]; merged: ExtractedMemory }>
  simplify_updates: Array<{ key: string; content: string }>
  importance_updates: Array<{ key: string; importance: 'critical' | 'normal' | 'low' }>
}

interface MemoryStats {
  count: number
  totalChars: number
  pinnedCount: number
  autoCount: number
  manualCount: number
  oldestTimestamp: number | null
  staleCount: number
}

class EmployeeMemoryService {
  private db: DatabaseService
  private llmClient: LLMClientService
  private static instance: EmployeeMemoryService
  private lastConsolidationAt: Map<string, number> = new Map()

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
  }

  static getInstance(): EmployeeMemoryService {
    if (!EmployeeMemoryService.instance) {
      EmployeeMemoryService.instance = new EmployeeMemoryService()
    }
    return EmployeeMemoryService.instance
  }

  listMemories(employeeId: string): EmployeeMemory[] {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_memories WHERE employee_id = ? ORDER BY is_pinned DESC, updated_at DESC'
    ).all(employeeId) as EmployeeMemory[]
  }

  getMemory(id: string): EmployeeMemory | undefined {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_memories WHERE id = ?'
    ).get(id) as EmployeeMemory | undefined
  }

  createMemory(params: MemoryCreateParams): EmployeeMemory {
    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    this.db.getDb().prepare(
      `INSERT INTO employee_memories (id, employee_id, key, topic, content, is_pinned, source, importance, created_at, updated_at, last_referenced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.employee_id,
      params.key,
      params.topic,
      params.content,
      params.is_pinned ? 1 : 0,
      params.source || 'manual',
      params.importance || 'normal',
      now,
      now,
      now
    )
    return this.getMemory(id)!
  }

  updateMemory(id: string, params: MemoryUpdateParams): EmployeeMemory | undefined {
    const existing = this.getMemory(id)
    if (!existing) return undefined

    const sets: string[] = []
    const values: any[] = []

    if (params.key !== undefined) { sets.push('key = ?'); values.push(params.key) }
    if (params.topic !== undefined) { sets.push('topic = ?'); values.push(params.topic) }
    if (params.content !== undefined) { sets.push('content = ?'); values.push(params.content) }
    if (params.is_pinned !== undefined) { sets.push('is_pinned = ?'); values.push(params.is_pinned ? 1 : 0) }
    if (params.importance !== undefined) { sets.push('importance = ?'); values.push(params.importance) }

    if (sets.length === 0) return existing

    sets.push('updated_at = ?')
    values.push(Math.floor(Date.now() / 1000))
    values.push(id)

    this.db.getDb().prepare(
      `UPDATE employee_memories SET ${sets.join(', ')} WHERE id = ?`
    ).run(...values)

    return this.getMemory(id)
  }

  deleteMemory(id: string): boolean {
    const result = this.db.getDb().prepare('DELETE FROM employee_memories WHERE id = ?').run(id)
    return result.changes > 0
  }

  deleteMemoryByKey(employeeId: string, key: string): boolean {
    const result = this.db.getDb().prepare(
      'DELETE FROM employee_memories WHERE employee_id = ? AND key = ?'
    ).run(employeeId, key)
    return result.changes > 0
  }

  togglePin(id: string): EmployeeMemory | undefined {
    const existing = this.getMemory(id)
    if (!existing) return undefined
    const newPinned = existing.is_pinned ? 0 : 1
    this.db.getDb().prepare(
      'UPDATE employee_memories SET is_pinned = ?, updated_at = ? WHERE id = ?'
    ).run(newPinned, Math.floor(Date.now() / 1000), id)
    return this.getMemory(id)
  }

  touchMemory(id: string): void {
    this.db.getDb().prepare(
      'UPDATE employee_memories SET last_referenced_at = ? WHERE id = ?'
    ).run(Math.floor(Date.now() / 1000), id)
  }

  searchMemories(employeeId: string, query: string, limit: number = 10): EmployeeMemory[] {
    const pinned = this.db.getDb().prepare(
      'SELECT * FROM employee_memories WHERE employee_id = ? AND is_pinned = 1 ORDER BY updated_at DESC'
    ).all(employeeId) as EmployeeMemory[]

    const searchResults = this.db.getDb().prepare(
      `SELECT * FROM employee_memories
       WHERE employee_id = ? AND is_pinned = 0 AND (key LIKE ? OR topic LIKE ? OR content LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`
    ).all(
      employeeId,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      limit
    ) as EmployeeMemory[]

    return [...pinned, ...searchResults]
  }

  getRelevantMemories(employeeId: string, query: string, limit: number = 5): EmployeeMemory[] {
    const pinned = this.db.getDb().prepare(
      'SELECT * FROM employee_memories WHERE employee_id = ? AND is_pinned = 1 ORDER BY updated_at DESC'
    ).all(employeeId) as EmployeeMemory[]

    const relevant = this.db.getDb().prepare(
      `SELECT * FROM employee_memories
       WHERE employee_id = ? AND is_pinned = 0 AND (key LIKE ? OR topic LIKE ? OR content LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`
    ).all(
      employeeId,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      limit
    ) as EmployeeMemory[]

    return [...pinned, ...relevant]
  }

  getMemoryStats(employeeId: string): MemoryStats {
    const memories = this.listMemories(employeeId)
    const now = Math.floor(Date.now() / 1000)
    const staleThreshold = now - STALE_MEMORY_DAYS * 86400

    let totalChars = 0
    let pinnedCount = 0
    let autoCount = 0
    let manualCount = 0
    let oldestTimestamp: number | null = null
    let staleCount = 0

    for (const m of memories) {
      totalChars += m.content.length
      if (m.is_pinned) pinnedCount++
      if (m.source === 'auto') autoCount++
      if (m.source === 'manual') manualCount++
      if (!oldestTimestamp || m.created_at < oldestTimestamp) oldestTimestamp = m.created_at
      if (!m.is_pinned && m.last_referenced_at && m.last_referenced_at < staleThreshold) staleCount++
      if (!m.is_pinned && !m.last_referenced_at && m.created_at < staleThreshold) staleCount++
    }

    return {
      count: memories.length,
      totalChars,
      pinnedCount,
      autoCount,
      manualCount,
      oldestTimestamp,
      staleCount,
    }
  }

  needsConsolidation(employeeId: string): boolean {
    const stats = this.getMemoryStats(employeeId)
    if (stats.count > MEMORY_MAX_COUNT) return true
    if (stats.totalChars > MEMORY_MAX_CHARS * MEMORY_CONSOLIDATION_THRESHOLD) return true
    if (stats.staleCount > stats.count * 0.3) return true
    return false
  }

  formatMemoriesForPrompt(memories: EmployeeMemory[], maxChars?: number): string {
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
      if (maxChars && totalLen + line.length > limit && !m.is_pinned) break
      lines.push(line)
      totalLen += line.length + 1
    }
    return lines.join('\n')
  }

  getConversationSummary(conversationId: string): string {
    if (!conversationId) return ''
    const row = this.db.getDb().prepare(
      'SELECT summary FROM conversations WHERE id = ?'
    ).get(conversationId) as { summary: string } | undefined
    return row?.summary || ''
  }

  private isTrivialMessage(text: string): boolean {
    const trimmed = text.trim()
    if (trimmed.length < EXTRACTION_USER_MIN_CHARS) return true
    for (const pattern of TRIVIAL_PATTERNS) {
      if (pattern.test(trimmed)) return true
    }
    return false
  }

  private getExtractionRelevantMemories(
    employeeId: string,
    conversationText: string
  ): EmployeeMemory[] {
    const all = this.listMemories(employeeId)
    if (all.length <= EXTRACTION_MAX_EXISTING_MEMORIES) return all

    const keywords = conversationText
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2)
      .slice(0, 10)

    const scored = all.map(m => {
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

  async extractMemoriesFromConversation(
    employeeId: string,
    messages: Array<{ role: string; content: string }>,
    providerId: string,
    modelId?: string,
    conversationId?: string
  ): Promise<ExtractedMemory[]> {
    const lastPair = this.extractLastTurn(messages)
    if (!lastPair) return []

    if (this.isTrivialMessage(lastPair.user)) {
      logger.info(`Skipped trivial message for employee ${employeeId}`)
      return []
    }

    const conversationText = this.formatTurnForExtraction(lastPair)
    if (conversationText.length < 30) return []

    const summary = conversationId ? this.getConversationSummary(conversationId) : ''
    const relevantMemories = this.getExtractionRelevantMemories(employeeId, conversationText)
    const existingMemoriesText = relevantMemories.length > 0
      ? relevantMemories.map(m => `${m.key}|${m.topic}|${m.content}`).join('\n')
      : ''

    const contextParts: string[] = []
    if (summary) {
      contextParts.push(summary)
    }
    contextParts.push(conversationText)
    if (existingMemoriesText) {
      contextParts.push(existingMemoriesText)
    }

    const prompt = `你是全局记忆提取器。从对话中提取关于"用户自身"的持久信息，而非临时业务细节。如果对话中没有任何值得持久记录的内容，返回空结果。

## 需要提取的内容（用户长期特征）
① 用户个人信息：职业、行业、岗位、常用办公工具/平台、工作场景等固定信息。
② 用户长期偏好：写作风格、文档格式要求、汇报偏好、沟通风格、工作节奏、审批习惯等办公场景下长期稳定的偏好。
③ 硬性禁忌/约束：用户明确表示"不要"/"禁止"的做法、工作流程限制、合规要求等不可违背的规则。
④ 用户自定义回答规则：用户要求助手始终遵守的回复格式、语气、风格等行为规范。
⑤ 确定落地的长期计划/关键方案：用户已确认并执行的长期工作计划、关键业务方案或工作决策。
⑥ 踩坑经验：办公工具/流程执行失败的原因及最终解决方案，下次可用以避免重复踩坑。

## 不提取的内容（临时对话噪声）
✗ 临时闲聊：问候、道谢、闲谈等无长期价值的内容。
✗ 一次性临时提问：仅当前上下文有效的临时问题（如"这个数据怎么填"、"帮我查一下这个信息"）。
✗ 随口临时想法：用户随口说的、未确认的想法或计划。
✗ 临时业务细节：只在当前对话中有意义的业务数据、临时配置、一次性操作等。
✗ 可推导的通用知识：LLM 本身已具备的通用办公知识。
✗ 已在现有记忆中存在且未变化的信息。

## 审查现有记忆
- 如果新信息与已有记忆矛盾，将过时的 key 加入 delete_keys。
- 如果新信息是对已有记忆的补充/更新，将更新后的内容加入 update_memories。

## 重要原则
- 宁缺毋滥：不确定是否值得长期保存的内容，不要提取。
- 允许空结果：如果对话没有任何值得持久记录的内容，返回空的 memories 数组。
- key 需短小唯一，如 "writing_style"、"report_format"、"no_ppt_animation"、"excel_pitfall"。
- content 需简洁具体，1-2句话即可。
- summary 用简短中文概括本轮对话要点（不超过200字）。

上下文（摘要|对话|现有记忆 key|topic|content）：
${contextParts.join('\n---\n')}

输出 JSON：
{"memories":[{"key":"唯一标识","topic":"分类标签","content":"具体事实"}],"delete_keys":["待删key"],"update_memories":[{"key":"key","content":"更新后内容","topic":"可选新topic"}],"summary":"对话摘要（中文，<200字）"}`

    try {
      const response = await this.llmClient.chat(
        providerId,
        [{ role: 'user', content: prompt }],
        {
          temperature: 0.1,
          max_tokens: 800,
          model: modelId,
          logSource: 'memory_extract',
        }
      )

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return []

      const parsed = JSON.parse(jsonMatch[0]) as ExtractionResult

      const validExtracted = (parsed.memories || []).filter(m => m.key && m.topic && m.content)

      for (const memory of validExtracted) {
        const existing = this.db.getDb().prepare(
          'SELECT * FROM employee_memories WHERE employee_id = ? AND key = ?'
        ).get(employeeId, memory.key) as EmployeeMemory | undefined

        if (existing) {
          this.db.getDb().prepare(
            'UPDATE employee_memories SET content = ?, topic = ?, updated_at = ?, last_referenced_at = ? WHERE id = ?'
          ).run(memory.content, memory.topic, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), existing.id)
        } else {
          this.createMemory({
            employee_id: employeeId,
            key: memory.key,
            topic: memory.topic,
            content: memory.content,
            source: 'auto',
          })
        }
      }

      for (const key of (parsed.delete_keys || [])) {
        this.deleteMemoryByKey(employeeId, key)
        logger.info(`Deleted outdated memory key=${key} for employee ${employeeId}`)
      }

      for (const update of (parsed.update_memories || [])) {
        if (!update.key || !update.content) continue
        const existing = this.db.getDb().prepare(
          'SELECT * FROM employee_memories WHERE employee_id = ? AND key = ?'
        ).get(employeeId, update.key) as EmployeeMemory | undefined
        if (existing) {
          const topic = update.topic || existing.topic
          this.db.getDb().prepare(
            'UPDATE employee_memories SET content = ?, topic = ?, updated_at = ?, last_referenced_at = ? WHERE id = ?'
          ).run(update.content, topic, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), existing.id)
          logger.info(`Updated memory key=${update.key} for employee ${employeeId}`)
        }
      }

      logger.info(`Extracted ${validExtracted.length} memories, deleted ${(parsed.delete_keys || []).length}, updated ${(parsed.update_memories || []).length} for employee ${employeeId}`)

      if (conversationId && parsed.summary) {
        const newSummary = parsed.summary.trim().substring(0, 500)
        if (newSummary) {
          this.db.getDb().prepare(
            'UPDATE conversations SET summary = ?, updated_at = ? WHERE id = ?'
          ).run(newSummary, Math.floor(Date.now() / 1000), conversationId)
        }
      }

      return validExtracted
    } catch (error: any) {
      logger.error(`Memory extraction failed: ${error.message}`)
      return []
    }
  }

  private getConsolidationCandidates(employeeId: string): EmployeeMemory[] {
    const all = this.listMemories(employeeId)
    if (all.length <= CONSOLIDATION_CANDIDATE_MAX) return all

    const now = Math.floor(Date.now() / 1000)
    const recentThreshold = now - 30 * 86400

    const candidates: EmployeeMemory[] = []
    const pinned: EmployeeMemory[] = []
    const recent: EmployeeMemory[] = []
    const old: EmployeeMemory[] = []

    for (const m of all) {
      if (m.is_pinned) {
        pinned.push(m)
      } else if (m.updated_at > recentThreshold || m.importance === 'critical') {
        recent.push(m)
      } else {
        old.push(m)
      }
    }

    candidates.push(...pinned)
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

  async consolidateMemories(
    employeeId: string,
    providerId: string,
    modelId?: string
  ): Promise<{ deleted: number; merged: number; simplified: number }> {
    const candidates = this.getConsolidationCandidates(employeeId)
    if (candidates.length < 2) return { deleted: 0, merged: 0, simplified: 0 }

    const now = Math.floor(Date.now() / 1000)

    const memoriesText = candidates.map(m => {
      const daysSinceUpdate = Math.floor((now - m.updated_at) / 86400)
      const refDays = m.last_referenced_at
        ? Math.floor((now - m.last_referenced_at) / 86400)
        : -1
      return `${m.key}|${m.topic}|${m.content}|${m.importance}|${daysSinceUpdate}d|ref:${refDays}d|${m.source}|pin:${m.is_pinned}`
    }).join('\n')

    const prompt = `你是全局记忆合并整理器。对用户记忆进行去重、合并和清理，保持记忆库精简有用。

## 规则
- pinned(pin:1) 标记的记忆不允许删除。
- manual source 的记忆谨慎删除，除非明确过时。
- >${STALE_MEMORY_DAYS}天未引用且非 pinned 的记忆优先删除。
- 合并内容重叠/高度相似的记忆为一条。
- 简化冗余啰嗦的内容，保持简洁。
- 重要性评估：critical=核心用户特征/硬性约束/关键踩坑；normal=常规偏好/计划；low=次要信息。
- 优先保留关于用户自身特征、偏好、踩坑经验的记忆，清理纯临时业务细节的记忆。

${memoriesText}

JSON: {"delete_keys":[],"merge_groups":[{"keys":[],"merged":{"key":"","topic":"","content":""}}],"simplify_updates":[{"key":"","content":""}],"importance_updates":[{"key":"","importance":"critical|normal|low"}]}`

    try {
      const response = await this.llmClient.chat(
        providerId,
        [{ role: 'user', content: prompt }],
        {
          temperature: 0.1,
          max_tokens: 1200,
          model: modelId,
          logSource: 'memory_consolidate',
        }
      )

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return { deleted: 0, merged: 0, simplified: 0 }

      const parsed = JSON.parse(jsonMatch[0]) as ConsolidationResult

      let deleted = 0
      let merged = 0
      let simplified = 0

      for (const key of (parsed.delete_keys || [])) {
        if (this.deleteMemoryByKey(employeeId, key)) deleted++
      }

      for (const group of (parsed.merge_groups || [])) {
        if (!group.keys || group.keys.length < 2 || !group.merged) continue
        const hasPinned = candidates.some(m => group.keys.includes(m.key) && m.is_pinned)
        this.createMemory({
          employee_id: employeeId,
          key: group.merged.key,
          topic: group.merged.topic,
          content: group.merged.content,
          source: 'auto',
          is_pinned: hasPinned,
        })
        for (const key of group.keys) {
          const mem = candidates.find(m => m.key === key)
          if (mem && !mem.is_pinned) {
            this.deleteMemoryByKey(employeeId, key)
          } else if (mem && mem.is_pinned) {
            this.db.getDb().prepare(
              'UPDATE employee_memories SET is_pinned = 0, updated_at = ? WHERE id = ?'
            ).run(Math.floor(Date.now() / 1000), mem.id)
          }
        }
        merged++
      }

      for (const update of (parsed.simplify_updates || [])) {
        if (!update.key || !update.content) continue
        const existing = candidates.find(m => m.key === update.key)
        if (existing && existing.content !== update.content) {
          this.db.getDb().prepare(
            'UPDATE employee_memories SET content = ?, updated_at = ? WHERE id = ?'
          ).run(update.content, Math.floor(Date.now() / 1000), existing.id)
          simplified++
        }
      }

      for (const update of (parsed.importance_updates || [])) {
        if (!update.key || !update.importance) continue
        const existing = candidates.find(m => m.key === update.key)
        if (existing) {
          this.db.getDb().prepare(
            'UPDATE employee_memories SET importance = ?, updated_at = ? WHERE id = ?'
          ).run(update.importance, Math.floor(Date.now() / 1000), existing.id)
        }
      }

      this.lastConsolidationAt.set(employeeId, Math.floor(Date.now() / 1000))
      logger.info(`Consolidated memories for employee ${employeeId}: deleted=${deleted}, merged=${merged}, simplified=${simplified}`)
      return { deleted, merged, simplified }
    } catch (error: any) {
      logger.error(`Memory consolidation failed: ${error.message}`)
      return { deleted: 0, merged: 0, simplified: 0 }
    }
  }

  async autoConsolidateIfNeeded(
    employeeId: string,
    providerId: string,
    modelId?: string
  ): Promise<{ deleted: number; merged: number; simplified: number } | null> {
    if (!this.needsConsolidation(employeeId)) return null

    const lastTime = this.lastConsolidationAt.get(employeeId) || 0
    const elapsed = Math.floor(Date.now() / 1000) - lastTime
    if (elapsed < CONSOLIDATION_COOLDOWN_SECONDS) {
      logger.info(`Consolidation cooldown for employee ${employeeId}, ${CONSOLIDATION_COOLDOWN_SECONDS - elapsed}s remaining`)
      return null
    }

    logger.info(`Auto-consolidation triggered for employee ${employeeId}`)
    return this.consolidateMemories(employeeId, providerId, modelId)
  }

  removeStaleMemories(employeeId: string): number {
    const now = Math.floor(Date.now() / 1000)
    const staleThreshold = now - STALE_MEMORY_DAYS * 86400

    const result = this.db.getDb().prepare(
      `DELETE FROM employee_memories
       WHERE employee_id = ? AND is_pinned = 0 AND importance = 'low'
       AND ((last_referenced_at IS NOT NULL AND last_referenced_at < ?)
            OR (last_referenced_at IS NULL AND created_at < ?))`
    ).run(employeeId, staleThreshold, staleThreshold)

    if (result.changes > 0) {
      logger.info(`Removed ${result.changes} stale memories for employee ${employeeId}`)
    }
    return result.changes
  }

  private extractLastTurn(messages: Array<{ role: string; content: string }>): { user: string; assistant: string } | null {
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

  private formatTurnForExtraction(turn: { user: string; assistant: string }): string {
    const maxLen = 600
    const truncate = (s: string) => s.length > maxLen ? s.substring(0, maxLen) + '...' : s
    return `用户: ${truncate(turn.user)}\n助手: ${truncate(turn.assistant)}`
  }

  async generateLLMSummary(
    messages: Array<{ role: string; content: string }>,
    providerId: string,
    modelId?: string
  ): Promise<string> {
    const conversationText = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
      .join('\n')

    if (conversationText.length < 30) {
      return this.generateFallbackSummary(messages)
    }

    const prompt = `请对以下对话历史生成结构化摘要，保留语义完整性。按以下格式输出：

主题：（用一句话概括对话主题）
要点：
- （列出3-5个关键讨论点）
结论：（如有明确结论则写出，否则写"无明确结论"）

对话内容：
${conversationText}`

    try {
      const response = await this.llmClient.chat(
        providerId,
        [{ role: 'user', content: prompt }],
        {
          temperature: 0.1,
          max_tokens: 1000,
          model: modelId,
          logSource: 'memory_summary',
        }
      )

      return response || this.generateFallbackSummary(messages)
    } catch (error: any) {
      logger.error(`LLM summary generation failed: ${error.message}`)
      return this.generateFallbackSummary(messages)
    }
  }

  private generateFallbackSummary(messages: Array<{ role: string; content: string }>): string {
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
}

export default EmployeeMemoryService
