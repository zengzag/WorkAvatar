import DatabaseService from './database.service'
import { createPiProvider } from './agent/llm/pi-provider-factory'
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
  type MemoryScope,
  type MemoryBucket,
  MEMORY_SCOPE_EMPLOYEE,
  MEMORY_SCOPE_GLOBAL,
  isGlobalScope,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_COUNT,
  MEMORY_CONTENT_MAX_CHARS,
  MEMORY_CONSOLIDATION_THRESHOLD,
  STALE_MEMORY_DAYS,
  CONSOLIDATION_COOLDOWN_SECONDS,
  MEMORY_SEARCH_DEFAULT_LIMIT,
  MEMORY_SEARCH_MAX_LIMIT,
  MEMORY_SEARCH_SCORE_FLOOR,
  MEMORY_ALWAYS_ON_MAX_COUNT,
} from './employee-memory-types'
import { buildExtractionPrompt, buildConsolidationPrompt } from './employee-memory-prompts'
import { parseJSON } from './llm-json-parser'
import {
  formatContentOnlyMessages,
  getExtractionRelevantMemories,
  getConsolidationCandidates,
  applyScoreFloor,
  selectAlwaysOnMemories,
  buildMemoryPromptBlock,
} from './employee-memory-helpers'
import { segmentMemoryText, buildMemoryFtsMatch } from './employee-memory-fts'

const logger = createLogger('Memory')

/** 检索候选过取倍数：先多取再按相对分数下限裁剪，避免噪声挤掉真实命中 */
const SEARCH_OVERFETCH_FACTOR = 3
const SEARCH_OVERFETCH_CAP = 50

/** 截断单条 content，超长时按句号/逗号优先在最近的标点处断开，保持语义完整 */
function clampContent(text: string, max: number = MEMORY_CONTENT_MAX_CHARS): string {
  const t = (text || '').trim()
  if (t.length <= max) return t
  const cut = t.substring(0, max)
  for (const sep of ['。', '，', '；', '.', ',', ';', ' ']) {
    const idx = cut.lastIndexOf(sep)
    if (idx > max / 2) return cut.substring(0, idx)
  }
  return cut
}

interface ScoredMemory {
  memory: EmployeeMemory
  score: number
}

class EmployeeMemoryService {
  private db: DatabaseService
  private static instance: EmployeeMemoryService
  private lastConsolidationAt: Map<string, number> = new Map()
  /**
   * 记忆数据集版本号：任何写操作（增删改/提取/整理/过期清理）都会递增。
   * agent 侧据此判断常驻记忆块是否需要刷新，避免每轮都重算（见 employee-agent.service）。
   */
  private revision = 0

  private constructor() {
    this.db = DatabaseService.getInstance()
  }

  static getInstance(): EmployeeMemoryService {
    if (!EmployeeMemoryService.instance) {
      EmployeeMemoryService.instance = new EmployeeMemoryService()
    }
    return EmployeeMemoryService.instance
  }

  /** 记忆数据集版本号（单调递增，仅进程内有效） */
  getRevision(): number {
    return this.revision
  }

  private markChanged(): void {
    this.revision += 1
  }

  /** 统一 LLM 调用入口（提取/整合共用）
   *  sessionId 用于上游会话路由：记忆任务使用独立命名空间，不占用用户对话会话，
   *  避免服务端会话记录错乱与 KV cache 互相失效。
   */
  private async llmChat(
    providerId: string,
    modelId: string | undefined,
    prompt: string,
    options: { maxTokens: number; logSource: string; sessionId?: string },
  ): Promise<string> {
    const provider = await createPiProvider(providerId, modelId)
    if (!provider) throw new Error('LLM Provider not found')
    const response = await provider.chat(
      [{ role: 'user', content: prompt }],
      [],
      { temperature: 0.7, maxTokens: options.maxTokens, logSource: options.logSource, sessionId: options.sessionId },
    )
    return response.content
  }

