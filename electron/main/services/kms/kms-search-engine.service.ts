import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import { generateId } from '../common-utils'

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

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSSearchEngineService {
    if (!KMSSearchEngineService.instance) {
      KMSSearchEngineService.instance = new KMSSearchEngineService()
    }
    return KMSSearchEngineService.instance
  }

  // ==================== 索引操作 ====================

  /**
   * 索引文件标题
   */
  indexFileTitle(fileId: string, fileName: string): void {
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
  }

  /**
   * 索引文件摘要
   */
  indexFileSummary(fileId: string, summary: string, keywords: string[]): void {
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
   * 删除文件的所有索引
   */
  deleteIndexByFile(fileId: string): void {
    const rows = this.db.prepare(
      'SELECT id FROM kms_search_index WHERE file_id = ?'
    ).all(fileId) as any[]

    if (rows.length > 0) {
      const transaction = this.db.transaction(() => {
        for (const row of rows) {
          this.deleteFtsRow(row.id)
        }
      })
      transaction()
    }

    this.db.prepare('DELETE FROM kms_search_index WHERE file_id = ?').run(fileId)
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
      const transaction = this.db.transaction(() => {
        for (const row of rows) {
          this.deleteFtsRow(row.id)
        }
      })
      transaction()
    }

    this.db.prepare(
      'DELETE FROM kms_search_index WHERE file_id = ? AND source_type = ?'
    ).run(fileId, sourceType)
  }

  /**
   * 克隆索引数据（用于MD5去重：相同内容文件复用索引）
   */
  cloneIndexData(sourceFileId: string, targetFileId: string): void {
    const sourceRows = this.db.prepare(
      'SELECT * FROM kms_search_index WHERE file_id = ?'
    ).all(sourceFileId) as any[]

    if (sourceRows.length === 0) return

    const transaction = this.db.transaction(() => {
      for (const row of sourceRows) {
        const newId = generateId()
        this.db.prepare(`
          INSERT INTO kms_search_index (id, file_id, source_type, source_id, paragraph_index, title, content, keywords_json, metadata_json, start_offset, end_offset, start_line, end_line, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(
          newId, targetFileId, row.source_type, generateId(),
          row.paragraph_index, row.title, row.content,
          row.keywords_json, row.metadata_json,
          row.start_offset, row.end_offset, row.start_line, row.end_line
        )

        this.insertFtsRow(newId, targetFileId, row.source_type as SourceType, newId, row.title, row.content, '')
      }
    })

    transaction()
    this.invalidateCache()
  }

  // ==================== 搜索操作 ====================

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
        // 长文本：切分为 bigram
        for (let i = 0; i < chars.length - 1; i++) {
          const bigram = chars.substring(i, i + 2)
          if (!stopWords.has(bigram)) keywords.add(bigram)
        }
        // 同时尝试提取3-gram 提升精确度
        for (let i = 0; i < chars.length - 2; i++) {
          const trigram = chars.substring(i, i + 3)
          keywords.add(trigram)
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
    // FTS5 中特殊字符需要转义或用引号包裹
    const escaped = keywords.map(k => {
      // 用双引号包裹，避免 FTS5 语法错误
      return `"${k.replace(/"/g, '""')}"*`
    })
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

    // 取所有索引记录，用 LIKE 匹配
    const rows = this.db.prepare(`
      SELECT si.* FROM kms_search_index si
      JOIN kms_files f ON si.file_id = f.id
      WHERE ${whereClause}
    `).all(...params) as any[]

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
    let embeddings = this.loadAllEmbeddings()

    // 按条件过滤
    if (options?.fileIds && options.fileIds.length > 0) {
      const fileSet = new Set(options.fileIds)
      embeddings = embeddings.filter(e => fileSet.has(e.fileId))
    }

    if (options?.sourceTypes && options.sourceTypes.length > 0) {
      const typeSet = new Set(options.sourceTypes as string[])
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
            score: sortKey,
          },
          sortKey,
        })
      } else if (useVector && vectorScore > 0) {
        const vs = vectorSourceMap.get(key)
        if (!vs) continue

        const indexEntry = this.db.prepare(
          'SELECT * FROM kms_search_index WHERE source_type = ? AND source_id = ?'
        ).get(vs.sourceType, vs.sourceId) as any

        if (indexEntry) {
          const file = this.db.prepare('SELECT file_name, file_path FROM kms_files WHERE id = ?').get(indexEntry.file_id) as any
          hybridResults.push({
            result: {
              file_id: indexEntry.file_id,
              file_name: file?.file_name || '',
              file_path: file?.file_path || '',
              paragraph_id: vs.sourceType === 'paragraph' ? vs.sourceId : undefined,
              paragraph_title: indexEntry.title,
              text: indexEntry.content.substring(0, 300),
              match_type: 'hybrid',
              start_offset: indexEntry.start_offset,
              end_offset: indexEntry.end_offset,
              score: sortKey,
            },
            sortKey,
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

  // ==================== 向量嵌入操作 ====================

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
    const existing = this.db.prepare(
      'SELECT id FROM kms_embeddings WHERE source_type = ? AND source_id = ?'
    ).get(sourceType, sourceId) as any

    const buffer = Buffer.from(embedding.buffer)

    if (existing) {
      this.db.prepare(`
        UPDATE kms_embeddings SET embedding = ?, model = ?, dimension = ?, updated_at = unixepoch() WHERE id = ?
      `).run(buffer, model, embedding.length, existing.id)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kms_embeddings (id, source_type, source_id, file_id, embedding, model, dimension, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, sourceType, sourceId, fileId, buffer, model, embedding.length)
    }

    this.embeddingCache.clear()
  }

  /**
   * 删除文件的所有向量嵌入
   */
  deleteEmbeddingsByFile(fileId: string): void {
    this.db.prepare('DELETE FROM kms_embeddings WHERE file_id = ?').run(fileId)
    this.embeddingCache.clear()
  }

  // ==================== 缓存操作 ====================

  invalidateCache(): void {
    this.searchCache.clear()
  }

  // ==================== 私有方法 ====================

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

    return { whereClause, params }
  }

  private convertFtsResultsToSearchResults(ftsResults: any[], topK: number, queryWords?: string[]): SearchResult[] {
    const fileCache: Map<string, { name: string; path: string }> = new Map()
    const getFile = (fileId: string) => {
      if (fileCache.has(fileId)) return fileCache.get(fileId)!
      const file = this.db.prepare('SELECT file_name, file_path FROM kms_files WHERE id = ?').get(fileId) as any
      const info = { name: file?.file_name || '', path: file?.file_path || '' }
      fileCache.set(fileId, info)
      return info
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

    const rows = this.db.prepare('SELECT * FROM kms_embeddings').all() as any[]

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
    return entry.results
  }

  private putToCache(key: string, results: SearchResult[]): void {
    if (this.searchCache.size >= KMSSearchEngineService.CACHE_MAX_SIZE) {
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
