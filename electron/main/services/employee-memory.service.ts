import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import { generateId } from './common-utils'
import { createLogger } from './logger'

const logger = createLogger('Memory')

const MEMORY_MAX_CHARS = 3000
const MEMORY_MAX_COUNT = 50
const MEMORY_CONSOLIDATION_THRESHOLD = 0.8
const STALE_MEMORY_DAYS = 90
const CONSOLIDATION_COOLDOWN_SECONDS = 3600
const EXTRACTION_MAX_EXISTING_MEMORIES = 15
const EXTRACTION_USER_MIN_CHARS = 10
const CONSOLIDATION_CANDIDATE_MAX = 20

const TRIVIAL_PATTERNS = [
  /^(你好|hi|hello|hey|谢谢|感谢|好的|ok|嗯|是|否|对|不|行|可以|再见|拜)/i,
  /^(请继续|继续|还有吗|then\?|and\?)/i,
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

    const prompt = `Extract persistent facts from dialog, review existing memories, generate summary.

Rules:
- Extract: user preferences, decisions, stable facts (tech stack, background, rules)
- Skip: temp state, 7-day expiring info, already-known info, imperative sentences
- Review existing: identify contradicted/outdated memories

Context(summary|dialog|existing key|topic|content):
${contextParts.join('\n---\n')}

Output JSON:
{"memories":[{"key":"id","topic":"cat","content":"fact"}],"delete_keys":[],"update_memories":[{"key":"k","content":"c"}],"summary":"brief summary<200chars"}`

    try {
      const response = await this.llmClient.chat(
        providerId,
        [{ role: 'user', content: prompt }],
        {
          temperature: 0.1,
          max_tokens: 800,
          model: modelId,
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

    const prompt = `Consolidate memories. Rules: pinned(pin:1) no delete; manual source cautious delete; >${STALE_MEMORY_DAYS}d unreferenced+unpinned prioritize delete; merge overlapping; simplify verbose.

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