  /** 将记忆桶转换为 SQL 归属条件（同时给出 employee 作用域的双重约束，防止越界读写） */
  private ownerClause(bucket: MemoryBucket): { sql: string; params: any[] } {
    if (isGlobalScope(bucket.scope)) {
      return { sql: `scope = ?`, params: [MEMORY_SCOPE_GLOBAL] }
    }
    return { sql: `scope = ? AND employee_id = ?`, params: [MEMORY_SCOPE_EMPLOYEE, bucket.employeeId ?? ''] }
  }

  // ---------------------------------------------------------------- 读取

  /** 列出某员工的员工作用域记忆（UI / 插件数据访问视角） */
  listMemories(employeeId: string): EmployeeMemory[] {
    return this.db.getDb().prepare(
      `SELECT * FROM employee_memories
       WHERE scope = ? AND employee_id = ? AND deleted_at IS NULL
       ORDER BY is_pinned DESC, updated_at DESC`
    ).all(MEMORY_SCOPE_EMPLOYEE, employeeId) as EmployeeMemory[]
  }

  /** 列出全局作用域记忆（跨员工共享） */
  listGlobalMemories(): EmployeeMemory[] {
    return this.db.getDb().prepare(
      `SELECT * FROM employee_memories
       WHERE scope = ? AND deleted_at IS NULL
       ORDER BY is_pinned DESC, updated_at DESC`
    ).all(MEMORY_SCOPE_GLOBAL) as EmployeeMemory[]
  }

  /** 列出注入给某个 agent 的全部生效记忆（员工作用域 + 全局作用域） */
  listMemoriesForInjection(employeeId: string): EmployeeMemory[] {
    return this.db.getDb().prepare(
      `SELECT * FROM employee_memories
       WHERE deleted_at IS NULL AND (
         (scope = ? AND employee_id = ?) OR scope = ?
       )
       ORDER BY is_pinned DESC, updated_at DESC`
    ).all(MEMORY_SCOPE_EMPLOYEE, employeeId, MEMORY_SCOPE_GLOBAL) as EmployeeMemory[]
  }

  /**
   * 构建注入到任务上下文的常驻记忆块：
   * 仅置顶 + 关键记忆入 prompt，其余交给 search_memories 工具按需检索。
   */
  buildInjectionMemoryPrompt(employeeId: string): string | undefined {
    const memories = this.listMemoriesForInjection(employeeId)
    const alwaysOn = selectAlwaysOnMemories(memories, { maxCount: MEMORY_ALWAYS_ON_MAX_COUNT })
    const block = buildMemoryPromptBlock(alwaysOn, memories.length)
    return block || undefined
  }

