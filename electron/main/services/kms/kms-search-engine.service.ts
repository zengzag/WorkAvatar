import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'

const logger = createLogger('KMSSearchEngine')

type SourceType = 'file_title' | 'file_summary' | 'paragraph' | 'content_paragraph'

export interface HighlightRange {
  start: number
  end: number
}

export interface SearchResult {
  file_id: string
  file_name: string
  file_path: string
  paragraph_id?: string
  paragraph_title?: string
  text: string
  match_type: SourceType | 'hybrid'
  start_offset?: number
  end_offset?: number
  start_line?: number
  end_line?: number
  score?: number
  highlights?: HighlightRange[]
  matched_keywords?: string[]
}

export interface SearchOptions {
  topK?: number
  fileIds?: string[]
  sourceTypes?: SourceType[]
  useVector?: boolean
  timeRangeStart?: number
  timeRangeEnd?: number
  fileExtensions?: string[]
  /** 按合集过滤：只搜索属于指定合集的文件 */
  collectionIds?: string[]
  /** 按索引目录过滤：只搜索指定目录下的文件 */
  dirIds?: string[]
}

export interface EmbeddingEntry {
  id: string
  sourceType: string
  sourceId: string
  fileId: string
  embedding: Float32Array
  model: string
  dimension: number
}

/**
 * KMS 搜索引擎服务
 * FTS5 全文检索 + 向量语义搜索 + 混合搜索 + 时间范围过滤
 */
