import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSSearchEngineService from './kms-search-engine.service'
import LLMClientService from '../llm-client.service'
import { createLogger } from '../logger'
import type { ProgressCallback } from './kms-index-manager.service'

const logger = createLogger('KMS-Embedding')

class KMSEmbeddingService {
  private db: Database.Database
  private static instance: KMSEmbeddingService

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSEmbeddingService {
    if (!KMSEmbeddingService.instance) {
      KMSEmbeddingService.instance = new KMSEmbeddingService()
    }
    return KMSEmbeddingService.instance
  }

  async generateEmbeddings(
    providerId?: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
    forceRegenerate: boolean = false,
  ): Promise<void> {
    if (!providerId) {
      const KMSService = (await import('./kms.service')).default
      const kmsService = KMSService.getInstance()
      const embConfig = kmsService.getKmsEmbeddingConfigPublic()
      if (embConfig) {
        providerId = embConfig.providerId
      } else {
        const defaultConfig = LLMClientService.getInstance().getDefaultEmbeddingConfig()
        if (!defaultConfig) {
          logger.warn('No embedding provider configured, skipping embedding generation')
          onProgress?.({
            phase: 'error',
            current: 0,
            total: 0,
            message: '未配置 Embedding 模型，请在「设置 - 模型设置」中配置智能索引模型后重试',
          })
          return
        }
        providerId = defaultConfig.providerId
      }
    }

    const searchEngine = KMSSearchEngineService.getInstance()
    const llmClient = LLMClientService.getInstance()

    if (forceRegenerate) {
      logger.info('Force regenerate embeddings: clearing all existing embeddings')
      const clearAll = this.db.transaction(() => {
        this.db.prepare('DELETE FROM kms_embeddings').run()
        try {
          this.db.prepare('DELETE FROM vec_kms_embeddings').run()
        } catch (err: any) {
          logger.warn('清理 vec_kms_embeddings 失败:', err?.message || err)
        }
      })
      clearAll()
      searchEngine.invalidateCache()
    }

    const batchSize = 20
    const pageLimit = 500
    let totalProcessed = 0
    let embeddingError: string | undefined
    let totalToProcess = 0
    {
      const row = this.db.prepare(`
        SELECT COUNT(*) as cnt
        FROM kms_search_index si
        LEFT JOIN kms_embeddings e ON si.source_type = e.source_type AND si.source_id = e.source_id
        WHERE e.id IS NULL AND si.content != ''
      `).get() as any
      totalToProcess = row?.cnt ?? 0
    }

    while (!signal?.aborted) {
      const unembedded = this.db.prepare(`
        SELECT si.id, si.source_type, si.source_id, si.file_id, si.title, si.content
        FROM kms_search_index si
        LEFT JOIN kms_embeddings e ON si.source_type = e.source_type AND si.source_id = e.source_id
        WHERE e.id IS NULL AND si.content != ''
        LIMIT ?
      `).all(pageLimit) as any[]

      if (unembedded.length === 0) {
        if (totalProcessed === 0) {
          logger.info('No unembedded entries found')
          onProgress?.({
            phase: 'embedding',
            current: 0,
            total: 0,
            message: '没有需要生成向量嵌入的条目',
          })
        }
        break
      }

      onProgress?.({ phase: 'embedding', current: totalProcessed, total: totalToProcess, message: `生成向量嵌入: ${totalProcessed}/${totalToProcess}` })

      for (let i = 0; i < unembedded.length; i += batchSize) {
        if (signal?.aborted) break
        const batch = unembedded.slice(i, i + batchSize)
        const texts = batch.map(entry => `${entry.title} ${entry.content}`.substring(0, 500))

        try {
          const embeddings = await llmClient.createEmbeddings(providerId, texts)
          const batchEntries = []
          for (let j = 0; j < batch.length && j < embeddings.length; j++) {
            batchEntries.push({
              sourceType: batch[j].source_type,
              sourceId: batch[j].source_id,
              fileId: batch[j].file_id,
              embedding: embeddings[j],
              model: providerId,
            })
          }
          if (batchEntries.length > 0) {
            searchEngine.storeEmbeddingsBatch(batchEntries)
          }
        } catch (err: any) {
          logger.error('Batch embedding generation failed:', err)
          if (!embeddingError) {
            embeddingError = err?.message || String(err)
            onProgress?.({
              phase: 'error',
              current: totalProcessed,
              total: totalToProcess,
              message: `向量嵌入失败: ${embeddingError}`,
            })
          }
          break
        }

        totalProcessed += batch.length
        onProgress?.({ phase: 'embedding', current: totalProcessed, total: totalToProcess, message: `生成向量嵌入: ${totalProcessed}/${totalToProcess}` })
      }

      if (unembedded.length < pageLimit) break
      if (embeddingError) break
    }

    searchEngine.invalidateCache()
  }

  async generateEmbeddingsForFile(
    fileId: string,
    chatProviderId: string,
  ): Promise<{ error?: string }> {
    try {
      const KMSService = (await import('./kms.service')).default
      const kmsService = KMSService.getInstance()
      const embConfig = kmsService.getKmsEmbeddingConfigPublic()
      const providerId = embConfig?.providerId || chatProviderId

      const llmClient = LLMClientService.getInstance()
      const searchEngine = KMSSearchEngineService.getInstance()

      const unembedded = this.db.prepare(`
        SELECT si.id, si.source_type, si.source_id, si.file_id, si.title, si.content
        FROM kms_search_index si
        LEFT JOIN kms_embeddings e ON si.source_type = e.source_type AND si.source_id = e.source_id
        WHERE e.id IS NULL AND si.content != '' AND si.file_id = ?
      `).all(fileId) as any[]

      if (unembedded.length === 0) return {}

      const batchSize = 20
      let firstError: string | undefined
      for (let i = 0; i < unembedded.length; i += batchSize) {
        const batch = unembedded.slice(i, i + batchSize)
        const texts = batch.map(entry => `${entry.title} ${entry.content}`.substring(0, 500))
        try {
          const embeddings = await llmClient.createEmbeddings(providerId, texts)
          const batchEntries = []
          for (let j = 0; j < batch.length && j < embeddings.length; j++) {
            batchEntries.push({
              sourceType: batch[j].source_type,
              sourceId: batch[j].source_id,
              fileId: batch[j].file_id,
              embedding: embeddings[j],
              model: providerId,
            })
          }
          if (batchEntries.length > 0) {
            searchEngine.storeEmbeddingsBatch(batchEntries)
          }
        } catch (err: any) {
          logger.error(`Batch embedding failed for file ${fileId}:`, err)
          if (!firstError) {
            firstError = err?.message || String(err)
          }
        }
      }
      searchEngine.invalidateCache()
      return firstError ? { error: firstError } : {}
    } catch (err: any) {
      logger.warn(`Failed to generate embeddings for file ${fileId}:`, err)
      return { error: err?.message || String(err) }
    }
  }
}

export default KMSEmbeddingService
