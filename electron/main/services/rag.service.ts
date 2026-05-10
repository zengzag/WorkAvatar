import { connect, type Connection } from '@lancedb/lancedb'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'

interface SearchResult {
  text: string
  score: number
  source: {
    file_id?: string
    file_name?: string
    document_id?: string
    document_name?: string
    chapter_id?: string
    chapter_title?: string
    chunk_index: number
    layer: 'text_chunk' | 'chapter_summary' | 'document_summary' | 'global_summary'
  }
}

class RAGService {
  private db: DatabaseService
  private llmClient: LLMClientService
  private connections: Map<string, Connection> = new Map()
  private static instance: RAGService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
  }

  static getInstance(): RAGService {
    if (!RAGService.instance) {
      RAGService.instance = new RAGService()
    }
    return RAGService.instance
  }

  private getVectorDbPath(scopeId: string): string {
    const isDev = !app.isPackaged
    const basePath = isDev
      ? path.join(process.cwd(), '.workavatar-data', 'vectors')
      : path.join(app.getPath('userData'), 'vectors')

    const scopePath = path.join(basePath, scopeId)
    if (!fs.existsSync(scopePath)) {
      fs.mkdirSync(scopePath, { recursive: true })
    }
    return scopePath
  }

  private async getConnection(scopeId: string): Promise<Connection> {
    if (this.connections.has(scopeId)) {
      return this.connections.get(scopeId)!
    }

    const dbPath = this.getVectorDbPath(scopeId)
    const conn = await connect(dbPath)
    this.connections.set(scopeId, conn)
    return conn
  }

  private async getEmbedding(text: string, providerId?: string): Promise<number[]> {
    const embeddings = await this.getEmbeddingsBatch([text], providerId)
    return embeddings[0] || []
  }

  private async getEmbeddingsBatch(texts: string[], providerId?: string): Promise<number[][]> {
    const provider = providerId || this.getDefaultProviderId()
    if (!provider) {
      throw new Error('No LLM provider configured for embeddings')
    }

    const config = await this.llmClient.getProviderConfig(provider)
    if (!config) {
      throw new Error('Provider config not found')
    }

    const baseURL = this.getBaseURL(config)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (config.api_key) {
      headers['Authorization'] = `Bearer ${config.api_key}`
    }

    const embeddingModel = config.embedding_model || 'text-embedding-3-small'

    const timeoutMs = config.timeout_ms || 30000
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(`${baseURL}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: embeddingModel,
          input: texts,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Embedding API error (${response.status}): ${errorText}`)
      }

      const data = await response.json()
      const results: number[][] = []
      for (let i = 0; i < texts.length; i++) {
        const item = data.data?.find((d: any) => d.index === i)
        results.push(item?.embedding || [])
      }
      return results
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private getBaseURL(config: any): string {
    if (config.base_url) {
      return config.base_url.replace(/\/+$/, '')
    }
    switch (config.provider_type) {
      case 'openai':
      case 'openai-compatible':
        return 'https://api.openai.com/v1'
      case 'groq':
        return 'https://api.groq.com/openai/v1'
      case 'mistral':
        return 'https://api.mistral.ai/v1'
      default:
        return 'https://api.openai.com/v1'
    }
  }

  private getDefaultProviderId(): string | null {
    const row = this.db.getDb().prepare(
      "SELECT id FROM llm_providers WHERE is_default = 1 LIMIT 1"
    ).get() as any
    return row?.id || null
  }

  private chunkText(text: string, chunkSize: number = 1000, overlap: number = 200): string[] {
    const chunks: string[] = []
    let start = 0

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length)
      let chunkEnd = end

      if (end < text.length) {
        const lastPeriod = text.lastIndexOf('。', end)
        const lastNewline = text.lastIndexOf('\n', end)
        const lastSpace = text.lastIndexOf(' ', end)
        const bestBreak = Math.max(lastPeriod, lastNewline, lastSpace)
        if (bestBreak > start) {
          chunkEnd = bestBreak + 1
        }
      }

      chunks.push(text.substring(start, chunkEnd).trim())
      start += chunkEnd - start - overlap

      if (start >= text.length) break
    }

    return chunks.filter((c) => c.length > 50)
  }

  async indexProjectFiles(
    projectId: string,
    onProgress?: (current: number, total: number) => void
  ): Promise<{ success: boolean; indexed: number; error?: string }> {
    try {
      const files = this.db.getDb().prepare(
        'SELECT * FROM files WHERE project_id = ? AND status = ?'
      ).all(projectId, 'completed') as any[]

      if (files.length === 0) {
        return { success: true, indexed: 0 }
      }

      const conn = await this.getConnection(projectId)
      const tableName = 'documents'

      try {
        await conn.dropTable(tableName)
      } catch {}

      const allChunks: Array<{
        id: string
        text: string
        file_id: string
        file_name: string
        chunk_index: number
      }> = []

      for (const file of files) {
        try {
          const parsed = file.parsed_json ? JSON.parse(file.parsed_json) : null
          const text = parsed?.fullText || file.thumbnail_text || ''
          if (!text || text.length < 50) continue

          const chunks = this.chunkText(text)
          for (let i = 0; i < chunks.length; i++) {
            allChunks.push({
              id: `${file.id}_chunk_${i}`,
              text: chunks[i],
              file_id: file.id,
              file_name: file.original_name,
              chunk_index: i,
            })
          }
        } catch (err) {
          console.error(`Failed to chunk file ${file.id}:`, err)
        }
      }

      if (allChunks.length === 0) {
        return { success: true, indexed: 0 }
      }

      const BATCH_SIZE = 50
      const indexedChunks: Array<{
        id: string
        vector: number[]
        text: string
        file_id: string
        file_name: string
        chunk_index: number
      }> = []

      for (let batchStart = 0; batchStart < allChunks.length; batchStart += BATCH_SIZE) {
        const batch = allChunks.slice(batchStart, batchStart + BATCH_SIZE)
        const embeddings = await this.getEmbeddingsBatch(batch.map((c) => c.text))

        for (let i = 0; i < batch.length; i++) {
          const embedding = embeddings[i]
          if (!embedding || embedding.length === 0) continue

          indexedChunks.push({
            id: batch[i].id,
            vector: embedding,
            text: batch[i].text,
            file_id: batch[i].file_id,
            file_name: batch[i].file_name,
            chunk_index: batch[i].chunk_index,
          })
        }

        onProgress?.(Math.min(batchStart + BATCH_SIZE, allChunks.length), allChunks.length)
      }

      if (indexedChunks.length > 0) {
        await conn.createTable(tableName, indexedChunks)
      }

      return { success: true, indexed: indexedChunks.length }
    } catch (err: any) {
      console.error('RAG index error:', err)
      return { success: false, indexed: 0, error: err.message }
    }
  }

  async indexKBDocuments(
    kbId: string,
    onProgress?: (current: number, total: number) => void
  ): Promise<{ success: boolean; indexed: number; error?: string }> {
    try {
      const docs = this.db.getDb().prepare(
        "SELECT * FROM kb_documents WHERE kb_id = ? AND parse_status = 'completed'"
      ).all(kbId) as any[]

      if (docs.length === 0) {
        return { success: true, indexed: 0 }
      }

      const conn = await this.getConnection(`kb-${kbId}`)

      const tables = await conn.tableNames()

      const allChunks: Array<{
        id: string
        vector: number[]
        text: string
        document_id: string
        document_name: string
        chapter_id: string
        chapter_title: string
        chunk_index: number
        layer: string
      }> = []

      for (const tableName of ['text_chunks', 'chapter_summaries', 'document_summaries']) {
        if (tables.includes(tableName)) {
          try { await conn.dropTable(tableName) } catch {}
        }
      }

      const textChunks: Array<{
        id: string
        text: string
        document_id: string
        document_name: string
        chapter_id: string
        chapter_title: string
        chunk_index: number
      }> = []

      const chapters = this.db.getDb().prepare(
        'SELECT * FROM kb_chapters WHERE kb_id = ?'
      ).all(kbId) as any[]

      const chapterMap = new Map<string, any>()
      for (const ch of chapters) {
        chapterMap.set(ch.id, ch)
      }

      for (const doc of docs) {
        const docChapters = chapters.filter(c => c.document_id === doc.id)
        if (docChapters.length > 0) {
          for (const chapter of docChapters) {
            const chunks = this.chunkText(chapter.content, 800, 150)
            for (let i = 0; i < chunks.length; i++) {
              textChunks.push({
                id: `${doc.id}_${chapter.id}_chunk_${i}`,
                text: chunks[i],
                document_id: doc.id,
                document_name: doc.original_name,
                chapter_id: chapter.id,
                chapter_title: chapter.title,
                chunk_index: i,
              })
            }
          }
        } else {
          const text = doc.content_text || ''
          if (text.length < 50) continue
          const chunks = this.chunkText(text)
          for (let i = 0; i < chunks.length; i++) {
            textChunks.push({
              id: `${doc.id}_chunk_${i}`,
              text: chunks[i],
              document_id: doc.id,
              document_name: doc.original_name,
              chapter_id: '',
              chapter_title: '',
              chunk_index: i,
            })
          }
        }
      }

      const BATCH_SIZE = 50
      let totalProcessed = 0
      const totalItems = textChunks.length

      for (let batchStart = 0; batchStart < textChunks.length; batchStart += BATCH_SIZE) {
        const batch = textChunks.slice(batchStart, batchStart + BATCH_SIZE)
        const embeddings = await this.getEmbeddingsBatch(batch.map((c) => c.text))

        for (let i = 0; i < batch.length; i++) {
          const embedding = embeddings[i]
          if (!embedding || embedding.length === 0) continue

          allChunks.push({
            id: batch[i].id,
            vector: embedding,
            text: batch[i].text,
            document_id: batch[i].document_id,
            document_name: batch[i].document_name,
            chapter_id: batch[i].chapter_id,
            chapter_title: batch[i].chapter_title,
            chunk_index: batch[i].chunk_index,
            layer: 'text_chunk',
          })
        }

        totalProcessed += batch.length
        onProgress?.(totalProcessed, totalItems)
      }

      const chapterSummaryChunks: Array<{
        id: string
        text: string
        document_id: string
        document_name: string
        chapter_id: string
        chapter_title: string
      }> = []

      for (const chapter of chapters) {
        if (chapter.summary) {
          chapterSummaryChunks.push({
            id: `cs_${chapter.id}`,
            text: chapter.summary,
            document_id: chapter.document_id,
            document_name: (docs.find(d => d.id === chapter.document_id) as any)?.original_name || '',
            chapter_id: chapter.id,
            chapter_title: chapter.title,
          })
        }
      }

      if (chapterSummaryChunks.length > 0) {
        for (let batchStart = 0; batchStart < chapterSummaryChunks.length; batchStart += BATCH_SIZE) {
          const batch = chapterSummaryChunks.slice(batchStart, batchStart + BATCH_SIZE)
          const embeddings = await this.getEmbeddingsBatch(batch.map((c) => c.text))

          for (let i = 0; i < batch.length; i++) {
            const embedding = embeddings[i]
            if (!embedding || embedding.length === 0) continue

            allChunks.push({
              id: batch[i].id,
              vector: embedding,
              text: batch[i].text,
              document_id: batch[i].document_id,
              document_name: batch[i].document_name,
              chapter_id: batch[i].chapter_id,
              chapter_title: batch[i].chapter_title,
              chunk_index: 0,
              layer: 'chapter_summary',
            })
          }
        }
      }

      const docSummaries = this.db.getDb().prepare(
        'SELECT ds.*, d.original_name as document_name FROM kb_document_summaries ds JOIN kb_documents d ON ds.document_id = d.id WHERE ds.kb_id = ?'
      ).all(kbId) as any[]

      if (docSummaries.length > 0) {
        const docSummaryTexts = docSummaries.map(ds => ({
          id: `ds_${ds.document_id}`,
          text: ds.summary,
          document_id: ds.document_id,
          document_name: ds.document_name,
        }))

        for (let batchStart = 0; batchStart < docSummaryTexts.length; batchStart += BATCH_SIZE) {
          const batch = docSummaryTexts.slice(batchStart, batchStart + BATCH_SIZE)
          const embeddings = await this.getEmbeddingsBatch(batch.map((c) => c.text))

          for (let i = 0; i < batch.length; i++) {
            const embedding = embeddings[i]
            if (!embedding || embedding.length === 0) continue

            allChunks.push({
              id: batch[i].id,
              vector: embedding,
              text: batch[i].text,
              document_id: batch[i].document_id,
              document_name: batch[i].document_name,
              chapter_id: '',
              chapter_title: '',
              chunk_index: 0,
              layer: 'document_summary',
            })
          }
        }
      }

      if (allChunks.length > 0) {
        await conn.createTable('knowledge_vectors', allChunks)
      }

      return { success: true, indexed: allChunks.length }
    } catch (err: any) {
      console.error('KB RAG index error:', err)
      return { success: false, indexed: 0, error: err.message }
    }
  }

  async search(
    projectId: string,
    query: string,
    topK: number = 5,
    minScore: number = 0.5
  ): Promise<SearchResult[]> {
    try {
      const conn = await this.getConnection(projectId)
      const table = await conn.openTable('documents')

      const queryEmbedding = await this.getEmbedding(query)

      const results = await table
        .query()
        .nearestTo(queryEmbedding)
        .limit(topK)
        .toArray()

      return results
        .map((r: any) => ({
          text: r.text as string,
          score: r._distance ? 1 - r._distance : 0,
          source: {
            file_id: r.file_id as string,
            file_name: r.file_name as string,
            chunk_index: r.chunk_index as number,
            layer: 'text_chunk' as const,
          },
        }))
        .filter((r) => r.score >= minScore)
    } catch (err: any) {
      console.error('RAG search error:', err)
      return []
    }
  }

  async searchKB(
    kbId: string,
    query: string,
    options?: {
      topK?: number
      minScore?: number
      layers?: Array<'text_chunk' | 'chapter_summary' | 'document_summary'>
      documentIds?: string[]
      contextSize?: number
    }
  ): Promise<SearchResult[]> {
    const topK = options?.topK || 10
    const minScore = options?.minScore || 0.3
    const layers = options?.layers || ['chapter_summary', 'text_chunk', 'document_summary']
    const documentIds = options?.documentIds
    const contextSize = options?.contextSize || 200

    try {
      const conn = await this.getConnection(`kb-${kbId}`)
      const tables = await conn.tableNames()

      if (!tables.includes('knowledge_vectors')) {
        return []
      }

      const table = await conn.openTable('knowledge_vectors')
      const queryEmbedding = await this.getEmbedding(query)

      let filterStr = ''
      const conditions: string[] = []

      if (layers.length > 0 && layers.length < 3) {
        const layerValues = layers.map(l => `'${l}'`).join(', ')
        conditions.push(`layer IN (${layerValues})`)
      }

      if (documentIds && documentIds.length > 0) {
        const docValues = documentIds.map(d => `'${d}'`).join(', ')
        conditions.push(`document_id IN (${docValues})`)
      }

      if (conditions.length > 0) {
        filterStr = conditions.join(' AND ')
      }

      let queryBuilder = table.query().nearestTo(queryEmbedding).limit(topK * 2)

      if (filterStr) {
        queryBuilder = queryBuilder.filter(filterStr)
      }

      const results = await queryBuilder.toArray()

      let searchResults: SearchResult[] = results
        .map((r: any) => ({
          text: r.text as string,
          score: r._distance ? 1 - r._distance : 0,
          source: {
            document_id: r.document_id as string,
            document_name: r.document_name as string,
            chapter_id: r.chapter_id as string,
            chapter_title: r.chapter_title as string,
            chunk_index: r.chunk_index as number,
            layer: r.layer as 'text_chunk' | 'chapter_summary' | 'document_summary',
          },
        }))
        .filter((r) => r.score >= minScore)

      if (contextSize > 0) {
        searchResults = await this.expandContext(kbId, searchResults, contextSize)
      }

      searchResults.sort((a, b) => b.score - a.score)

      const layerPriority: Record<string, number> = { chapter_summary: 0, document_summary: 1, text_chunk: 2, global_summary: 3 }
      searchResults.sort((a, b) => {
        const la = layerPriority[a.source.layer] ?? 3
        const lb = layerPriority[b.source.layer] ?? 3
        if (la !== lb) return la - lb
        return b.score - a.score
      })

      return searchResults.slice(0, topK)
    } catch (err: any) {
      console.error('KB RAG search error:', err)
      return []
    }
  }

  private async expandContext(
    _kbId: string,
    results: SearchResult[],
    contextSize: number
  ): Promise<SearchResult[]> {
    const expandedResults: SearchResult[] = []

    for (const result of results) {
      if (result.source.layer !== 'text_chunk' || !result.source.chapter_id) {
        expandedResults.push(result)
        continue
      }

      const chapter = this.db.getDb().prepare(
        'SELECT content FROM kb_chapters WHERE id = ?'
      ).get(result.source.chapter_id) as any

      if (chapter?.content) {
        const textIndex = chapter.content.indexOf(result.text)
        if (textIndex >= 0) {
          const start = Math.max(0, textIndex - contextSize)
          const end = Math.min(chapter.content.length, textIndex + result.text.length + contextSize)
          const expandedText = chapter.content.substring(start, end)

          expandedResults.push({
            ...result,
            text: start > 0 ? `...${expandedText}` : expandedText,
            score: result.score,
          })
        } else {
          expandedResults.push(result)
        }
      } else {
        expandedResults.push(result)
      }
    }

    return expandedResults
  }

  async multiLevelSearch(
    kbId: string,
    query: string,
    topK: number = 5
  ): Promise<{
    globalResults: SearchResult[]
    documentResults: SearchResult[]
    chapterResults: SearchResult[]
    textResults: SearchResult[]
  }> {
    const [documentResults, chapterResults, textResults] = await Promise.all([
      this.searchKB(kbId, query, { topK, layers: ['document_summary'] }),
      this.searchKB(kbId, query, { topK, layers: ['chapter_summary'] }),
      this.searchKB(kbId, query, { topK, layers: ['text_chunk'] }),
    ])

    const globalSummary = this.db.getDb().prepare(
      'SELECT * FROM kb_global_summaries WHERE kb_id = ?'
    ).get(kbId) as any

    let globalResults: SearchResult[] = []
    if (globalSummary?.summary) {
      const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
      let score = 0
      const summaryLower = globalSummary.summary.toLowerCase()
      for (const word of queryWords) {
        if (summaryLower.includes(word)) score += 2
      }
      if (score > 0) {
        globalResults.push({
          text: globalSummary.summary,
          score: Math.min(score / 10, 1),
          source: {
            chunk_index: 0,
            layer: 'global_summary',
          },
        })
      }
    }

    return { globalResults, documentResults, chapterResults, textResults }
  }

  async getIndexStatus(projectId: string): Promise<{
    exists: boolean
    documentCount: number
  }> {
    try {
      const conn = await this.getConnection(projectId)
      const tables = await conn.tableNames()

      if (!tables.includes('documents')) {
        return { exists: false, documentCount: 0 }
      }

      const table = await conn.openTable('documents')
      const count = await table.countRows()
      return { exists: true, documentCount: count }
    } catch {
      return { exists: false, documentCount: 0 }
    }
  }

  async getKBIndexStatus(kbId: string): Promise<{
    exists: boolean
    vectorCount: number
    layerCounts: Record<string, number>
  }> {
    try {
      const conn = await this.getConnection(`kb-${kbId}`)
      const tables = await conn.tableNames()

      if (!tables.includes('knowledge_vectors')) {
        return { exists: false, vectorCount: 0, layerCounts: {} }
      }

      const table = await conn.openTable('knowledge_vectors')
      const count = await table.countRows()

      const layerCounts: Record<string, number> = {}
      try {
        for (const layer of ['text_chunk', 'chapter_summary', 'document_summary']) {
          const layerResults = await table.query().filter(`layer = '${layer}'`).limit(999999).toArray()
          layerCounts[layer] = layerResults.length
        }
      } catch {}

      return { exists: true, vectorCount: count, layerCounts }
    } catch {
      return { exists: false, vectorCount: 0, layerCounts: {} }
    }
  }

  async deleteIndex(projectId: string): Promise<boolean> {
    try {
      const conn = await this.getConnection(projectId)
      await conn.dropTable('documents')
      return true
    } catch {
      return false
    }
  }

  async deleteKBIndex(kbId: string): Promise<boolean> {
    try {
      const conn = await this.getConnection(`kb-${kbId}`)
      const tables = await conn.tableNames()
      for (const table of tables) {
        try { await conn.dropTable(table) } catch {}
      }
      return true
    } catch {
      return false
    }
  }
}

export default RAGService