class KMSSearchEngineService {
  private db: Database.Database
  private static instance: KMSSearchEngineService
  private searchCache: Map<string, { results: SearchResult[]; timestamp: number }> = new Map()
  private static readonly CACHE_TTL = 60000
  private static readonly CACHE_MAX_SIZE = 100
  private embeddingCache: Map<string, EmbeddingEntry[]> = new Map()
  // vec0 虚表当前维度，null 表示虚表尚未创建
  private vecDimension: number | null = null
  private vecReady: boolean = false

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
    this.initVecIndex()
  }

  static getInstance(): KMSSearchEngineService {
    if (!KMSSearchEngineService.instance) {
      KMSSearchEngineService.instance = new KMSSearchEngineService()
    }
    return KMSSearchEngineService.instance
  }

  /**
   * 初始化 vec0 向量索引：
   * 1. 检查 sqlite-vec 扩展是否加载
   * 2. 如果 vec_kms_embeddings 已存在，读取其维度
   * 3. 如果不存在但有现有数据，按数据维度创建并迁移
   */
  private initVecIndex(): void {
    try {
      this.db.prepare('SELECT vec_version()').get()
      this.vecReady = true
    } catch {
      logger.warn('sqlite-vec 扩展未加载，向量检索将回退到 JS 全扫描模式')
      return
    }

    const existing = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_kms_embeddings'"
    ).get() as any

    if (existing) {
      const dimRow = this.db.prepare(
        'SELECT dimension FROM kms_embeddings ORDER BY updated_at DESC LIMIT 1'
      ).get() as any
      if (dimRow?.dimension) {
        this.vecDimension = dimRow.dimension
      }
      logger.info(`vec0 虚表已存在，维度=${this.vecDimension}`)
      return
    }

    const countRow = this.db.prepare(
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

  /**
   * 创建 vec0 虚表（如不存在）
   */
  private createVecTable(dimension: number): void {
    try {
      this.db.exec(`
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

  /**
   * 将 kms_embeddings 表中的现有数据迁移到 vec0 虚表
   */
  private migrateExistingEmbeddings(dimension: number): void {
    try {
      const rows = this.db.prepare(
        'SELECT rowid, embedding, file_id, source_type FROM kms_embeddings WHERE dimension = ?'
      ).all(dimension) as any[]

      if (rows.length === 0) return

      const insertStmt = this.db.prepare(
        'INSERT INTO vec_kms_embeddings(rowid, embedding, file_id, source_type) VALUES (?, ?, ?, ?)'
      )
      const migrate = this.db.transaction(() => {
        for (const row of rows) {
          try {
            insertStmt.run(row.rowid, row.embedding, row.file_id, row.source_type)
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

  /**
   * 索引文件标题
   */
  indexFileTitle(fileId: string, fileName: string): void {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id FROM kms_search_index WHERE source_type = 'file_title' AND source_id = ?"
      ).get(fileId) as any

      if (existing) {
        this.db.prepare(
          'UPDATE kms_search_index SET title = ?, content = ?, updated_at = unixepoch() WHERE id = ?'
        ).run(fileName, fileName, existing.id)

        this.deleteFtsRow(existing.id)
        this.insertFtsRow(existing.id, fileId, 'file_title', fileId, fileName, fileName, '')
      } else {
        const id = generateId()
        this.db.prepare(`
          INSERT INTO kms_search_index (id, file_id, source_type, source_id, title, content, created_at, updated_at)
          VALUES (?, ?, 'file_title', ?, ?, ?, unixepoch(), unixepoch())
        `).run(id, fileId, fileId, fileName, fileName)

        this.insertFtsRow(id, fileId, 'file_title', fileId, fileName, fileName, '')
      }
    })
    tx()
  }

  /**
   * 索引文件摘要
   */
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

  /**
   * 索引段落（标题+摘要+关键词）
   */
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

  /**
   * 索引原文内容段落（按双换行分割，含行号和偏移）
   */
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
        insertIndex.run(id, fileId, fileId, pi, fileName, para,
          paraStartOffset, paraEndOffset, startLine, endLine)

        this.insertFtsRow(id, fileId, 'content_paragraph', fileId, fileName, para, '')

        currentOffset = paraEndOffset
      }
    })

    transaction()
  }

  /**
   * 保存段落到 kms_paragraphs 表（段落切分结果写入）
   * 若段落已存在（按 file_id + paragraph_index）则更新
   * 返回写入的段落列表（含生成的 id）
   */
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

  /**
   * 更新段落的 LLM 摘要和关键词
   */
  updateParagraphSummary(paragraphId: string, summary: string, keywords: string[]): void {
    this.db.prepare(`
      UPDATE kms_paragraphs SET summary = ?, keywords_json = ?, updated_at = unixepoch() WHERE id = ?
    `).run(summary, JSON.stringify(keywords), paragraphId)
  }

  /**
   * 删除文件的所有段落（同步级联删除索引、向量、FTS行）
   */
  deleteParagraphsByFile(fileId: string): void {
    // 删除段落对应的搜索索引与FTS行
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
    // 删除段落对应的向量
    const paraIds = (this.db.prepare('SELECT id FROM kms_paragraphs WHERE file_id = ?').all(fileId) as any[]).map(r => r.id)
    if (paraIds.length > 0) {
      const placeholders = paraIds.map(() => '?').join(',')
      this.db.prepare(
        `DELETE FROM kms_embeddings WHERE source_type = 'paragraph' AND source_id IN (${placeholders})`
      ).run(...paraIds)
    }
    // 删除段落本身
    this.db.prepare('DELETE FROM kms_paragraphs WHERE file_id = ?').run(fileId)
    this.invalidateCache()
  }

  /**
   * 删除文件中 paragraph_index >= fromIndex 的所有段落（含搜索索引、向量嵌入）
   * 用于增量重新生成场景：保留前半部分段落，重新生成后半部分
   */
  deleteParagraphsFromFileIndex(fileId: string, fromIndex: number): void {
    // 查询待删除的段落 ID
    const paraRows = this.db.prepare(
      'SELECT id FROM kms_paragraphs WHERE file_id = ? AND paragraph_index >= ?'
    ).all(fileId, fromIndex) as any[]
    const paraIds = paraRows.map(r => r.id)
    if (paraIds.length === 0) return

    const placeholders = paraIds.map(() => '?').join(',')

    // 删除段落对应的搜索索引与 FTS 行
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

    // 删除段落对应的向量嵌入
    this.db.prepare(
      `DELETE FROM kms_embeddings WHERE source_type = 'paragraph' AND source_id IN (${placeholders})`
    ).run(...paraIds)

    // 删除段落本身
    this.db.prepare(
      'DELETE FROM kms_paragraphs WHERE file_id = ? AND paragraph_index >= ?'
    ).run(fileId, fromIndex)
    this.invalidateCache()
  }

  /**
   * 增量插入段落到 kms_paragraphs 表（不删除已有段落）
   * 用于增量重新生成场景：在保留前半部分段落的基础上追加新段落
   * 返回写入的段落列表（含生成的 id）
   */
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

  /**
   * 保存文件 TOC 到 kms_file_summaries.toc_json
   */
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

  /**
   * 删除文件的所有索引（含段落表、段落向量）
   */
  deleteIndexByFile(fileId: string): void {
    const rows = this.db.prepare(
      'SELECT id FROM kms_search_index WHERE file_id = ?'
    ).all(fileId) as any[]

    // 单一事务包裹批量 FTS 行删除 + 三张表 DELETE，避免多次 fsync 与中途失败留下脏数据
    const tx = this.db.transaction(() => {
      if (rows.length > 0) {
        const ids = rows.map(r => r.id)
        const placeholders = ids.map(() => '?').join(',')
        this.db.prepare(`DELETE FROM kms_fts WHERE index_id IN (${placeholders})`).run(...ids)
      }
      this.db.prepare('DELETE FROM kms_search_index WHERE file_id = ?').run(fileId)
      this.db.prepare('DELETE FROM kms_paragraphs WHERE file_id = ?').run(fileId)
      this.db.prepare('DELETE FROM kms_embeddings WHERE file_id = ?').run(fileId)
    })
    tx()

    // 仅失效受影响 fileId 的缓存条目；__all__ 缓存通过过滤移除该文件向量，避免全量重载
    this.invalidateEmbeddingCacheForFile(fileId)
    this.invalidateCache()
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

    // 预加载源文件的 embedding 记录
    const sourceEmbeddings = this.db.prepare(
      'SELECT * FROM kms_embeddings WHERE file_id = ?'
    ).all(sourceFileId) as any[]

    // 建立 source_type+source_id → embedding 记录 的映射
    const embeddingMap = new Map<string, any>()
    for (const emb of sourceEmbeddings) {
      embeddingMap.set(`${emb.source_type}:${emb.source_id}`, emb)
    }

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

        // 克隆对应的 embedding 记录
        const embKey = `${row.source_type}:${row.source_id}`
        const sourceEmb = embeddingMap.get(embKey)
        if (sourceEmb) {
          const embResult = this.db.prepare(`
            INSERT INTO kms_embeddings (source_type, source_id, file_id, embedding, model, dimension, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, unixepoch())
          `).run(
            sourceEmb.source_type, sourceEmb.source_id, targetFileId,
            sourceEmb.embedding, sourceEmb.model, sourceEmb.dimension
          )

          if (this.vecReady && this.vecDimension && sourceEmb.dimension === this.vecDimension) {
            try {
              const vecRowId = Number(embResult.lastInsertRowid)
              if (vecRowId > 0) {
                this.db.prepare(
                  'INSERT INTO vec_kms_embeddings(rowid, embedding, file_id, source_type) VALUES (?, ?, ?, ?)'
                ).run(vecRowId, sourceEmb.embedding, targetFileId, sourceEmb.source_type)
              }
            } catch (err: any) {
              logger.warn(`cloneIndexData: vec0 insert failed for targetFile=${targetFileId}:`, err?.message || err)
            }
          }
        }
      }
    })

    transaction()
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
    const queryWords = this.extractQueryKeywords(query)
    if (queryWords.length === 0) return []

    const ftsQuery = this.buildFtsQuery(queryWords)
    const { whereClause, params } = this.buildFtsWhereClause(options)

    try {
      const ftsResults = this.db.prepare(`
        SELECT si.*, fts.rank
        FROM kms_fts fts
        JOIN kms_search_index si ON fts.index_id = si.id
        JOIN kms_files f ON si.file_id = f.id
        WHERE kms_fts MATCH ? AND ${whereClause}
        ORDER BY fts.rank
        LIMIT ?
      `).all(ftsQuery, ...params, topK * 2) as any[]

      let results = this.convertFtsResultsToSearchResults(ftsResults, topK, queryWords)

      // FTS5 无结果时，降级到 LIKE 模糊匹配（参考搜索引擎的容错机制）
      if (results.length === 0) {
        results = this.likeSearch(query, options, topK)
      }

      this.putToCache(cacheKey, results)
      return results
    } catch {
      // FTS5 查询语法错误时，降级到 LIKE 模糊匹配
      const results = this.likeSearch(query, options, topK)
      this.putToCache(cacheKey, results)
      return results
    }
  }

  /**
   * 从查询文本中提取关键词（支持中英文混合）
   * - 英文/数字：按空格和标点分词
   * - 中文：按2-4字符粒度切分为bigram（参考搜索引擎中文分词的简化方案）
   */
  private extractQueryKeywords(query: string): string[] {
    const lower = query.toLowerCase().trim()
    if (!lower) return []

    // 中文停用词
    const stopWords = new Set([
      '的', '了', '和', '是', '在', '我', '有', '这', '不', '为', '之', '与', '或', '也', '都',
      '如何', '怎么', '什么', '为什么', '哪里', '哪个', '吗', '呢', '吧', '啊', '哦', '嗯',
      '可以', '能够', '应该', '需要', '关于', '对于', '通过', '进行', '以及', '但是', '因为',
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'how', 'what', 'why', 'where', 'which', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
    ])

    const keywords = new Set<string>()

    // 1. 先按空格/标点分词（处理英文和已分词的中文）
    const tokens = lower.split(/[\s,，。.!！?？;；:：、""''()（）\[\]【】{}]+/).filter(t => t.length > 0)
    for (const token of tokens) {
      if (stopWords.has(token)) continue
      // 纯英文/数字 token，长度>1 才保留
      if (/^[a-z0-9_\-\.]+$/i.test(token)) {
        if (token.length > 1) keywords.add(token)
        continue
      }
      // 中文 token：切分为 bigram（2-gram）以提升 FTS5 匹配率
      const chars = token.replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '')
      if (chars.length <= 2) {
        if (chars.length > 0 && !stopWords.has(chars)) keywords.add(chars)
      } else if (chars.length <= 4) {
        // 2-4字符：整体作为一个关键词
        keywords.add(chars)
        // 同时加入 bigram 提升召回率
        for (let i = 0; i < chars.length - 1; i++) {
          const bigram = chars.substring(i, i + 2)
          if (!stopWords.has(bigram)) keywords.add(bigram)
        }
      } else {
        // 长文本：仅切分为 bigram（不再生成 trigram，避免 MATCH 表达式过长导致前缀扫描开销线性增长）
        // bigram 已能保证召回率，trigram 的精确度收益不足以抵消其带来的性能成本
        for (let i = 0; i < chars.length - 1; i++) {
          const bigram = chars.substring(i, i + 2)
          if (!stopWords.has(bigram)) keywords.add(bigram)
        }
      }
    }

    return Array.from(keywords).filter(k => k.length > 0)
  }

  /**
   * 构建 FTS5 MATCH 查询表达式
   * 使用 OR 连接所有关键词，每个关键词加前缀匹配 *
   */
  private buildFtsQuery(keywords: string[]): string {
    const escaped = keywords.map(k => {
      const clean = k.replace(/"/g, '""').replace(/[*()^\-+]/g, '')
      if (!clean) return null
      return `"${clean}"*`
    }).filter(Boolean) as string[]
    if (escaped.length === 0) return '""*'
    return escaped.join(' OR ')
  }

  /**
   * LIKE 模糊匹配（FTS5 无结果时的降级方案）
   * 参考搜索引擎的容错机制，对每个关键词做子串匹配
   */
  private likeSearch(query: string, options: SearchOptions | undefined, topK: number): SearchResult[] {
    const queryWords = this.extractQueryKeywords(query)
    if (queryWords.length === 0) return []

    const { whereClause, params } = this.buildLikeWhereClause(options)

    // 将关键词 LIKE 匹配下推到 SQL，避免加载无匹配的行；取 topK*5 候选供 JS 精排
    const likeClauses: string[] = []
    const likeParams: any[] = []
    for (const word of queryWords) {
      const pattern = `%${word}%`
      likeClauses.push('(LOWER(si.title) LIKE ? OR LOWER(si.content) LIKE ? OR LOWER(si.keywords_json) LIKE ?)')
      likeParams.push(pattern, pattern, pattern)
    }
    const likeWhere = likeClauses.join(' OR ')
    const candidateLimit = Math.min(topK * 5, 500)

    const rows = this.db.prepare(`
      SELECT si.* FROM kms_search_index si
      JOIN kms_files f ON si.file_id = f.id
      WHERE ${whereClause} AND (${likeWhere})
      LIMIT ${candidateLimit}
    `).all(...params, ...likeParams) as any[]

    // 对每条记录计算匹配分数
    const scored = rows.map(row => {
      const text = `${row.title || ''} ${row.content || ''} ${row.keywords_json || ''}`.toLowerCase()
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
   * 构建 LIKE 查询的 WHERE 子句
   */
  private buildLikeWhereClause(options?: SearchOptions): { whereClause: string; params: any[] } {
    let whereClause = '1=1'
    const params: any[] = []

    if (options?.fileIds && options.fileIds.length > 0) {
      const placeholders = options.fileIds.map(() => '?').join(',')
      whereClause += ` AND si.file_id IN (${placeholders})`
      params.push(...options.fileIds)
    }

    if (options?.sourceTypes && options.sourceTypes.length > 0) {
      const placeholders = options.sourceTypes.map(() => '?').join(',')
      whereClause += ` AND si.source_type IN (${placeholders})`
      params.push(...options.sourceTypes)
    }

    if (options?.timeRangeStart || options?.timeRangeEnd) {
      if (options.timeRangeStart) {
        whereClause += ' AND f.modified_time >= ?'
        params.push(options.timeRangeStart)
      }
      if (options.timeRangeEnd) {
        whereClause += ' AND f.modified_time <= ?'
        params.push(options.timeRangeEnd)
      }
    }

    if (options?.fileExtensions && options.fileExtensions.length > 0) {
      const placeholders = options.fileExtensions.map(() => '?').join(',')
      whereClause += ` AND f.file_ext IN (${placeholders})`
      params.push(...options.fileExtensions)
    }

    // 合集过滤
    if (options?.collectionIds && options.collectionIds.length > 0) {
      const placeholders = options.collectionIds.map(() => '?').join(',')
      whereClause += ` AND si.file_id IN (SELECT file_id FROM kms_file_collections WHERE collection_id IN (${placeholders}))`
      params.push(...options.collectionIds)
    }

    // 索引目录过滤
    if (options?.dirIds && options.dirIds.length > 0) {
      const placeholders = options.dirIds.map(() => '?').join(',')
      whereClause += ` AND si.file_id IN (SELECT id FROM kms_files WHERE dir_id IN (${placeholders}))`
      params.push(...options.dirIds)
    }

    return { whereClause, params }
  }

  /**
   * 向量语义搜索
   */
  vectorSearch(
    queryEmbedding: Float32Array,
    options?: SearchOptions
  ): Array<{ sourceType: string; sourceId: string; fileId: string; score: number }> {
    const topK = options?.topK || 10

    // 将 collectionIds / dirIds 解析为 fileIds，与现有 fileIds 取交集
    const effectiveOptions = this.resolveFileFilter(options)

    // 优先用 vec0 KNN 索引；维度不匹配或未就绪时回退到 JS 全扫描
    if (this.vecReady && this.vecDimension === queryEmbedding.length) {
      const vecResult = this.vectorSearchViaVec0(queryEmbedding, topK, effectiveOptions)
      if (vecResult !== null) return vecResult
    }

    return this.vectorSearchViaJS(queryEmbedding, topK, effectiveOptions)
  }

  /**
   * 解析 collectionIds / dirIds 为 fileIds，与现有 fileIds 取交集
   * 用于向量搜索（vec0 与 JS 扫描均依赖 fileIds 过滤）
   * 返回新的 options 对象，fileIds 字段被替换为合并后的结果
   */
  private resolveFileFilter(options?: SearchOptions): SearchOptions | undefined {
    if (!options) return options
    const { collectionIds, dirIds, fileIds } = options

    // 无合集/目录过滤，直接返回原 options
    if (!collectionIds?.length && !dirIds?.length) return options

    const sets: string[][] = []
    if (fileIds?.length) sets.push(fileIds)

    if (collectionIds?.length) {
      const placeholders = collectionIds.map(() => '?').join(',')
      const rows = this.db.prepare(
        `SELECT DISTINCT file_id FROM kms_file_collections WHERE collection_id IN (${placeholders})`
      ).all(...collectionIds) as any[]
      sets.push(rows.map(r => r.file_id))
    }

    if (dirIds?.length) {
      const placeholders = dirIds.map(() => '?').join(',')
      const rows = this.db.prepare(
        `SELECT id FROM kms_files WHERE dir_id IN (${placeholders})`
      ).all(...dirIds) as any[]
      sets.push(rows.map(r => r.id))
    }

    // 多组条件取交集，单组直接使用
    let resolved: string[]
    if (sets.length === 0) {
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
      const queryBuffer = Buffer.from(queryEmbedding.buffer)
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

      const knnRows = this.db.prepare(
        `SELECT rowid, distance FROM vec_kms_embeddings WHERE ${whereClause} ORDER BY distance`
      ).all(...params) as any[]

      if (knnRows.length === 0) return []

      // 回查 kms_embeddings 获取元数据
      const rowids = knnRows.map(r => r.rowid)
      const placeholders = rowids.map(() => '?').join(',')
      const metaRows = this.db.prepare(
        `SELECT rowid, source_type, source_id, file_id FROM kms_embeddings WHERE rowid IN (${placeholders})`
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

    const queryNorm = this.norm(queryEmbedding)
    if (queryNorm === 0) return []

    const scored = embeddings.map(e => {
      const similarity = this.cosineSimilarity(queryEmbedding, e.embedding, queryNorm)
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
   * 混合搜索（BM25 + 向量语义加权）
   */
  hybridSearch(query: string, queryEmbedding: Float32Array | null, options?: SearchOptions): SearchResult[] {
    const topK = options?.topK || 10
    const keywordWeight = 0.6
    const vectorWeight = 0.4
    const useVector = options?.useVector !== false && queryEmbedding !== null
    const queryWords = this.extractQueryKeywords(query)

    // FTS5 关键词搜索
    const ftsResults = this.ftsSearch(query, { ...options, topK: topK * 2 })

    const ftsRankMap = new Map<string, number>()
    for (let i = 0; i < ftsResults.length; i++) {
      const r = ftsResults[i]
      const key = this.getResultKey(r)
      ftsRankMap.set(key, (ftsResults.length - i) / ftsResults.length)
    }

    const vectorScoreMap = new Map<string, number>()
    const vectorSourceMap = new Map<string, { sourceType: string; sourceId: string; fileId: string }>()

    if (useVector && queryEmbedding) {
      const vectorResults = this.vectorSearch(queryEmbedding, { ...options, topK: topK * 2 })

      const maxVectorScore = Math.max(...vectorResults.map(r => r.score), 1)
      for (const vr of vectorResults) {
        const key = `${vr.sourceType}-${vr.sourceId}`
        vectorScoreMap.set(key, vr.score / maxVectorScore)
        vectorSourceMap.set(key, vr)
      }
    }

    const allKeys = new Set([...ftsRankMap.keys(), ...vectorScoreMap.keys()])
    const hybridResults: Array<{ result: SearchResult; sortKey: number }> = []
    const missingEntries: Array<{ key: string; vs: { sourceType: string; sourceId: string }; sortKey: number }> = []

    // 预建 ftsResults 的 key → result 索引，避免循环内 O(N) find 造成 O(N²)
    const ftsResultMap = new Map<string, SearchResult>()
    for (const r of ftsResults) {
      ftsResultMap.set(this.getResultKey(r), r)
    }

    for (const key of allKeys) {
      const ftsRank = ftsRankMap.get(key) || 0
      const vectorScore = vectorScoreMap.get(key) || 0
      const sortKey = ftsRank * keywordWeight + vectorScore * vectorWeight

      const ftsResult = ftsResultMap.get(key)

      if (ftsResult) {
        hybridResults.push({
          result: {
            ...ftsResult,
            match_type: useVector ? 'hybrid' : ftsResult.match_type,
            score: sortKey,
          },
          sortKey,
        })
      } else if (useVector && vectorScore > 0) {
        const vs = vectorSourceMap.get(key)
        if (!vs) continue
        missingEntries.push({ key, vs, sortKey })
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
      const fileMap = new Map<string, { file_name: string; file_path: string }>()
      if (fileIds.length > 0) {
        const fileRows = this.db.prepare(
          `SELECT id, file_name, file_path FROM kms_files WHERE id IN (${fileIds.map(() => '?').join(', ')})`
        ).all(...fileIds) as any[]
        for (const row of fileRows) {
          fileMap.set(row.id, { file_name: row.file_name, file_path: row.file_path })
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
              paragraph_id: entry.vs.sourceType === 'paragraph' ? entry.vs.sourceId : undefined,
              paragraph_title: indexEntry.title,
              text: indexEntry.content.substring(0, 300),
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

    hybridResults.sort((a, b) => b.sortKey - a.sortKey)
    return hybridResults.slice(0, topK).map(h => ({
      ...h.result,
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

    const embeddingCount = (this.db.prepare(
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
    const buffer = Buffer.from(embedding.buffer)

    // 事务包裹 check-then-insert，避免并发写入产生重复行
    const upsert = this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT id, rowid FROM kms_embeddings WHERE source_type = ? AND source_id = ?'
      ).get(sourceType, sourceId) as any

      if (existing) {
        this.db.prepare(`
          UPDATE kms_embeddings SET embedding = ?, model = ?, dimension = ?, updated_at = unixepoch() WHERE id = ?
        `).run(buffer, model, embedding.length, existing.id)
        return existing.rowid
      }

      const id = generateId()
      this.db.prepare(`
        INSERT INTO kms_embeddings (id, source_type, source_id, file_id, embedding, model, dimension, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, sourceType, sourceId, fileId, buffer, model, embedding.length)
      return Number((this.db.prepare('SELECT last_insert_rowid() as r').get() as any).r)
    })

    const rowid = upsert()

    // 同步写入 vec0 虚表
    this.syncVecIndex(rowid, buffer, fileId, sourceType, embedding.length)

    // 仅更新 __all__ 缓存（若已存在），追加新条目而非全量清空，避免批量写入时缓存命中率归零
    const cached = this.embeddingCache.get('__all__')
    if (cached) {
      cached.push({
        id: sourceId,
        sourceType,
        sourceId,
        fileId,
        embedding: new Float32Array(embedding),
        model,
        dimension: embedding.length,
      })
    }
  }

  /**
   * 批量存储向量嵌入（单事务，消除 per-item 事务开销）
   * 用于 generateEmbeddings 等批量写入场景
   */
  storeEmbeddingsBatch(
    entries: Array<{ sourceType: string; sourceId: string; fileId: string; embedding: Float32Array; model: string }>
  ): void {
    if (entries.length === 0) return

    const tx = this.db.transaction(() => {
      for (const e of entries) {
        const buffer = Buffer.from(e.embedding.buffer)
        const existing = this.db.prepare(
          'SELECT id, rowid FROM kms_embeddings WHERE source_type = ? AND source_id = ?'
        ).get(e.sourceType, e.sourceId) as any

        let rowid: number
        if (existing) {
          this.db.prepare(`
            UPDATE kms_embeddings SET embedding = ?, model = ?, dimension = ?, updated_at = unixepoch() WHERE id = ?
          `).run(buffer, e.model, e.embedding.length, existing.id)
          rowid = existing.rowid
        } else {
          const id = generateId()
          const result = this.db.prepare(`
            INSERT INTO kms_embeddings (id, source_type, source_id, file_id, embedding, model, dimension, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
          `).run(id, e.sourceType, e.sourceId, e.fileId, buffer, e.model, e.embedding.length)
          rowid = Number(result.lastInsertRowid)
        }

        if (this.vecReady && this.vecDimension === e.embedding.length) {
          try {
            this.db.prepare('DELETE FROM vec_kms_embeddings WHERE rowid = ?').run(rowid)
            this.db.prepare(
              'INSERT INTO vec_kms_embeddings(rowid, embedding, file_id, source_type) VALUES (?, ?, ?, ?)'
            ).run(rowid, buffer, e.fileId, e.sourceType)
          } catch (err: any) {
            logger.warn(`storeEmbeddingsBatch: vec0 sync failed for rowid=${rowid}:`, err?.message || err)
          }
        }
      }
    })

    tx()

    // 增量更新缓存
    const allCache = this.embeddingCache.get('__all__')
    if (allCache) {
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
    }
  }

  /**
   * 失效指定 fileId 的 embedding 缓存（删除文件时调用）
   * 从 __all__ 缓存数组中过滤掉该 fileId 的条目，避免全量重载
   */
  private invalidateEmbeddingCacheForFile(fileId: string): void {
    const cached = this.embeddingCache.get('__all__')
    if (cached) {
      const filtered = cached.filter(e => e.fileId !== fileId)
      if (filtered.length !== cached.length) {
        this.embeddingCache.set('__all__', filtered)
      }
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
      this.db.prepare('DELETE FROM vec_kms_embeddings WHERE rowid = ?').run(rowid)
      this.db.prepare(
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
    this.db.prepare(`
      INSERT INTO kms_fts (index_id, file_id, source_type, source_id, title, content, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(indexId, fileId, sourceType, sourceId, title, content, keywords)
  }

  private deleteFtsRow(indexId: string): void {
    this.db.prepare('DELETE FROM kms_fts WHERE index_id = ?').run(indexId)
  }

  private buildFtsWhereClause(options?: SearchOptions): { whereClause: string; params: any[] } {
    let whereClause = '1=1'
    const params: any[] = []

    if (options?.fileIds && options.fileIds.length > 0) {
      const placeholders = options.fileIds.map(() => '?').join(',')
      whereClause += ` AND kms_fts.file_id IN (${placeholders})`
      params.push(...options.fileIds)
    }

    if (options?.sourceTypes && options.sourceTypes.length > 0) {
      const placeholders = options.sourceTypes.map(() => '?').join(',')
      whereClause += ` AND kms_fts.source_type IN (${placeholders})`
      params.push(...options.sourceTypes)
    }

    // 时间范围过滤
    if (options?.timeRangeStart || options?.timeRangeEnd) {
      whereClause += ' AND f.id = kms_fts.file_id'
      if (options.timeRangeStart) {
        whereClause += ' AND f.modified_time >= ?'
        params.push(options.timeRangeStart)
      }
      if (options.timeRangeEnd) {
        whereClause += ' AND f.modified_time <= ?'
        params.push(options.timeRangeEnd)
      }
    }

    // 文件扩展名过滤
    if (options?.fileExtensions && options.fileExtensions.length > 0) {
      const placeholders = options.fileExtensions.map(() => '?').join(',')
      whereClause += ` AND f.file_ext IN (${placeholders})`
      params.push(...options.fileExtensions)
    }

    // 合集过滤：只搜索属于指定合集的文件
    if (options?.collectionIds && options.collectionIds.length > 0) {
      const placeholders = options.collectionIds.map(() => '?').join(',')
      whereClause += ` AND kms_fts.file_id IN (SELECT file_id FROM kms_file_collections WHERE collection_id IN (${placeholders}))`
      params.push(...options.collectionIds)
    }

    // 索引目录过滤：只搜索指定目录下的文件
    if (options?.dirIds && options.dirIds.length > 0) {
      const placeholders = options.dirIds.map(() => '?').join(',')
      whereClause += ` AND kms_fts.file_id IN (SELECT id FROM kms_files WHERE dir_id IN (${placeholders}))`
      params.push(...options.dirIds)
    }

    return { whereClause, params }
  }

  private convertFtsResultsToSearchResults(ftsResults: any[], topK: number, queryWords?: string[]): SearchResult[] {
    // 批量预加载所有 fileId 对应的文件信息，避免循环内 N+1 查询
    const fileIds = [...new Set(ftsResults.map(r => r.file_id).filter(Boolean))]
    const fileCache: Map<string, { name: string; path: string }> = new Map()
    if (fileIds.length > 0) {
      const placeholders = fileIds.map(() => '?').join(',')
      const rows = this.db.prepare(
        `SELECT id, file_name, file_path FROM kms_files WHERE id IN (${placeholders})`
      ).all(...fileIds) as any[]
      for (const row of rows) {
        fileCache.set(row.id, { name: row.file_name || '', path: row.file_path || '' })
      }
    }
    const getFile = (fileId: string) => {
      return fileCache.get(fileId) ?? { name: '', path: '' }
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
            text: `文件标题匹配: ${row.title}`,
            match_type: 'file_title',
          }
          break

        case 'file_summary':
          result = {
            file_id: row.file_id,
            file_name: fileInfo.name,
            file_path: fileInfo.path,
            text: `文件摘要: ${row.content.substring(0, 300)}${row.content.length > 300 ? '...' : ''}`,
            match_type: 'file_summary',
          }
          break

        case 'paragraph':
          result = {
            file_id: row.file_id,
            file_name: fileInfo.name,
            file_path: fileInfo.path,
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
            file_id: row.file_id,
            file_name: fileInfo.name,
            file_path: fileInfo.path,
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
    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey)!
    }

    const rows = this.db.prepare('SELECT id, source_type, source_id, file_id, embedding, model, dimension FROM kms_embeddings').all() as any[]

    const entries: EmbeddingEntry[] = rows.map(row => ({
      id: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      fileId: row.file_id,
      embedding: new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimension),
      model: row.model,
      dimension: row.dimension,
    }))

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
    const rows = this.db.prepare(
      `SELECT id, source_type, source_id, file_id, embedding, model, dimension FROM kms_embeddings${whereClause}`
    ).all(...params) as any[]

    return rows.map(row => ({
      id: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      fileId: row.file_id,
      embedding: new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimension),
      model: row.model,
      dimension: row.dimension,
    }))
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
      return `content-${result.file_id}-${result.start_offset}`
    }
    return `${result.match_type}-${result.file_id}`
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
