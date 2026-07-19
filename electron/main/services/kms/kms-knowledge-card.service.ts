import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSKeywordStatsService from './kms-keyword-stats.service'
import KMSStopWordsService from './kms-stop-words.service'
import LLMClientService from '../llm-client.service'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'
import { getKmsSummaryLLMConfig, getKmsEmbeddingConfig, getKmsSettings } from './kms-config-helpers'
import {
  type KnowledgeCardKeyPoint,
  type KnowledgeCardCitation,
  generateCardViaAgentLoop,
  type AccessedFile,
} from './kms-knowledge-card-agent'
import { cosineSimilarity } from './kms-search-helpers'
import { type SearchTraceStep } from './kms-search-agent-types'

const logger = createLogger('KMS-KnowledgeCard')

/** 卡片归档天数：90天未被搜索/查看且非置顶 → 归档 */
const CARD_ARCHIVE_DAYS = 90

/** 从 agent loop 跟踪的访问文件构建引用 */
function buildCitationsFromAccessedFiles(files: AccessedFile[]): KnowledgeCardCitation[] {
  return files.map(f => ({
    fileId: f.fileId,
    fileName: f.fileName,
    filePath: f.filePath,
    paragraphId: f.paragraphId,
    paragraphTitle: f.paragraphTitle,
    snippet: f.snippet,
    startLine: f.startLine,
    endLine: f.endLine,
  }))
}

export interface KnowledgeCard {
  id: string
  keyword: string
  displayKeyword: string
  summary: string
  keyPoints: KnowledgeCardKeyPoint[]
  citations: KnowledgeCardCitation[]
  relatedFileIds: string[]
  status: 'active' | 'stale' | 'archived' | 'disabled'
  pinned: boolean
  searchCount: number
  createdAt: number
  updatedAt: number
  lastRefreshedAt: number
}

class KMSKnowledgeCardService {
  private db: Database.Database
  private static instance: KMSKnowledgeCardService
  /** 正在生成/刷新的关键词，防止并发重复生成 */
  private generatingKeywords = new Set<string>()

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSKnowledgeCardService {
    if (!KMSKnowledgeCardService.instance) {
      KMSKnowledgeCardService.instance = new KMSKnowledgeCardService()
    }
    return KMSKnowledgeCardService.instance
  }

  private rowToCard(row: any): KnowledgeCard {
    return {
      id: row.id,
      keyword: row.keyword,
      displayKeyword: row.display_keyword,
      summary: row.summary || '',
      keyPoints: (() => { try { return JSON.parse(row.key_points_json || '[]') } catch { return [] } })(),
      citations: (() => { try { return JSON.parse(row.citations_json || '[]') } catch { return [] } })(),
      relatedFileIds: (() => { try { return JSON.parse(row.related_file_ids_json || '[]') } catch { return [] } })(),
      status: row.status,
      pinned: !!row.pinned,
      searchCount: row.search_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRefreshedAt: row.last_refreshed_at || 0,
    }
  }

