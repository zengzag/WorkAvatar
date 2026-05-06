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
    file_id: string
    file_name: string
    chunk_index: number
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

  private getVectorDbPath(projectId: string): string {
    const isDev = !app.isPackaged
    const basePath = isDev
      ? path.join(process.cwd(), '.workavatar-data', 'vectors')
      : path.join(app.getPath('userData'), 'vectors')

    const projectPath = path.join(basePath, projectId)
    if (!fs.existsSync(projectPath)) {
      fs.mkdirSync(projectPath, { recursive: true })
    }
    return projectPath
  }

  private async getConnection(projectId: string): Promise<Connection> {
    if (this.connections.has(projectId)) {
      return this.connections.get(projectId)!
    }

    const dbPath = this.getVectorDbPath(projectId)
    const conn = await connect(dbPath)
    this.connections.set(projectId, conn)
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
      } catch {
        // Table may not exist
      }

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
          },
        }))
        .filter((r) => r.score >= minScore)
    } catch (err: any) {
      console.error('RAG search error:', err)
      return []
    }
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

  async deleteIndex(projectId: string): Promise<boolean> {
    try {
      const conn = await this.getConnection(projectId)
      await conn.dropTable('documents')
      return true
    } catch {
      return false
    }
  }
}

export default RAGService
