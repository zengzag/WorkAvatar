import KBDatabaseService from './kb-database.service'
import { generateId } from './common-utils'
import { createLogger } from './logger'

const logger = createLogger('SearchEngine')

type SourceType = 'document_title' | 'document_summary' | 'paragraph' | 'content_paragraph'

interface SearchResult {
  document_id: string
  document_name: string
  paragraph_id?: string
  paragraph_title?: string
  text: string
  match_type: SourceType | 'hybrid'
  start_offset?: number
  end_offset?: number
  start_line?: number
  end_line?: number
}

interface HybridSearchOptions {
  topK?: number
  documentIds?: string[]
  sourceTypes?: SourceType[]
  useVector?: boolean
}

interface EmbeddingEntry {
  id: string
  kbId: string
  sourceType: string
  sourceId: string
  documentId: string
  embedding: Float32Array
  model: string
  dimension: number
}

class SearchEngineService {
  private kbDb: KBDatabaseService
  private static instance: SearchEngineService
  private searchCache: Map<string, { results: SearchResult[]; timestamp: number }> = new Map()
  private static readonly CACHE_TTL = 60000
  private static readonly CACHE_MAX_SIZE = 100
  private embeddingCache: Map<string, EmbeddingEntry[]> = new Map()
  // vec0 虚表当前维度，null 表示虚表尚未创建
  private vecDimension: number | null = null
  private vecReady: boolean = false

  private constructor() {
    this.kbDb = KBDatabaseService.getInstance()
    this.initVecIndex()
  }

  private get db() { return this.kbDb.getDb() }

  static getInstance(): SearchEngineService {
    if (!SearchEngineService.instance) {
      SearchEngineService.instance = new SearchEngineService()
    }
    return SearchEngineService.instance
  }

  /**
   * 初始化 vec0 向量索引：
   * 1. 检查 sqlite-vec 扩展是否加载
   * 2. 如果 vec_kb_embeddings 已存在，读取其维度
   * 3. 如果不存在但有现有数据，按数据维度创建并迁移
   */
  private initVecIndex(): void {
    try {
      // 验证 sqlite-vec 扩展已加载
      this.db.prepare('SELECT vec_version()').get()
      this.vecReady = true
    } catch {
      logger.warn('sqlite-vec 扩展未加载，向量检索将回退到 JS 全扫描模式')
      return
    }

    // 检查 vec_kb_embeddings 虚表是否已存在
    const existing = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_kb_embeddings'"
    ).get() as any

    if (existing) {
      // 虚表已存在，从现有数据推断维度
      const dimRow = this.db.prepare(
        'SELECT dimension FROM kb_embeddings ORDER BY updated_at DESC LIMIT 1'
      ).get() as any
      if (dimRow?.dimension) {
        this.vecDimension = dimRow.dimension
      }
      logger.info(`vec0 虚表已存在，维度=${this.vecDimension}`)
      return
    }

    // 虚表不存在，检查是否有现有数据需要迁移
    const countRow = this.db.prepare('SELECT COUNT(*) as count, dimension FROM kb_embeddings GROUP BY dimension ORDER BY count DESC LIMIT 1').get() as any
    if (!countRow || countRow.count === 0) {
      logger.info('kb_embeddings 表为空，vec0 虚表将延迟到首次写入时创建')
      return
    }

