import KBDatabaseService from './kb-database.service'
import { generateId } from './common-utils'

type SourceType = 'document_title' | 'document_summary' | 'chapter' | 'entity' | 'content_paragraph'

interface SearchResult {
  document_id: string
  document_name: string
  chapter_id?: string
  chapter_title?: string
  text: string
  match_type: SourceType | 'hybrid'
  start_offset?: number
  end_offset?: number
  start_line?: number
  end_line?: number
  entity_id?: string
  entity_name?: string
  entity_type?: string
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

  private constructor() {
    this.kbDb = KBDatabaseService.getInstance()
  }

  private get db() { return this.kbDb.getDb() }

  static getInstance(): SearchEngineService {
    if (!SearchEngineService.instance) {
      SearchEngineService.instance = new SearchEngineService()
    }
    return SearchEngineService.instance
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
    keywords: string[],
    topics: string[]
  ): void {
    const existing = this.db.prepare(
      "SELECT id FROM kb_search_index WHERE source_type = 'document_summary' AND source_id = ?"
    ).get(documentId) as any

    const keywordsStr = keywords.join(', ')
    const content = [summary, ...topics].join(' ')

    if (existing) {
      this.db.prepare(`
        UPDATE kb_search_index SET title = ?, content = ?, keywords_json = ?, metadata_json = ?, updated_at = unixepoch() WHERE id = ?
      `).run('文档摘要', content, JSON.stringify(keywords), JSON.stringify({ topics }), existing.id)

      this.deleteFtsRow(existing.id)
      this.insertFtsRow(existing.id, kbId, 'document_summary', documentId, documentId, '文档摘要', content, keywordsStr)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_search_index (id, kb_id, source_type, source_id, document_id, title, content, keywords_json, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'document_summary', ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, kbId, documentId, documentId, '文档摘要', content, JSON.stringify(keywords), JSON.stringify({ topics }))

      this.insertFtsRow(id, kbId, 'document_summary', documentId, documentId, '文档摘要', content, keywordsStr)
    }
  }

  indexChapter(
    kbId: string,
    documentId: string,
    chapterId: string,
    title: string,
    summary: string,
    keywords: string[],
    entities: Array<{ name: string; type: string }>,
    startOffset: number,
    endOffset: number
  ): void {
    const existing = this.db.prepare(
      "SELECT id FROM kb_search_index WHERE source_type = 'chapter' AND source_id = ?"
    ).get(chapterId) as any

    const keywordsStr = keywords.join(', ')
    const entityNames = entities.map(e => e.name).join(', ')
    const content = [title, summary, entityNames].filter(Boolean).join(' ')

    if (existing) {
      this.db.prepare(`
        UPDATE kb_search_index SET title = ?, content = ?, keywords_json = ?, metadata_json = ?,
          start_offset = ?, end_offset = ?, updated_at = unixepoch() WHERE id = ?
      `).run(title, content, JSON.stringify(keywords), JSON.stringify({ entities, summary }),
        startOffset, endOffset, existing.id)

      this.deleteFtsRow(existing.id)
      this.insertFtsRow(existing.id, kbId, 'chapter', chapterId, documentId, title, content, keywordsStr)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_search_index (id, kb_id, source_type, source_id, document_id, title, content, keywords_json, metadata_json, start_offset, end_offset, created_at, updated_at)
        VALUES (?, ?, 'chapter', ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, kbId, chapterId, documentId, title, content,
        JSON.stringify(keywords), JSON.stringify({ entities, summary }),
        startOffset, endOffset)

      this.insertFtsRow(id, kbId, 'chapter', chapterId, documentId, title, content, keywordsStr)
    }
  }

