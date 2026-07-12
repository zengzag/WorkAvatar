import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSSearchEngineService from './kms-search-engine.service'
import LLMClientService from '../llm-client.service'
import { createLogger } from '../logger'
import type { ProgressCallback } from './kms-index-manager.service'

const logger = createLogger('KMS-Embedding')

class KMSEmbeddingService {
  private db: Database.Database
  private vectorDb: Database.Database
  private static instance: KMSEmbeddingService

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
    this.vectorDb = KMSDatabaseService.getInstance().getVectorDb()
  }

  static getInstance(): KMSEmbeddingService {
    if (!KMSEmbeddingService.instance) {
      KMSEmbeddingService.instance = new KMSEmbeddingService()
    }
    return KMSEmbeddingService.instance
  }

  /**
   * 从向量库加载所有已嵌入条目的 (source_type, source_id) 集合。
   *
   * 替代原跨库 LEFT JOIN 查询：
   * 原 SQL `LEFT JOIN kms_embeddings e ON si.source_type = e.source_type AND si.source_id = e.source_id WHERE e.id IS NULL`
   * 在分库后不可用（跨库 JOIN 失效），改为在应用层用 Set 过滤。
   *
   * @returns Set<`${source_type}:${source_id}`>
   */
  private loadExistingEmbeddingKeys(): Set<string> {
    const keys = new Set<string>()
    const rows = this.vectorDb.prepare(
      'SELECT source_type, source_id FROM kms_embeddings'
    ).all() as any[]
    for (const row of rows) {
      keys.add(`${row.source_type}:${row.source_id}`)
    }
    return keys
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
      const clearAll = this.vectorDb.transaction(() => {
        this.vectorDb.prepare('DELETE FROM kms_embeddings').run()
        try {
          this.vectorDb.prepare('DELETE FROM vec_kms_embeddings').run()
        } catch (err: any) {
          logger.warn('清理 vec_kms_embeddings 失败:', err?.message || err)
        }
      })
      clearAll()
      searchEngine.invalidateCache()
    }

    // 从向量库加载已嵌入条目的 (source_type, source_id) 集合
    // 用于在应用层过滤未嵌入条目（替代原跨库 LEFT JOIN）
    const existingKeys = this.loadExistingEmbeddingKeys()

    const batchSize = 20
    const pageLimit = 500
    let totalProcessed = 0
    let embeddingError: string | undefined

    // 统计唯一 (source_type, source_id) 数：content_paragraph 类型同一文件多段落共享同一 key，
    // 而 kms_embeddings 按 (source_type, source_id) 唯一存储，因此必须统计唯一 key 数才能准确估算
    const uniqueRow = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM (SELECT DISTINCT source_type, source_id FROM kms_search_index WHERE content != '')"
    ).get() as any
    const uniqueCandidates = uniqueRow?.cnt ?? 0
    const totalToProcess = Math.max(0, uniqueCandidates - existingKeys.size)

    logger.info(`Embedding generation: ${totalToProcess} entry(s) to process (forceRegenerate=${forceRegenerate}, provider=${providerId})`)

    // keyset 分页：用 id > ? 替代 OFFSET，避免大表 OFFSET 性能退化
    let lastId = ''
    while (!signal?.aborted) {
      const candidates = this.db.prepare(
        "SELECT id, source_type, source_id, file_id, title, content FROM kms_search_index WHERE content != '' AND id > ? ORDER BY id LIMIT ?"
      ).all(lastId, pageLimit) as any[]

      if (candidates.length === 0) {
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

      lastId = candidates[candidates.length - 1].id

      // 应用层过滤：排除向量库中已存在的条目 + 同页内 (source_type, source_id) 去重
      // content_paragraph 类型同一文件多段落共享同一 key，只取第一条即可
      const seenInPage = new Set<string>()
      const unembedded: typeof candidates = []
      for (const c of candidates) {
        const key = `${c.source_type}:${c.source_id}`
        if (!existingKeys.has(key) && !seenInPage.has(key)) {
          seenInPage.add(key)
          unembedded.push(c)
        }
      }

      if (unembedded.length === 0) {
        if (candidates.length < pageLimit) break
        continue
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
            for (const entry of batchEntries) {
              existingKeys.add(`${entry.sourceType}:${entry.sourceId}`)
            }
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

      if (candidates.length < pageLimit) break
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

      // 从主库查询该文件的所有待嵌入条目
      const candidates = this.db.prepare(`
        SELECT id, source_type, source_id, file_id, title, content
        FROM kms_search_index
        WHERE content != '' AND file_id = ?
      `).all(fileId) as any[]

      if (candidates.length === 0) return {}

      // 从向量库查询该文件已嵌入的 (source_type, source_id) 集合
      const existingRows = this.vectorDb.prepare(
        'SELECT source_type, source_id FROM kms_embeddings WHERE file_id = ?'
      ).all(fileId) as any[]
      const existingKeys = new Set<string>()
      for (const row of existingRows) {
        existingKeys.add(`${row.source_type}:${row.source_id}`)
      }

      // 应用层过滤未嵌入条目 + 同文件内 (source_type, source_id) 去重
      const seen = new Set<string>()
      const unembedded: typeof candidates = []
      for (const c of candidates) {
        const key = `${c.source_type}:${c.source_id}`
        if (!existingKeys.has(key) && !seen.has(key)) {
          seen.add(key)
          unembedded.push(c)
        }
      }
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