  listCards(params?: {
    status?: 'active' | 'stale' | 'archived' | 'disabled'
    keyword?: string
    pinnedOnly?: boolean
    limit?: number
    offset?: number
  }): { cards: KnowledgeCard[]; total: number } {
    const limit = Math.min(Math.max(params?.limit || 50, 1), 500)
    const offset = Math.max(params?.offset || 0, 0)

    let where = 'WHERE 1=1'
    const sqlParams: any[] = []

    if (params?.status) {
      where += ' AND status = ?'
      sqlParams.push(params.status)
    }
    if (params?.keyword) {
      where += ' AND (keyword LIKE ? OR display_keyword LIKE ? OR summary LIKE ?)'
      const kw = `%${params.keyword}%`
      sqlParams.push(kw, kw, kw)
    }
    if (params?.pinnedOnly) {
      where += ' AND pinned = 1'
    }

    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM kms_knowledge_cards ${where}`).get(...sqlParams) as any
    const total = countRow?.cnt || 0

    const rows = this.db.prepare(
      `SELECT * FROM kms_knowledge_cards ${where} ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`
    ).all(...sqlParams, limit, offset) as any[]

    return { cards: rows.map(r => this.rowToCard(r)), total }
  }

  getCard(id: string): KnowledgeCard | null {
    const row = this.db.prepare('SELECT * FROM kms_knowledge_cards WHERE id = ?').get(id) as any
    return row ? this.rowToCard(row) : null
  }

  getCardByKeyword(keyword: string): KnowledgeCard | null {
    const normalized = KMSKeywordStatsService.getInstance().normalizeKeyword(keyword)
    const row = this.db.prepare(
      "SELECT * FROM kms_knowledge_cards WHERE keyword = ? AND status NOT IN ('archived', 'disabled')"
    ).get(normalized) as any
    return row ? this.rowToCard(row) : null
  }

  async searchCards(query: string, topK: number = 3): Promise<KnowledgeCard[]> {
    const normalized = KMSKeywordStatsService.getInstance().normalizeKeyword(query)

    // 多关键词搜索：按空格拆分，对每个子词分别查找卡片，合并去重
    const segments = normalized.split(/\s+/).filter(s => s.length > 0)
    const searchTerms = segments.length > 1 ? segments : [normalized]
    const foundCards = new Map<string, KnowledgeCard>()

    for (const term of searchTerms) {
      // 精确匹配
      const exact = this.db.prepare(
        "SELECT * FROM kms_knowledge_cards WHERE keyword = ? AND status NOT IN ('archived', 'disabled')"
      ).get(term) as any
      if (exact) {
        const card = this.rowToCard(exact)
        if (!foundCards.has(card.id)) foundCards.set(card.id, card)
        continue
      }

      // LIKE 匹配
      const likeRows = this.db.prepare(
        "SELECT * FROM kms_knowledge_cards WHERE status NOT IN ('archived', 'disabled') AND (keyword LIKE ? OR display_keyword LIKE ?) ORDER BY search_count DESC LIMIT ?"
      ).all(`%${term}%`, `%${term}%`, topK) as any[]
      for (const row of likeRows) {
        const card = this.rowToCard(row)
        if (!foundCards.has(card.id)) foundCards.set(card.id, card)
      }
    }

    if (foundCards.size >= topK) {
      return Array.from(foundCards.values()).slice(0, topK)
    }

    // 语义匹配作为兜底
    try {
      const embConfig = getKmsEmbeddingConfig()
      if (!embConfig) return Array.from(foundCards.values()).slice(0, topK)

      const llmClient = LLMClientService.getInstance()
      const queryEmbedding = await llmClient.createEmbedding(embConfig.providerId, query, embConfig.modelName)

      const cardRows = this.db.prepare(
        "SELECT * FROM kms_knowledge_cards WHERE status NOT IN ('archived', 'disabled') AND embedding IS NOT NULL AND dimension > 0"
      ).all() as any[]

      if (cardRows.length === 0) return Array.from(foundCards.values()).slice(0, topK)

      const scored = cardRows.map(row => {
        try {
          const embBuffer = row.embedding as Buffer
          const emb = new Float32Array(embBuffer.buffer, embBuffer.byteOffset, embBuffer.byteLength / 4)
          const sim = cosineSimilarity(queryEmbedding, emb)
          return { card: this.rowToCard(row), score: sim }
        } catch {
          return { card: this.rowToCard(row), score: 0 }
        }
      })

      for (const s of scored.filter(s => s.score > 0.75).sort((a, b) => b.score - a.score)) {
        if (!foundCards.has(s.card.id)) foundCards.set(s.card.id, s.card)
      }

      return Array.from(foundCards.values()).slice(0, topK)
    } catch (err: any) {
      logger.warn('Semantic card search failed:', err?.message || err)
      return Array.from(foundCards.values()).slice(0, topK)
    }
  }

  /**
   * 沉淀知识卡片：通过 Agent Loop 让 LLM 自主调用 kms_search / kms_get_content / kms_knowledge_card 工具
   * LLM 自主决定搜索策略、读取哪些文件正文、何时停止，最终输出结构化摘要
   */
  async generateCard(
    keyword: string,
    displayKeyword?: string,
    options?: { onProgress?: (step: SearchTraceStep) => void; signal?: AbortSignal },
  ): Promise<{ success: boolean; card?: KnowledgeCard; error?: string }> {
    const addStep = (step: SearchTraceStep) => { options?.onProgress?.(step) }
    const signal = options?.signal
    const keywordStats = KMSKeywordStatsService.getInstance()
    const normalized = keywordStats.normalizeKeyword(keyword)
    if (!normalized) return { success: false, error: 'INVALID_KEYWORD' }

    // 停用词检查：已被禁用的关键词不允许生成卡片
    if (KMSStopWordsService.getInstance().isStopWord(normalized)) {
      return { success: false, error: 'KEYWORD_DISABLED' }
    }

    // 并发保护：同一关键词只允许一个生成流程
    if (this.generatingKeywords.has(normalized)) return { success: false, error: 'CARD_ALREADY_EXISTS' }

    const existing = this.db.prepare(
      "SELECT id FROM kms_knowledge_cards WHERE keyword = ? AND status NOT IN ('archived', 'disabled')"
    ).get(normalized) as any
    if (existing) return { success: false, error: 'CARD_ALREADY_EXISTS' }

    this.generatingKeywords.add(normalized)
    try {
    const dispKeyword = displayKeyword || keyword
    const llmConfig = getKmsSummaryLLMConfig()
    if (!llmConfig) return { success: false, error: 'NO_LLM_PROVIDER' }

    const t0 = Date.now()
    const statRow = this.db.prepare('SELECT search_count FROM kms_keyword_stats WHERE keyword = ?').get(normalized) as any
    const searchCount = statRow?.search_count || 0

    // === Agent Loop: LLM 自主调用 kms_search / kms_get_content / kms_knowledge_card 工具 ===
    const agentResult = await generateCardViaAgentLoop(
      dispKeyword,
      searchCount,
      addStep,
      signal,
    )

    if (!agentResult.success) {
      return { success: false, error: agentResult.error }
    }

    const result = agentResult.result!
    if (signal?.aborted) return { success: false, error: 'ABORTED' }

    // === 构建引用 + 保存卡片 ===
    const citations = buildCitationsFromAccessedFiles(result.accessedFiles)
    const relatedFileIds = [...new Set(result.accessedFiles.map(f => f.fileId))]
    const cardId = generateId()
    const now = Math.floor(Date.now() / 1000)

    this.db.prepare(`
      INSERT OR IGNORE INTO kms_knowledge_cards
        (id, keyword, display_keyword, summary, key_points_json, citations_json, related_file_ids_json, status, pinned, search_count, created_at, updated_at, last_refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)
    `).run(cardId, normalized, dispKeyword, result.summary, JSON.stringify(result.keyPoints), JSON.stringify(citations), JSON.stringify(relatedFileIds), searchCount, now, now, now)

    // === 生成向量嵌入 ===
    addStep({ phase: 'card', action: '生成向量嵌入', type: 'info' })
    const embStart = Date.now()
    try {
      await this.generateCardEmbedding(cardId, signal)
      addStep({ phase: 'card', action: '生成向量嵌入', type: 'info', detail: '完成', durationMs: Date.now() - embStart })
    } catch (err: any) {
      logger.warn(`Card embedding generation failed for "${keyword}":`, err?.message || err)
    }

    const card = this.getCard(cardId)
    addStep({ phase: 'card', action: '卡片生成完成', type: 'result', detail: `${result.summary.length} 字摘要, ${citations.length} 条引用, ${result.iterations} 轮迭代, 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s` })
    logger.info(`Knowledge card generated for "${keyword}": ${result.summary.length} chars, ${citations.length} citations, ${result.iterations} iterations`)
    return { success: true, card: card || undefined }
    } finally {
      this.generatingKeywords.delete(normalized)
    }
  }

  private async generateCardEmbedding(cardId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const card = this.db.prepare('SELECT summary, key_points_json FROM kms_knowledge_cards WHERE id = ?').get(cardId) as any
      if (!card || !card.summary) return false

      const keyPoints: string[] = (() => {
        try { const arr = JSON.parse(card.key_points_json || '[]'); return Array.isArray(arr) ? arr.map((kp: any) => kp?.point || '').filter(Boolean) : [] }
        catch { return [] }
      })()

      const text = `${card.summary} ${keyPoints.join(' ')}`.trim()
      if (!text) return false

      const embConfig = getKmsEmbeddingConfig()
      if (!embConfig) return false

      const llmClient = LLMClientService.getInstance()
      const embedding = await llmClient.createEmbedding(embConfig.providerId, text, embConfig.modelName)
      if (signal?.aborted) return false

      const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
      this.db.prepare(`UPDATE kms_knowledge_cards SET embedding = ?, dimension = ?, embedding_model = ?, updated_at = unixepoch() WHERE id = ?`).run(buffer, embedding.length, embConfig.modelName, cardId)
      return true
    } catch (err: any) {
      logger.warn(`generateCardEmbedding failed for card ${cardId}:`, err?.message || err)
      return false
    }
  }

  async refreshCard(cardId: string, signal?: AbortSignal, options?: { onProgress?: (step: SearchTraceStep) => void }): Promise<{ success: boolean; card?: KnowledgeCard; error?: string }> {
    const card = this.getCard(cardId)
    if (!card) return { success: false, error: 'CARD_NOT_FOUND' }

    this.db.prepare('DELETE FROM kms_knowledge_cards WHERE id = ?').run(cardId)
    const result = await this.generateCard(card.keyword, card.displayKeyword, { ...options, signal })

    if (!result.success) {
      // 恢复旧卡片（INSERT OR IGNORE 防止并发冲突）
      const now = Math.floor(Date.now() / 1000)
      try {
        this.db.prepare(`
          INSERT OR IGNORE INTO kms_knowledge_cards
            (id, keyword, display_keyword, summary, key_points_json, citations_json, related_file_ids_json, status, pinned, search_count, created_at, updated_at, last_refreshed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'stale', ?, ?, ?, ?, ?)
        `).run(cardId, card.keyword, card.displayKeyword, card.summary, JSON.stringify(card.keyPoints), JSON.stringify(card.citations), JSON.stringify(card.relatedFileIds), card.pinned ? 1 : 0, card.searchCount, card.createdAt, now, card.lastRefreshedAt)
      } catch {}
      return { success: false, error: result.error }
    }

    if (card.pinned && result.card) {
      this.db.prepare('UPDATE kms_knowledge_cards SET pinned = 1 WHERE id = ?').run(result.card.id)
    }
    return { success: true, card: result.card }
  }

  updateCard(params: { id: string; summary?: string; keyPoints?: KnowledgeCardKeyPoint[]; pinned?: boolean }): { success: boolean; error?: string } {
    const card = this.getCard(params.id)
    if (!card) return { success: false, error: 'CARD_NOT_FOUND' }

    const sets: string[] = []
    const sqlParams: any[] = []

    if (params.summary !== undefined) { sets.push('summary = ?'); sqlParams.push(params.summary) }
    if (params.keyPoints !== undefined) { sets.push('key_points_json = ?'); sqlParams.push(JSON.stringify(params.keyPoints)) }
    if (params.pinned !== undefined) { sets.push('pinned = ?'); sqlParams.push(params.pinned ? 1 : 0) }

    if (sets.length === 0) return { success: true }
    sets.push('updated_at = unixepoch()')
    sqlParams.push(params.id)

    this.db.prepare(`UPDATE kms_knowledge_cards SET ${sets.join(', ')} WHERE id = ?`).run(...sqlParams)
    return { success: true }
  }

  deleteCard(id: string): void {
    // 先获取卡片关键词，删除后重置对应搜索次数，避免删除后立即重新生成
    const row = this.db.prepare('SELECT keyword FROM kms_knowledge_cards WHERE id = ?').get(id) as any
    this.db.prepare('DELETE FROM kms_knowledge_cards WHERE id = ?').run(id)
    if (row?.keyword) {
      this.db.prepare('UPDATE kms_keyword_stats SET search_count = 0, updated_at = unixepoch() WHERE keyword = ?').run(row.keyword)
    }
  }

  /**
   * 禁用知识卡片：将卡片状态设为 disabled，同时把关键词加入停用词表。
   * 禁用后该关键词不会再被自动生成卡片，也不会出现在搜索结果中。
   */
  disableCard(id: string): void {
    const row = this.db.prepare('SELECT keyword FROM kms_knowledge_cards WHERE id = ?').get(id) as any
    if (!row?.keyword) return
    this.db.prepare("UPDATE kms_knowledge_cards SET status = 'disabled', updated_at = unixepoch() WHERE id = ?").run(id)
    // 将关键词加入停用词表（用户手动操作 → source='manual'）
    KMSStopWordsService.getInstance().addStopWord(row.keyword, 'manual')
    logger.info(`Knowledge card "${row.keyword}" disabled and added to stop words`)
  }

  /** 启用知识卡片：恢复为 active 状态，并从停用词表中移除 */
  enableCard(id: string): void {
    const row = this.db.prepare('SELECT keyword FROM kms_knowledge_cards WHERE id = ?').get(id) as any
    if (!row?.keyword) return
    this.db.prepare("UPDATE kms_knowledge_cards SET status = 'active', updated_at = unixepoch() WHERE id = ?").run(id)
    // 从停用词表中移除
    KMSStopWordsService.getInstance().deleteStopWordByWord(row.keyword)
    logger.info(`Knowledge card "${row.keyword}" enabled and removed from stop words`)
  }

  pinCard(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE kms_knowledge_cards SET pinned = ?, updated_at = unixepoch() WHERE id = ?').run(pinned ? 1 : 0, id)
  }

  markCardsStaleForFile(fileId: string): void {
    try {
      const result = this.db.prepare(`UPDATE kms_knowledge_cards SET status = 'stale', updated_at = unixepoch() WHERE status = 'active' AND related_file_ids_json LIKE ?`).run(`%"${fileId}"%`)
      if (result.changes > 0) logger.info(`Marked ${result.changes} knowledge card(s) as stale due to file ${fileId} update`)
    } catch (err: any) {
      logger.warn('markCardsStaleForFile failed:', err?.message || err)
    }
  }

  async evaluateCards(force: boolean = false): Promise<{ generated: number; refreshed: number; archived: number }> {
    const settings = getKmsSettings()
    if (!settings.searchParams.enableKnowledgeCards) return { generated: 0, refreshed: 0, archived: 0 }

    let generated = 0
    let refreshed = 0
    let archived = 0

    try {
      const threshold = settings.searchParams.knowledgeCardThreshold || 5
      const hotKeywords = KMSKeywordStatsService.getInstance().findHotKeywordsWithoutCards(threshold)
      for (const kw of hotKeywords.slice(0, 5)) {
        try {
          const result = await this.generateCard(kw.keyword, kw.displayKeyword)
          if (result.success) generated++
        } catch (err: any) {
          logger.warn(`Auto-generate card for "${kw.keyword}" failed:`, err?.message || err)
        }
      }
    } catch (err: any) {
      logger.warn('Auto-generate cards failed:', err?.message || err)
    }

    if (force || settings.searchParams.autoRefreshStaleCards) {
      try {
        const staleCards = this.db.prepare("SELECT id FROM kms_knowledge_cards WHERE status = 'stale' ORDER BY updated_at ASC LIMIT 3").all() as any[]
        for (const c of staleCards) {
          try {
            const result = await this.refreshCard(c.id)
            if (result.success) refreshed++
          } catch (err: any) {
            logger.warn(`Refresh card ${c.id} failed:`, err?.message || err)
          }
        }
      } catch (err: any) {
        logger.warn('Auto-refresh stale cards failed:', err?.message || err)
      }
    }

    try {
      const now = Math.floor(Date.now() / 1000)
      const archiveCutoff = now - CARD_ARCHIVE_DAYS * 86400
      const result = this.db.prepare(`UPDATE kms_knowledge_cards SET status = 'archived', updated_at = unixepoch() WHERE status = 'active' AND pinned = 0 AND updated_at < ?`).run(archiveCutoff)
      archived = result.changes
    } catch (err: any) {
      logger.warn('Archive old cards failed:', err?.message || err)
    }

    if (generated > 0 || refreshed > 0 || archived > 0) {
      logger.info(`Card evaluation: generated=${generated}, refreshed=${refreshed}, archived=${archived}`)
    }
    return { generated, refreshed, archived }
  }
}

export default KMSKnowledgeCardService