    // 有现有数据，按最常见维度创建虚表并迁移
    const dimension = countRow.dimension
    this.createVecTable(dimension)
    this.migrateExistingEmbeddings(dimension)
  }

  /**
   * 创建 vec0 虚表（如不存在）
   */
  private createVecTable(dimension: number): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_kb_embeddings USING vec0(
          embedding float[${dimension}] distance_metric=cosine,
          kb_id TEXT PARTITION KEY,
          document_id TEXT,
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

  /**
   * 将 kb_embeddings 表中的现有数据迁移到 vec0 虚表
   */
  private migrateExistingEmbeddings(dimension: number): void {
    try {
      const rows = this.db.prepare(
        'SELECT rowid, embedding, kb_id, document_id, source_type FROM kb_embeddings WHERE dimension = ?'
      ).all(dimension) as any[]

      if (rows.length === 0) return

      const insertStmt = this.db.prepare(
        'INSERT INTO vec_kb_embeddings(rowid, embedding, kb_id, document_id, source_type) VALUES (?, ?, ?, ?, ?)'
      )
      const migrate = this.db.transaction(() => {
        for (const row of rows) {
          try {
            insertStmt.run(row.rowid, row.embedding, row.kb_id, row.document_id, row.source_type)
          } catch (err: any) {
            // 单条迁移失败不中断整体流程
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

  private insertFtsRow(indexId: string, kbId: string, sourceType: SourceType, sourceId: string, documentId: string, title: string, content: string, keywords: string): void {
    this.db.prepare(`
      INSERT INTO kb_fts (index_id, kb_id, source_type, source_id, document_id, title, content, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(indexId, kbId, sourceType, sourceId, documentId, title, content, keywords)
  }

  private deleteFtsRow(indexId: string): void {
    this.db.prepare('DELETE FROM kb_fts WHERE index_id = ?').run(indexId)
  }

  indexDocumentTitle(kbId: string, documentId: string, documentName: string): void {
    const existing = this.db.prepare(
      "SELECT id FROM kb_search_index WHERE source_type = 'document_title' AND source_id = ?"
    ).get(documentId) as any

    if (existing) {
      this.db.prepare(
        'UPDATE kb_search_index SET title = ?, content = ?, updated_at = unixepoch() WHERE id = ?'
      ).run(documentName, documentName, existing.id)

      this.deleteFtsRow(existing.id)
      this.insertFtsRow(existing.id, kbId, 'document_title', documentId, documentId, documentName, documentName, '')
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_search_index (id, kb_id, source_type, source_id, document_id, title, content, created_at, updated_at)
        VALUES (?, ?, 'document_title', ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, kbId, documentId, documentId, documentName, documentName)

      this.insertFtsRow(id, kbId, 'document_title', documentId, documentId, documentName, documentName, '')
    }
  }

  indexDocumentSummary(
    kbId: string,
    documentId: string,
    summary: string,
    keywords: string[]
  ): void {
    const existing = this.db.prepare(
      "SELECT id FROM kb_search_index WHERE source_type = 'document_summary' AND source_id = ?"
    ).get(documentId) as any

    const keywordsStr = keywords.join(', ')
    const content = summary

    if (existing) {
      this.db.prepare(`
        UPDATE kb_search_index SET title = ?, content = ?, keywords_json = ?, metadata_json = ?, updated_at = unixepoch() WHERE id = ?
      `).run('文档摘要', content, JSON.stringify(keywords), JSON.stringify({}), existing.id)

      this.deleteFtsRow(existing.id)
      this.insertFtsRow(existing.id, kbId, 'document_summary', documentId, documentId, '文档摘要', content, keywordsStr)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_search_index (id, kb_id, source_type, source_id, document_id, title, content, keywords_json, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'document_summary', ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, kbId, documentId, documentId, '文档摘要', content, JSON.stringify(keywords), JSON.stringify({}))

      this.insertFtsRow(id, kbId, 'document_summary', documentId, documentId, '文档摘要', content, keywordsStr)
    }
  }

  indexParagraph(
    kbId: string,
    documentId: string,
    paragraphId: string,
    title: string,
    titlePath: string,
    summary: string,
    keywords: string[],
    startOffset: number,
    endOffset: number
  ): void {
    const existing = this.db.prepare(
      "SELECT id FROM kb_search_index WHERE source_type = 'paragraph' AND source_id = ?"
    ).get(paragraphId) as any

    const keywordsStr = keywords.join(', ')
    const content = [title, summary].filter(Boolean).join(' ')

    if (existing) {
      this.db.prepare(`
        UPDATE kb_search_index SET title = ?, content = ?, keywords_json = ?, metadata_json = ?,
          start_offset = ?, end_offset = ?, updated_at = unixepoch() WHERE id = ?
      `).run(title, content, JSON.stringify(keywords), JSON.stringify({ summary, title_path: titlePath }),
        startOffset, endOffset, existing.id)

      this.deleteFtsRow(existing.id)
      this.insertFtsRow(existing.id, kbId, 'paragraph', paragraphId, documentId, title, content, keywordsStr)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_search_index (id, kb_id, source_type, source_id, document_id, title, content, keywords_json, metadata_json, start_offset, end_offset, created_at, updated_at)
        VALUES (?, ?, 'paragraph', ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, kbId, paragraphId, documentId, title, content,
        JSON.stringify(keywords), JSON.stringify({ summary, title_path: titlePath }),
        startOffset, endOffset)

      this.insertFtsRow(id, kbId, 'paragraph', paragraphId, documentId, title, content, keywordsStr)
    }
  }

  indexContentParagraphs(
    kbId: string,
    documentId: string,
    content: string,
    documentName: string
  ): void {
    this.deleteIndexByDocumentAndType(documentId, 'content_paragraph')

    const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 20)
    if (paragraphs.length === 0) return

    const lines = content.split('\n')
    const lineOffsets: number[] = []
    let offset = 0
    for (const line of lines) {
      lineOffsets.push(offset)
      offset += line.length + 1
    }

    let currentOffset = 0
    const insertIndex = this.db.prepare(`
      INSERT INTO kb_search_index (id, kb_id, source_type, source_id, document_id, paragraph_index, title, content, start_offset, end_offset, start_line, end_line, created_at, updated_at)
      VALUES (?, ?, 'content_paragraph', ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
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
        insertIndex.run(id, kbId, documentId, documentId, pi, documentName, para,
          paraStartOffset, paraEndOffset, startLine, endLine)

        this.insertFtsRow(id, kbId, 'content_paragraph', documentId, documentId, documentName, para, '')

        currentOffset = paraEndOffset
      }
    })

    transaction()
  }

  deleteIndexByDocument(documentId: string): void {
    const rows = this.db.prepare(
      'SELECT id FROM kb_search_index WHERE document_id = ?'
    ).all(documentId) as any[]

    if (rows.length > 0) {
      const transaction = this.db.transaction(() => {
        for (const row of rows) {
          this.deleteFtsRow(row.id)
        }
      })
      transaction()
    }

    this.db.prepare('DELETE FROM kb_search_index WHERE document_id = ?').run(documentId)
    this.invalidateCache()
  }

  deleteIndexByDocumentAndType(documentId: string, sourceType: SourceType): void {
    const rows = this.db.prepare(
      'SELECT id FROM kb_search_index WHERE document_id = ? AND source_type = ?'
    ).all(documentId, sourceType) as any[]

    if (rows.length > 0) {
      const transaction = this.db.transaction(() => {
        for (const row of rows) {
          this.deleteFtsRow(row.id)
        }
      })
      transaction()
    }

    this.db.prepare(
      'DELETE FROM kb_search_index WHERE document_id = ? AND source_type = ?'
    ).run(documentId, sourceType)
  }

  deleteIndexByKb(kbId: string): void {
    this.db.prepare("DELETE FROM kb_fts WHERE kb_id = ?").run(kbId)
    this.db.prepare('DELETE FROM kb_search_index WHERE kb_id = ?').run(kbId)
    this.db.prepare('DELETE FROM kb_embeddings WHERE kb_id = ?').run(kbId)
    // 同步清理 vec0 虚表（partition key 过滤）
    if (this.vecReady) {
      try {
        this.db.prepare('DELETE FROM vec_kb_embeddings WHERE kb_id = ?').run(kbId)
      } catch (err: any) {
        logger.warn('清理 vec0 索引失败:', err?.message || err)
      }
    }
    this.embeddingCache.delete(kbId)
    this.invalidateCache()
  }

  rebuildIndexForKb(kbId: string): void {
    this.deleteIndexByKb(kbId)
  }

  private buildFtsWhereClause(kbId: string, options?: { documentIds?: string[]; sourceTypes?: SourceType[] }): { whereClause: string; params: any[] } {
    let whereClause = "kb_fts.kb_id = ?"
    const params: any[] = [kbId]

    if (options?.documentIds && options.documentIds.length > 0) {
      const placeholders = options.documentIds.map(() => '?').join(',')
      whereClause += ` AND kb_fts.document_id IN (${placeholders})`
      params.push(...options.documentIds)
    }

    if (options?.sourceTypes && options.sourceTypes.length > 0) {
      const placeholders = options.sourceTypes.map(() => '?').join(',')
      whereClause += ` AND kb_fts.source_type IN (${placeholders})`
      params.push(...options.sourceTypes)
    }

    return { whereClause, params }
  }

  private executeFtsQuery(ftsQuery: string, whereClause: string, params: any[], limit: number): any[] {
    return this.db.prepare(`
      SELECT si.*, fts.rank
      FROM kb_fts fts
      JOIN kb_search_index si ON fts.index_id = si.id
      WHERE kb_fts MATCH ? AND ${whereClause}
      ORDER BY fts.rank
      LIMIT ?
    `).all(ftsQuery, ...params, limit) as any[]
  }

  ftsSearch(kbId: string, query: string, topK: number = 10, options?: { documentIds?: string[]; sourceTypes?: SourceType[] }): SearchResult[] {
    const cacheKey = `fts:${kbId}:${query}:${topK}:${JSON.stringify(options)}`
    const cached = this.getFromCache(cacheKey)
    if (cached) return cached

    const escapedQuery = query.toLowerCase().split(/\s+/).filter(w => w.length > 0)
      .map(w => `${w}*`).join(' OR ')

    if (!escapedQuery) return []

    const { whereClause, params } = this.buildFtsWhereClause(kbId, options)

    try {
      const ftsResults = this.executeFtsQuery(escapedQuery, whereClause, params, topK * 2)
      const results = this.convertFtsResultsToSearchResults(ftsResults, topK)
      this.putToCache(cacheKey, results)
      return results
    } catch {
      return this.fallbackKeywordSearch(kbId, query, topK, options)
    }
  }

  private convertFtsResultsToSearchResults(ftsResults: any[], topK: number): SearchResult[] {
    const docNameCache: Map<string, string> = new Map()
    const getDocName = (docId: string): string => {
      if (docNameCache.has(docId)) return docNameCache.get(docId)!
      const doc = this.db.prepare('SELECT original_name FROM kb_documents WHERE id = ?').get(docId) as any
      const name = doc?.original_name || ''
      docNameCache.set(docId, name)
      return name
    }

    const results: SearchResult[] = []
    const seen = new Set<string>()

    for (const row of ftsResults) {
      const key = `${row.source_type}-${row.source_id}-${row.paragraph_index || 0}`
      if (seen.has(key)) continue
      seen.add(key)

      const docName = getDocName(row.document_id)
      const metadata = this.safeParseJSON(row.metadata_json, {}) as Record<string, any>

      let result: SearchResult

      switch (row.source_type as SourceType) {
        case 'document_title':
          result = {
            document_id: row.document_id,
            document_name: docName,
            text: `文档标题匹配: ${row.title}`,
            match_type: 'document_title',
          }
          break

        case 'document_summary':
          result = {
            document_id: row.document_id,
            document_name: docName,
            text: `文档摘要: ${row.content.substring(0, 300)}${row.content.length > 300 ? '...' : ''}`,
            match_type: 'document_summary',
          }
          break

        case 'paragraph':
          result = {
            document_id: row.document_id,
            document_name: docName,
            paragraph_id: row.source_id,
            paragraph_title: row.title,
            text: `段落「${row.title}」(${metadata.title_path || ''}): ${metadata.summary || row.content}`.substring(0, 400),
            match_type: 'paragraph',
            start_offset: row.start_offset,
            end_offset: row.end_offset,
          }
          break

        case 'content_paragraph':
          result = {
            document_id: row.document_id,
            document_name: docName,
            text: row.content.substring(0, 400),
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

    return results.slice(0, topK)
  }

  private fallbackKeywordSearch(kbId: string, query: string, topK: number, options?: { documentIds?: string[]; sourceTypes?: SourceType[] }): SearchResult[] {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
    if (queryWords.length === 0) return []

    let whereClause = 'kb_id = ?'
    const params: any[] = [kbId]

    if (options?.documentIds && options.documentIds.length > 0) {
      const placeholders = options.documentIds.map(() => '?').join(',')
      whereClause += ` AND document_id IN (${placeholders})`
      params.push(...options.documentIds)
    }

    if (options?.sourceTypes && options.sourceTypes.length > 0) {
      const placeholders = options.sourceTypes.map(() => '?').join(',')
      whereClause += ` AND source_type IN (${placeholders})`
      params.push(...options.sourceTypes)
    }

    const rows = this.db.prepare(
      `SELECT * FROM kb_search_index WHERE ${whereClause}`
    ).all(...params) as any[]

    const scored = rows.map(row => {
      const text = `${row.title} ${row.content} ${row.keywords_json || ''}`.toLowerCase()
      let score = 0
      for (const word of queryWords) {
        const count = (text.match(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
        score += count
      }
      return { ...row, keywordScore: score }
    }).filter(r => r.keywordScore > 0)

    scored.sort((a, b) => b.keywordScore - a.keywordScore)
    return this.convertFtsResultsToSearchResults(scored.slice(0, topK), topK)
  }

  storeEmbedding(
    kbId: string,
    sourceType: string,
    sourceId: string,
    documentId: string,
    embedding: Float32Array,
    model: string
  ): void {
    const existing = this.db.prepare(
      'SELECT id, rowid FROM kb_embeddings WHERE source_type = ? AND source_id = ?'
    ).get(sourceType, sourceId) as any

    const buffer = Buffer.from(embedding.buffer)
    let rowid: number

    if (existing) {
      this.db.prepare(`
        UPDATE kb_embeddings SET embedding = ?, model = ?, dimension = ?, updated_at = unixepoch() WHERE id = ?
      `).run(buffer, model, embedding.length, existing.id)
      rowid = existing.rowid
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_embeddings (id, kb_id, source_type, source_id, document_id, embedding, model, dimension, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, kbId, sourceType, sourceId, documentId, buffer, model, embedding.length)
      rowid = Number((this.db.prepare('SELECT last_insert_rowid() as r').get() as any).r)
    }

    // 同步写入 vec0 虚表
    this.syncVecIndex(rowid, buffer, kbId, documentId, sourceType, embedding.length)

    this.embeddingCache.delete(kbId)
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
    kbId: string,
    documentId: string,
    sourceType: string,
    dimension: number
  ): void {
    if (!this.vecReady) return

    // 延迟创建虚表
    if (this.vecDimension === null) {
      this.createVecTable(dimension)
      if (this.vecDimension === null) return
    }

    // 维度不匹配，跳过 vec0 写入（降级到 JS 检索）
    if (this.vecDimension !== dimension) {
      logger.warn(`向量维度 ${dimension} 与 vec0 虚表维度 ${this.vecDimension} 不匹配，跳过索引写入`)
      return
    }

    try {
      // vec0 不支持 UPDATE 向量，先删后插
      this.db.prepare('DELETE FROM vec_kb_embeddings WHERE rowid = ?').run(rowid)
      this.db.prepare(
        'INSERT INTO vec_kb_embeddings(rowid, embedding, kb_id, document_id, source_type) VALUES (?, ?, ?, ?, ?)'
      ).run(rowid, buffer, kbId, documentId, sourceType)
    } catch (err: any) {
      logger.warn(`vec0 同步失败 rowid=${rowid}:`, err?.message || err)
    }
  }

  vectorSearch(
    kbId: string,
    queryEmbedding: Float32Array,
    topK: number = 10,
    options?: { documentIds?: string[]; sourceTypes?: string[] }
  ): Array<{ sourceType: string; sourceId: string; documentId: string; score: number }> {
    // 优先用 vec0 KNN 索引；维度不匹配或未就绪时回退到 JS 全扫描
    if (this.vecReady && this.vecDimension === queryEmbedding.length) {
      const vecResult = this.vectorSearchViaVec0(kbId, queryEmbedding, topK, options)
      if (vecResult !== null) return vecResult
    }

    return this.vectorSearchViaJS(kbId, queryEmbedding, topK, options)
  }

  /**
   * 使用 vec0 虚表的 KNN 查询：
   * - partition key 过滤 kb_id
   * - metadata 过滤 document_id、source_type
   * - 多取 topK*3 条以缓解 pre-filter 后不足 k 的问题
   * 返回 null 表示 KNN 查询失败，调用方应回退到 JS。
   */
  private vectorSearchViaVec0(
    kbId: string,
    queryEmbedding: Float32Array,
    topK: number,
    options?: { documentIds?: string[]; sourceTypes?: string[] }
  ): Array<{ sourceType: string; sourceId: string; documentId: string; score: number }> | null {
    try {
      const queryBuffer = Buffer.from(queryEmbedding.buffer)
      const k = Math.max(topK * 3, 30)

      let whereClause = 'embedding MATCH ? AND k = ? AND kb_id = ?'
      const params: any[] = [queryBuffer, k, kbId]

      if (options?.documentIds && options.documentIds.length > 0) {
        const placeholders = options.documentIds.map(() => '?').join(',')
        whereClause += ` AND document_id IN (${placeholders})`
        params.push(...options.documentIds)
      }

      if (options?.sourceTypes && options.sourceTypes.length > 0) {
        const placeholders = options.sourceTypes.map(() => '?').join(',')
        whereClause += ` AND source_type IN (${placeholders})`
        params.push(...options.sourceTypes)
      }

      const knnRows = this.db.prepare(
        `SELECT rowid, distance FROM vec_kb_embeddings WHERE ${whereClause} ORDER BY distance`
      ).all(...params) as any[]

      if (knnRows.length === 0) return []

      // 回查 kb_embeddings 获取元数据
      const rowids = knnRows.map(r => r.rowid)
      const placeholders = rowids.map(() => '?').join(',')
      const metaRows = this.db.prepare(
        `SELECT rowid, source_type, source_id, document_id FROM kb_embeddings WHERE rowid IN (${placeholders})`
      ).all(...rowids) as any[]

      const metaMap = new Map<number, any>()
      for (const row of metaRows) {
        metaMap.set(row.rowid, row)
      }

      return knnRows.map(knn => {
        const meta = metaMap.get(knn.rowid)
        return {
          sourceType: meta?.source_type || '',
          sourceId: meta?.source_id || '',
          documentId: meta?.document_id || '',
          // cosine distance = 1 - cosine similarity
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
   */
  private vectorSearchViaJS(
    kbId: string,
    queryEmbedding: Float32Array,
    topK: number,
    options?: { documentIds?: string[]; sourceTypes?: string[] }
  ): Array<{ sourceType: string; sourceId: string; documentId: string; score: number }> {
    let embeddings = this.loadEmbeddings(kbId)

    if (options?.documentIds && options.documentIds.length > 0) {
      const docSet = new Set(options.documentIds)
      embeddings = embeddings.filter(e => docSet.has(e.documentId))
    }

    if (options?.sourceTypes && options.sourceTypes.length > 0) {
      const typeSet = new Set(options.sourceTypes)
      embeddings = embeddings.filter(e => typeSet.has(e.sourceType))
    }

    if (embeddings.length === 0) return []

    const queryNorm = this.norm(queryEmbedding)
    if (queryNorm === 0) return []

    const scored = embeddings.map(e => {
      const similarity = this.cosineSimilarity(queryEmbedding, e.embedding, queryNorm)
      return {
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        documentId: e.documentId,
        score: similarity
      }
    })

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  hybridSearch(kbId: string, query: string, queryEmbedding: Float32Array | null, options?: HybridSearchOptions): SearchResult[] {
    const topK = options?.topK || 10
    const keywordWeight = 0.6
    const vectorWeight = 0.4
    const useVector = options?.useVector !== false && queryEmbedding !== null

    const ftsResults = this.ftsSearch(kbId, query, topK * 2, {
      documentIds: options?.documentIds,
      sourceTypes: options?.sourceTypes
    })

    const ftsRankMap = new Map<string, number>()
    for (let i = 0; i < ftsResults.length; i++) {
      const r = ftsResults[i]
      const key = this.getResultKey(r)
      ftsRankMap.set(key, (ftsResults.length - i) / ftsResults.length)
    }

    const vectorScoreMap = new Map<string, number>()
    const vectorSourceMap = new Map<string, { sourceType: string; sourceId: string; documentId: string }>()

    if (useVector && queryEmbedding) {
      const vectorResults = this.vectorSearch(kbId, queryEmbedding, topK * 2, {
        documentIds: options?.documentIds,
        sourceTypes: options?.sourceTypes as string[] | undefined
      })

      const maxVectorScore = Math.max(...vectorResults.map(r => r.score), 1)
      for (const vr of vectorResults) {
        const key = `${vr.sourceType}-${vr.sourceId}`
        vectorScoreMap.set(key, vr.score / maxVectorScore)
        vectorSourceMap.set(key, vr)
      }
    }

    const allKeys = new Set([...ftsRankMap.keys(), ...vectorScoreMap.keys()])
    const hybridResults: Array<{ result: SearchResult; sortKey: number }> = []
    const missingEntries: Array<{ key: string; vs: { sourceType: string; sourceId: string; documentId: string }; sortKey: number }> = []

    for (const key of allKeys) {
      const ftsRank = ftsRankMap.get(key) || 0
      const vectorScore = vectorScoreMap.get(key) || 0
      const sortKey = ftsRank * keywordWeight + vectorScore * vectorWeight

      const ftsResult = ftsResults.find(r => this.getResultKey(r) === key)

      if (ftsResult) {
        hybridResults.push({
          result: {
            ...ftsResult,
            match_type: useVector ? 'hybrid' : ftsResult.match_type,
          },
          sortKey,
        })
      } else if (useVector && vectorScore > 0) {
        const vs = vectorSourceMap.get(key)
        if (!vs) continue
        missingEntries.push({ key, vs, sortKey })
      }
    }

    if (missingEntries.length > 0) {
      const conditions = missingEntries.map(() => '(source_type = ? AND source_id = ?)').join(' OR ')
      const params = missingEntries.flatMap(m => [m.vs.sourceType, m.vs.sourceId])
      const indexRows = this.db.prepare(
        `SELECT source_type, source_id, document_id, title, content, start_offset, end_offset FROM kb_search_index WHERE ${conditions}`
      ).all(...params) as any[]

      const docIds = [...new Set(indexRows.map(r => r.document_id).filter(Boolean))]
      const docNameMap = new Map<string, string>()
      if (docIds.length > 0) {
        const docRows = this.db.prepare(
          `SELECT id, original_name FROM kb_documents WHERE id IN (${docIds.map(() => '?').join(', ')})`
        ).all(...docIds) as any[]
        for (const row of docRows) {
          docNameMap.set(row.id, row.original_name)
        }
      }

      const indexMap = new Map<string, any>()
      for (const row of indexRows) {
        indexMap.set(`${row.source_type}-${row.source_id}`, row)
      }

      for (const entry of missingEntries) {
        const indexEntry = indexMap.get(`${entry.vs.sourceType}-${entry.vs.sourceId}`)
        if (indexEntry) {
          hybridResults.push({
            result: {
              document_id: indexEntry.document_id,
              document_name: docNameMap.get(indexEntry.document_id) || '',
              paragraph_id: entry.vs.sourceType === 'paragraph' ? entry.vs.sourceId : undefined,
              paragraph_title: indexEntry.title,
              text: indexEntry.content.substring(0, 300),
              match_type: 'hybrid',
              start_offset: indexEntry.start_offset,
              end_offset: indexEntry.end_offset,
            },
            sortKey: entry.sortKey,
          })
        }
      }
    }

    hybridResults.sort((a, b) => b.sortKey - a.sortKey)
    return hybridResults.slice(0, topK).map(h => h.result)
  }

  search(kbId: string, query: string, topK: number = 10, documentIds?: string[], queryEmbedding?: Float32Array): SearchResult[] {
    if (queryEmbedding) {
      return this.hybridSearch(kbId, query, queryEmbedding, {
        topK,
        documentIds,
        useVector: true,
      })
    }

    return this.ftsSearch(kbId, query, topK, { documentIds })
  }

  getIndexStats(kbId: string): {
    totalEntries: number
    byType: Record<string, number>
    embeddingCount: number
    ftsEntryCount: number
  } {
    const totalEntries = (this.db.prepare(
      'SELECT COUNT(*) as count FROM kb_search_index WHERE kb_id = ?'
    ).get(kbId) as any)?.count || 0

    const typeRows = this.db.prepare(
      'SELECT source_type, COUNT(*) as count FROM kb_search_index WHERE kb_id = ? GROUP BY source_type'
    ).all(kbId) as any[]

    const byType: Record<string, number> = {}
    for (const row of typeRows) {
      byType[row.source_type] = row.count
    }

    const embeddingCount = (this.db.prepare(
      'SELECT COUNT(*) as count FROM kb_embeddings WHERE kb_id = ?'
    ).get(kbId) as any)?.count || 0

    return { totalEntries, byType, embeddingCount, ftsEntryCount: totalEntries }
  }

  isIndexBuilt(kbId: string): boolean {
    const count = (this.db.prepare(
      'SELECT COUNT(*) as count FROM kb_search_index WHERE kb_id = ?'
    ).get(kbId) as any)?.count || 0
    return count > 0
  }

  private loadEmbeddings(kbId: string): EmbeddingEntry[] {
    if (this.embeddingCache.has(kbId)) {
      return this.embeddingCache.get(kbId)!
    }

    const rows = this.db.prepare(
      'SELECT id, kb_id, source_type, source_id, document_id, embedding, model, dimension FROM kb_embeddings WHERE kb_id = ?'
    ).all(kbId) as any[]

    const entries: EmbeddingEntry[] = rows.map(row => ({
      id: row.id,
      kbId: row.kb_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      documentId: row.document_id,
      embedding: new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimension),
      model: row.model,
      dimension: row.dimension,
    }))

    this.embeddingCache.set(kbId, entries)
    return entries
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array, normA?: number): number {
    const na = normA ?? this.norm(a)
    const nb = this.norm(b)
    if (na === 0 || nb === 0) return 0

    let dot = 0
    const len = Math.min(a.length, b.length)
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i]
    }
    return dot / (na * nb)
  }

  private norm(vec: Float32Array): number {
    let sum = 0
    for (let i = 0; i < vec.length; i++) {
      sum += vec[i] * vec[i]
    }
    return Math.sqrt(sum)
  }

  private getResultKey(result: SearchResult): string {
    if (result.paragraph_id) return `paragraph-${result.paragraph_id}`
    if (result.match_type === 'content_paragraph' && result.start_offset !== undefined) {
      return `content-${result.document_id}-${result.start_offset}`
    }
    return `${result.match_type}-${result.document_id}`
  }

  private getFromCache(key: string): SearchResult[] | null {
    const entry = this.searchCache.get(key)
    if (!entry) return null
    if (Date.now() - entry.timestamp > SearchEngineService.CACHE_TTL) {
      this.searchCache.delete(key)
      return null
    }
    return entry.results
  }

  private putToCache(key: string, results: SearchResult[]): void {
    if (this.searchCache.size >= SearchEngineService.CACHE_MAX_SIZE) {
      const oldestKey = this.searchCache.keys().next().value
      if (oldestKey) this.searchCache.delete(oldestKey)
    }
    this.searchCache.set(key, { results, timestamp: Date.now() })
  }

  invalidateCache(): void {
    this.searchCache.clear()
  }

  invalidateKbCache(kbId: string): void {
    for (const key of this.searchCache.keys()) {
      if (key.includes(kbId)) {
        this.searchCache.delete(key)
      }
    }
    this.embeddingCache.delete(kbId)
  }

  private safeParseJSON<T>(raw: string, fallback: T): T {
    try {
      return JSON.parse(raw || 'null') ?? fallback
    } catch {
      return fallback
    }
  }
}

export default SearchEngineService
export type { SearchResult, SourceType, HybridSearchOptions }