  getMemory(id: string): EmployeeMemory | undefined {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_memories WHERE id = ?'
    ).get(id) as EmployeeMemory | undefined
  }

  // ---------------------------------------------------------------- 写入

  createMemory(params: EmployeeMemoryCreateParams & { scope?: MemoryScope }): EmployeeMemory {
    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    const content = clampContent(params.content)
    const scope: MemoryScope = isGlobalScope(params.scope) ? MEMORY_SCOPE_GLOBAL : MEMORY_SCOPE_EMPLOYEE
    const employeeId = scope === MEMORY_SCOPE_GLOBAL ? null : (params.employee_id ?? '')
    this.db.getDb().prepare(
      `INSERT INTO employee_memories (id, employee_id, scope, key, topic, content, is_pinned, source, importance, created_at, updated_at, last_referenced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      employeeId,
      scope,
      params.key,
      params.topic,
      content,
      params.is_pinned ? 1 : 0,
      params.source || 'manual',
      params.importance || 'normal',
      now,
      now,
      now
    )
    this.syncMemoryFTS(id, employeeId, params.key, params.topic, content)
    this.markChanged()
    return this.getMemory(id)!
  }

  updateMemory(id: string, params: EmployeeMemoryUpdateData): EmployeeMemory | undefined {
    const existing = this.getMemory(id)
    if (!existing || existing.deleted_at) return undefined

    const sets: string[] = []
    const values: any[] = []

    if (params.key !== undefined) { sets.push('key = ?'); values.push(params.key) }
    if (params.topic !== undefined) { sets.push('topic = ?'); values.push(params.topic) }
    if (params.content !== undefined) { sets.push('content = ?'); values.push(clampContent(params.content)) }
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
    this.markChanged()

    return this.getMemory(id)
  }

  /** 同步 FTS 索引：索引侧使用 jieba 预分词（中文必需，否则整段中文会被 unicode61 视作单个 token） */
  private syncMemoryFTS(id: string, employeeId: string | null, key: string, topic: string, content: string): void {
    this.db.getDb().prepare('DELETE FROM employee_memories_fts WHERE memory_id = ?').run(id)
    this.db.getDb().prepare(
      'INSERT INTO employee_memories_fts (key, topic, content, memory_id, employee_id) VALUES (?, ?, ?, ?, ?)'
    ).run(
      segmentMemoryText(key),
      segmentMemoryText(topic),
      segmentMemoryText(content),
      id,
      employeeId ?? ''
    )
  }

  deleteMemory(id: string): boolean {
    // 软删除：移入回收站，保留记录便于恢复
    this.db.getDb().prepare('DELETE FROM employee_memories_fts WHERE memory_id = ?').run(id)
    const result = this.db.getDb().prepare(
      'UPDATE employee_memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'
    ).run(Math.floor(Date.now() / 1000), id)
    if (result.changes > 0) this.markChanged()
    return result.changes > 0
  }

  deleteMemoryByKey(bucket: MemoryBucket, key: string): boolean {
    const owner = this.ownerClause(bucket)
    // 软删除：仅标记 deleted_at，不物理删除
    const ids = this.db.getDb().prepare(
      `SELECT id FROM employee_memories WHERE ${owner.sql} AND key = ? AND deleted_at IS NULL`
    ).all(...owner.params, key) as Array<{ id: string }>
    if (ids.length === 0) return false
    const placeholders = ids.map(() => '?').join(',')
    this.db.getDb().prepare(`DELETE FROM employee_memories_fts WHERE memory_id IN (${placeholders})`).run(...ids.map(i => i.id))
    const result = this.db.getDb().prepare(
      `UPDATE employee_memories SET deleted_at = ? WHERE ${owner.sql} AND key = ? AND deleted_at IS NULL`
    ).run(Math.floor(Date.now() / 1000), ...owner.params, key)
    if (result.changes > 0) this.markChanged()
    return result.changes > 0
  }

  togglePin(id: string): EmployeeMemory | undefined {
    const existing = this.getMemory(id)
    if (!existing || existing.deleted_at) return undefined
    const newPinned = existing.is_pinned ? 0 : 1
    this.db.getDb().prepare(
      'UPDATE employee_memories SET is_pinned = ?, updated_at = ? WHERE id = ?'
    ).run(newPinned, Math.floor(Date.now() / 1000), id)
    this.markChanged()
    return this.getMemory(id)
  }

  /** 批量刷新"最近被引用"时间：检索命中时调用，使过期清理反映真实使用情况 */
  touchMemories(ids: string[]): void {
    const unique = Array.from(new Set(ids.filter(Boolean)))
    if (unique.length === 0) return
    const now = Math.floor(Date.now() / 1000)
    const stmt = this.db.getDb().prepare('UPDATE employee_memories SET last_referenced_at = ? WHERE id = ?')
    const tx = this.db.getDb().transaction(() => {
      for (const id of unique) stmt.run(now, id)
    })
    tx()
  }

  // ---------------------------------------------------------------- 检索

  /**
   * 指定作用域内的检索（UI / 插件视角）：置顶优先展示，随后按相关度排序的非置顶命中。
   * 不刷新 last_referenced_at（检索行为发生在 UI 浏览场景，不代表记忆被 agent 实际使用）。
   */
  searchScopeMemories(bucket: MemoryBucket, query: string, limit: number = 10): EmployeeMemory[] {
    const owner = this.ownerClause(bucket)
    const pinned = this.db.getDb().prepare(
      `SELECT * FROM employee_memories WHERE ${owner.sql} AND is_pinned = 1 AND deleted_at IS NULL ORDER BY updated_at DESC`
    ).all(...owner.params) as EmployeeMemory[]

    // JOIN 中 FTS 表同样含 employee_id 列，归属条件必须带 m. 前缀消除歧义
    const joinSql = isGlobalScope(bucket.scope)
      ? 'm.scope = ?'
      : 'm.scope = ? AND m.employee_id = ?'
    const ranked = this.ftsSearch(`${joinSql} AND m.is_pinned = 0`, owner.params, query, limit)
    return [...pinned, ...ranked.map(r => r.memory)]
  }

  /** 员工作用域检索的便捷入口 */
  searchMemories(employeeId: string, query: string, limit: number = 10): EmployeeMemory[] {
    return this.searchScopeMemories({ scope: MEMORY_SCOPE_EMPLOYEE, employeeId }, query, limit)
  }

  /**
   * agent 检索：员工作用域 + 全局作用域（可过滤），BM25 排序 + 相对分数下限去噪，
   * 命中项刷新 last_referenced_at。
   */
  searchMemoriesForAgent(
    employeeId: string,
    query: string,
    options?: { limit?: number; scope?: MemoryScope | 'all' }
  ): EmployeeMemory[] {
    const limit = Math.min(
      Math.max(Math.floor(options?.limit ?? MEMORY_SEARCH_DEFAULT_LIMIT) || MEMORY_SEARCH_DEFAULT_LIMIT, 1),
      MEMORY_SEARCH_MAX_LIMIT
    )
    const scope = options?.scope ?? 'all'

    let ownerSql: string
    let ownerParams: any[]
    if (scope === MEMORY_SCOPE_GLOBAL) {
      ownerSql = `m.scope = ?`
      ownerParams = [MEMORY_SCOPE_GLOBAL]
    } else if (scope === MEMORY_SCOPE_EMPLOYEE) {
      ownerSql = `m.scope = ? AND m.employee_id = ?`
      ownerParams = [MEMORY_SCOPE_EMPLOYEE, employeeId]
    } else {
      ownerSql = `((m.scope = ? AND m.employee_id = ?) OR m.scope = ?)`
      ownerParams = [MEMORY_SCOPE_EMPLOYEE, employeeId, MEMORY_SCOPE_GLOBAL]
    }

    const ranked = this.ftsSearch(ownerSql, ownerParams, query, limit)
    this.touchMemories(ranked.map(r => r.memory.id))
    return ranked.map(r => r.memory)
  }

  /**
   * FTS5 检索（BM25 降序 → 相对分数下限裁剪）。
   * @param ownerSql 归属过滤片段（可含 `m.` 前缀）
   */
  private ftsSearch(ownerSql: string, ownerParams: any[], query: string, limit: number): ScoredMemory[] {
    const match = buildMemoryFtsMatch(query)
    if (!match) return []

    const fetchLimit = Math.min(limit * SEARCH_OVERFETCH_FACTOR, SEARCH_OVERFETCH_CAP)
    const rows = this.db.getDb().prepare(
      `SELECT m.*, bm25(employee_memories_fts) AS raw_score
       FROM employee_memories_fts f
       JOIN employee_memories m ON m.id = f.memory_id
       WHERE m.deleted_at IS NULL AND ${ownerSql}
         AND employee_memories_fts MATCH ?
       ORDER BY raw_score ASC
       LIMIT ?`
    ).all(...ownerParams, match, fetchLimit) as Array<EmployeeMemory & { raw_score: number }>

    // bm25() 越小越相关；翻转为越大越相关，供相对分数下限判断
    const scored: ScoredMemory[] = rows.map(r => {
      const { raw_score, ...memory } = r
      return { memory: memory as EmployeeMemory, score: -raw_score }
    })
    return applyScoreFloor(scored, MEMORY_SEARCH_SCORE_FLOOR).slice(0, limit)
  }

  // ---------------------------------------------------------------- 统计与维护

  getMemoryStats(bucket: MemoryBucket): MemoryStats {
    const now = Math.floor(Date.now() / 1000)
    const staleThreshold = now - STALE_MEMORY_DAYS * 86400
    const owner = this.ownerClause(bucket)

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
      FROM employee_memories WHERE ${owner.sql} AND deleted_at IS NULL
    `).get(staleThreshold, staleThreshold, ...owner.params) as any

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

  needsConsolidation(bucket: MemoryBucket): boolean {
    const stats = this.getMemoryStats(bucket)
    if (stats.count > MEMORY_MAX_COUNT) return true
    if (stats.totalChars > MEMORY_MAX_CHARS * MEMORY_CONSOLIDATION_THRESHOLD) return true
    if (stats.staleCount > stats.count * 0.3) return true
    return false
  }

  getConversationSummary(conversationId: string): string {
    if (!conversationId) return ''
    const row = this.db.getDb().prepare(
      'SELECT summary FROM conversations WHERE id = ?'
    ).get(conversationId) as { summary: string } | undefined
    return row?.summary || ''
  }

  // ---------------------------------------------------------------- 提取

  /**
   * 从对话中提取记忆（增量或全量）。
   *
   * 失败会抛出异常（而非静默返回空数组），以便调用方决定是否推进提取指针——
   * 静默吞掉失败会让记忆永久丢失且无从感知。
   */
  async extractMemoriesFromConversation(
    employeeId: string,
    messages: Array<{ role: string; content: string }>,
    providerId: string,
    modelId?: string,
    conversationId?: string,
    extractedMessageCount?: number,
    fullExtract?: boolean
  ): Promise<ExtractedMemory[]> {
    // 增量提取：只处理自上次提取以来的新消息；全量提取：处理全部消息
    const newMessages = messages.slice(fullExtract ? 0 : (extractedMessageCount || 0))
    if (newMessages.length === 0) return []

    // 仅取 content 部分（跳过 tool 消息、reasoning_content、toolCalls），不截断
    const conversationText = formatContentOnlyMessages(newMessages)
    if (conversationText.length < 30) return []

    // 全量手动提取时不使用摘要——用户主动触发说明觉得有遗漏，给完整上下文更充分
    const summary = (!fullExtract && conversationId) ? this.getConversationSummary(conversationId) : ''
    const existingMemories = [
      ...this.listMemories(employeeId),
      ...this.listGlobalMemories(),
    ]
    const relevantMemories = getExtractionRelevantMemories(existingMemories, conversationText)
    const existingMemoriesText = relevantMemories.length > 0
      ? relevantMemories.map(m => `${isGlobalScope(m.scope) ? '[global] ' : ''}${m.key}|${m.topic}|${m.content}`).join('\n')
      : ''

    const contextParts: string[] = []
    if (summary) {
      contextParts.push(`【历史摘要】（已提取对话的运行式压缩，提供上下文背景，勿从中提取记忆）\n${summary}`)
    }
    const dialogLabel = fullExtract
      ? '【完整对话】（用户手动触发的全量提取，需从中提取记忆）'
      : '【本轮新对话】（自上次提取以来的新消息，仅含 content，需从中提取记忆）'
    contextParts.push(`${dialogLabel}\n${conversationText}`)
    if (existingMemoriesText) {
      contextParts.push(`【现有记忆】（[global] 前缀为全局记忆，其余为当前员工记忆；格式 key|topic|content，用于去重与更新判断）\n${existingMemoriesText}`)
    }

    const prompt = buildExtractionPrompt(contextParts)

    const response = await this.llmChat(providerId, modelId, prompt, {
      maxTokens: 800,
      logSource: 'memory_extract',
      sessionId: `memory-extract:${employeeId}`,
    })

    const parsed = parseJSON<ExtractionResult | null>(response, null)
    if (!parsed) {
      throw new Error('EXTRACTION_INVALID_OUTPUT')
    }

    const validExtracted = (parsed.memories || []).filter(m => m.key && m.topic && m.content)

    this.db.getDb().transaction(() => {
      const now = Math.floor(Date.now() / 1000)

      for (const memory of validExtracted) {
        const bucket: MemoryBucket = isGlobalScope(memory.scope)
          ? { scope: MEMORY_SCOPE_GLOBAL }
          : { scope: MEMORY_SCOPE_EMPLOYEE, employeeId }
        this.upsertExtractedMemory(bucket, memory, now)
      }

      for (const key of (parsed.delete_keys || [])) {
        if (this.deleteMemoryByKey({ scope: MEMORY_SCOPE_EMPLOYEE, employeeId }, key)) {
          logger.info(`Deleted outdated memory key=${key} for employee ${employeeId}`)
        }
      }

      for (const update of (parsed.update_memories || [])) {
        if (!update.key || !update.content) continue
        const candidateScopes: MemoryBucket[] = isGlobalScope(update.scope)
          ? [{ scope: MEMORY_SCOPE_GLOBAL }]
          : [
              { scope: MEMORY_SCOPE_EMPLOYEE, employeeId },
              { scope: MEMORY_SCOPE_GLOBAL },
            ]
        const applied = this.applyExtractedUpdate(candidateScopes, update, now)
        if (applied) logger.info(`Updated memory key=${update.key} for employee ${employeeId}`)
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
    this.markChanged()

    return validExtracted
  }

  /** 按 key 在指定作用域内 upsert 一条提取结果 */
  private upsertExtractedMemory(bucket: MemoryBucket, memory: ExtractedMemory, now: number): void {
    const owner = this.ownerClause(bucket)
    const existing = this.db.getDb().prepare(
      `SELECT * FROM employee_memories WHERE ${owner.sql} AND key = ? AND deleted_at IS NULL`
    ).get(...owner.params, memory.key) as EmployeeMemory | undefined

    if (existing) {
      const content = clampContent(memory.content)
      this.db.getDb().prepare(
        'UPDATE employee_memories SET content = ?, topic = ?, updated_at = ?, last_referenced_at = ? WHERE id = ?'
      ).run(content, memory.topic, now, now, existing.id)
      this.syncMemoryFTS(existing.id, existing.employee_id, existing.key, memory.topic, content)
      return
    }

    this.createMemory({
      employee_id: bucket.employeeId ?? '',
      scope: bucket.scope,
      key: memory.key,
      topic: memory.topic,
      content: memory.content,
      source: 'auto',
    })
  }

  /** 依次尝试在候选作用域中更新指定 key，命中第一个即返回 */
  private applyExtractedUpdate(
    scopes: MemoryBucket[],
    update: { key: string; content: string; topic?: string },
    now: number
  ): boolean {
    for (const bucket of scopes) {
      const owner = this.ownerClause(bucket)
      const existing = this.db.getDb().prepare(
        `SELECT * FROM employee_memories WHERE ${owner.sql} AND key = ? AND deleted_at IS NULL`
      ).get(...owner.params, update.key) as EmployeeMemory | undefined
      if (!existing) continue
      const topic = update.topic || existing.topic
      const content = clampContent(update.content)
      this.db.getDb().prepare(
        'UPDATE employee_memories SET content = ?, topic = ?, updated_at = ?, last_referenced_at = ? WHERE id = ?'
      ).run(content, topic, now, now, existing.id)
      this.syncMemoryFTS(existing.id, existing.employee_id, existing.key, topic, content)
      return true
    }
    return false
  }

  // ---------------------------------------------------------------- 整理

  /** 记忆整理：按作用域分桶整理；传字符串等价于员工作用域（兼容旧调用形态） */
  async consolidateMemories(
    bucketOrEmployeeId: MemoryBucket | string,
    providerId: string,
    modelId?: string
  ): Promise<{ deleted: number; merged: number; simplified: number }> {
    const bucket: MemoryBucket = typeof bucketOrEmployeeId === 'string'
      ? { scope: MEMORY_SCOPE_EMPLOYEE, employeeId: bucketOrEmployeeId }
      : bucketOrEmployeeId
    const bucketKey = this.bucketKey(bucket)
    const candidates = getConsolidationCandidates(this.listBucketMemories(bucket))
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

    let response: string
    try {
      response = await this.llmChat(providerId, modelId, prompt, {
        maxTokens: 1200,
        logSource: 'memory_consolidate',
        sessionId: `memory-consolidate:${bucketKey}`,
      })
    } catch (error: any) {
      logger.error(`Memory consolidation failed: ${error.message}`)
      return { deleted: 0, merged: 0, simplified: 0 }
    }

    const parsed = parseJSON<ConsolidationResult | null>(response, null)
    if (!parsed) {
      logger.error('Memory consolidation failed: invalid JSON output')
      return { deleted: 0, merged: 0, simplified: 0 }
    }

    let deleted = 0
    let merged = 0
    let simplified = 0

    this.db.getDb().transaction(() => {
      for (const key of (parsed.delete_keys || [])) {
        if (this.deleteMemoryByKey(bucket, key)) deleted++
      }

      for (const group of (parsed.merge_groups || [])) {
        if (!group.keys || group.keys.length < 2 || !group.merged) continue
        const hasPinned = candidates.some(m => group.keys.includes(m.key) && m.is_pinned)
        this.createMemory({
          employee_id: bucket.employeeId ?? '',
          scope: bucket.scope,
          key: group.merged.key,
          topic: group.merged.topic,
          content: group.merged.content,
          source: 'auto',
          is_pinned: hasPinned,
        })
        for (const key of group.keys) {
          const mem = candidates.find(m => m.key === key)
          if (mem && !mem.is_pinned) {
            this.deleteMemoryByKey(bucket, key)
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
          const content = clampContent(update.content)
          this.db.getDb().prepare(
            'UPDATE employee_memories SET content = ?, updated_at = ? WHERE id = ?'
          ).run(content, Math.floor(Date.now() / 1000), existing.id)
          this.syncMemoryFTS(existing.id, existing.employee_id, existing.key, existing.topic, content)
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

    this.lastConsolidationAt.set(bucketKey, Math.floor(Date.now() / 1000))
    this.markChanged()
    logger.info(`Consolidated memories for ${bucketKey}: deleted=${deleted}, merged=${merged}, simplified=${simplified}`)
    return { deleted, merged, simplified }
  }

  async autoConsolidateIfNeeded(
    employeeId: string,
    providerId: string,
    modelId?: string
  ): Promise<{ deleted: number; merged: number; simplified: number } | null> {
    const bucket: MemoryBucket = { scope: MEMORY_SCOPE_EMPLOYEE, employeeId }
    if (!this.needsConsolidation(bucket)) return null

    const bucketKey = this.bucketKey(bucket)
    const lastTime = this.lastConsolidationAt.get(bucketKey) || 0
    const elapsed = Math.floor(Date.now() / 1000) - lastTime
    if (elapsed < CONSOLIDATION_COOLDOWN_SECONDS) {
      logger.info(`Consolidation cooldown for ${bucketKey}, ${CONSOLIDATION_COOLDOWN_SECONDS - elapsed}s remaining`)
      return null
    }

    logger.info(`Auto-consolidation triggered for ${bucketKey}`)
    return this.consolidateMemories(bucket, providerId, modelId)
  }

  private bucketKey(bucket: MemoryBucket): string {
    return isGlobalScope(bucket.scope) ? '__global__' : (bucket.employeeId ?? '')
  }

  private listBucketMemories(bucket: MemoryBucket): EmployeeMemory[] {
    return isGlobalScope(bucket.scope)
      ? this.listGlobalMemories()
      : this.listMemories(bucket.employeeId ?? '')
  }

  // ---------------------------------------------------------------- 过期清理

  removeStaleMemories(bucket: MemoryBucket): number {
    const now = Math.floor(Date.now() / 1000)
    const staleThreshold = now - STALE_MEMORY_DAYS * 86400
    const owner = this.ownerClause(bucket)

    const staleClause = `is_pinned = 0 AND importance = 'low' AND deleted_at IS NULL
       AND ((last_referenced_at IS NOT NULL AND last_referenced_at < ?)
            OR (last_referenced_at IS NULL AND created_at < ?))`

    const staleIds = this.db.getDb().prepare(
      `SELECT id FROM employee_memories WHERE ${owner.sql} AND ${staleClause}`
    ).all(...owner.params, staleThreshold, staleThreshold) as Array<{ id: string }>

    if (staleIds.length === 0) return 0

    const placeholders = staleIds.map(() => '?').join(',')
    this.db.getDb().prepare(`DELETE FROM employee_memories_fts WHERE memory_id IN (${placeholders})`).run(...staleIds.map(i => i.id))
    // 软删除过期记忆，移入回收站便于恢复
    const result = this.db.getDb().prepare(
      `UPDATE employee_memories SET deleted_at = ? WHERE ${owner.sql} AND ${staleClause}`
    ).run(now, ...owner.params, staleThreshold, staleThreshold)

    if (result.changes > 0) {
      logger.info(`Soft-deleted ${result.changes} stale memories for ${this.bucketKey(bucket)}`)
      this.markChanged()
    }
    return result.changes
  }

  // ---------------------------------------------------------------- 回收站

  listTrashedMemories(bucket: MemoryBucket): EmployeeMemory[] {
    const owner = this.ownerClause(bucket)
    return this.db.getDb().prepare(
      `SELECT * FROM employee_memories WHERE ${owner.sql} AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`
    ).all(...owner.params) as EmployeeMemory[]
  }

  restoreMemory(id: string): EmployeeMemory | undefined {
    const existing = this.getMemory(id)
    if (!existing || !existing.deleted_at) return undefined
    this.db.getDb().prepare(
      'UPDATE employee_memories SET deleted_at = NULL, updated_at = ? WHERE id = ?'
    ).run(Math.floor(Date.now() / 1000), id)
    // 恢复 FTS 索引
    this.syncMemoryFTS(id, existing.employee_id, existing.key, existing.topic, existing.content)
    this.markChanged()
    return this.getMemory(id)
  }

  purgeMemory(id: string): boolean {
    this.db.getDb().prepare('DELETE FROM employee_memories_fts WHERE memory_id = ?').run(id)
    const result = this.db.getDb().prepare(
      'DELETE FROM employee_memories WHERE id = ? AND deleted_at IS NOT NULL'
    ).run(id)
    if (result.changes > 0) this.markChanged()
    return result.changes > 0
  }

  emptyTrash(bucket: MemoryBucket): number {
    const owner = this.ownerClause(bucket)
    const ids = this.db.getDb().prepare(
      `SELECT id FROM employee_memories WHERE ${owner.sql} AND deleted_at IS NOT NULL`
    ).all(...owner.params) as Array<{ id: string }>
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    this.db.getDb().prepare(`DELETE FROM employee_memories_fts WHERE memory_id IN (${placeholders})`).run(...ids.map(i => i.id))
    const result = this.db.getDb().prepare(
      `DELETE FROM employee_memories WHERE ${owner.sql} AND deleted_at IS NOT NULL`
    ).run(...owner.params)
    if (result.changes > 0) this.markChanged()
    return result.changes
  }
}

export default EmployeeMemoryService
