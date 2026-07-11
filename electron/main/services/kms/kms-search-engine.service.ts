import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'
import kmsTokenizer from './kms-tokenizer.service'
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
  /**
   * embedding 内存缓存（LRU + 字节上限）
   *
   * 替代原无上限 Map，限制总字节 ≤ EMBEDDING_CACHE_MAX_BYTES（256MB）。
   * 大索引场景下超限的 __all__ 条目将不被缓存，向量检索回退到 DB 全量加载。
   */
  private embeddingCache: LRUBoundedCache<EmbeddingEntry[]> = new LRUBoundedCache(
    EMBEDDING_CACHE_MAX_BYTES,
    computeEmbeddingEntriesBytes
  )
  private vecDimension: number | null = null
  private vecReady: boolean = false

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
      const dimRow = this.vectorDb.prepare(
        'SELECT dimension FROM kms_embeddings ORDER BY updated_at DESC LIMIT 1'
      ).get() as any
      if (dimRow?.dimension) {
        this.vecDimension = dimRow.dimension
      }
      logger.info(`vec0 虚表已存在，维度=${this.vecDimension}`)
      return
    }

    const countRow = this.vectorDb.prepare(
      'SELECT COUNT(*) as count, dimension FROM kms_embeddings GROUP BY dimension ORDER BY count DESC LIMIT 1'
    ).get() as any
    if (!countRow || countRow.count === 0) {
      logger.info('kms_embeddings 表为空，vec0 虚表将延迟到首次写入时创建')
      return
    }

    const dimension = countRow.dimension
    this.createVecTable(dimension)
    this.migrateExistingEmbeddings(dimension)
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

  private migrateExistingEmbeddings(dimension: number): void {
    try {
      const rows = this.vectorDb.prepare(
        'SELECT rowid, embedding, file_id, source_type FROM kms_embeddings WHERE dimension = ?'
      ).all(dimension) as any[]

      if (rows.length === 0) return

      const insertStmt = this.vectorDb.prepare(
        'INSERT INTO vec_kms_embeddings(rowid, embedding, file_id, source_type) VALUES (?, ?, ?, ?)'
      )
      const migrate = this.vectorDb.transaction(() => {
        for (const row of rows) {
          try {
            // rowid 必须以 BigInt 绑定以避开 sqlite-vec 0.1.x 在加载了原生扩展时的类型校验回归
            insertStmt.run(BigInt(row.rowid), row.embedding, row.file_id, row.source_type)
          } catch (err: any) {
            logger.warn(`迁移 rowid=${row.rowid} 失败:`, err?.message || err)
          }
        }
      })
      migrate()
      logger.info(`vec0 迁移完成，共迁移 ${rows.length} 条向量`)
    } catch (err: any) {
      logger.error('vec0 数据迁移失败:', err?.message || err)
    }
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

    const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 20)
    if (paragraphs.length === 0) return

    const lines = content.split('\n')
    const lineOffsets: number[] = []
    let offset = 0
    for (const line of lines) {
      lineOffsets.push(offset)
      offset += line.length + 1
    }

    // kms_search_index.content 只存前 500 字符（用于搜索结果 snippet 和 embedding 生成），
    // FTS5 仍索引完整原文（用于全文搜索）。
    // 这样 kms_search_index 表体积减少 50%+，而搜索能力不受影响：
    // - 搜索结果显示用 content.substring(0, 400)（< 500）
    // - embedding 生成用 content.substring(0, 500)（= 500）
    // - FTS5 全文搜索仍能匹配完整原文
    // - LIKE 搜索只能匹配前 500 字符（可接受，LIKE 是 FTS5 的 fallback）
    const SEARCH_INDEX_CONTENT_LIMIT = 500

    let currentOffset = 0
    const insertIndex = this.db.prepare(`
      INSERT INTO kms_search_index (id, file_id, source_type, source_id, paragraph_index, title, content, start_offset, end_offset, start_line, end_line, created_at, updated_at)
      VALUES (?, ?, 'content_paragraph', ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `)

    const transaction = this.db.transaction(() => {
      for (let pi = 0; pi < paragraphs.length; pi++) {
        const para = paragraphs[pi]
        const paraStartOffset = content.indexOf(para, currentOffset)
        const paraEndOffset = paraStartOffset + para.length

        let startLine = 1
        let endLine = 1
        for (let i = 0; i < lineOffsets.length; i++) {
          if (lineOffsets[i] <= paraStartOffset) startLine = i + 1
          if (lineOffsets[i] < paraEndOffset) endLine = i + 1
        }

        const id = generateId()
        // kms_search_index 只存截断后的 content，节省存储
        const truncatedContent = para.length > SEARCH_INDEX_CONTENT_LIMIT
          ? para.substring(0, SEARCH_INDEX_CONTENT_LIMIT)
          : para
        insertIndex.run(id, fileId, fileId, pi, fileName, truncatedContent,
          paraStartOffset, paraEndOffset, startLine, endLine)

        // FTS5 索引完整原文，保证全文搜索能力
        this.insertFtsRow(id, fileId, 'content_paragraph', fileId, fileName, para, '')

        currentOffset = paraEndOffset
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
    if (paraIndexRows.length > 0) {
      const ids = paraIndexRows.map(r => r.id)
      const placeholders = ids.map(() => '?').join(',')
      this.db.prepare(`DELETE FROM kms_fts WHERE index_id IN (${placeholders})`).run(...ids)
      this.db.prepare(
        "DELETE FROM kms_search_index WHERE file_id = ? AND source_type = 'paragraph'"
      ).run(fileId)
    }
    // 删除段落对应的向量（向量库独立事务）
    const paraIds = (this.db.prepare('SELECT id FROM kms_paragraphs WHERE file_id = ?').all(fileId) as any[]).map(r => r.id)
    if (paraIds.length > 0) {
      this.deleteEmbeddingsBySourceTypeAndIds('paragraph', paraIds)
    }
    // 删除段落本身
    this.db.prepare('DELETE FROM kms_paragraphs WHERE file_id = ?').run(fileId)
    this.invalidateCache()
  }

  deleteParagraphsFromFileIndex(fileId: string, fromIndex: number): void {
    const paraRows = this.db.prepare(
      'SELECT id FROM kms_paragraphs WHERE file_id = ? AND paragraph_index >= ?'
    ).all(fileId, fromIndex) as any[]
    const paraIds = paraRows.map(r => r.id)
    if (paraIds.length === 0) return

    const placeholders = paraIds.map(() => '?').join(',')

    const indexRows = this.db.prepare(
      `SELECT id FROM kms_search_index WHERE file_id = ? AND source_type = 'paragraph' AND source_id IN (${placeholders})`
    ).all(fileId, ...paraIds) as any[]
    if (indexRows.length > 0) {
      const ids = indexRows.map(r => r.id)
      const idxPlaceholders = ids.map(() => '?').join(',')
      this.db.prepare(`DELETE FROM kms_fts WHERE index_id IN (${idxPlaceholders})`).run(...ids)
      this.db.prepare(
        `DELETE FROM kms_search_index WHERE file_id = ? AND source_type = 'paragraph' AND source_id IN (${placeholders})`
      ).run(fileId, ...paraIds)
    }

    // 删除段落对应的向量（向量库独立事务）
    this.deleteEmbeddingsBySourceTypeAndIds('paragraph', paraIds)

    this.db.prepare(
      'DELETE FROM kms_paragraphs WHERE file_id = ? AND paragraph_index >= ?'
    ).run(fileId, fromIndex)
    this.invalidateCache()
  }

  /**
   * 按 source_type + source_id 批量删除 embedding 记录和对应的 vec0 虚表行。
   *
   * 由于 kms_embeddings 在独立的向量库，需在向量库独立事务中执行。
   */
  private deleteEmbeddingsBySourceTypeAndIds(sourceType: string, sourceIds: string[]): void {
    if (sourceIds.length === 0) return
    const placeholders = sourceIds.map(() => '?').join(',')
    const vecTx = this.vectorDb.transaction(() => {
      // 收集要删除的 rowid
      let rowids: number[] = []
      try {
        const rows = this.vectorDb.prepare(
          `SELECT rowid FROM kms_embeddings WHERE source_type = ? AND source_id IN (${placeholders})`
        ).all(sourceType, ...sourceIds) as any[]
        rowids = rows.map(r => r.rowid)
      } catch (err: any) {
        logger.warn(`查询 ${sourceType} 的 embedding rowid 失败:`, err?.message || err)
      }

      this.vectorDb.prepare(
        `DELETE FROM kms_embeddings WHERE source_type = ? AND source_id IN (${placeholders})`
      ).run(sourceType, ...sourceIds)

      if (rowids.length > 0 && this.vecReady) {
        const rowidPlaceholders = rowids.map(() => '?').join(',')
        try {
          // rowid 必须以 BigInt 绑定以避开 sqlite-vec 0.1.x 在加载了原生扩展时的类型校验回归
          this.vectorDb.prepare(`DELETE FROM vec_kms_embeddings WHERE rowid IN (${rowidPlaceholders})`).run(...rowids.map(r => BigInt(r)))
        } catch (err: any) {
          logger.warn(`清理 vec_kms_embeddings 失败 (${sourceType}):`, err?.message || err)
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

    // 主库事务：删除 fts、search_index、paragraphs
    const tx = this.db.transaction(() => {
      if (rows.length > 0) {
        const ids = rows.map(r => r.id)
        const placeholders = ids.map(() => '?').join(',')
        this.db.prepare(`DELETE FROM kms_fts WHERE index_id IN (${placeholders})`).run(...ids)
      }
      this.db.prepare('DELETE FROM kms_search_index WHERE file_id = ?').run(fileId)
      this.db.prepare('DELETE FROM kms_paragraphs WHERE file_id = ?').run(fileId)
    })
    tx()

    // 向量库独立事务：删除 kms_embeddings + vec_kms_embeddings（跨库不能同事务）
    this.deleteEmbeddingsByFile(fileId)

    // 仅失效受影响 fileId 的缓存条目；__all__ 缓存通过过滤移除该文件向量，避免全量重载
    this.invalidateEmbeddingCacheForFile(fileId)
    this.invalidateCache()
  }

  /**
   * 删除指定文件的所有 embedding 记录和对应的 vec0 虚表行。
   *
   * 由于 kms_embeddings 已迁移到独立的向量库，无法和主库共用事务，
   * 需要在向量库独立事务中执行删除。
   */
  private deleteEmbeddingsByFile(fileId: string): void {
    const vecTx = this.vectorDb.transaction(() => {
      // 先收集要删除的 rowid（vec_kms_embeddings 通过 rowid 关联 kms_embeddings）
      let rowids: number[] = []
      try {
        const rows = this.vectorDb.prepare(
          'SELECT rowid FROM kms_embeddings WHERE file_id = ?'
        ).all(fileId) as any[]
        rowids = rows.map(r => r.rowid)
      } catch (err: any) {
        logger.warn(`查询 file_id=${fileId} 的 embedding rowid 失败:`, err?.message || err)
      }

      this.vectorDb.prepare('DELETE FROM kms_embeddings WHERE file_id = ?').run(fileId)

      // 删除 vec_kms_embeddings 虚表中的对应行（不会自动级联）
      if (rowids.length > 0 && this.vecReady) {
        const placeholders = rowids.map(() => '?').join(',')
        try {
          // rowid 必须以 BigInt 绑定以避开 sqlite-vec 0.1.x 在加载了原生扩展时的类型校验回归
          this.vectorDb.prepare(`DELETE FROM vec_kms_embeddings WHERE rowid IN (${placeholders})`).run(...rowids.map(r => BigInt(r)))
        } catch (err: any) {
          logger.warn(`清理 vec_kms_embeddings 失败 (file_id=${fileId}):`, err?.message || err)
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

    if (rows.length > 0) {
      const ids = rows.map(r => r.id)
      const placeholders = ids.map(() => '?').join(',')
      this.db.prepare(`DELETE FROM kms_fts WHERE index_id IN (${placeholders})`).run(...ids)
    }

    this.db.prepare(
      'DELETE FROM kms_search_index WHERE file_id = ? AND source_type = ?'
    ).run(fileId, sourceType)
  }

  /**
   * 克隆索引数据（用于MD5去重：相同内容文件复用索引）
   * 同时克隆对应的 embedding 记录，避免去重文件缺少向量嵌入
   */
  cloneIndexData(sourceFileId: string, targetFileId: string): void {
    const sourceRows = this.db.prepare(
      'SELECT * FROM kms_search_index WHERE file_id = ?'
    ).all(sourceFileId) as any[]

    if (sourceRows.length === 0) return

    // 预加载源文件的 embedding 记录（向量库）
    const sourceEmbeddings = this.vectorDb.prepare(
      'SELECT * FROM kms_embeddings WHERE file_id = ?'
    ).all(sourceFileId) as any[]

    // 建立 source_type+source_id → embedding 记录 的映射
    const embeddingMap = new Map<string, any>()
    for (const emb of sourceEmbeddings) {
      embeddingMap.set(`${emb.source_type}:${emb.source_id}`, emb)
    }

    // 收集需要克隆的 embedding 数据，待主库事务完成后在向量库独立事务中写入
    const embeddingsToClone: Array<{
      sourceType: string
      sourceId: string
      embedding: any
      model: string
      dimension: number
    }> = []

    // 主库事务：克隆 kms_search_index + kms_fts
    const transaction = this.db.transaction(() => {
      for (const row of sourceRows) {
        const newId = generateId()
        // 保留原 source_id，使 LEFT JOIN 能匹配到原文件的 embedding
        this.db.prepare(`
          INSERT INTO kms_search_index (id, file_id, source_type, source_id, paragraph_index, title, content, keywords_json, metadata_json, start_offset, end_offset, start_line, end_line, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(
          newId, targetFileId, row.source_type, row.source_id,
          row.paragraph_index, row.title, row.content,
          row.keywords_json, row.metadata_json,
          row.start_offset, row.end_offset, row.start_line, row.end_line
        )

        this.insertFtsRow(newId, targetFileId, row.source_type as SourceType, row.source_id, row.title, row.content, '')

        // 收集对应的 embedding 记录，稍后在向量库事务中写入
        const embKey = `${row.source_type}:${row.source_id}`
        const sourceEmb = embeddingMap.get(embKey)
        if (sourceEmb) {
          embeddingsToClone.push({
            sourceType: sourceEmb.source_type,
            sourceId: sourceEmb.source_id,
            embedding: sourceEmb.embedding,
            model: sourceEmb.model,
            dimension: sourceEmb.dimension,
          })
        }
      }
    })

    transaction()

    // 向量库独立事务：克隆 kms_embeddings + vec_kms_embeddings
    // 跨库不能共用事务，需在向量库独立事务中执行
    if (embeddingsToClone.length > 0) {
      const vecTx = this.vectorDb.transaction(() => {
        for (const emb of embeddingsToClone) {
          const embResult = this.vectorDb.prepare(`
            INSERT INTO kms_embeddings (source_type, source_id, file_id, embedding, model, dimension, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, unixepoch())
          `).run(
            emb.sourceType, emb.sourceId, targetFileId,
            emb.embedding, emb.model, emb.dimension
          )

          if (this.vecReady && this.vecDimension && emb.dimension === this.vecDimension) {
            try {
              const vecRowId = Number(embResult.lastInsertRowid)
              if (vecRowId > 0) {
                // rowid 必须以 BigInt 绑定以避开 sqlite-vec 0.1.x 在加载了原生扩展时的类型校验回归
                this.vectorDb.prepare(
                  'INSERT INTO vec_kms_embeddings(rowid, embedding, file_id, source_type) VALUES (?, ?, ?, ?)'
                ).run(BigInt(vecRowId), emb.embedding, targetFileId, emb.sourceType)
              }
            } catch (err: any) {
              logger.warn(`cloneIndexData: vec0 insert failed for targetFile=${targetFileId}:`, err?.message || err)
            }
          }
        }
      })
      vecTx()
    }

    this.invalidateCache()
  }

  /**
   * FTS5 全文检索
   */
  ftsSearch(query: string, options?: SearchOptions): SearchResult[] {
    const topK = options?.topK || 10
    const cacheKey = `fts:${query}:${topK}:${JSON.stringify(options)}`
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
        WHERE kms_fts MATCH ? AND ${whereClause}
        ORDER BY fts.rank
        LIMIT ?
      `).all(ftsQuery, ...params, topK * 2) as any[]

      const convertStart = Date.now()
      let results = this.convertFtsResultsToSearchResults(ftsResults, topK, queryWords)
      logger.info(`ftsSearch "${query}": tokenize=${convertStart - tokenizeStart}ms, fts=${convertStart - ftsStart}ms, convert=${Date.now() - convertStart}ms, results=${results.length}`)

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

    // 优先用 vec0 KNN 索引；维度不匹配或未就绪时回退到 JS 全扫描
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

    // 无文件作用域过滤，直接返回原 options（保留原 fileIds 语义）
    if (!hasCollection && !hasDir && !hasExt && !hasTime) return options

    const sets: string[][] = []
    if (fileIds?.length) sets.push(fileIds)

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

    return { ...options, fileIds: resolved }
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

      if (options?.fileIds && options.fileIds.length > 0) {
        const placeholders = options.fileIds.map(() => '?').join(',')
        whereClause += ` AND file_id IN (${placeholders})`
        params.push(...options.fileIds)
      }

      if (options?.sourceTypes && options.sourceTypes.length > 0) {
        const placeholders = options.sourceTypes.map(() => '?').join(',')
        whereClause += ` AND source_type IN (${placeholders})`
        params.push(...options.sourceTypes)
      }

      const knnRows = this.vectorDb.prepare(
        `SELECT rowid, distance FROM vec_kms_embeddings WHERE ${whereClause} ORDER BY distance`
      ).all(...params) as any[]

      // KNN 返回 0 行时返回 null 触发 JS 全扫描兜底，而非返回空数组。
      // vec0 索引可能因并发写入、内部状态等原因暂时返回 0 行，
      // 此时 kms_embeddings 表中仍有数据，JS 扫描可以正常返回结果。
      if (knnRows.length === 0) return null

      // 回查 kms_embeddings 获取元数据
      const rowids = knnRows.map(r => r.rowid)
      const placeholders = rowids.map(() => '?').join(',')
      const metaRows = this.vectorDb.prepare(
        `SELECT rowid, source_type, source_id, file_id FROM kms_embeddings WHERE rowid IN (${placeholders})`
      ).all(...rowids) as any[]

      // vec0 返回的 rowid 可能为 BigInt，kms_embeddings 返回的 rowid 为 number，
      // 统一转为 Number 作为 Map key，避免类型不一致导致查找失败
      const metaMap = new Map<number, any>()
      for (const row of metaRows) {
        metaMap.set(Number(row.rowid), row)
      }

      return knnRows.map(knn => {
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
    // 按过滤条件加载 embeddings：有过滤时下推 SQL，无过滤时使用全量缓存
    const hasFileFilter = options?.fileIds && options.fileIds.length > 0
    const hasTypeFilter = options?.sourceTypes && options.sourceTypes.length > 0
    const embeddings = (hasFileFilter || hasTypeFilter)
      ? this.loadEmbeddingsFiltered(options!.fileIds, options!.sourceTypes as string[])
      : this.loadAllEmbeddings()

    if (embeddings.length === 0) return []

    const queryNorm = norm(queryEmbedding)
    if (queryNorm === 0) return []

    // 防御性过滤：即使 loadAllEmbeddings/loadEmbeddingsFiltered 已过滤脏行，
    // 缓存中的旧条目仍可能存在 embedding 为 null/空 的边缘情况（如旧版本写入的脏数据）
    const validEmbeddings = embeddings.filter(e => e.embedding && e.embedding.length > 0)
    if (validEmbeddings.length === 0) return []

    const scored = validEmbeddings.map(e => {
      const similarity = cosineSimilarity(queryEmbedding, e.embedding, queryNorm)
      return {
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        fileId: e.fileId,
        score: similarity
      }
    })

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
    if (queryWords.length === 0) return []

    // 构建文件名 LIKE 子句（OR 关系，任一关键词命中即可）
    const nameClauses: string[] = []
    const nameParams: any[] = []
    for (const word of queryWords) {
      nameClauses.push('LOWER(f.file_name) LIKE ?')
      nameParams.push(`%${word}%`)
    }
    const nameWhere = nameClauses.join(' OR ')

    // 过滤条件：复用 buildLikeWhereClause 中除 si 相关外的语义，
    // 改为直接引用 f.* 字段，collectionIds/dirIds 走子查询。
    const conditions: string[] = ['1=1']
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

    // 多取 topK*3 候选供 JS 精排
    const candidateLimit = Math.min(topK * 3, 500)
    const rows = this.db.prepare(`
      SELECT f.id as file_id, f.file_name, f.file_path, f.modified_time
      FROM kms_files f
      WHERE ${conditions.join(' AND ')} AND (${nameWhere})
      LIMIT ${candidateLimit}
    `).all(...filterParams, ...nameParams) as any[]

    // JS 精排：长词权重 + 关键词匹配率，与 likeSearch 一致
    const scored = rows.map(row => {
      const name = (row.file_name || '').toLowerCase()
      let score = 0
      let matchCount = 0
      for (const word of queryWords) {
        if (name.includes(word)) {
          score += word.length * 2
          matchCount++
        }
      }
      const matchRatio = matchCount / queryWords.length
      return { row, score: score * (0.5 + matchRatio * 0.5) }
    }).filter(r => r.score > 0)

    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, topK)

    return top.map(s => {
      const text = s.row.file_name || ''
      return {
        file_id: s.row.file_id,
        file_name: s.row.file_name,
        file_path: s.row.file_path,
        modified_time: s.row.modified_time,
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
   * 三个独立来源的 RRF 融合：关键词（FTS5）+ 语义（向量）+ 文件名（LIKE）。
   * 文档在任意单一来源命中即可被召回，同时命中多来源时按各来源排名叠加得分。
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
    const topK = options?.topK || 10
    const useVector = options?.useVector !== false && queryEmbedding !== null
    const queryWords = extractQueryKeywords(query)

    // FTS5 关键词搜索
    // ftsSearch 内部已有 try-catch 降级到 LIKE，但 LIKE 路径中的 convertFtsResultsToSearchResults
    // 仍可能因脏数据（如 content 为 null）抛出异常。此处再加一层兜底，确保 hybridSearch 不中断。
    let ftsResults: SearchResult[] = []
    try {
      ftsResults = this.ftsSearch(query, { ...options, topK: topK * 2 })
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
        const vectorResults = this.vectorSearch(queryEmbedding, { ...options, topK: topK * 2 })
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
      fileNameResults = this.fileNameSearch(query, { ...options, topK: topK * 2 })
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

    // RRF 融合：score = Σ 1/(k + rank_i)，i ∈ {fts, vec, file_name}
    // 来源缺失的贡献为 0（rank undefined → 跳过）
    const allKeys = new Set([...ftsRankMap.keys(), ...vecRankMap.keys(), ...fileNameRankMap.keys()])
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
        sortKey += 1 / (RRF_K + fileNameRank)
      }

      const ftsResult = ftsResultMap.get(key)

      if (ftsResult) {
        hybridResults.push({
          result: {
            ...ftsResult,
            match_type: (useVector || fileNameRank !== undefined) ? 'hybrid' : ftsResult.match_type,
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
      const conditions = missingEntries.map(() => '(source_type = ? AND source_id = ?)').join(' OR ')
      const params = missingEntries.flatMap(m => [m.vs.sourceType, m.vs.sourceId])
      const indexRows = this.db.prepare(
        `SELECT source_type, source_id, file_id, title, content, start_offset, end_offset FROM kms_search_index WHERE ${conditions}`
      ).all(...params) as any[]

      const fileIds = [...new Set(indexRows.map(r => r.file_id).filter(Boolean))]
      const fileMap = new Map<string, { file_name: string; file_path: string; modified_time?: number }>()
      if (fileIds.length > 0) {
        const fileRows = this.db.prepare(
          `SELECT id, file_name, file_path, modified_time FROM kms_files WHERE id IN (${fileIds.map(() => '?').join(', ')})`
        ).all(...fileIds) as any[]
        for (const row of fileRows) {
          fileMap.set(row.id, { file_name: row.file_name, file_path: row.file_path, modified_time: row.modified_time })
        }
      }

      const indexMap = new Map<string, any>()
      for (const row of indexRows) {
        indexMap.set(`${row.source_type}-${row.source_id}`, row)
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
              paragraph_id: entry.vs.sourceType === 'paragraph' ? entry.vs.sourceId : undefined,
              paragraph_title: indexEntry.title,
              text: (indexEntry.content || '').substring(0, 300),
              match_type: 'hybrid',
              start_offset: indexEntry.start_offset,
              end_offset: indexEntry.end_offset,
              score: entry.sortKey,
            },
            sortKey: entry.sortKey,
          })
        }
      }
    }

    // 合并文件名命中结果后统一排序
    hybridResults.push(...fileNameOnlyResults)
    hybridResults.sort((a, b) => b.sortKey - a.sortKey)
    const topResults = hybridResults.slice(0, topK)

    // RRF 分数归一化到 [0, 1]：除以本批最大分数，使 Top 结果 score=1.0
    // 前端 KMSSearchResultList 按 score*100 渲染匹配度进度条，未归一化的 RRF 原始分数
    //（最大约 2/61 ≈ 0.033）会导致进度条几乎不可见
    const maxSortKey = topResults.length > 0 ? topResults[0].sortKey : 0
    const safeMax = maxSortKey > 0 ? maxSortKey : 1

    return topResults.map(h => ({
      ...h.result,
      score: h.sortKey / safeMax,
      highlights: this.computeHighlights(h.result.text, queryWords),
      matched_keywords: queryWords,
    }))
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

    // 事务包裹 check-then-insert，避免并发写入产生重复行
    const upsert = this.vectorDb.transaction(() => {
      const existing = this.vectorDb.prepare(
        'SELECT id, rowid FROM kms_embeddings WHERE source_type = ? AND source_id = ?'
      ).get(sourceType, sourceId) as any

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

    // 同步写入 vec0 虚表
    this.syncVecIndex(rowid, buffer, fileId, sourceType, embedding.length)

    // 仅更新 __all__ 缓存（若已存在），追加新条目而非全量清空，避免批量写入时缓存命中率归零
    // 通过 LRU update 接口原地修改并重算字节，超限时自动淘汰
    this.embeddingCache.update('__all__', entries => {
      entries.push({
        id: sourceId,
        sourceType,
        sourceId,
        fileId,
        embedding: new Float32Array(embedding),
        model,
        dimension: embedding.length,
      })
    })
  }

  /**
   * 批量存储向量嵌入（单事务，消除 per-item 事务开销）
   * 用于 generateEmbeddings 等批量写入场景
   */
  storeEmbeddingsBatch(
    entries: Array<{ sourceType: string; sourceId: string; fileId: string; embedding: Float32Array; model: string }>
  ): void {
    if (entries.length === 0) return

    const tx = this.vectorDb.transaction(() => {
      for (const e of entries) {
        // 使用 byteOffset + byteLength 构造 Buffer，避免 subarray 视图写入错误数据
        const buffer = Buffer.from(e.embedding.buffer, e.embedding.byteOffset, e.embedding.byteLength)
        const existing = this.vectorDb.prepare(
          'SELECT id, rowid FROM kms_embeddings WHERE source_type = ? AND source_id = ?'
        ).get(e.sourceType, e.sourceId) as any

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

        if (this.vecReady && this.vecDimension === e.embedding.length) {
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

    // 增量更新缓存：通过 LRU update 接口原地修改并重算字节，超限时自动淘汰
    this.embeddingCache.update('__all__', allCache => {
      for (const e of entries) {
        const existingIdx = allCache.findIndex(c => c.sourceType === e.sourceType && c.sourceId === e.sourceId)
        const entry: EmbeddingEntry = {
          id: e.sourceId,
          sourceType: e.sourceType,
          sourceId: e.sourceId,
          fileId: e.fileId,
          embedding: new Float32Array(e.embedding),
          model: e.model,
          dimension: e.embedding.length,
        }
        if (existingIdx >= 0) {
          allCache[existingIdx] = entry
        } else {
          allCache.push(entry)
        }
      }
    })
  }

  /**
   * 失效指定 fileId 的 embedding 缓存（删除文件时调用）
   * 从 __all__ 缓存数组中过滤掉该 fileId 的条目，避免全量重载
   *
   * 通过 LRU update 接口原地 filter 并重算字节，超限时自动淘汰整个 __all__ 条目。
   * 注意：filter 会产生新数组引用，但 update 接口会将其重新 set 到缓存中。
   */
  private invalidateEmbeddingCacheForFile(fileId: string): void {
    const cached = this.embeddingCache.get('__all__')
    if (!cached) return
    const filtered = cached.filter(e => e.fileId !== fileId)
    if (filtered.length !== cached.length) {
      // 重新 set 以触发字节重算与超限淘汰检查
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
      this.vectorDb.prepare('DELETE FROM vec_kms_embeddings WHERE rowid = ?').run(rowid)
      this.vectorDb.prepare(
        'INSERT INTO vec_kms_embeddings(rowid, embedding, file_id, source_type) VALUES (?, ?, ?, ?)'
      ).run(rowid, buffer, fileId, sourceType)
    } catch (err: any) {
      logger.warn(`vec0 同步失败 rowid=${rowid}:`, err?.message || err)
    }
  }

  invalidateCache(): void {
    this.searchCache.clear()
  }

  private insertFtsRow(indexId: string, fileId: string, sourceType: SourceType, sourceId: string, title: string, content: string, keywords: string): void {
    // 索引侧中文分词：将连续中文切分为空格分隔的词序列，
    // 使 FTS5 unicode61 tokenizer 能按空格建立正确 token 边界，
    // 从而 BM25 排序基于真实词粒度而非整段中文字符串。
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

  private convertFtsResultsToSearchResults(ftsResults: any[], topK: number, queryWords?: string[]): SearchResult[] {
    // 批量预加载所有 fileId 对应的文件信息，避免循环内 N+1 查询
    const fileIds = [...new Set(ftsResults.map(r => r.file_id).filter(Boolean))]
    const fileCache: Map<string, { name: string; path: string; modified_time?: number }> = new Map()
    if (fileIds.length > 0) {
      const placeholders = fileIds.map(() => '?').join(',')
      const rows = this.db.prepare(
        `SELECT id, file_name, file_path, modified_time FROM kms_files WHERE id IN (${placeholders})`
      ).all(...fileIds) as any[]
      for (const row of rows) {
        fileCache.set(row.id, { name: row.file_name || '', path: row.file_path || '', modified_time: row.modified_time })
      }
    }
    const getFile = (fileId: string) => {
      return fileCache.get(fileId) ?? { name: '', path: '', modified_time: undefined }
    }

    const results: SearchResult[] = []
    const seen = new Set<string>()

    for (const row of ftsResults) {
      const key = `${row.source_type}-${row.source_id}-${row.paragraph_index || 0}`
      if (seen.has(key)) continue
      seen.add(key)

      const fileInfo = getFile(row.file_id)
      const metadata = this.safeParseJSON(row.metadata_json, {}) as Record<string, any>

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

  private loadAllEmbeddings(): EmbeddingEntry[] {
    const cacheKey = '__all__'
    const cached = this.embeddingCache.get(cacheKey)
    if (cached) return cached

    const rows = this.vectorDb.prepare('SELECT id, source_type, source_id, file_id, embedding, model, dimension FROM kms_embeddings').all() as any[]

    const entries: EmbeddingEntry[] = rows
      .filter(row => row.embedding && row.dimension > 0)
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
    this.embeddingCache.set(cacheKey, entries)
    return entries
  }

  /**
   * 按过滤条件加载 embeddings（不下发全量缓存，直接 SQL WHERE 过滤）
   * 用于 vectorSearchViaJS 有 fileIds/sourceTypes 过滤时的场景，避免全量加载
   */
  private loadEmbeddingsFiltered(fileIds?: string[], sourceTypes?: string[]): EmbeddingEntry[] {
    const conditions: string[] = []
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
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.vectorDb.prepare(
      `SELECT id, source_type, source_id, file_id, embedding, model, dimension FROM kms_embeddings${whereClause}`
    ).all(...params) as any[]

    // 与 loadAllEmbeddings 保持一致：过滤掉 embedding 为 null 或 dimension<=0 的脏行，
    // 避免后续 new Float32Array(null.buffer, ...) 或 cosineSimilarity(null) 报错
    return rows
      .filter(row => row.embedding && row.dimension > 0)
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
