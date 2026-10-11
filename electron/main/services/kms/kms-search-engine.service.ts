import type Database from 'better-sqlite3'
import { isMainThread } from 'worker_threads'
import KMSDatabaseService from './kms-database.service'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'
import kmsTokenizer from './kms-tokenizer.service'
import { foldResultsByContent } from './kms-search-quality'
import { rerankResults, type RerankHints } from './kms-rerank.service'
import { tokenizeFileName, tokenizeQueryTerm } from './kms-text-tokens'
import { LRUBoundedCache } from './lru-bounded-cache'
import {
  computeEmbeddingEntriesBytes,
  extractQueryKeywords,
  buildFtsQuery,
  buildLikeWhereClause,
  buildFtsWhereClause,
  cosineSimilarity,
  norm,
  getResultKey,
} from './kms-search-helpers'
import type {
  SourceType,
  HighlightRange,
  SearchResult,
  SearchOptions,
  EmbeddingEntry,
} from './kms-search-types'

export type { SourceType, HighlightRange, SearchResult, SearchOptions, EmbeddingEntry }

const logger = createLogger('KMSSearchEngine')

/** embedding 缓存字节上限：256MB（覆盖约 8 万条 768 维向量） */
const EMBEDDING_CACHE_MAX_BYTES = 256 * 1024 * 1024

/**
 * RRF（Reciprocal Rank Fusion）常数
 * 标准值 k=60（源自 Cormack et al. 2009 论文），控制排名靠后文档的得分衰减。
 * k 越大，排名差异对分数的影响越平缓；k 越小，Top 命中优势越明显。
 */
const RRF_K = 60

/**
 * 整句短语命中的 RRF 权重倍数。
 * 文档中连续出现完整查询句（整句命中）表明与搜索意图高度相关，
 * 权重倍数使其显著高于词级分散命中（词级单来源最高仅 1/(k+rank)）。
 */
const PHRASE_RRF_WEIGHT = 3

/**
 * 文件名命中的 RRF 权重倍数。
 * 文件名直接包含查询词是强意图信号（用户常以文件名检索），
 * 权重倍数使其高于纯内容匹配的来源（FTS/向量均为 1/(k+rank)）。
 */
const FILE_NAME_RRF_WEIGHT = 2

/** JS 向量兜底只允许作为小规模精确扫描，禁止无限加载全库 */
const VECTOR_FALLBACK_MAX_SCAN = 50_000
const VECTOR_FALLBACK_BUDGET_MS = 300
const VECTOR_FALLBACK_MIN_SCORE = 0.35

