import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import { generateId } from './common-utils'
import { createLogger } from './logger'
import {
  type EmployeeMemory,
  type EmployeeMemoryCreateParams,
  type EmployeeMemoryUpdateData,
  type ExtractedMemory,
  type ExtractionResult,
  type ConsolidationResult,
  type MemoryStats,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_COUNT,
  MEMORY_CONSOLIDATION_THRESHOLD,
  STALE_MEMORY_DAYS,
  CONSOLIDATION_COOLDOWN_SECONDS,
} from './employee-memory-types'
import {
  buildExtractionPrompt,
  buildConsolidationPrompt,
  buildSummaryPrompt,
} from './employee-memory-prompts'
import {
  buildFtsQuery,
  isTrivialMessage,
  extractLastTurn,
  formatTurnForExtraction,
  formatMemoriesForPrompt,
  getExtractionRelevantMemories,
  getConsolidationCandidates,
  generateFallbackSummary,
} from './employee-memory-helpers'

const logger = createLogger('Memory')

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

  createMemory(params: EmployeeMemoryCreateParams): EmployeeMemory {
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
    this.syncMemoryFTS(id, params.employee_id, params.key, params.topic, params.content)
    return this.getMemory(id)!
  }

  updateMemory(id: string, params: EmployeeMemoryUpdateData): EmployeeMemory | undefined {
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

    if (params.key !== undefined || params.topic !== undefined || params.content !== undefined) {
      const updated = this.getMemory(id)!
      this.syncMemoryFTS(id, updated.employee_id, updated.key, updated.topic, updated.content)
    }

    return this.getMemory(id)
  }

  private syncMemoryFTS(id: string, employeeId: string, key: string, topic: string, content: string): void {
    this.db.getDb().prepare('DELETE FROM employee_memories_fts WHERE memory_id = ?').run(id)
    this.db.getDb().prepare(
      'INSERT INTO employee_memories_fts (key, topic, content, memory_id, employee_id) VALUES (?, ?, ?, ?, ?)'
    ).run(key, topic, content, id, employeeId)
  }

  deleteMemory(id: string): boolean {
    this.db.getDb().prepare('DELETE FROM employee_memories_fts WHERE memory_id = ?').run(id)
    const result = this.db.getDb().prepare('DELETE FROM employee_memories WHERE id = ?').run(id)
    return result.changes > 0
  }

  deleteMemoryByKey(employeeId: string, key: string): boolean {
    const ids = this.db.getDb().prepare(
      'SELECT id FROM employee_memories WHERE employee_id = ? AND key = ?'
    ).all(employeeId, key) as Array<{ id: string }>
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',')
      this.db.getDb().prepare(`DELETE FROM employee_memories_fts WHERE memory_id IN (${placeholders})`).run(...ids.map(i => i.id))
    }
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
    return this.queryMemories(employeeId, query, limit)
  }

  getRelevantMemories(employeeId: string, query: string, limit: number = 5): EmployeeMemory[] {
    return this.queryMemories(employeeId, query, limit)
  }

  private queryMemories(employeeId: string, query: string, limit: number): EmployeeMemory[] {
    const pinned = this.db.getDb().prepare(
      'SELECT * FROM employee_memories WHERE employee_id = ? AND is_pinned = 1 ORDER BY updated_at DESC'
    ).all(employeeId) as EmployeeMemory[]

    const ftsQuery = buildFtsQuery(query)
    const searchResults = ftsQuery
      ? (this.db.getDb().prepare(
          `SELECT m.* FROM employee_memories m
           JOIN employee_memories_fts f ON f.memory_id = m.id
           WHERE f.employee_id = ? AND m.is_pinned = 0 AND employee_memories_fts MATCH ?
           ORDER BY f.rank LIMIT ?`
        ).all(employeeId, ftsQuery, limit) as EmployeeMemory[])
      : []

    return [...pinned, ...searchResults]
  }

  getMemoryStats(employeeId: string): MemoryStats {
    const now = Math.floor(Date.now() / 1000)
    const staleThreshold = now - STALE_MEMORY_DAYS * 86400

    const row = this.db.getDb().prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(LENGTH(content)), 0) as totalChars,
        SUM(CASE WHEN is_pinned = 1 THEN 1 ELSE 0 END) as pinnedCount,
        SUM(CASE WHEN source = 'auto' THEN 1 ELSE 0 END) as autoCount,
        SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) as manualCount,
        MIN(created_at) as oldestTimestamp,
        SUM(CASE WHEN is_pinned = 0 AND (
          (last_referenced_at IS NOT NULL AND last_referenced_at < ?) OR
          (last_referenced_at IS NULL AND created_at < ?)
        ) THEN 1 ELSE 0 END) as staleCount
      FROM employee_memories WHERE employee_id = ?
    `).get(staleThreshold, staleThreshold, employeeId) as any

    return {
      count: row?.count ?? 0,
      totalChars: row?.totalChars ?? 0,
      pinnedCount: row?.pinnedCount ?? 0,
      autoCount: row?.autoCount ?? 0,
      manualCount: row?.manualCount ?? 0,
      oldestTimestamp: row?.oldestTimestamp ?? null,
      staleCount: row?.staleCount ?? 0,
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
    return formatMemoriesForPrompt(memories, maxChars)
  }

  getConversationSummary(conversationId: string): string {
    if (!conversationId) return ''
    const row = this.db.getDb().prepare(
      'SELECT summary FROM conversations WHERE id = ?'
    ).get(conversationId) as { summary: string } | undefined
    return row?.summary || ''
  }

  async extractMemoriesFromConversation(
    employeeId: string,
    messages: Array<{ role: string; content: string }>,
    providerId: string,
    modelId?: string,
    conversationId?: string
  ): Promise<ExtractedMemory[]> {
    const lastPair = extractLastTurn(messages)
    if (!lastPair) return []

    if (isTrivialMessage(lastPair.user)) {
      logger.info(`Skipped trivial message for employee ${employeeId}`)
      return []
    }

    const conversationText = formatTurnForExtraction(lastPair)
    if (conversationText.length < 30) return []

    const summary = conversationId ? this.getConversationSummary(conversationId) : ''
    const relevantMemories = getExtractionRelevantMemories(this.listMemories(employeeId), conversationText)
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

    const prompt = buildExtractionPrompt(contextParts)

    try {
      const response = await this.llmClient.chat(
        providerId,
        [{ role: 'user', content: prompt }],
        {
          temperature: 0.7,
          max_tokens: 800,
          model: modelId,
          logSource: 'memory_extract',
        }
      )

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return []

      const parsed = JSON.parse(jsonMatch[0]) as ExtractionResult

      const validExtracted = (parsed.memories || []).filter(m => m.key && m.topic && m.content)

      this.db.getDb().transaction(() => {
        const now = Math.floor(Date.now() / 1000)
        const allNewKeys = validExtracted.map(m => m.key)
        const existingMap = new Map<string, EmployeeMemory>()
        if (allNewKeys.length > 0) {
          const keyPlaceholders = allNewKeys.map(() => '?').join(',')
          const existingRows = this.db.getDb().prepare(
            `SELECT * FROM employee_memories WHERE employee_id = ? AND key IN (${keyPlaceholders})`
          ).all(employeeId, ...allNewKeys) as EmployeeMemory[]
          for (const row of existingRows) {
            existingMap.set(row.key, row)
          }
        }

        for (const memory of validExtracted) {
          const existing = existingMap.get(memory.key)

          if (existing) {
            this.db.getDb().prepare(
              'UPDATE employee_memories SET content = ?, topic = ?, updated_at = ?, last_referenced_at = ? WHERE id = ?'
            ).run(memory.content, memory.topic, now, now, existing.id)
            this.syncMemoryFTS(existing.id, employeeId, existing.key, memory.topic, memory.content)
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

        const allUpdateKeys = (parsed.update_memories || []).map(u => u.key).filter(Boolean)
        const updateExistingMap = new Map<string, EmployeeMemory>()
        if (allUpdateKeys.length > 0) {
          const upPlaceholders = allUpdateKeys.map(() => '?').join(',')
          const upRows = this.db.getDb().prepare(
            `SELECT * FROM employee_memories WHERE employee_id = ? AND key IN (${upPlaceholders})`
          ).all(employeeId, ...allUpdateKeys) as EmployeeMemory[]
          for (const row of upRows) {
            updateExistingMap.set(row.key, row)
          }
        }

        for (const update of (parsed.update_memories || [])) {
          if (!update.key || !update.content) continue
          const existing = updateExistingMap.get(update.key)
          if (existing) {
            const topic = update.topic || existing.topic
            this.db.getDb().prepare(
              'UPDATE employee_memories SET content = ?, topic = ?, updated_at = ?, last_referenced_at = ? WHERE id = ?'
            ).run(update.content, topic, now, now, existing.id)
            this.syncMemoryFTS(existing.id, employeeId, existing.key, topic, update.content)
            logger.info(`Updated memory key=${update.key} for employee ${employeeId}`)
          }
        }

        if (conversationId && parsed.summary) {
          const newSummary = parsed.summary.trim().substring(0, 500)
          if (newSummary) {
            this.db.getDb().prepare(
              'UPDATE conversations SET summary = ?, updated_at = ? WHERE id = ?'
            ).run(newSummary, now, conversationId)
          }
        }
      })()

      logger.info(`Extracted ${validExtracted.length} memories, deleted ${(parsed.delete_keys || []).length}, updated ${(parsed.update_memories || []).length} for employee ${employeeId}`)

      return validExtracted
    } catch (error: any) {
      logger.error(`Memory extraction failed: ${error.message}`)
      return []
    }
  }

  async consolidateMemories(
    employeeId: string,
    providerId: string,
    modelId?: string
  ): Promise<{ deleted: number; merged: number; simplified: number }> {
    const candidates = getConsolidationCandidates(this.listMemories(employeeId))
    if (candidates.length < 2) return { deleted: 0, merged: 0, simplified: 0 }

    const now = Math.floor(Date.now() / 1000)

    const memoriesText = candidates.map(m => {
      const daysSinceUpdate = Math.floor((now - m.updated_at) / 86400)
      const refDays = m.last_referenced_at
        ? Math.floor((now - m.last_referenced_at) / 86400)
        : -1
      return `${m.key}|${m.topic}|${m.content}|${m.importance}|${daysSinceUpdate}d|ref:${refDays}d|${m.source}|pin:${m.is_pinned}`
    }).join('\n')

    const prompt = buildConsolidationPrompt(memoriesText)

    try {
      const response = await this.llmClient.chat(
        providerId,
        [{ role: 'user', content: prompt }],
        {
          temperature: 0.7,
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

      this.db.getDb().transaction(() => {
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
            this.syncMemoryFTS(existing.id, employeeId, existing.key, existing.topic, update.content)
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
      })()

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

    const staleIds = this.db.getDb().prepare(
      `SELECT id FROM employee_memories
       WHERE employee_id = ? AND is_pinned = 0 AND importance = 'low'
       AND ((last_referenced_at IS NOT NULL AND last_referenced_at < ?)
            OR (last_referenced_at IS NULL AND created_at < ?))`
    ).all(employeeId, staleThreshold, staleThreshold) as Array<{ id: string }>

    if (staleIds.length === 0) return 0

    const placeholders = staleIds.map(() => '?').join(',')
    this.db.getDb().prepare(`DELETE FROM employee_memories_fts WHERE memory_id IN (${placeholders})`).run(...staleIds.map(i => i.id))
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
      return generateFallbackSummary(messages)
    }

    const prompt = buildSummaryPrompt(conversationText)

    try {
      const response = await this.llmClient.chat(
        providerId,
        [{ role: 'user', content: prompt }],
        {
          temperature: 0.7,
          max_tokens: 1000,
          model: modelId,
          logSource: 'memory_summary',
        }
      )

      return response || generateFallbackSummary(messages)
    } catch (error: any) {
      logger.error(`LLM summary generation failed: ${error.message}`)
      return generateFallbackSummary(messages)
    }
  }
}

export default EmployeeMemoryService