  indexEntity(
    kbId: string,
    entityId: string,
    name: string,
    type: string,
    description: string,
    aliases: string[],
    firstSeenDocId: string
  ): void {
    const existing = this.db.prepare(
      "SELECT id FROM kb_search_index WHERE source_type = 'entity' AND source_id = ?"
    ).get(entityId) as any

    const aliasesStr = aliases.join(', ')
    const content = [name, type, description, aliasesStr].filter(Boolean).join(' ')

    if (existing) {
      this.db.prepare(`
        UPDATE kb_search_index SET title = ?, content = ?, metadata_json = ?, document_id = ?, updated_at = unixepoch() WHERE id = ?
      `).run(name, content, JSON.stringify({ type, description, aliases }), firstSeenDocId, existing.id)

      this.deleteFtsRow(existing.id)
      this.insertFtsRow(existing.id, kbId, 'entity', entityId, firstSeenDocId, name, content, aliasesStr)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_search_index (id, kb_id, source_type, source_id, document_id, title, content, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'entity', ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, kbId, entityId, firstSeenDocId, name, content,
        JSON.stringify({ type, description, aliases }))

      this.insertFtsRow(id, kbId, 'entity', entityId, firstSeenDocId, name, content, aliasesStr)
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
    this.embeddingCache.delete(kbId)
    this.invalidateCache()
  }

  rebuildIndexForKb(kbId: string): void {
    this.deleteIndexByKb(kbId)
  }

  private buildFtsWhereClause(kbId: string, options?: { documentIds?: string[]; sourceTypes?: SourceType[]; excludeEntity?: boolean }): { whereClause: string; params: any[] } {
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

    if (options?.excludeEntity) {
      whereClause += " AND kb_fts.source_type != 'entity'"
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

  advancedFtsSearch(
    kbId: string,
    query: string,
    topK: number = 10,
    options?: { documentIds?: string[]; documentType?: string }
  ): SearchResult[] {
    const phrases: string[] = []
    const required: string[] = []
    const excludedWords: string[] = []
    const optional: string[] = []

    const phraseRegex = /"([^"]+)"/g
    let match
    let queryWithoutPhrases = query
    while ((match = phraseRegex.exec(query)) !== null) {
      phrases.push(match[1].toLowerCase())
      queryWithoutPhrases = queryWithoutPhrases.replace(match[0], ' ')
    }

    const words = queryWithoutPhrases.toLowerCase().split(/\s+/).filter((w: string) => w.length > 0)
    for (const word of words) {
      if (word.startsWith('+') && word.length > 1) {
        required.push(word.slice(1))
      } else if (word.startsWith('-') && word.length > 1) {
        excludedWords.push(word.slice(1))
      } else if (word.length > 1) {
        optional.push(word)
      }
    }

    if (phrases.length === 0 && required.length === 0 && optional.length === 0) return []

    const ftsParts: string[] = []
    for (const phrase of phrases) {
      ftsParts.push(`"${phrase}"`)
    }
    for (const req of required) {
      ftsParts.push(`${req}*`)
    }
    for (const opt of optional) {
      ftsParts.push(`${opt}*`)
    }

    const ftsQuery = ftsParts.join(' OR ')
    if (!ftsQuery) return []

    const { whereClause, params } = this.buildFtsWhereClause(kbId, {
      documentIds: options?.documentIds,
      excludeEntity: !!options?.documentType,
    })

    try {
      let filtered = this.executeFtsQuery(ftsQuery, whereClause, params, topK * 3)

      if (required.length > 0) {
        filtered = filtered.filter((r: any) => {
          const text = `${r.title} ${r.content}`.toLowerCase()
          return required.every(req => text.includes(req))
        })
      }

      if (excludedWords.length > 0) {
        filtered = filtered.filter((r: any) => {
          const text = `${r.title} ${r.content}`.toLowerCase()
          return !excludedWords.some(ex => text.includes(ex))
        })
      }

      return this.convertFtsResultsToSearchResults(filtered, topK)
    } catch {
      return []
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

        case 'chapter':
          result = {
            document_id: row.document_id,
            document_name: docName,
            chapter_id: row.source_id,
            chapter_title: row.title,
            text: `章节「${row.title}」: ${(metadata.summary || row.content).substring(0, 300)}`,
            match_type: 'chapter',
            start_offset: row.start_offset,
            end_offset: row.end_offset,
          }
          break

        case 'entity':
          result = {
            document_id: row.document_id,
            document_name: '知识图谱实体',
            text: `实体「${row.title}」(${metadata.type || 'other'}): ${metadata.description || '无描述'}`,
            match_type: 'entity',
            entity_id: row.source_id,
            entity_name: row.title,
            entity_type: metadata.type,
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
      'SELECT id FROM kb_embeddings WHERE source_type = ? AND source_id = ?'
    ).get(sourceType, sourceId) as any

    const buffer = Buffer.from(embedding.buffer)

    if (existing) {
      this.db.prepare(`
        UPDATE kb_embeddings SET embedding = ?, model = ?, dimension = ?, updated_at = unixepoch() WHERE id = ?
      `).run(buffer, model, embedding.length, existing.id)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_embeddings (id, kb_id, source_type, source_id, document_id, embedding, model, dimension, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, kbId, sourceType, sourceId, documentId, buffer, model, embedding.length)
    }

    this.embeddingCache.delete(kbId)
  }

  vectorSearch(
    kbId: string,
    queryEmbedding: Float32Array,
    topK: number = 10,
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

        const indexEntry = this.db.prepare(
          'SELECT * FROM kb_search_index WHERE source_type = ? AND source_id = ?'
        ).get(vs.sourceType, vs.sourceId) as any

        if (indexEntry) {
          const doc = this.db.prepare('SELECT original_name FROM kb_documents WHERE id = ?').get(indexEntry.document_id) as any
          hybridResults.push({
            result: {
              document_id: indexEntry.document_id,
              document_name: doc?.original_name || '',
              chapter_id: vs.sourceType === 'chapter' ? vs.sourceId : undefined,
              chapter_title: indexEntry.title,
              text: indexEntry.content.substring(0, 300),
              match_type: 'hybrid',
              start_offset: indexEntry.start_offset,
              end_offset: indexEntry.end_offset,
            },
            sortKey,
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
      'SELECT * FROM kb_embeddings WHERE kb_id = ?'
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
    if (result.chapter_id) return `chapter-${result.chapter_id}`
    if (result.entity_id) return `entity-${result.entity_id}`
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