class KMSSearchEngineService {
  private db: Database.Database
  /**
   * 向量库连接（独立的 workavatar-kms-vectors.db）。
   *
   * kms_embeddings 和 vec_kms_embeddings 表存储在此库中，
   * 与主库分离以减小主库体积、降低 IO 竞争。
   * 所有 embedding 读写操作使用此连接。
   */
  private vectorDb: Database.Database
  private static instance: KMSSearchEngineService
  private searchCache: Map<string, { results: SearchResult[]; timestamp: number }> = new Map()
  private static readonly CACHE_TTL = 60000
  private static readonly CACHE_MAX_SIZE = 100
  /** kms_search_index.content 最大字符数：仅用于 content_paragraph source type 的截断，
   * 用于控制大文档段落（可达数万字）在 kms_search_index 中的存储体积。
   * file_title/file_summary/paragraph 三个 source type 不截断，以保证 LIKE fallback 搜索准确性。
   * 完整原文始终由 FTS5 索引（insertFtsRow 传入未截断的 content）。
   * 500→1000：为语义向量提供更长的输入文本，提升长段落的语义召回（存储增量有限）。 */
  private static readonly SEARCH_INDEX_CONTENT_LIMIT = 1000
  /** content_paragraph 段落最小字符数：低于此值的短块与相邻段落合并，
   * 避免 Excel/CSV 按行切分产生海量碎片向量；合并后完整文本仍写入 FTS5 全文索引，不丢内容 */
  private static readonly MIN_CONTENT_PARAGRAPH_CHARS = 300
  /** 短块合并成段落的长度上限：累积 + 当前块超过该值则截断另起一段，
   * 防止连续短行（众多表格行）被合并成巨型段落，导致 FTS5 BM25 长段落惩罚与 content 截断 */
  private static readonly MAX_MERGE_PARAGRAPH_CHARS = 2000
  /**
   * embedding 内存缓存（LRU + 字节上限）
   *
   * 替代原无上限 Map，限制总字节 ≤ EMBEDDING_CACHE_MAX_BYTES（256MB）。
   * 大索引场景下超限的 __all__ 条目将不被缓存，向量检索回退到 DB 全量加载。
   *
   * Worker 模式下禁用缓存：Worker 仅做写入，每次写入都会触发 invalidateEmbeddingCacheForFile
   * 全量 filter + set 重新计算所有 8 万条向量的字节数（O(N) × N 次写入 = 灾难性卡死）。
   * 搜索读取在主线程进行，Worker 内的缓存是无效开销且会致命阻塞事件循环。
   */
  private embeddingCache: LRUBoundedCache<EmbeddingEntry[]> = isMainThread
    ? new LRUBoundedCache(
        EMBEDDING_CACHE_MAX_BYTES,
        computeEmbeddingEntriesBytes
      )
    : (null as any)  // Worker 模式下不分配缓存，调用 embeddingCache.* 时走短路逻辑
  private vecDimension: number | null = null
  private vecReady: boolean = false
  private indexGeneration: number = 0
  /** 文件名 token 补齐节流：避免每次搜索都对 kms_files 全表做 NOT EXISTS 探测 */
  private lastFileNameTokenBackfillAt: number = 0

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
    this.vectorDb = KMSDatabaseService.getInstance().getVectorDb()
    this.initVecIndex()
  }

  static getInstance(): KMSSearchEngineService {
    if (!KMSSearchEngineService.instance) {
      KMSSearchEngineService.instance = new KMSSearchEngineService()
    }
    return KMSSearchEngineService.instance
  }

  private initVecIndex(): void {
    try {
      this.vectorDb.prepare('SELECT vec_version()').get()
      this.vecReady = true
    } catch {
      logger.warn('sqlite-vec 扩展未加载，向量检索将回退到 JS 全扫描模式')
      return
    }

    const existing = this.vectorDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_kms_embeddings'"
    ).get() as any

    if (existing) {
      const active = this.getActiveVectorModel()
      if (!active) {
        const latest = this.vectorDb.prepare(`
          SELECT model, dimension FROM kms_embeddings
          WHERE dimension > 0
          GROUP BY model, dimension
          ORDER BY updated_at DESC
          LIMIT 1
        `).get() as any
        if (latest?.dimension) {
          this.setVectorMeta('active_model', latest.model || '')
          this.setVectorMeta('active_dimension', String(latest.dimension))
        }
      }
      this.vecDimension = active?.dimension ?? this.getActiveVectorModel()?.dimension ?? null
      logger.info(`vec0 虚表已存在，维度=${this.vecDimension}`)
      return
    }

    logger.info('vec0 虚表尚未创建，将延迟到首次写入时创建')
  }

  getActiveVectorModel(): { model: string; dimension: number } | null {
    try {
      const row = this.vectorDb.prepare(`
        SELECT key, value FROM kms_vector_meta
        WHERE key IN ('active_model', 'active_dimension')
      `).all() as any[]
      const map = new Map<string, string>(row.map((r: any) => [r.key, r.value]))
      const dimension = Number(map.get('active_dimension'))
      if (!Number.isFinite(dimension) || dimension <= 0) return null
      return { model: map.get('active_model') || '', dimension }
    } catch {
      return null
    }
  }

  private setVectorMeta(key: string, value: string): void {
    this.vectorDb.prepare(`
      INSERT INTO kms_vector_meta (key, value, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
    `).run(key, value)
  }

  activateVectorModel(model: string, dimension: number, recreateIndex: boolean = false): void {
    if (!Number.isFinite(dimension) || dimension <= 0) return
    const previous = this.getActiveVectorModel()
    this.setVectorMeta('active_model', model || '')
    this.setVectorMeta('active_dimension', String(dimension))

    if (this.vecReady && (!previous || previous.dimension !== dimension || recreateIndex)) {
      try {
        this.vectorDb.exec('DROP TABLE IF EXISTS vec_kms_embeddings')
        this.createVecTable(dimension)
      } catch (err: any) {
        logger.warn('Failed to recreate vec0 table for active model:', err?.message || err)
      }
    } else {
      this.vecDimension = dimension
    }
    this.invalidateAllCaches()
  }

  prepareVectorModel(model: string, dimension: number, rebuild: boolean = false): void {
    this.activateVectorModel(model, dimension, rebuild)
    if (rebuild) {
      this.vectorDb.prepare('DELETE FROM kms_embeddings WHERE model = ?').run(model)
      this.invalidateAllCaches()
    }
  }

  archiveChunkVectorsForColdFiles(limit: number = 1000): number {
    const rows = this.db.prepare(`
      SELECT f.id
      FROM kms_files f
      WHERE f.data_tier = 'cold'
        AND EXISTS (
          SELECT 1 FROM kms_embeddings e
          WHERE e.file_id = f.id
            AND e.source_type IN ('paragraph', 'content_paragraph')
            AND COALESCE(e.archived, 0) = 0
        )
      LIMIT ?
    `).all(limit) as any[]
    if (rows.length === 0) return 0
    const ids = rows.map(r => r.id)
    const tx = this.vectorDb.transaction(() => {
      for (let i = 0; i < ids.length; i += 500) {
        const batch = ids.slice(i, i + 500)
        const placeholders = batch.map(() => '?').join(',')
        const rowids = (this.vectorDb.prepare(
          `SELECT rowid FROM kms_embeddings
           WHERE file_id IN (${placeholders}) AND source_type IN ('paragraph','content_paragraph')
             AND COALESCE(archived, 0) = 0`
        ).all(...batch) as any[]).map(r => Number(r.rowid))
        this.vectorDb.prepare(
          `UPDATE kms_embeddings SET archived = 1, updated_at = unixepoch()
           WHERE file_id IN (${placeholders}) AND source_type IN ('paragraph','content_paragraph')
             AND COALESCE(archived, 0) = 0`
        ).run(...batch)
        for (let j = 0; j < rowids.length; j += 500) {
          const rowidBatch = rowids.slice(j, j + 500).map(x => BigInt(x))
          const rowidPlaceholders = rowidBatch.map(() => '?').join(',')
          try {
            this.vectorDb.prepare(`DELETE FROM vec_kms_embeddings WHERE rowid IN (${rowidPlaceholders})`).run(...rowidBatch)
          } catch (err: any) {
            logger.warn('Failed to remove archived vectors from vec0:', err?.message || err)
          }
        }
      }
    })
    tx()
    this.invalidateAllCaches()
    return ids.length
  }

  restoreArchivedVectorsForFile(fileId: string): number {
    const rows = this.vectorDb.prepare(`
      SELECT rowid, embedding, source_type, file_id, model, dimension
      FROM kms_embeddings
      WHERE file_id = ? AND COALESCE(archived, 0) = 1
    `).all(fileId) as any[]
    if (rows.length === 0) return 0

    const active = this.getActiveVectorModel()
    const tx = this.vectorDb.transaction(() => {
      this.vectorDb.prepare(`
        UPDATE kms_embeddings
        SET archived = 0, updated_at = unixepoch()
        WHERE file_id = ? AND COALESCE(archived, 0) = 1
      `).run(fileId)
      // 归档时已从 vec0 移除，恢复时必须重新写回，否则晋升后向量不在 ANN 索引中
      for (const row of rows) {
        if (!row.embedding) continue
        if (active && (row.model !== active.model || row.dimension !== active.dimension)) continue
        this.syncVecIndex(Number(row.rowid), row.embedding, row.file_id, row.source_type, row.dimension)
      }
    })
    tx()
    this.invalidateAllCaches()
    return rows.length
  }

  /**
   * 物理删除已归档的冷向量（真正的磁盘空间回收）
   *
   * 归档（archiveChunkVectorsForColdFiles）只是把向量标记 archived=1 并移出 vec0 索引，
   * 行数据仍留在 kms_embeddings 中。本方法把满足条件的归档行彻底删除：
   * - 默认仅删除「文件仍为 cold 层级」且归档时间超过 olderThanDays（默认 30 天）的向量
   *   —— 30 天宽限期保证：若文件刚被降级就又被搜索命中晋升，无需重新生成向量
   * - once 删除同时清理 vec0 虚表（此时已无对应 rowid，容忍失败）
   * - 返回物理删除的行数；代码为幂等操作，可重复调用
   */
  purgeArchivedVectors(options?: { olderThanDays?: number; limit?: number }): number {
    const olderThanDays = options?.olderThanDays ?? 30
    const limit = options?.limit ?? 5000
    const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400
    const rows = this.vectorDb.prepare(`
      SELECT e.rowid AS rowid
      FROM kms_embeddings e
      JOIN kms_files f ON f.id = e.file_id
      WHERE COALESCE(e.archived, 0) = 1
        AND f.data_tier = 'cold'
        AND e.updated_at < ?
      LIMIT ?
    `).all(cutoff, limit) as any[]
    if (rows.length === 0) return 0

    let purged = 0
    const tx = this.vectorDb.transaction(() => {
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500)
        const rowidBatch = batch.map(r => BigInt(Number(r.rowid)))
        const placeholders = rowidBatch.map(() => '?').join(',')
        try {
          this.vectorDb.prepare(`DELETE FROM vec_kms_embeddings WHERE rowid IN (${placeholders})`).run(...rowidBatch)
        } catch (err: any) {
          logger.warn('purgeArchivedVectors: vec0 清理失败（行已不在索引中，忽略）:', err?.message || err)
        }
        this.vectorDb.prepare(`DELETE FROM kms_embeddings WHERE rowid IN (${placeholders})`).run(...rowidBatch)
        purged += batch.length
      }
    })
    tx()
    this.invalidateAllCaches()
    logger.info(`purgeArchivedVectors: physically removed ${purged} archived cold vectors (olderThanDays=${olderThanDays})`)
    return purged
  }

  getArchivedVectorCount(): number {
    return (this.vectorDb.prepare(
      'SELECT COUNT(*) AS cnt FROM kms_embeddings WHERE COALESCE(archived, 0) = 1'
    ).get() as any)?.cnt || 0
  }

  private isActiveVectorEntry(model: string, dimension: number): boolean {
    const active = this.getActiveVectorModel()
    if (!active) return true
    return active.model === model && active.dimension === dimension
  }

  private createVecTable(dimension: number): void {
    try {
      this.vectorDb.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_kms_embeddings USING vec0(
          embedding float[${dimension}] distance_metric=cosine,
          file_id TEXT,
          source_type TEXT
        )
      `)
      this.vecDimension = dimension
      logger.info(`vec0 虚表创建成功，维度=${dimension}`)
    } catch (err: any) {
      logger.error('vec0 虚表创建失败:', err?.message || err)
      this.vecReady = false
    }
  }

  syncFileNameTokens(fileId: string, fileName: string, filePath?: string): void {
    const tokens = tokenizeFileName(fileName, filePath)
    this.db.prepare('DELETE FROM kms_file_name_tokens WHERE file_id = ?').run(fileId)
    const stmt = this.db.prepare('INSERT OR IGNORE INTO kms_file_name_tokens (file_id, token) VALUES (?, ?)')
    for (const token of tokens) stmt.run(fileId, token)
  }

  backfillFileNameTokens(limit: number = 1000): number {
    const rows = this.db.prepare(`
      SELECT f.id, f.file_name, f.file_path
      FROM kms_files f
      WHERE NOT EXISTS (SELECT 1 FROM kms_file_name_tokens t WHERE t.file_id = f.id)
      LIMIT ?
    `).all(limit) as any[]
    for (const row of rows) this.syncFileNameTokens(row.id, row.file_name, row.file_path)
    return rows.length
  }

  indexFileTitle(fileId: string, fileName: string, filePath?: string): void {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id FROM kms_search_index WHERE source_type = 'file_title' AND source_id = ?"
      ).get(fileId) as any

      // 将文件路径纳入索引内容，使路径中的目录名也可被搜索命中
      // （如文件在"公文模板"目录下，搜索"公文"也能匹配到该文件）
      const indexContent = filePath ? `${fileName} ${filePath}` : fileName

      if (existing) {
        this.db.prepare(
          'UPDATE kms_search_index SET title = ?, content = ?, updated_at = unixepoch() WHERE id = ?'
        ).run(fileName, indexContent, existing.id)

        this.deleteFtsRow(existing.id)
        this.insertFtsRow(existing.id, fileId, 'file_title', fileId, fileName, indexContent, '')
      } else {
        const id = generateId()
        this.db.prepare(`
          INSERT INTO kms_search_index (id, file_id, source_type, source_id, title, content, created_at, updated_at)
          VALUES (?, ?, 'file_title', ?, ?, ?, unixepoch(), unixepoch())
        `).run(id, fileId, fileId, fileName, indexContent)

        this.insertFtsRow(id, fileId, 'file_title', fileId, fileName, indexContent, '')
      }
    })
    tx()
    this.syncFileNameTokens(fileId, fileName, filePath)
  }

  indexFileSummary(fileId: string, summary: string, keywords: string[]): void {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id FROM kms_search_index WHERE source_type = 'file_summary' AND source_id = ?"
      ).get(fileId) as any

      const keywordsStr = keywords.join(', ')

      if (existing) {
        this.db.prepare(`
          UPDATE kms_search_index SET title = ?, content = ?, keywords_json = ?, metadata_json = ?, updated_at = unixepoch() WHERE id = ?
        `).run('文件摘要', summary, JSON.stringify(keywords), JSON.stringify({}), existing.id)

        this.deleteFtsRow(existing.id)
        this.insertFtsRow(existing.id, fileId, 'file_summary', fileId, '文件摘要', summary, keywordsStr)
      } else {
        const id = generateId()
        this.db.prepare(`
          INSERT INTO kms_search_index (id, file_id, source_type, source_id, title, content, keywords_json, metadata_json, created_at, updated_at)
          VALUES (?, ?, 'file_summary', ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(id, fileId, fileId, '文件摘要', summary, JSON.stringify(keywords), JSON.stringify({}))

        this.insertFtsRow(id, fileId, 'file_summary', fileId, '文件摘要', summary, keywordsStr)
      }
    })
    tx()
  }

  indexFileDocument(fileId: string, fileName: string, filePath: string, documentText: string): void {
    const title = fileName
    const pathContext = (filePath || '').split(/[\\/]/).filter(Boolean).slice(-4).join(' / ')
    const preview = (documentText || '').replace(/\s+/g, ' ').trim().substring(0, 1200)
    const content = [`文档: ${fileName}`, pathContext ? `路径: ${pathContext}` : '', preview].filter(Boolean).join('\n')
    const sourceId = `doc:${fileId}`
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id FROM kms_search_index WHERE source_type = 'document' AND source_id = ?"
      ).get(sourceId) as any
      if (existing) {
        this.db.prepare(`
          UPDATE kms_search_index
          SET file_id = ?, title = ?, content = ?, content_version_id = COALESCE(NULLIF((SELECT content_version_id FROM kms_files WHERE id = ?), ''), ''), updated_at = unixepoch()
          WHERE id = ?
        `).run(fileId, title, content, fileId, existing.id)
        this.deleteFtsRow(existing.id)
        this.insertFtsRow(existing.id, fileId, 'document', sourceId, title, content, '')
      } else {
        const versionRow = this.db.prepare('SELECT content_version_id FROM kms_files WHERE id = ?').get(fileId) as any
        const id = generateId()
        this.db.prepare(`
          INSERT INTO kms_search_index (id, file_id, source_type, source_id, title, content, content_version_id, created_at, updated_at)
          VALUES (?, ?, 'document', ?, ?, ?, COALESCE(?, ''), unixepoch(), unixepoch())
        `).run(id, fileId, sourceId, title, content, versionRow?.content_version_id || '')
        this.insertFtsRow(id, fileId, 'document', sourceId, title, content, '')
      }
    })
    tx()
  }

  indexParagraph(
    fileId: string,
    paragraphId: string,
    title: string,
    titlePath: string,
    summary: string,
    keywords: string[],
    startOffset: number,
    endOffset: number
  ): void {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id FROM kms_search_index WHERE source_type = 'paragraph' AND source_id = ?"
      ).get(paragraphId) as any

      const keywordsStr = keywords.join(', ')
      const content = [title, summary].filter(Boolean).join(' ')

      if (existing) {
        this.db.prepare(`
          UPDATE kms_search_index SET title = ?, content = ?, keywords_json = ?, metadata_json = ?,
            start_offset = ?, end_offset = ?, updated_at = unixepoch() WHERE id = ?
        `).run(title, content, JSON.stringify(keywords), JSON.stringify({ summary, title_path: titlePath }),
          startOffset, endOffset, existing.id)

        this.deleteFtsRow(existing.id)
        this.insertFtsRow(existing.id, fileId, 'paragraph', paragraphId, title, content, keywordsStr)
      } else {
        const id = generateId()
        this.db.prepare(`
          INSERT INTO kms_search_index (id, file_id, source_type, source_id, title, content, keywords_json, metadata_json, start_offset, end_offset, created_at, updated_at)
          VALUES (?, ?, 'paragraph', ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(id, fileId, paragraphId, title, content,
          JSON.stringify(keywords), JSON.stringify({ summary, title_path: titlePath }),
          startOffset, endOffset)

        this.insertFtsRow(id, fileId, 'paragraph', paragraphId, title, content, keywordsStr)
      }
    })
    tx()
  }

  indexContentParagraphs(fileId: string, content: string, fileName: string): void {
    this.deleteIndexByFileAndType(fileId, 'content_paragraph')

    // 单次线性扫描切分段落并记录偏移，替代原 split + indexOf 的 O(N²) 方案
    // 原方案对每个段落执行 content.indexOf(para, currentOffset)，大文档（1MB+ 500 段）= 500MB 字符比较
    const paragraphs: Array<{ text: string; startOffset: number; endOffset: number }> = []
    let pos = 0
    // 短块(<MIN_CONTENT_PARAGRAPH_CHARS)与相邻内容合并成一个段落，减少碎片向量；
    // 合并后的完整文本仍写入 FTS5，全文检索不丢内容
    let buffer = ''
    let bufferStart = -1
    let bufferEnd = -1
    const flush = () => {
      if (buffer.trim().length > 0) {
        paragraphs.push({ text: buffer, startOffset: bufferStart, endOffset: bufferEnd })
      }
      buffer = ''
      bufferStart = -1
      bufferEnd = -1
    }
    while (pos < content.length) {
      const nextBreak = content.indexOf('\n\n', pos)
      const end = nextBreak === -1 ? content.length : nextBreak
      const text = content.substring(pos, end)
      const trimmed = text.trim()
      if (trimmed.length >= KMSSearchEngineService.MIN_CONTENT_PARAGRAPH_CHARS) {
        flush()
        paragraphs.push({ text, startOffset: pos, endOffset: end })
      } else if (trimmed.length > 0) {
        // 短块：累积 + 当前块超过合并上限时，先落库当前累积，再以当前块另起一段
        if (buffer && buffer.length + text.length > KMSSearchEngineService.MAX_MERGE_PARAGRAPH_CHARS) {
          flush()
        }
        if (bufferStart === -1) bufferStart = pos
        buffer = buffer ? buffer + '\n' + text : text
        bufferEnd = end
      } else {
        flush()
      }
      // 跳过所有连续换行符（\n\n+ 分隔符）
      pos = end
      while (pos < content.length && content[pos] === '\n') pos++
    }
    flush()
    if (paragraphs.length === 0) return

    // 预计算每行起始偏移，用于段落→行号映射（二分查找替代线性扫描）
    const lineOffsets: number[] = []
    let offset = 0
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') {
        lineOffsets.push(offset)
        offset = i + 1
      }
    }
    lineOffsets.push(offset)

    // kms_search_index.content 只存前 500 字符（用于搜索结果 snippet 和 embedding 生成），
    // FTS5 仍索引完整原文（用于全文搜索）。
    const insertIndex = this.db.prepare(`
      INSERT INTO kms_search_index (id, file_id, source_type, source_id, paragraph_index, title, content, start_offset, end_offset, start_line, end_line, created_at, updated_at)
      VALUES (?, ?, 'content_paragraph', ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `)

    const transaction = this.db.transaction(() => {
      for (let pi = 0; pi < paragraphs.length; pi++) {
        const { text: para, startOffset: paraStartOffset, endOffset: paraEndOffset } = paragraphs[pi]

        // 二分查找行号，替代原 O(N) 线性扫描
        let startLine = 1
        let endLine = 1
        let lo = 0, hi = lineOffsets.length - 1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (lineOffsets[mid] <= paraStartOffset) { startLine = mid + 1; lo = mid + 1 }
          else hi = mid - 1
        }
        lo = 0; hi = lineOffsets.length - 1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (lineOffsets[mid] < paraEndOffset) { endLine = mid + 1; lo = mid + 1 }
          else hi = mid - 1
        }

        const id = generateId()
        const truncatedContent = para.length > KMSSearchEngineService.SEARCH_INDEX_CONTENT_LIMIT
          ? para.substring(0, KMSSearchEngineService.SEARCH_INDEX_CONTENT_LIMIT)
          : para
        // source_id 使用段落自身 id（而非 fileId），使每个段落拥有唯一标识，
        // 向量库按 (source_type, source_id) 唯一存储时才能逐段生成独立向量，
        // 而非同一文件仅保留第一条段落向量。
        insertIndex.run(id, fileId, id, pi, fileName, truncatedContent,
          paraStartOffset, paraEndOffset, startLine, endLine)

        this.insertFtsRow(id, fileId, 'content_paragraph', id, fileName, para, '')
      }
    })

    transaction()
  }

  saveParagraphs(
    fileId: string,
    paragraphs: Array<{
      title: string
      titlePath: string
      level: number
      paragraphIndex: number
      startOffset: number
      endOffset: number
      content: string
    }>
  ): Array<{ id: string; paragraphIndex: number }> {
    // 先清除该文件已有的段落（保留外键约束下级联）
    this.deleteParagraphsByFile(fileId)

    const result: Array<{ id: string; paragraphIndex: number }> = []
    if (paragraphs.length === 0) return result

    const insertStmt = this.db.prepare(`
      INSERT INTO kms_paragraphs (id, file_id, title, title_path, level, paragraph_index, start_offset, end_offset, content, keywords_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', unixepoch(), unixepoch())
    `)

    const tx = this.db.transaction(() => {
      for (const p of paragraphs) {
        const id = generateId()
        insertStmt.run(id, fileId, p.title, p.titlePath, p.level, p.paragraphIndex, p.startOffset, p.endOffset, p.content)
        result.push({ id, paragraphIndex: p.paragraphIndex })
      }
    })
    tx()
    return result
  }

  updateParagraphSummary(paragraphId: string, summary: string, keywords: string[]): void {
    this.db.prepare(`
      UPDATE kms_paragraphs SET summary = ?, keywords_json = ?, updated_at = unixepoch() WHERE id = ?
    `).run(summary, JSON.stringify(keywords), paragraphId)
  }

  deleteParagraphsByFile(fileId: string): void {
    const paraIndexRows = this.db.prepare(
      "SELECT id FROM kms_search_index WHERE file_id = ? AND source_type = 'paragraph'"
    ).all(fileId) as any[]

    // 先收集段落 ID（删除后无法再查询），用于后续清理向量
    const paraIds = (this.db.prepare('SELECT id FROM kms_paragraphs WHERE file_id = ?').all(fileId) as any[]).map(r => r.id)

    const tx = this.db.transaction(() => {
      // FTS5 + search_index DELETE 在同一事务内，保证一致性
      if (paraIndexRows.length > 0) {
        const ids = paraIndexRows.map(r => r.id)
        for (let i = 0; i < ids.length; i += 500) {
          const batch = ids.slice(i, i + 500)
          const placeholders = batch.map(() => '?').join(',')
          this.db.prepare(`DELETE FROM kms_fts WHERE index_id IN (${placeholders})`).run(...batch)
        }
        this.db.prepare(
          "DELETE FROM kms_search_index WHERE file_id = ? AND source_type = 'paragraph'"
        ).run(fileId)
      }
      // 删除段落本身
      this.db.prepare('DELETE FROM kms_paragraphs WHERE file_id = ?').run(fileId)
    })
    tx()

    // 删除段落对应的向量（向量库独立事务，跨库不能共用事务）
    if (paraIds.length > 0) {
      this.deleteEmbeddingsBySourceTypeAndIds('paragraph', paraIds)
    }
    this.invalidateCache()
  }

  deleteParagraphsFromFileIndex(fileId: string, fromIndex: number): void {
    const paraRows = this.db.prepare(
      'SELECT id FROM kms_paragraphs WHERE file_id = ? AND paragraph_index >= ?'
    ).all(fileId, fromIndex) as any[]
    const paraIds = paraRows.map(r => r.id)
    if (paraIds.length === 0) return

    // 分批查询 search_index 行（SQLite 参数上限 999）
    const indexIds: string[] = []
    for (let i = 0; i < paraIds.length; i += 500) {
      const batch = paraIds.slice(i, i + 500)
      const placeholders = batch.map(() => '?').join(',')
      const rows = this.db.prepare(
        `SELECT id FROM kms_search_index WHERE file_id = ? AND source_type = 'paragraph' AND source_id IN (${placeholders})`
      ).all(fileId, ...batch) as any[]
      indexIds.push(...rows.map(r => r.id))
    }

    const tx = this.db.transaction(() => {
      // FTS5 + search_index + paragraphs DELETE 在同一事务内，保证一致性
      if (indexIds.length > 0) {
        for (let i = 0; i < indexIds.length; i += 500) {
          const batch = indexIds.slice(i, i + 500)
          const placeholders = batch.map(() => '?').join(',')
          this.db.prepare(`DELETE FROM kms_fts WHERE index_id IN (${placeholders})`).run(...batch)
        }
      }
      // search_index 按 paraIds 分批删除
      for (let i = 0; i < paraIds.length; i += 500) {
        const batch = paraIds.slice(i, i + 500)
        const placeholders = batch.map(() => '?').join(',')
        this.db.prepare(
          `DELETE FROM kms_search_index WHERE file_id = ? AND source_type = 'paragraph' AND source_id IN (${placeholders})`
        ).run(fileId, ...batch)
      }
      // 删除段落本身
      this.db.prepare(
        'DELETE FROM kms_paragraphs WHERE file_id = ? AND paragraph_index >= ?'
      ).run(fileId, fromIndex)
    })
    tx()

    // 删除段落对应的向量（向量库独立事务，跨库不能共用事务）
    this.deleteEmbeddingsBySourceTypeAndIds('paragraph', paraIds)

    this.invalidateCache()
  }

  /**
   * 按 source_type + source_id 批量删除 embedding 记录和对应的 vec0 虚表行。
   *
   * 由于 kms_embeddings 在独立的向量库，需在向量库独立事务中执行。
   * 大批量 sourceIds（如文件段落 >1000）需分批以避开 SQLite 参数上限 999。
   */
  private deleteEmbeddingsBySourceTypeAndIds(sourceType: string, sourceIds: string[]): void {
    if (sourceIds.length === 0) return
    const BATCH = 500
    const vecTx = this.vectorDb.transaction(() => {
      for (let i = 0; i < sourceIds.length; i += BATCH) {
        const batch = sourceIds.slice(i, i + BATCH)
        const placeholders = batch.map(() => '?').join(',')

        // 收集要删除的 rowid
        let rowids: number[] = []
        try {
          const rows = this.vectorDb.prepare(
            `SELECT rowid FROM kms_embeddings WHERE source_type = ? AND source_id IN (${placeholders})`
          ).all(sourceType, ...batch) as any[]
          rowids = rows.map(r => r.rowid)
        } catch (err: any) {
          logger.warn(`查询 ${sourceType} 的 embedding rowid 失败:`, err?.message || err)
        }

        this.vectorDb.prepare(
          `DELETE FROM kms_embeddings WHERE source_type = ? AND source_id IN (${placeholders})`
        ).run(sourceType, ...batch)

        if (rowids.length > 0 && this.vecReady) {
          for (let j = 0; j < rowids.length; j += BATCH) {
            const rowidBatch = rowids.slice(j, j + BATCH)
            const rowidPlaceholders = rowidBatch.map(() => '?').join(',')
            try {
              // rowid 必须以 BigInt 绑定以避开 sqlite-vec 0.1.x 在加载了原生扩展时的类型校验回归
              this.vectorDb.prepare(`DELETE FROM vec_kms_embeddings WHERE rowid IN (${rowidPlaceholders})`).run(...rowidBatch.map(r => BigInt(r)))
            } catch (err: any) {
              logger.warn(`清理 vec_kms_embeddings 失败 (${sourceType}):`, err?.message || err)
            }
          }
        }
      }
    })
    vecTx()
  }

  insertParagraphs(
    fileId: string,
    paragraphs: Array<{
      title: string
      titlePath: string
      level: number
      paragraphIndex: number
      startOffset: number
      endOffset: number
      content: string
    }>
  ): Array<{ id: string; paragraphIndex: number }> {
    const result: Array<{ id: string; paragraphIndex: number }> = []
    if (paragraphs.length === 0) return result

    const insertStmt = this.db.prepare(`
      INSERT INTO kms_paragraphs (id, file_id, title, title_path, level, paragraph_index, start_offset, end_offset, content, keywords_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', unixepoch(), unixepoch())
    `)

    const tx = this.db.transaction(() => {
      for (const p of paragraphs) {
        const id = generateId()
        insertStmt.run(id, fileId, p.title, p.titlePath, p.level, p.paragraphIndex, p.startOffset, p.endOffset, p.content)
        result.push({ id, paragraphIndex: p.paragraphIndex })
      }
    })
    tx()
    return result
  }

  saveFileToc(fileId: string, tocJson: string): void {
    const existing = this.db.prepare('SELECT id FROM kms_file_summaries WHERE file_id = ?').get(fileId) as any
    if (existing) {
      this.db.prepare('UPDATE kms_file_summaries SET toc_json = ?, updated_at = unixepoch() WHERE file_id = ?')
        .run(tocJson, fileId)
    } else {
      this.db.prepare(`
        INSERT INTO kms_file_summaries (id, file_id, summary, toc_json, keywords_json, main_topics_json, created_at, updated_at)
        VALUES (?, ?, '', ?, '[]', '[]', unixepoch(), unixepoch())
      `).run(generateId(), fileId, tocJson)
    }
  }

  deleteIndexByFile(fileId: string): void {
    const rows = this.db.prepare(
      'SELECT id FROM kms_search_index WHERE file_id = ?'
    ).all(fileId) as any[]

    const tx = this.db.transaction(() => {
      // FTS5 DELETE 在事务内执行，避免崩溃后 kms_fts 与 kms_search_index 不一致
      if (rows.length > 0) {
        const ids = rows.map(r => r.id)
        for (let i = 0; i < ids.length; i += 500) {
          const batch = ids.slice(i, i + 500)
          const placeholders = batch.map(() => '?').join(',')
          this.db.prepare(`DELETE FROM kms_fts WHERE index_id IN (${placeholders})`).run(...batch)
        }
      }
      this.db.prepare('DELETE FROM kms_search_index WHERE file_id = ?').run(fileId)
      this.db.prepare('DELETE FROM kms_paragraphs WHERE file_id = ?').run(fileId)
    })
    tx()

    this.deleteEmbeddingsByFile(fileId)
    this.invalidateEmbeddingCacheForFile(fileId)
    this.invalidateCache()
  }

  /**
   * 批量化删除一组文件的所有索引：FTS5 操作只执行一次，避免逐文件 O(N) 扫描。
   * 大数组分批处理，避免 SQLite 参数上限（SQLITE_MAX_VARIABLE_NUMBER）。
   *
   * 性能关键路径：1000+ 文件的目录删除必须走此批量方法，
   * 避免逐文件事务导致主线程卡死。
   */
  deleteIndexByFiles(fileIds: string[]): void {
    if (fileIds.length === 0) return

    const tx = this.db.transaction(() => {
      // 分批查询 + 删除，避免 IN 子句参数超限
      for (let i = 0; i < fileIds.length; i += 500) {
        const batch = fileIds.slice(i, i + 500)
        const placeholders = batch.map(() => '?').join(',')

        // 查询这批文件的索引 ID
        const indexIdRows = this.db.prepare(
          `SELECT id FROM kms_search_index WHERE file_id IN (${placeholders})`
        ).all(...batch) as any[]

        // FTS5 DELETE 在事务内执行，保证一致性
        if (indexIdRows.length > 0) {
          const ids = indexIdRows.map(r => r.id)
          for (let j = 0; j < ids.length; j += 500) {
            const ftsBatch = ids.slice(j, j + 500)
            const ftsPlaceholders = ftsBatch.map(() => '?').join(',')
            this.db.prepare(`DELETE FROM kms_fts WHERE index_id IN (${ftsPlaceholders})`).run(...ftsBatch)
          }
        }

        this.db.prepare(`DELETE FROM kms_search_index WHERE file_id IN (${placeholders})`).run(...batch)
        this.db.prepare(`DELETE FROM kms_paragraphs WHERE file_id IN (${placeholders})`).run(...batch)
      }
    })
    tx()

    // 批量删除 embedding：使用单一向量库事务，避免 1000 文件 = 1000 事务
    this.deleteEmbeddingsByFiles(fileIds)

    // 批量失效 embedding 缓存
    if (this.embeddingCache) {
      const cached = this.embeddingCache.get('__all__')
      if (cached) {
        const idSet = new Set(fileIds)
        const filtered = cached.filter(e => !idSet.has(e.fileId))
        if (filtered.length !== cached.length) {
          this.embeddingCache.set('__all__', filtered)
        }
      }
    }
    this.invalidateCache()
  }

  deleteEmbeddingsByFilesPublic(fileIds: string[]): void {
    this.deleteEmbeddingsByFiles(fileIds)
  }

  /**
   * 删除指定文件的所有 embedding 记录和对应的 vec0 虚表行。
   *
   * 由于 kms_embeddings 已迁移到独立的向量库，无法和主库共用事务，
   * 需要在向量库独立事务中执行删除。
   */
  private deleteEmbeddingsByFile(fileId: string): void {
    this.deleteEmbeddingsByFiles([fileId])
  }

  /**
   * 批量删除多个文件的 embedding 记录和对应的 vec0 虚表行。
   *
   * 单一向量库事务处理所有文件，避免逐文件事务开销。
   * 大数组分批以避开 SQLite 参数上限（SQLITE_MAX_VARIABLE_NUMBER=999）。
   */
  private deleteEmbeddingsByFiles(fileIds: string[]): void {
    if (fileIds.length === 0) return

    const vecTx = this.vectorDb.transaction(() => {
      for (let i = 0; i < fileIds.length; i += 500) {
        const batch = fileIds.slice(i, i + 500)
        const placeholders = batch.map(() => '?').join(',')

        // 先收集要删除的 rowid（vec_kms_embeddings 通过 rowid 关联 kms_embeddings）
        let rowids: number[] = []
        try {
          const rows = this.vectorDb.prepare(
            `SELECT rowid FROM kms_embeddings WHERE file_id IN (${placeholders})`
          ).all(...batch) as any[]
          rowids = rows.map(r => r.rowid)
        } catch (err: any) {
          logger.warn(`批量查询 embedding rowid 失败 (batch size=${batch.length}):`, err?.message || err)
        }

        this.vectorDb.prepare(
          `DELETE FROM kms_embeddings WHERE file_id IN (${placeholders})`
        ).run(...batch)

        // 删除 vec_kms_embeddings 虚表中的对应行（不会自动级联）
        if (rowids.length > 0 && this.vecReady) {
          // rowid 绑定必须用 BigInt 以避开 sqlite-vec 0.1.x 类型校验回归
          for (let j = 0; j < rowids.length; j += 500) {
            const rowidBatch = rowids.slice(j, j + 500)
            const rowidPlaceholders = rowidBatch.map(() => '?').join(',')
            try {
              this.vectorDb.prepare(
                `DELETE FROM vec_kms_embeddings WHERE rowid IN (${rowidPlaceholders})`
              ).run(...rowidBatch.map(r => BigInt(r)))
            } catch (err: any) {
              logger.warn(`批量清理 vec_kms_embeddings 失败 (batch size=${rowidBatch.length}):`, err?.message || err)
            }
          }
        }
      }
    })
    vecTx()
  }

  /**
   * 删除文件指定类型的索引
   */
  deleteIndexByFileAndType(fileId: string, sourceType: SourceType): void {
    const rows = this.db.prepare(
      'SELECT id FROM kms_search_index WHERE file_id = ? AND source_type = ?'
    ).all(fileId, sourceType) as any[]

    const tx = this.db.transaction(() => {
      // FTS5 DELETE 在事务内执行，保证与 kms_search_index 一致性
      if (rows.length > 0) {
        const ids = rows.map(r => r.id)
        for (let i = 0; i < ids.length; i += 500) {
          const batch = ids.slice(i, i + 500)
          const placeholders = batch.map(() => '?').join(',')
          this.db.prepare(`DELETE FROM kms_fts WHERE index_id IN (${placeholders})`).run(...batch)
        }
      }
      this.db.prepare(
        'DELETE FROM kms_search_index WHERE file_id = ? AND source_type = ?'
      ).run(fileId, sourceType)
    })
    tx()
  }

  /**
   * FTS5 全文检索
   */
  ftsSearch(
    query: string,
    options?: SearchOptions,
    internalOptions?: { includePhrase?: boolean }
  ): SearchResult[] {
    const topK = options?.topK || 10
    const includePhrase = internalOptions?.includePhrase !== false
    const cacheKey = `fts:${this.indexGeneration}:${includePhrase ? 1 : 0}:${query}:${topK}:${JSON.stringify(options)}`
    const cached = this.getFromCache(cacheKey)
    if (cached) return cached

    // 预处理查询：提取关键词并构建 FTS5 查询表达式
    const tokenizeStart = Date.now()
    const queryWords = extractQueryKeywords(query)
    if (queryWords.length === 0) return []

    const ftsQuery = buildFtsQuery(queryWords)
    const { whereClause, params } = buildFtsWhereClause(options)

    try {
      const ftsStart = Date.now()
      const ftsResults = this.db.prepare(`
        SELECT si.*, fts.rank
        FROM kms_fts fts
        JOIN kms_search_index si ON fts.index_id = si.id
        JOIN kms_files f ON si.file_id = f.id
        JOIN kms_index_dirs d ON d.id = f.dir_id
        WHERE kms_fts MATCH ? AND ${whereClause}
        ORDER BY fts.rank
        LIMIT ?
      `).all(ftsQuery, ...params, topK * 2) as any[]

      const convertStart = Date.now()
      let results = this.convertFtsResultsToSearchResults(ftsResults, topK, queryWords)
      logger.info(`ftsSearch "${query}": tokenize=${convertStart - tokenizeStart}ms, fts=${convertStart - ftsStart}ms, convert=${Date.now() - convertStart}ms, results=${results.length}`)

      // 整句短语命中加权：hybrid 会把 phrase 作为独立 RRF 来源，不能在此重复查询
      if (internalOptions?.includePhrase !== false) {
        const phraseResults = this.phraseSearch(query, options, topK)
        if (phraseResults.length > 0) {
          results = this.mergePhraseToTop(results, phraseResults, topK)
        }
      }

      // FTS5 无结果时，降级到 LIKE 模糊匹配（参考搜索引擎的容错机制）
      if (results.length === 0) {
        results = this.likeSearch(query, options, topK)
      }

      // 仅缓存非空结果：空结果可能是瞬态故障（并发索引、vec0 内部状态等）导致，
      // 缓存空结果会让后续 60s 内相同查询持续返回空，表现为"去掉筛选反而搜不到"
      if (results.length > 0) {
        this.putToCache(cacheKey, results)
      }
      return results
    } catch {
      // FTS5 查询语法错误时，降级到 LIKE 模糊匹配
      const results = this.likeSearch(query, options, topK)
      if (results.length > 0) {
        this.putToCache(cacheKey, results)
      }
      return results
    }
  }

  /**
   * LIKE 模糊匹配（FTS5 无结果时的降级方案）
   * 参考搜索引擎的容错机制，对每个关键词做子串匹配
   */
  private likeSearch(query: string, options: SearchOptions | undefined, topK: number): SearchResult[] {
    const queryWords = extractQueryKeywords(query)
    if (queryWords.length === 0) return []

    const { whereClause, params } = buildLikeWhereClause(options)

    // 将关键词 LIKE 匹配下推到 SQL，避免加载无匹配的行；取 topK*5 候选供 JS 精排
    // 同时匹配 f.file_path，使文件路径中的目录名也可被 LIKE 搜索命中
    const likeClauses: string[] = []
    const likeParams: any[] = []
    for (const word of queryWords) {
      const pattern = `%${word}%`
      likeClauses.push('(LOWER(si.title) LIKE ? OR LOWER(si.content) LIKE ? OR LOWER(si.keywords_json) LIKE ? OR LOWER(f.file_path) LIKE ?)')
      likeParams.push(pattern, pattern, pattern, pattern)
    }
    const likeWhere = likeClauses.join(' OR ')
    const candidateLimit = Math.min(topK * 5, 500)

    const rows = this.db.prepare(`
      SELECT si.*, f.file_path AS f_file_path FROM kms_search_index si
      JOIN kms_files f ON si.file_id = f.id
      JOIN kms_index_dirs d ON d.id = f.dir_id
      WHERE ${whereClause} AND (${likeWhere})
      LIMIT ${candidateLimit}
    `).all(...params, ...likeParams) as any[]

    // 对每条记录计算匹配分数（含文件路径）
    const scored = rows.map(row => {
      const text = `${row.title || ''} ${row.content || ''} ${row.keywords_json || ''} ${row.f_file_path || ''}`.toLowerCase()
      let score = 0
      let matchCount = 0
      for (const word of queryWords) {
        if (text.includes(word)) {
          score += word.length * 2  // 长词权重更高
          matchCount++
        }
      }
      // 匹配的关键词越多，分数越高（乘以匹配率）
      const matchRatio = matchCount / queryWords.length
      return { row, score: score * (0.5 + matchRatio * 0.5), matchCount }
    }).filter(r => r.score > 0)

    scored.sort((a, b) => b.score - a.score)
    const topResults = scored.slice(0, topK).map(s => s.row)

    return this.convertFtsResultsToSearchResults(topResults, topK, queryWords)
  }

  /**
   * 整句短语检索：用完整分词序列（保留停用词/标点/顺序，与索引侧一致）构造 FTS5 短语查询，
   * 精确匹配原文中连续出现的整句。命中即代表"这句原样出现在文档里"，应获得高权重。
   * 用于在 ftsSearch / hybridSearch 中把整句命中的文档顶到最前。
   */
  private phraseSearch(query: string, options?: SearchOptions, topK: number = 10): SearchResult[] {
    const tokens = kmsTokenizer.segmentForPhrase(query)
    // 至少 3 个有效内容词才算有意义的整句，避免过短查询整体短语命中所有文档
    const contentTokens = tokens.filter(t => /[\u4e00-\u9fa5a-z0-9]/i.test(t))
    if (contentTokens.length < 3) return []

    const ftsQuery = `"${tokens.join(' ').replace(/"/g, '""').replace(/[*()^\-+:{}\[\]<>~:]/g, '')}"`
    const { whereClause, params } = buildFtsWhereClause(options)

    try {
      const rows = this.db.prepare(`
        SELECT si.*, fts.rank
        FROM kms_fts fts
        JOIN kms_search_index si ON fts.index_id = si.id
        JOIN kms_files f ON si.file_id = f.id
        JOIN kms_index_dirs d ON d.id = f.dir_id
        WHERE kms_fts MATCH ? AND ${whereClause}
        ORDER BY fts.rank
        LIMIT ?
      `).all(ftsQuery, ...params, topK) as any[]
      if (rows.length === 0) return []
      return this.convertFtsResultsToSearchResults(rows, topK)
    } catch {
      return []
    }
  }

  /**
   * 把整句短语命中的结果排在词级结果之前（去重后封顶 topK）。
   * 整句连续命中 = 强相关信号，应优先展示。
   */
  private mergePhraseToTop(wordResults: SearchResult[], phraseResults: SearchResult[], topK: number): SearchResult[] {
    const seen = new Set<string>()
    const merged: SearchResult[] = []
    for (const r of phraseResults) {
      const k = getResultKey(r)
      if (seen.has(k)) continue
      seen.add(k)
      merged.push(r)
      if (merged.length >= topK) return merged
    }
    for (const r of wordResults) {
      const k = getResultKey(r)
      if (seen.has(k)) continue
      seen.add(k)
      merged.push(r)
      if (merged.length >= topK) return merged
    }
    return merged
  }

  /**
   * 向量语义搜索
   */
  vectorSearch(
    queryEmbedding: Float32Array,
    options?: SearchOptions
  ): Array<{ sourceType: string; sourceId: string; fileId: string; score: number }> {
    const topK = options?.topK || 10

    // 将 collectionIds / dirIds / fileExtensions / timeRange 解析为 fileIds，与现有 fileIds 取交集
    const effectiveOptions = this.resolveFileFilter(options)

    // 作用域过滤（collectionIds/dirIds/fileExtensions/timeRange）生效但未匹配任何文件时，
    // resolveFileFilter 返回空 fileIds。空 fileIds 在下游 vec0/JS 检索中被当作"无过滤"，
    // 此处短路返回空结果，避免向量检索返回全部文件。
    if (
      effectiveOptions &&
      this.hasScopeFilter(options) &&
      (effectiveOptions.fileIds?.length ?? 0) === 0
    ) {
      return []
    }

    const activeModel = this.getActiveVectorModel()
    if (options?.embeddingModel && activeModel) {
      if (activeModel.model !== options.embeddingModel || activeModel.dimension !== queryEmbedding.length) {
        logger.info(`Skip vector search: active=${activeModel.model}/${activeModel.dimension}, requested=${options.embeddingModel}/${queryEmbedding.length}`)
        return []
      }
    }

    // 优先用 vec0 KNN 索引；维度不匹配或未就绪时回退到有预算的 JS 精确扫描
    if (this.vecReady && this.vecDimension === queryEmbedding.length) {
      const vecResult = this.vectorSearchViaVec0(queryEmbedding, topK, effectiveOptions)
      if (vecResult !== null) return vecResult
    }

    return this.vectorSearchViaJS(queryEmbedding, topK, effectiveOptions)
  }

  /**
   * 判断 options 是否包含文件作用域过滤条件（collectionIds/dirIds/fileExtensions/timeRange）
   * 用于 vectorSearch 中区分"无过滤"与"过滤后匹配 0 个文件"两种场景
   */
  private hasScopeFilter(options?: SearchOptions): boolean {
    if (!options) return false
    return (
      (options.collectionIds?.length || 0) > 0 ||
      (options.dirIds?.length || 0) > 0 ||
      (options.fileExtensions?.length || 0) > 0 ||
      options.timeRangeStart !== undefined ||
      options.timeRangeEnd !== undefined
    )
  }

  /**
   * 解析 collectionIds / dirIds / fileExtensions / timeRange 为 fileIds，与现有 fileIds 取交集
   * 用于向量搜索（vec0 与 JS 扫描均依赖 fileIds 过滤）
   * 返回新的 options 对象，fileIds 字段被替换为合并后的结果
   *
   * 关键：当任一作用域过滤条件生效但匹配 0 个文件时，返回 fileIds=[]。
   * 调用方（vectorSearch）通过 hasScopeFilter 判断后短路返回空结果，
   * 避免空 fileIds 被下游当作"无过滤"而返回全部文件。
   */
  private resolveFileFilter(options?: SearchOptions): SearchOptions | undefined {
    if (!options) return options
    const { collectionIds, dirIds, fileIds, fileExtensions, timeRangeStart, timeRangeEnd } = options

    const hasCollection = (collectionIds?.length || 0) > 0
    const hasDir = (dirIds?.length || 0) > 0
    const hasExt = (fileExtensions?.length || 0) > 0
    const hasTime = timeRangeStart !== undefined || timeRangeEnd !== undefined

    const aiExcludedIds = this.getAiExcludedFileIds()
    const sets: string[][] = []
    if (fileIds?.length) sets.push(fileIds)

    // 无文件作用域过滤时只需携带 AI 排除集（用排除集而非允许白名单，避免大库全量 id 下传）
    if (!hasCollection && !hasDir && !hasExt && !hasTime) {
      return aiExcludedIds ? { ...options, excludeFileIds: aiExcludedIds } : options
    }

    if (hasCollection) {
      const placeholders = collectionIds!.map(() => '?').join(',')
      const rows = this.db.prepare(
        `SELECT DISTINCT file_id FROM kms_file_collections WHERE collection_id IN (${placeholders})`
      ).all(...collectionIds!) as any[]
      sets.push(rows.map(r => r.file_id))
    }

    if (hasDir) {
      const placeholders = dirIds!.map(() => '?').join(',')
      const rows = this.db.prepare(
        `SELECT id FROM kms_files WHERE dir_id IN (${placeholders})`
      ).all(...dirIds!) as any[]
      sets.push(rows.map(r => r.id))
    }

    // fileExtensions / timeRange 作用于 kms_files 表，合并为一次查询避免多次扫描
    if (hasExt || hasTime) {
      const conditions: string[] = []
      const params: any[] = []
      if (hasExt) {
        const placeholders = fileExtensions!.map(() => '?').join(',')
        conditions.push(`file_ext IN (${placeholders})`)
        params.push(...fileExtensions!)
      }
      if (timeRangeStart !== undefined) {
        conditions.push('modified_time >= ?')
        params.push(timeRangeStart)
      }
      if (timeRangeEnd !== undefined) {
        conditions.push('modified_time <= ?')
        params.push(timeRangeEnd)
      }
      const rows = this.db.prepare(
        `SELECT id FROM kms_files WHERE ${conditions.join(' AND ')}`
      ).all(...params) as any[]
      sets.push(rows.map(r => r.id))
    }

    // 多组条件取交集，单组直接使用
    let resolved: string[]
    if (sets.length === 0) {
      // 作用域过滤生效但未提供 fileIds 且所有子查询均无结果占位
      resolved = []
    } else if (sets.length === 1) {
      resolved = sets[0]
    } else {
      let result = new Set(sets[0])
      for (let i = 1; i < sets.length; i++) {
        const s = new Set(sets[i])
        result = new Set([...result].filter(x => s.has(x)))
      }
      resolved = [...result]
    }

    if (resolved.length > 0) {
      resolved = this.expandContentVersionFileIds(resolved)
    }

    return { ...options, fileIds: resolved, excludeFileIds: aiExcludedIds }
  }

  /** 返回 AI 完全排除（level>=2）的文件 id；无排除时返回 undefined，供下游做小而精确的 NOT IN 过滤 */
  private getAiExcludedFileIds(): string[] | undefined {
    const rows = this.db.prepare(`
      SELECT f.id FROM kms_files f
      JOIN kms_index_dirs d ON d.id = f.dir_id
      WHERE COALESCE(f.ai_exclusion_level, 0) >= 2 OR COALESCE(d.ai_exclusion_level, 0) >= 2
    `).all() as any[]
    return rows.length > 0 ? rows.map(r => r.id) : undefined
  }

  /**
   * 使用 vec0 虚表的 KNN 查询：
   * - metadata 过滤 file_id、source_type
   * - 多取 topK*3 条以缓解 pre-filter 后不足 k 的问题
   * 返回 null 表示 KNN 查询失败，调用方应回退到 JS。
   */
  private vectorSearchViaVec0(
    queryEmbedding: Float32Array,
    topK: number,
    options?: SearchOptions
  ): Array<{ sourceType: string; sourceId: string; fileId: string; score: number }> | null {
    try {
      // 使用 byteOffset + byteLength 构造 Buffer，避免 Float32Array 是 subarray 视图时
      // 传入完整底层 ArrayBuffer 导致维度错误
      const queryBuffer = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength)
      const k = Math.max(topK * 3, 30)

      let whereClause = 'embedding MATCH ? AND k = ?'
      const params: any[] = [queryBuffer, k]

      // fileIds 过滤：小批量用 IN 子句，大批量用临时表避免 SQLite 参数上限 999
      const fileIds = options?.fileIds
      let usedTempTable = false
      if (fileIds && fileIds.length > 0) {
        if (fileIds.length <= 500) {
          const placeholders = fileIds.map(() => '?').join(',')
          whereClause += ` AND file_id IN (${placeholders})`
          params.push(...fileIds)
        } else {
          // 大批量：写入临时表，用子查询过滤
          this.vectorDb.exec('CREATE TEMP TABLE IF NOT EXISTS _kms_vec_filter_ids (id TEXT PRIMARY KEY)')
          this.vectorDb.exec('DELETE FROM _kms_vec_filter_ids')
          const insertStmt = this.vectorDb.prepare('INSERT OR IGNORE INTO _kms_vec_filter_ids (id) VALUES (?)')
          const insertBatch = this.vectorDb.transaction((ids: string[]) => {
            for (const id of ids) insertStmt.run(id)
          })
          insertBatch(fileIds)
          whereClause += ' AND file_id IN (SELECT id FROM _kms_vec_filter_ids)'
          usedTempTable = true
        }
      }

      if (options?.sourceTypes && options.sourceTypes.length > 0) {
        const placeholders = options.sourceTypes.map(() => '?').join(',')
        whereClause += ` AND source_type IN (${placeholders})`
        params.push(...options.sourceTypes)
      }

      // AI 排除集（通常很小）：小集合用 NOT IN 下推；过大时退回结果侧过滤，避免每次搜索建大临时表
      const excludeIds = options?.excludeFileIds
      const excludeSet = excludeIds && excludeIds.length > 500 ? new Set(excludeIds) : null
      if (excludeIds && excludeIds.length > 0 && excludeIds.length <= 500) {
        whereClause += ` AND file_id NOT IN (${excludeIds.map(() => '?').join(',')})`
        params.push(...excludeIds)
      }

      const knnRows = this.vectorDb.prepare(
        `SELECT rowid, distance FROM vec_kms_embeddings WHERE ${whereClause} ORDER BY distance`
      ).all(...params) as any[]

      // 清理临时表
      if (usedTempTable) {
        try { this.vectorDb.exec('DELETE FROM _kms_vec_filter_ids') } catch {}
      }

      // KNN 返回 0 行时返回 null 触发 JS 全扫描兜底，而非返回空数组。
      // vec0 索引可能因并发写入、内部状态等原因暂时返回 0 行，
      // 此时 kms_embeddings 表中仍有数据，JS 扫描可以正常返回结果。
      if (knnRows.length === 0) return null

      // 回查 kms_embeddings 获取元数据（rowids 数量 = k ≤ topK*3，通常远 < 999）
      const rowids = knnRows.map(r => r.rowid)
      const metaMap = new Map<number, any>()
      for (let i = 0; i < rowids.length; i += 500) {
        const batch = rowids.slice(i, i + 500)
        const placeholders = batch.map(() => '?').join(',')
        const metaRows = this.vectorDb.prepare(
          `SELECT rowid, source_type, source_id, file_id, model, dimension FROM kms_embeddings WHERE COALESCE(archived, 0) = 0 AND rowid IN (${placeholders})`
        ).all(...batch) as any[]
        for (const row of metaRows) {
          metaMap.set(Number(row.rowid), row)
        }
      }

      const active = this.getActiveVectorModel()
      return knnRows.filter(knn => {
        const meta = metaMap.get(Number(knn.rowid))
        if (!meta) return false
        if (meta.dimension !== queryEmbedding.length) return false
        if (options?.embeddingModel && meta.model !== options.embeddingModel) return false
        if (!options?.embeddingModel && active && meta.model !== active.model) return false
        if (excludeSet && excludeSet.has(meta.file_id)) return false
        return true
      }).map(knn => {
        const meta = metaMap.get(Number(knn.rowid))
        return {
          sourceType: meta?.source_type || '',
          sourceId: meta?.source_id || '',
          fileId: meta?.file_id || '',
          score: 1 - knn.distance,
        }
      }).slice(0, topK)
    } catch (err: any) {
      logger.warn('vec0 KNN 查询失败，回退到 JS:', err?.message || err)
      return null
    }
  }

  /**
   * JS 全扫描向量检索（fallback）：
   * 当 vec0 索引不可用或维度不匹配时使用
   * 优化：当存在 fileIds/sourceTypes 过滤条件时，下推到 SQL WHERE 子句，避免全量加载
   */
  private vectorSearchViaJS(
    queryEmbedding: Float32Array,
    topK: number,
    options?: SearchOptions
  ): Array<{ sourceType: string; sourceId: string; fileId: string; score: number }> {
    const activeModel = this.getActiveVectorModel()
    const modelFilter = options?.embeddingModel || activeModel?.model
    const excludeSet = options?.excludeFileIds?.length ? new Set(options.excludeFileIds) : null
    const startedAt = Date.now()

    // 按过滤条件加载 embeddings：有过滤时下推 SQL，无过滤时也受扫描预算保护
    const hasFileFilter = options?.fileIds && options.fileIds.length > 0
    const hasTypeFilter = options?.sourceTypes && options.sourceTypes.length > 0
    const embeddings = (hasFileFilter || hasTypeFilter)
      ? this.loadEmbeddingsFiltered(options!.fileIds, options!.sourceTypes as string[], modelFilter, queryEmbedding.length)
      : this.loadAllEmbeddings(modelFilter, queryEmbedding.length)

    if (embeddings.length === 0) return []

    const queryNorm = norm(queryEmbedding)
    if (queryNorm === 0 || !Number.isFinite(queryNorm)) return []

    const scored: Array<{ sourceType: string; sourceId: string; fileId: string; score: number }> = []
    for (const e of embeddings) {
      if (!e.embedding || e.embedding.length !== queryEmbedding.length) continue
      if (excludeSet && excludeSet.has(e.fileId)) continue
      const similarity = cosineSimilarity(queryEmbedding, e.embedding, queryNorm)
      if (!Number.isFinite(similarity) || similarity < VECTOR_FALLBACK_MIN_SCORE) continue
      scored.push({ sourceType: e.sourceType, sourceId: e.sourceId, fileId: e.fileId, score: similarity })
      if (Date.now() - startedAt > VECTOR_FALLBACK_BUDGET_MS) {
        logger.warn(`JS vector fallback budget exceeded after ${scored.length} accepted candidate(s)`)
        break
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  /**
   * 文件名搜索（基于 kms_files.file_name 的 LIKE 匹配）
   *
   * 作为混合搜索的第三个 RRF 来源，与 FTS（关键词）和 vector（语义）并列。
   * 不依赖任何已建立的索引/向量，可与现有过滤条件（dirIds / collectionIds /
   * fileExtensions / timeRange）协同工作；timeRange 单位为 unix 秒（与
   * kms_files.modified_time 一致），调用方（hybridSearch）负责毫秒→秒转换。
   */
  fileNameSearch(query: string, options: SearchOptions): SearchResult[] {
    const topK = options?.topK || 10
    const queryWords = extractQueryKeywords(query)
    const rawTerms = query.split(/[\s,，。；;：:、？?！!/\\()（）【】\[\]{}'"]+/)
      .map(s => s.trim()).filter(Boolean)
    if (queryWords.length === 0 && rawTerms.length === 0) return []

    if (Date.now() - this.lastFileNameTokenBackfillAt > 30_000) {
      this.backfillFileNameTokens(1000)
      this.lastFileNameTokenBackfillAt = Date.now()
    }

    const tokenSets = (rawTerms.length > 0 ? rawTerms : queryWords)
      .map(tokenizeQueryTerm).filter(tokens => tokens.length > 0)
    if (tokenSets.length === 0) return []

    const conditions: string[] = [
      "COALESCE(f.ai_exclusion_level, 0) < 2",
      "COALESCE(d.ai_exclusion_level, 0) < 2",
    ]
    const filterParams: any[] = []

    if (options?.dirIds && options.dirIds.length > 0) {
      const placeholders = options.dirIds.map(() => '?').join(',')
      conditions.push(`f.dir_id IN (${placeholders})`)
      filterParams.push(...options.dirIds)
    }
    if (options?.fileExtensions && options.fileExtensions.length > 0) {
      const placeholders = options.fileExtensions.map(() => '?').join(',')
      conditions.push(`f.file_ext IN (${placeholders})`)
      filterParams.push(...options.fileExtensions)
    }
    if (options?.timeRangeStart !== undefined) {
      conditions.push('f.modified_time >= ?')
      filterParams.push(options.timeRangeStart)
    }
    if (options?.timeRangeEnd !== undefined) {
      conditions.push('f.modified_time <= ?')
      filterParams.push(options.timeRangeEnd)
    }
    if (options?.collectionIds && options.collectionIds.length > 0) {
      const placeholders = options.collectionIds.map(() => '?').join(',')
      conditions.push(`f.id IN (SELECT file_id FROM kms_file_collections WHERE collection_id IN (${placeholders}))`)
      filterParams.push(...options.collectionIds)
    }
    if (options?.fileIds && options.fileIds.length > 0) {
      const placeholders = options.fileIds.map(() => '?').join(',')
      conditions.push(`f.id IN (${placeholders})`)
      filterParams.push(...options.fileIds)
    }

    const tokenClauses: string[] = []
    const tokenParams: any[] = []
    for (const tokens of tokenSets) {
      tokenClauses.push(tokens.map(() => `EXISTS (
        SELECT 1 FROM kms_file_name_tokens t
        WHERE t.file_id = f.id AND t.token = ?
      )`).join(' AND '))
      tokenParams.push(...tokens)
    }

    const candidateLimit = Math.min(topK * 3, 500)
    const tokenSql = `
      SELECT f.id as file_id, f.file_name, f.file_path, f.modified_time, f.content_version_id
      FROM kms_files f
      JOIN kms_index_dirs d ON d.id = f.dir_id
      WHERE ${conditions.join(' AND ')} AND ${tokenClauses.join(' AND ')}
      LIMIT ${candidateLimit}
    `
    let rows = this.db.prepare(tokenSql).all(...filterParams, ...tokenParams) as any[]
    if (rows.length === 0 && process.env.KMS_DEBUG_FILE_NAME === '1') {
      logger.info(`fileName token miss sql=${tokenSql} params=${JSON.stringify([...filterParams, ...tokenParams])}`)
    }

    // token 索引缺失或分词未命中时，仅在小规模候选集下安全回退 LIKE
    if (rows.length === 0) {
      const likeTerms = rawTerms.length > 0 ? rawTerms : queryWords
      const likeClauses = likeTerms.map(() => 'LOWER(f.file_name) LIKE ?')
      const likeParams = likeTerms.map(word => `%${word}%`)
      rows = this.db.prepare(`
        SELECT f.id as file_id, f.file_name, f.file_path, f.modified_time, f.content_version_id
        FROM kms_files f
        JOIN kms_index_dirs d ON d.id = f.dir_id
        WHERE ${conditions.join(' AND ')} AND (${likeClauses.join(' OR ')})
        LIMIT ${candidateLimit}
      `).all(...filterParams, ...likeParams) as any[]
    }

    const scored = rows.map(row => {
      const name = (row.file_name || '').toLowerCase()
      let score = 0
      let matchCount = 0
      const scoreTerms = rawTerms.length > 0 ? rawTerms : queryWords
      for (const word of scoreTerms) {
        if (name.includes(word)) {
          score += word.length * 2
          matchCount++
        }
      }
      const matchRatio = matchCount / scoreTerms.length
      return { row, score: Math.max(score, 1) * (0.5 + matchRatio * 0.5) }
    }).filter(r => r.score > 0)

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK).map(s => {
      const text = s.row.file_name || ''
      return {
        file_id: s.row.file_id,
        file_name: s.row.file_name,
        file_path: s.row.file_path,
        modified_time: s.row.modified_time,
        content_version_id: s.row.content_version_id || '',
        text,
        match_type: 'file_name' as SourceType,
        highlights: this.computeHighlights(text, queryWords),
        matched_keywords: queryWords,
      } as SearchResult
    })
  }

  /**
   * 混合搜索（RRF 倒数排名融合）
   *
   * 四个独立来源的 RRF 融合：关键词（FTS5）+ 语义（向量）+ 文件名（LIKE）+ 整句短语。
   * 文档在任意单一来源命中即可被召回，同时命中多来源时按各来源排名叠加得分。
   * 文件名来源权重 ×2（FILE_NAME_RRF_WEIGHT）、整句短语 ×3（PHRASE_RRF_WEIGHT），
   * 高于 FTS/向量的 1/(k+rank)，体现「文件名命中」与「整句命中」的强意图信号。
   *
   * 替代原「线性加权」方案：
   * - 旧方案：`sortKey = ftsRank * 0.6 + vectorScore * 0.4`，
   *   其中 ftsRank 是基于排名位置的线性归一化（`(length - i) / length`），
   *   丢弃了 FTS5 `fts.rank` 的 BM25 真实分数；vectorScore 也需 max 归一化。
   *   两个尺度不同的归一化分数硬编码权重相加，对异常值敏感、不可调。
   * - 新方案：RRF（Reciprocal Rank Fusion），公式 `Σ 1/(k + rank_i)`，
   *   仅依赖排名位置（1-indexed），无需分数归一化，对尺度鲁棒。
   *   标准常数 k=60（Cormack et al. 2009），平衡 Top 命中优势与长尾召回。
   *
   * RRF 的优势：
   * 1. 无需归一化 BM25 与 cosine 分数（尺度不同导致的加权失真问题消失）
   * 2. 同时出现在多个来源的文档自然获得更高分数（Σ 1/(k+r_i)）
   * 3. 仅出现在一个来源的文档也有非零分数，保留召回
   * 4. 算法成熟，被 Elasticsearch、OpenSearch 等主流搜索引擎广泛采用
   *
   * 文件名来源（file_name）：与 FTS/向量并列的第三个来源，键格式 `file_name-${fileId}`，
   * 与 `file_title-${fileId}` / `content-${fileId}-${offset}` 等键不冲突。
   * 当一个文件在 FTS 中通过 file_title 命中、向量中通过 file_title embedding 命中、
   * 同时文件名直接包含查询关键词时，三个来源的 RRF 贡献叠加，得分最高。
   */
  hybridSearch(query: string, queryEmbedding: Float32Array | null, options?: SearchOptions): SearchResult[] {
    const hybridStartedAt = Date.now()
    const topK = options?.topK || 10
    const useVector = options?.useVector !== false && queryEmbedding !== null
    const queryWords = extractQueryKeywords(query)
    const timings: Record<string, number> = {}

    // FTS5 关键词搜索（phrase 作为下方独立 RRF 来源，此处禁止内部重复查询）
    let ftsResults: SearchResult[] = []
    try {
      const startedAt = Date.now()
      ftsResults = this.ftsSearch(query, { ...options, topK: topK * 2 }, { includePhrase: false })
      timings.fts = Date.now() - startedAt
    } catch (err: any) {
      logger.warn('ftsSearch failed in hybridSearch, continuing with vector results only:', err?.message || err)
    }

    // 构建 FTS 排名映射（1-indexed 排名，越小越靠前）
    const ftsRankMap = new Map<string, number>()
    for (let i = 0; i < ftsResults.length; i++) {
      const r = ftsResults[i]
      const key = getResultKey(r)
      // 仅保留首次出现的排名（FTS 结果按相关性排序，首次出现即最佳排名）
      if (!ftsRankMap.has(key)) {
        ftsRankMap.set(key, i + 1)
      }
    }

    // 向量检索排名映射
    const vecRankMap = new Map<string, number>()
    const vectorSourceMap = new Map<string, { sourceType: string; sourceId: string; fileId: string }>()

    if (useVector && queryEmbedding) {
      try {
        const startedAt = Date.now()
        const vectorResults = this.vectorSearch(queryEmbedding, { ...options, topK: topK * 2 })
        timings.vector = Date.now() - startedAt
        for (let i = 0; i < vectorResults.length; i++) {
          const vr = vectorResults[i]
          const key = `${vr.sourceType}-${vr.sourceId}`
          if (!vecRankMap.has(key)) {
            vecRankMap.set(key, i + 1)
            vectorSourceMap.set(key, vr)
          }
        }
      } catch (err: any) {
        // 向量检索失败时不阻断混合搜索，仅使用 FTS + 文件名结果
        logger.warn('Vector search failed, falling back to FTS + file_name only:', err?.message || err)
      }
    }

    // 文件名搜索：第三个 RRF 来源
    // 与 FTS 文件标题索引（file_title）独立，作为对文件名匹配意图的显式信号。
    // 文件名不含中文分词的段索引意义弱、纯语义匹配噪声大，关键词 LIKE 是最稳定的方式。
    let fileNameResults: SearchResult[] = []
    try {
      const startedAt = Date.now()
      fileNameResults = this.fileNameSearch(query, { ...options, topK: topK * 2 })
      timings.fileName = Date.now() - startedAt
    } catch (err: any) {
      // 文件名搜索失败时不影响主流程
      logger.warn('fileNameSearch failed in hybridSearch, continuing without file_name results:', err?.message || err)
    }

    const fileNameRankMap = new Map<string, number>()
    for (let i = 0; i < fileNameResults.length; i++) {
      const r = fileNameResults[i]
      const key = `file_name-${r.file_id}`
      if (!fileNameRankMap.has(key)) {
        fileNameRankMap.set(key, i + 1)
      }
    }

    // 整句短语检索：第 4 个 RRF 来源，命中完整查询句的文档按权重倍数显著加权
    let phraseResults: SearchResult[] = []
    try {
      const startedAt = Date.now()
      phraseResults = this.phraseSearch(query, { ...options, topK: topK * 2 })
      timings.phrase = Date.now() - startedAt
    } catch (err: any) {
      logger.warn('phraseSearch failed in hybridSearch, continuing without phrase results:', err?.message || err)
    }
    const phraseRankMap = new Map<string, number>()
    const phraseResultMap = new Map<string, SearchResult>()
    for (let i = 0; i < phraseResults.length; i++) {
      const r = phraseResults[i]
      const key = getResultKey(r)
      if (!phraseRankMap.has(key)) {
        phraseRankMap.set(key, i + 1)
        phraseResultMap.set(key, r)
      }
    }

    // RRF 融合：score = Σ w_i/(k + rank_i)，i ∈ {fts, vec, file_name, phrase}
    // 权重 w：fts/vec = 1，file_name = FILE_NAME_RRF_WEIGHT，phrase = PHRASE_RRF_WEIGHT
    // 来源缺失的贡献为 0（rank undefined → 跳过）
    const mergeStartedAt = Date.now()
    const allKeys = new Set([...ftsRankMap.keys(), ...vecRankMap.keys(), ...fileNameRankMap.keys(), ...phraseRankMap.keys()])
    const hybridResults: Array<{ result: SearchResult; sortKey: number }> = []
    const missingEntries: Array<{ key: string; vs: { sourceType: string; sourceId: string }; sortKey: number }> = []
    // 仅文件名来源命中的条目：使用 fileNameResultMap 直接出结果，无需回查 DB
    const fileNameOnlyResults: Array<{ result: SearchResult; sortKey: number }> = []

    // 预建 ftsResults 的 key → result 索引，避免循环内 O(N) find 造成 O(N²)
    const ftsResultMap = new Map<string, SearchResult>()
    for (const r of ftsResults) {
      ftsResultMap.set(getResultKey(r), r)
    }

    // 预建 fileNameResults 的 key → result 索引
    const fileNameResultMap = new Map<string, SearchResult>()
    for (const r of fileNameResults) {
      fileNameResultMap.set(`file_name-${r.file_id}`, r)
    }

    for (const key of allKeys) {
      let sortKey = 0
      const ftsRank = ftsRankMap.get(key)
      if (ftsRank !== undefined) {
        sortKey += 1 / (RRF_K + ftsRank)
      }
      const vecRank = vecRankMap.get(key)
      if (vecRank !== undefined) {
        sortKey += 1 / (RRF_K + vecRank)
      }
      const fileNameRank = fileNameRankMap.get(key)
      if (fileNameRank !== undefined) {
        sortKey += FILE_NAME_RRF_WEIGHT / (RRF_K + fileNameRank)
      }
      // 整句短语命中：权重倍数显著高于词级分散命中
      const phraseRank = phraseRankMap.get(key)
      if (phraseRank !== undefined) {
        sortKey += PHRASE_RRF_WEIGHT / (RRF_K + phraseRank)
      }

      const ftsResult = ftsResultMap.get(key)
      const phraseResult = phraseResultMap.get(key)

      if (ftsResult) {
        hybridResults.push({
          result: {
            ...ftsResult,
            match_type: (useVector || fileNameRank !== undefined) ? 'hybrid' : ftsResult.match_type,
            score: sortKey,
          },
          sortKey,
        })
      } else if (phraseResult) {
        // 仅整句短语命中（如查询词多为停用词/常用词，词级 FTS 已被过滤）：直接使用短语命中结果
        hybridResults.push({
          result: {
            ...phraseResult,
            match_type: 'hybrid',
            score: sortKey,
          },
          sortKey,
        })
      } else if (useVector && vecRank !== undefined) {
        // FTS 未命中但向量命中的文档，需回查索引表补充元数据
        const vs = vectorSourceMap.get(key)
        if (!vs) continue
        missingEntries.push({ key, vs, sortKey })
      } else if (fileNameRank !== undefined) {
        // 仅文件名命中：fileNameResult 已含完整元数据（file_name/file_path/modified_time），
        // 无需回查 kms_search_index
        const fnResult = fileNameResultMap.get(key)
        if (!fnResult) continue
        // 多来源命中时（如同时有 vector/file_name），结果用 'hybrid' 标识
        const isHybrid = useVector && vecRank !== undefined
        fileNameOnlyResults.push({
          result: {
            ...fnResult,
            match_type: isHybrid ? 'hybrid' : 'file_name',
            score: sortKey,
          },
          sortKey,
        })
      }
    }

    // 批量查询缺失的索引条目，避免 N+1（原实现每条向量命中都执行 2 次查询）
    if (missingEntries.length > 0) {
      const indexMap = new Map<string, any>()
      // fileMap 提到分批循环外：后续结果装配统一引用
      const fileMap = new Map<string, { file_name: string; file_path: string; modified_time?: number; content_version_id?: string }>()
      // 分批查询防超 SQLITE 参数上限（每条 2 个参数，大 topK 时可能超 999）
      const batchSize = 400
      for (let i = 0; i < missingEntries.length; i += batchSize) {
        const batch = missingEntries.slice(i, i + batchSize)
        const conditions = batch.map(() => '(source_type = ? AND source_id = ?)').join(' OR ')
        const params = batch.flatMap(m => [m.vs.sourceType, m.vs.sourceId])
        const indexRows = this.db.prepare(
          `SELECT source_type, source_id, file_id, title, content, start_offset, end_offset FROM kms_search_index WHERE ${conditions}`
        ).all(...params) as any[]

        const fileIds = [...new Set(indexRows.map(r => r.file_id).filter(Boolean))]
        if (fileIds.length > 0) {
          const fileRows = this.db.prepare(
            `SELECT id, file_name, file_path, modified_time, content_version_id FROM kms_files WHERE id IN (${fileIds.map(() => '?').join(', ')})`
          ).all(...fileIds) as any[]
          for (const row of fileRows) {
            fileMap.set(row.id, {
              file_name: row.file_name,
              file_path: row.file_path,
              modified_time: row.modified_time,
              content_version_id: row.content_version_id || '',
            })
          }
        }

        for (const row of indexRows) {
          indexMap.set(`${row.source_type}-${row.source_id}`, row)
        }
      }

      for (const entry of missingEntries) {
        const indexEntry = indexMap.get(`${entry.vs.sourceType}-${entry.vs.sourceId}`)
        if (indexEntry) {
          const file = fileMap.get(indexEntry.file_id)
          hybridResults.push({
            result: {
              file_id: indexEntry.file_id,
              file_name: file?.file_name || '',
              file_path: file?.file_path || '',
              modified_time: file?.modified_time,
              paragraph_id: (entry.vs.sourceType === 'paragraph' || entry.vs.sourceType === 'content_paragraph') ? entry.vs.sourceId : undefined,
              paragraph_title: indexEntry.title,
              text: (indexEntry.content || '').substring(0, 300),
              match_type: 'hybrid',
              start_offset: indexEntry.start_offset,
              end_offset: indexEntry.end_offset,
              content_version_id: file?.content_version_id || '',
              score: entry.sortKey,
            },
            sortKey: entry.sortKey,
          })
        }
      }
    }

    // 合并文件名命中结果后统一排序，再按物理文档折叠，避免长文档/重复片段刷屏
    hybridResults.push(...fileNameOnlyResults)
    hybridResults.sort((a, b) => b.sortKey - a.sortKey)
    const foldedResults = foldResultsByContent(hybridResults.map(h => ({
      file_id: h.result.file_id,
      content_version_id: h.result.content_version_id,
      score: h.sortKey,
      item: h,
    })), 1)
    const topResults = foldedResults.slice(0, topK).map(r => ({
      ...r.item,
      result: {
        ...r.item.result,
        sibling_count: r.sibling_count || 0,
      },
    }))

    // RRF 分数归一化到 [0, 1]：除以本批最大分数，使 Top 结果 score=1.0
    // 前端 KMSSearchResultList 按 score*100 渲染匹配度进度条，未归一化的 RRF 原始分数
    //（最大约 2/61 ≈ 0.033）会导致进度条几乎不可见
    const maxSortKey = topResults.length > 0 ? topResults[0].sortKey : 0
    const safeMax = maxSortKey > 0 ? maxSortKey : 1

    timings.rrfMerge = Date.now() - mergeStartedAt

    // 规则重排：新鲜度衰减 + 词覆盖 + 版本约束 + 文件名前缀（kms-rerank.service）
    const nowSec = Math.floor(Date.now() / 1000)
    // 查询已折叠结果所属文件的最新 content_version_id，用于非最新版本降权
    const topFileIds = [...new Set(topResults.map(h => h.result.file_id).filter(Boolean))]
    const latestVersionMap = new Map<string, string>()
    if (topFileIds.length > 0) {
      const versionRows = this.db.prepare(
        `SELECT id, content_version_id FROM kms_files WHERE id IN (${topFileIds.map(() => '?').join(',')})`
      ).all(...topFileIds) as any[]
      for (const row of versionRows) {
        if (row.content_version_id) latestVersionMap.set(row.id, row.content_version_id)
      }
    }

    const rerankInput = topResults.map(h => ({
      item: h.result,
      hints: {
        baseScore: h.sortKey / safeMax,
        modifiedTime: h.result.modified_time,
        contentVersionId: h.result.content_version_id,
        latestVersionId: latestVersionMap.get(h.result.file_id),
        text: h.result.text,
        fileName: h.result.file_name,
        nowSec,
      } as RerankHints,
    }))
    const rerankStartedAt = Date.now()
    const reranked = rerankResults(rerankInput, queryWords)
    timings.rerank = Date.now() - rerankStartedAt

    const finalResults = reranked.map(r => ({
      ...r.item,
      score: r.rerankScore,
      highlights: this.computeHighlights(r.item.text, queryWords),
      matched_keywords: queryWords,
    }))
    logger.info(`hybridSearch "${query}": results=${finalResults.length}, candidates=${hybridResults.length}, timings=${JSON.stringify(timings)}, total=${Date.now() - hybridStartedAt}ms`)
    return finalResults
  }

  /**
   * 统一搜索入口
   */
  search(query: string, queryEmbedding?: Float32Array, options?: SearchOptions): SearchResult[] {
    if (queryEmbedding) {
      return this.hybridSearch(query, queryEmbedding, {
        ...options,
        useVector: true,
      })
    }

    return this.ftsSearch(query, options)
  }

  /**
   * 获取索引统计
   */
  getIndexStats(): {
    totalEntries: number
    byType: Record<string, number>
    embeddingCount: number
    ftsEntryCount: number
  } {
    const totalEntries = (this.db.prepare(
      'SELECT COUNT(*) as count FROM kms_search_index'
    ).get() as any)?.count || 0

    const typeRows = this.db.prepare(
      'SELECT source_type, COUNT(*) as count FROM kms_search_index GROUP BY source_type'
    ).all() as any[]

    const byType: Record<string, number> = {}
    for (const row of typeRows) byType[row.source_type] = row.count

    const embeddingCount = (this.vectorDb.prepare(
      'SELECT COUNT(*) as count FROM kms_embeddings'
    ).get() as any)?.count || 0

    return { totalEntries, byType, embeddingCount, ftsEntryCount: totalEntries }
  }

  /**
   * 存储向量嵌入
   */
  storeEmbedding(
    sourceType: string,
    sourceId: string,
    fileId: string,
    embedding: Float32Array,
    model: string
  ): void {
    // 使用 byteOffset + byteLength 构造 Buffer，避免 Float32Array 是 subarray 视图时
    // 传入完整底层 ArrayBuffer 导致存储了错误的向量数据
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)

    if (!this.getActiveVectorModel()) {
      this.activateVectorModel(model, embedding.length)
    }

    // 同一逻辑条目可按模型保留多版本向量，因此 upsert 必须包含 model
    const upsert = this.vectorDb.transaction(() => {
      const existing = this.vectorDb.prepare(
        'SELECT id, rowid FROM kms_embeddings WHERE source_type = ? AND source_id = ? AND model = ?'
      ).get(sourceType, sourceId, model) as any

      if (existing) {
        this.vectorDb.prepare(`
          UPDATE kms_embeddings SET embedding = ?, model = ?, dimension = ?, updated_at = unixepoch() WHERE id = ?
        `).run(buffer, model, embedding.length, existing.id)
        return existing.rowid
      }

      const id = generateId()
      this.vectorDb.prepare(`
        INSERT INTO kms_embeddings (id, source_type, source_id, file_id, embedding, model, dimension, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, sourceType, sourceId, fileId, buffer, model, embedding.length)
      return Number((this.vectorDb.prepare('SELECT last_insert_rowid() as r').get() as any).r)
    })

    const rowid = upsert()

    // 同步写入当前活动模型的 vec0 虚表；旧模型保留原始 BLOB 但不进入 ANN
    if (this.isActiveVectorEntry(model, embedding.length)) {
      this.syncVecIndex(rowid, buffer, fileId, sourceType, embedding.length)
    }
    this.invalidateEmbeddingCaches()
  }

  /**
   * 批量存储向量嵌入（单事务，消除 per-item 事务开销）
   * 用于 generateEmbeddings 等批量写入场景
   */
  storeEmbeddingsBatch(
    entries: Array<{ sourceType: string; sourceId: string; fileId: string; embedding: Float32Array; model: string }>
  ): void {
    if (entries.length === 0) return

    if (!this.getActiveVectorModel() && entries[0]) {
      this.activateVectorModel(entries[0].model, entries[0].embedding.length)
    }

    const tx = this.vectorDb.transaction(() => {
      for (const e of entries) {
        // 使用 byteOffset + byteLength 构造 Buffer，避免 subarray 视图写入错误数据
        const buffer = Buffer.from(e.embedding.buffer, e.embedding.byteOffset, e.embedding.byteLength)
        const existing = this.vectorDb.prepare(
          'SELECT id, rowid FROM kms_embeddings WHERE source_type = ? AND source_id = ? AND model = ?'
        ).get(e.sourceType, e.sourceId, e.model) as any

        let rowid: number
        if (existing) {
          this.vectorDb.prepare(`
            UPDATE kms_embeddings SET embedding = ?, model = ?, dimension = ?, updated_at = unixepoch() WHERE id = ?
          `).run(buffer, e.model, e.embedding.length, existing.id)
          rowid = existing.rowid
        } else {
          const id = generateId()
          const result = this.vectorDb.prepare(`
            INSERT INTO kms_embeddings (id, source_type, source_id, file_id, embedding, model, dimension, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
          `).run(id, e.sourceType, e.sourceId, e.fileId, buffer, e.model, e.embedding.length)
          rowid = Number(result.lastInsertRowid)
        }

        if (this.vecReady && this.isActiveVectorEntry(e.model, e.embedding.length)) {
          try {
            // 注意：sqlite-vec 0.1.x 在加载了 onnxruntime-node / PaddleOCR 等原生扩展的进程里
            // 会拒绝 number 类型的 rowid（"Only integers are allows for primary key values"）。
            // 改用 BigInt 绑定可绕过该回归，详见 sqlite-vec issue tracker。
            const vecRowid = BigInt(rowid)
            this.vectorDb.prepare('DELETE FROM vec_kms_embeddings WHERE rowid = ?').run(vecRowid)
            this.vectorDb.prepare(
              'INSERT INTO vec_kms_embeddings(rowid, embedding, file_id, source_type) VALUES (?, ?, ?, ?)'
            ).run(vecRowid, buffer, e.fileId, e.sourceType)
          } catch (err: any) {
            logger.warn(`storeEmbeddingsBatch: vec0 sync failed for rowid=${rowid}:`, err?.message || err)
          }
        }
      }
    })

    tx()

    // 批量写入可能包含不同模型/维度，直接清空向量缓存比增量维护多键缓存更安全
    this.invalidateEmbeddingCaches()
  }

  /**
   * 失效指定 fileId 的 embedding 缓存（删除文件时调用）
   * 从 __all__ 缓存数组中过滤掉该 fileId 的条目，避免全量重载
   *
   * 通过 LRU update 接口原地 filter 并重算字节，超限时自动淘汰整个 __all__ 条目。
   * 注意：filter 会产生新数组引用，但 update 接口会将其重新 set 到缓存中。
   */
  private invalidateEmbeddingCacheForFile(fileId: string): void {
    if (!this.embeddingCache) return
    const cached = this.embeddingCache.get('__all__')
    if (!cached) return
    const filtered = cached.filter(e => e.fileId !== fileId)
    if (filtered.length !== cached.length) {
      this.embeddingCache.set('__all__', filtered)
    }
  }

  /**
   * 同步向量到 vec0 虚表：
   * - 延迟创建虚表（首次写入时按 embedding 维度创建）
   * - 维度不匹配时跳过（降级到 JS 检索）
   * - vec0 不支持 UPDATE 向量列，用 DELETE + INSERT 替代
   */
  private syncVecIndex(
    rowid: number,
    buffer: Buffer,
    fileId: string,
    sourceType: string,
    dimension: number
  ): void {
    if (!this.vecReady) return

    if (this.vecDimension === null) {
      this.createVecTable(dimension)
      if (this.vecDimension === null) return
    }

    if (this.vecDimension !== dimension) {
      logger.warn(`向量维度 ${dimension} 与 vec0 虚表维度 ${this.vecDimension} 不匹配，跳过索引写入`)
      return
    }

    try {
      // rowid 必须以 BigInt 绑定以避开 sqlite-vec 0.1.x 在加载了原生扩展时的类型校验回归
      const vecRowid = BigInt(rowid)
      this.vectorDb.prepare('DELETE FROM vec_kms_embeddings WHERE rowid = ?').run(vecRowid)
      this.vectorDb.prepare(
        'INSERT INTO vec_kms_embeddings(rowid, embedding, file_id, source_type) VALUES (?, ?, ?, ?)'
      ).run(vecRowid, buffer, fileId, sourceType)
    } catch (err: any) {
      logger.warn(`vec0 同步失败 rowid=${rowid}:`, err?.message || err)
    }
  }

  invalidateCache(): void {
    this.searchCache.clear()
  }

  invalidateEmbeddingCaches(): void {
    this.embeddingCache?.clear()
  }

  invalidateAllCaches(): void {
    this.indexGeneration++
    this.searchCache.clear()
    this.embeddingCache?.clear()
  }

  private insertFtsRow(indexId: string, fileId: string, sourceType: SourceType, sourceId: string, title: string, content: string, keywords: string): void {
    // 索引侧中文分词：将连续中文切分为空格分隔的词序列，
    // 使 FTS5 unicode61 tokenizer 能按空格建立正确 token 边界，
    // 从而 BM25 排序基于真实词粒度而非整段中文字符串。
    // 注意：FTS5 存储完整原文不做截断，截断会导致搜索词在段落后半部分无法命中
    const segmentedTitle = kmsTokenizer.segment(title)
    const segmentedContent = kmsTokenizer.segment(content)
    this.db.prepare(`
      INSERT INTO kms_fts (index_id, file_id, source_type, source_id, title, content, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(indexId, fileId, sourceType, sourceId, segmentedTitle, segmentedContent, keywords)
  }

  private deleteFtsRow(indexId: string): void {
    this.db.prepare('DELETE FROM kms_fts WHERE index_id = ?').run(indexId)
  }

  private expandContentVersionFileIds(fileIds: string[]): string[] {
    if (fileIds.length === 0) return fileIds
    const versionRows = this.db.prepare(`
      SELECT DISTINCT content_version_id
      FROM kms_files
      WHERE id IN (${fileIds.map(() => '?').join(',')}) AND content_version_id != ''
    `).all(...fileIds) as any[]
    if (versionRows.length === 0) return fileIds
    const versionIds = versionRows.map(r => r.content_version_id)
    const canonicalRows = this.db.prepare(`
      SELECT DISTINCT canonical_file_id
      FROM kms_content_versions
      WHERE id IN (${versionIds.map(() => '?').join(',')}) AND canonical_file_id IS NOT NULL
    `).all(...versionIds) as any[]
    return [...new Set([...fileIds, ...canonicalRows.map(r => r.canonical_file_id)])]
  }

  private convertFtsResultsToSearchResults(ftsResults: any[], topK: number, queryWords?: string[]): SearchResult[] {
    // 批量预加载所有 fileId 对应的文件信息，避免循环内 N+1 查询
    const fileIds = [...new Set(ftsResults.map(r => r.file_id).filter(Boolean))]
    const fileCache: Map<string, { name: string; path: string; modified_time?: number; content_version_id?: string }> = new Map()
    if (fileIds.length > 0) {
      const placeholders = fileIds.map(() => '?').join(',')
      const rows = this.db.prepare(
        `SELECT id, file_name, file_path, modified_time, content_version_id FROM kms_files WHERE id IN (${placeholders})`
      ).all(...fileIds) as any[]
      for (const row of rows) {
        fileCache.set(row.id, {
          name: row.file_name || '',
          path: row.file_path || '',
          modified_time: row.modified_time,
          content_version_id: row.content_version_id || '',
        })
      }
    }
    const getFile = (fileId: string) => {
      return fileCache.get(fileId) ?? { name: '', path: '', modified_time: undefined, content_version_id: '' }
    }

    const results: SearchResult[] = []
    const seen = new Set<string>()
    const seenContent = new Set<string>()

    for (const row of ftsResults) {
      const key = `${row.source_type}-${row.source_id}-${row.paragraph_index || 0}`
      if (seen.has(key)) continue
      seen.add(key)

      const fileInfo = getFile(row.file_id)
      const metadata = this.safeParseJSON(row.metadata_json, {}) as Record<string, any>
      const contentKey = fileInfo.content_version_id || row.file_id
      if (seenContent.has(contentKey)) continue
      seenContent.add(contentKey)

      let result: SearchResult

      switch (row.source_type as SourceType) {
        case 'file_title':
          result = {
            file_id: row.file_id,
            file_name: fileInfo.name,
            file_path: fileInfo.path,
            modified_time: fileInfo.modified_time,
            text: `文件标题匹配: ${row.title}`,
            match_type: 'file_title',
          }
          break

        case 'document':
          result = {
            file_id: row.file_id,
            file_name: fileInfo.name,
            file_path: fileInfo.path,
            modified_time: fileInfo.modified_time,
            paragraph_id: row.source_id,
            text: (row.content || '').substring(0, 400),
            match_type: 'document',
          }
          break

        case 'file_summary':
          result = {
            file_id: row.file_id,
            file_name: fileInfo.name,
            file_path: fileInfo.path,
            modified_time: fileInfo.modified_time,
            text: `文件摘要: ${(row.content || '').substring(0, 300)}${(row.content || '').length > 300 ? '...' : ''}`,
            match_type: 'file_summary',
          }
          break

        case 'paragraph':
          result = {
            file_id: row.file_id,
            file_name: fileInfo.name,
            file_path: fileInfo.path,
            modified_time: fileInfo.modified_time,
            paragraph_id: row.source_id,
            paragraph_title: row.title,
            text: `段落「${row.title || ''}」(${metadata.title_path || ''}): ${metadata.summary || row.content || ''}`.substring(0, 400),
            match_type: 'paragraph',
            start_offset: row.start_offset,
            end_offset: row.end_offset,
          }
          break

        case 'content_paragraph':
          result = {
            file_id: row.file_id,
            file_name: fileInfo.name,
            file_path: fileInfo.path,
            modified_time: fileInfo.modified_time,
            // 段落自身 id（kms_search_index.source_id）：与向量侧键（sourceType-sourceId）
            // 保持一致，hybridSearch RRF 才能把同一段落的 FTS/向量命中融合为一条
            paragraph_id: row.source_id,
            text: (row.content || '').substring(0, 400),
            match_type: 'content_paragraph',
            start_offset: row.start_offset,
            end_offset: row.end_offset,
            start_line: row.start_line,
            end_line: row.end_line,
          }
          break

        default:
          continue
      }

      result.content_version_id = fileInfo.content_version_id
      results.push(result)
    }

    // 计算关键词高亮
    if (queryWords && queryWords.length > 0) {
      for (const r of results) {
        r.highlights = this.computeHighlights(r.text, queryWords)
        r.matched_keywords = queryWords
      }
    }

    return results.slice(0, topK)
  }

  private loadAllEmbeddings(modelFilter?: string, dimensionFilter?: number): EmbeddingEntry[] {
    const conditions: string[] = []
    const params: any[] = []
    conditions.push('COALESCE(archived, 0) = 0')
    if (dimensionFilter && dimensionFilter > 0) {
      conditions.push('dimension = ?')
      params.push(dimensionFilter)
    }
    if (modelFilter) {
      conditions.push('model = ?')
      params.push(modelFilter)
    }
    const whereClause = ` WHERE ${conditions.join(' AND ')}`
    const countRow = this.vectorDb.prepare(
      `SELECT COUNT(*) AS cnt FROM kms_embeddings${whereClause}`
    ).get(...params) as any
    if (Number(countRow?.cnt ?? 0) > VECTOR_FALLBACK_MAX_SCAN) {
      logger.warn(`Skip unbounded JS vector scan: ${countRow.cnt} candidates exceed ${VECTOR_FALLBACK_MAX_SCAN}`)
      return []
    }

    const cacheKey = `__all__:${modelFilter || ''}:${dimensionFilter || 0}`
    // Worker 模式下无 embedding 缓存，每次都从 DB 加载（Worker 仅做写入，不读）
    if (this.embeddingCache) {
      const cached = this.embeddingCache.get(cacheKey)
      if (cached) return cached
    }

    const rows = this.vectorDb.prepare(
      `SELECT id, source_type, source_id, file_id, embedding, model, dimension
       FROM kms_embeddings${whereClause}
       LIMIT ?`
    ).all(...params, VECTOR_FALLBACK_MAX_SCAN) as any[]

    const entries: EmbeddingEntry[] = rows
      .filter(row => row.embedding && row.dimension > 0 && row.embedding.length / 4 === row.dimension)
      .map(row => ({
        id: row.id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        fileId: row.file_id,
        embedding: new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimension),
        model: row.model,
        dimension: row.dimension,
      }))

    // LRU set：若 entries 总字节超过 EMBEDDING_CACHE_MAX_BYTES，
    // 将拒绝缓存（下次仍从 DB 加载），避免内存占用过高
    if (this.embeddingCache) {
      this.embeddingCache.set(cacheKey, entries)
    }
    return entries
  }

  /**
   * 按过滤条件加载 embeddings（不下发全量缓存，直接 SQL WHERE 过滤）
   * 用于 vectorSearchViaJS 有 fileIds/sourceTypes 过滤时的场景，避免全量加载。
   * 大批量 fileIds（>500）分批查询合并结果，避免 SQLite 参数上限 999。
   */
  private loadEmbeddingsFiltered(
    fileIds?: string[],
    sourceTypes?: string[],
    modelFilter?: string,
    dimensionFilter?: number
  ): EmbeddingEntry[] {
    // sourceTypes 通常只有几种（file_title/file_summary/paragraph/content_paragraph），不会超限
    // fileIds 可能来自大目录/大合集，需分批；累计达到 fallback 扫描上限后停止
    if (fileIds && fileIds.length > 500) {
      const allEntries: EmbeddingEntry[] = []
      for (let i = 0; i < fileIds.length; i += 500) {
        const batch = fileIds.slice(i, i + 500)
        const remaining = VECTOR_FALLBACK_MAX_SCAN - allEntries.length
        if (remaining <= 0) {
          logger.warn(`Stop filtered JS vector scan at ${VECTOR_FALLBACK_MAX_SCAN} candidates`)
          break
        }
        const entries = this.loadEmbeddingsFilteredSingle(batch, sourceTypes, modelFilter, dimensionFilter, remaining)
        allEntries.push(...entries)
      }
      return allEntries
    }
    return this.loadEmbeddingsFilteredSingle(fileIds, sourceTypes, modelFilter, dimensionFilter, VECTOR_FALLBACK_MAX_SCAN)
  }

  private loadEmbeddingsFilteredSingle(
    fileIds?: string[],
    sourceTypes?: string[],
    modelFilter?: string,
    dimensionFilter?: number,
    limit: number = VECTOR_FALLBACK_MAX_SCAN
  ): EmbeddingEntry[] {
    const conditions: string[] = ['COALESCE(archived, 0) = 0']
    const params: any[] = []
    if (fileIds && fileIds.length > 0) {
      const placeholders = fileIds.map(() => '?').join(',')
      conditions.push(`file_id IN (${placeholders})`)
      params.push(...fileIds)
    }
    if (sourceTypes && sourceTypes.length > 0) {
      const placeholders = sourceTypes.map(() => '?').join(',')
      conditions.push(`source_type IN (${placeholders})`)
      params.push(...sourceTypes)
    }
    if (dimensionFilter && dimensionFilter > 0) {
      conditions.push('dimension = ?')
      params.push(dimensionFilter)
    }
    if (modelFilter) {
      conditions.push('model = ?')
      params.push(modelFilter)
    }
    const whereClause = ` WHERE ${conditions.join(' AND ')}`
    const rows = this.vectorDb.prepare(
      `SELECT id, source_type, source_id, file_id, embedding, model, dimension
       FROM kms_embeddings${whereClause}
       LIMIT ?`
    ).all(...params, limit) as any[]

    // 与 loadAllEmbeddings 保持一致：过滤掉异常 BLOB 或 dimension<=0 的脏行
    return rows
      .filter(row => row.embedding && row.dimension > 0 && row.embedding.length / 4 === row.dimension)
      .map(row => ({
        id: row.id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        fileId: row.file_id,
        embedding: new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimension),
        model: row.model,
        dimension: row.dimension,
      }))
  }

  private getFromCache(key: string): SearchResult[] | null {
    const entry = this.searchCache.get(key)
    if (!entry) return null
    if (Date.now() - entry.timestamp > KMSSearchEngineService.CACHE_TTL) {
      this.searchCache.delete(key)
      return null
    }
    // LRU：命中时先删除再重新插入，使该键移到 Map 末尾（最近使用），避免被 FIFO 淘汰
    this.searchCache.delete(key)
    this.searchCache.set(key, entry)
    return entry.results
  }

  private putToCache(key: string, results: SearchResult[]): void {
    // 若 key 已存在，先删除以更新插入顺序（LRU 语义）
    if (this.searchCache.has(key)) {
      this.searchCache.delete(key)
    }
    if (this.searchCache.size >= KMSSearchEngineService.CACHE_MAX_SIZE) {
      // Map 的 keys().next() 返回最早插入且未再访问的键（LRU 淘汰）
      const oldestKey = this.searchCache.keys().next().value
      if (oldestKey) this.searchCache.delete(oldestKey)
    }
    this.searchCache.set(key, { results, timestamp: Date.now() })
  }

  private safeParseJSON<T>(raw: string, fallback: T): T {
    try {
      return JSON.parse(raw || 'null') ?? fallback
    } catch {
      return fallback
    }
  }

  /**
   * 计算文本中关键词的高亮范围
   */
  private computeHighlights(text: string, queryWords: string[]): HighlightRange[] {
    if (!text || !queryWords.length) return []

    const ranges: HighlightRange[] = []
    const textLower = text.toLowerCase()

    for (const word of queryWords) {
      if (!word) continue
      let startPos = 0
      while (startPos < textLower.length) {
        const idx = textLower.indexOf(word, startPos)
        if (idx === -1) break
        ranges.push({ start: idx, end: idx + word.length })
        startPos = idx + 1
      }
    }

    // 合并重叠的范围
    if (ranges.length === 0) return []

    ranges.sort((a, b) => a.start - b.start)
    const merged: HighlightRange[] = [ranges[0]]
    for (let i = 1; i < ranges.length; i++) {
      const last = merged[merged.length - 1]
      if (ranges[i].start <= last.end) {
        last.end = Math.max(last.end, ranges[i].end)
      } else {
        merged.push(ranges[i])
      }
    }

    return merged
  }
}

export default KMSSearchEngineService
