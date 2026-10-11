import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSSearchEngineService from './kms-search-engine.service'
import LLMClientService from '../llm-client.service'
import { createLogger } from '../logger'
import type { ProgressCallback } from './kms-index-manager.service'

const logger = createLogger('KMS-Embedding')

/** embedding 输入文本长度上限（字符）。
 * kms_search_index.content 已按 SEARCH_INDEX_CONTENT_LIMIT(1000) 截断，
 * 此处取整段截断内容作为向量输入，保证向量语义与段落关键词一致。 */
const EMBEDDING_TEXT_LIMIT = 1000

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


  private getEligibleCandidates(lastId: string, limit: number): any[] {
    return this.db.prepare(`
      SELECT si.id, si.source_type, si.source_id, si.file_id, si.title, si.content,
             COALESCE(f.content_version_id, '') AS content_version_id, f.file_hash
      FROM kms_search_index si
      JOIN kms_files f ON f.id = si.file_id
      WHERE si.content != ''
        AND COALESCE(f.ai_exclusion_level, 0) < 2
        AND (
          si.source_type IN ('document', 'file_title', 'file_summary')
          OR (si.source_type IN ('paragraph', 'content_paragraph') AND f.data_tier = 'hot')
        )
        AND si.id > ?
      ORDER BY si.id
      LIMIT ?
    `).all(lastId, limit) as any[]
  }

  reconcileJobs(modelKey: string): number {
    // 已存在的向量键：用于判断任务是否“真的完成”。
    // 重建索引会删除向量但保留 done 任务，若只看任务状态会漏生成，必须按“向量是否存在”重新入队。
    const existing = new Set<string>(
      (this.vectorDb.prepare('SELECT source_type, source_id FROM kms_embeddings WHERE model = ?').all(modelKey) as any[])
        .map(r => `${r.source_type}:${r.source_id}`)
    )
    let enqueued = 0
    let lastId = ''
    const pageSize = 500
    while (true) {
      const candidates = this.getEligibleCandidates(lastId, pageSize)
      if (candidates.length === 0) break
      lastId = candidates[candidates.length - 1].id
      const tx = this.vectorDb.transaction(() => {
        for (const c of candidates) {
          const hasEmbedding = existing.has(`${c.source_type}:${c.source_id}`) ? 1 : 0
          const result = this.vectorDb.prepare(`
            INSERT INTO kms_embedding_jobs (
              id, model_key, file_id, content_version_id, source_type, source_id, content_hash, status, priority, created_at, updated_at
            ) VALUES (@id, @modelKey, @fileId, @contentVersionId, @sourceType, @sourceId, @contentHash, 'pending', 100, unixepoch(), unixepoch())
            ON CONFLICT(model_key, source_type, source_id, content_hash) DO UPDATE SET
              file_id = excluded.file_id,
              content_version_id = excluded.content_version_id,
              status = CASE
                WHEN @hasEmbedding = 0 AND kms_embedding_jobs.status IN ('done', 'failed') THEN 'pending'
                ELSE kms_embedding_jobs.status
              END,
              attempts = CASE WHEN @hasEmbedding = 0 AND kms_embedding_jobs.status = 'done' THEN 0 ELSE kms_embedding_jobs.attempts END,
              locked_by = CASE WHEN @hasEmbedding = 0 AND kms_embedding_jobs.status = 'done' THEN '' ELSE kms_embedding_jobs.locked_by END,
              locked_until = CASE WHEN @hasEmbedding = 0 AND kms_embedding_jobs.status = 'done' THEN 0 ELSE kms_embedding_jobs.locked_until END,
              updated_at = unixepoch()
          `).run({
            id: `${modelKey}:${c.source_type}:${c.source_id}:${c.file_hash}`,
            modelKey,
            fileId: c.file_id,
            contentVersionId: c.content_version_id,
            sourceType: c.source_type,
            sourceId: c.source_id,
            contentHash: c.file_hash,
            hasEmbedding,
          })
          if (result.changes > 0) enqueued++
        }
      })
      tx()
      if (candidates.length < pageSize) break
    }
    return enqueued
  }

  private claimJobs(modelKey: string, limit: number): any[] {
    const lockId = `worker:${process.pid}:${Date.now()}`
    const lockedUntil = Math.floor(Date.now() / 1000) + 10 * 60
    return this.vectorDb.transaction(() => {
      const rows = this.vectorDb.prepare(`
        SELECT * FROM kms_embedding_jobs
        WHERE model_key = ?
          AND (status = 'pending' OR (status = 'running' AND locked_until < unixepoch()))
        ORDER BY priority ASC, updated_at ASC
        LIMIT ?
      `).all(modelKey, limit) as any[]
      for (const row of rows) {
        this.vectorDb.prepare(`
          UPDATE kms_embedding_jobs
          SET status = 'running', locked_by = ?, locked_until = ?, attempts = attempts + 1, updated_at = unixepoch()
          WHERE id = ?
        `).run(lockId, lockedUntil, row.id)
      }
      return rows
    })()
  }

  private completeJob(job: any): void {
    this.vectorDb.prepare(`
      UPDATE kms_embedding_jobs
      SET status = 'done', locked_by = '', locked_until = 0, last_error = '', updated_at = unixepoch()
      WHERE id = ?
    `).run(job.id)
  }

  private failJob(job: any, error: string): void {
    this.vectorDb.prepare(`
      UPDATE kms_embedding_jobs
      SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
          locked_by = '',
          locked_until = 0,
          last_error = ?,
          updated_at = unixepoch()
      WHERE id = ?
    `).run(error.substring(0, 1000), job.id)
  }

  private loadCandidatesForJobs(jobs: any[]): any[] {
    const fileIds = [...new Set(jobs.map(j => j.file_id))]
    const rows: any[] = []
    for (let i = 0; i < fileIds.length; i += 500) {
      const batch = fileIds.slice(i, i + 500)
      const placeholders = batch.map(() => '?').join(',')
      const candidates = this.db.prepare(`
        SELECT si.id, si.source_type, si.source_id, si.file_id, si.title, si.content
        FROM kms_search_index si
        JOIN kms_files f ON f.id = si.file_id
        WHERE si.file_id IN (${placeholders})
          AND si.content != ''
          AND COALESCE(f.ai_exclusion_level, 0) < 2
          AND (
            si.source_type IN ('document', 'file_title', 'file_summary')
            OR (si.source_type IN ('paragraph', 'content_paragraph') AND f.data_tier = 'hot')
          )
      `).all(...batch) as any[]
      rows.push(...candidates)
    }
    const byKey = new Map(rows.map(r => [`${r.file_id}:${r.source_type}:${r.source_id}`, r]))
    return jobs.map(j => byKey.get(`${j.file_id}:${j.source_type}:${j.source_id}`)).filter(Boolean)
  }

  async generateEmbeddings(
    providerIdParam?: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
    forceRegenerate: boolean = false,
  ): Promise<void> {
    let providerId = providerIdParam
    // 记录真实模型名（写入 kms_embeddings.model 供排查维度/模型问题，勿存 providerId）
    let modelLabel: string = providerIdParam || ''
    if (!providerId) {
      const KMSService = (await import('./kms.service')).default
      const kmsService = KMSService.getInstance()
      const embConfig = kmsService.getKmsEmbeddingConfigPublic()
      if (embConfig) {
        providerId = embConfig.providerId
        modelLabel = embConfig.modelName || providerId
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
        modelLabel = (defaultConfig as any).model || providerId
      }
    }

    const searchEngine = KMSSearchEngineService.getInstance()
    const llmClient = LLMClientService.getInstance()

    if (forceRegenerate) {
      logger.info('Force regenerate embeddings: current-model vectors will be reset after embedding dimension is known')
    }

    this.reconcileJobs(modelLabel)
    if (forceRegenerate) {
      this.vectorDb.prepare(`
        UPDATE kms_embedding_jobs
        SET status = 'pending', attempts = 0, locked_by = '', locked_until = 0, last_error = '', updated_at = unixepoch()
        WHERE model_key = ?
      `).run(modelLabel)
    }

    const totalToProcess = (this.vectorDb.prepare(`
      SELECT COUNT(*) AS cnt FROM kms_embedding_jobs
      WHERE model_key = ? AND status IN ('pending','running')
    `).get(modelLabel) as any)?.cnt || 0
    let totalProcessed = 0
    let vectorModelPrepared = false

    logger.info(`Embedding queue: ${totalToProcess} job(s) (forceRegenerate=${forceRegenerate}, provider=${providerId})`)
    if (totalToProcess === 0) {
      onProgress?.({ phase: 'embedding', current: 0, total: 0, message: '没有需要生成向量嵌入的条目' })
      searchEngine.invalidateCache()
      return
    }

    while (!signal?.aborted) {
      const jobs = this.claimJobs(modelLabel, 100)
      if (jobs.length === 0) break
      const candidates = this.loadCandidatesForJobs(jobs)
      const jobByKey = new Map(jobs.map(j => [`${j.file_id}:${j.source_type}:${j.source_id}`, j]))

      for (let i = 0; i < candidates.length; i += 20) {
        if (signal?.aborted) break
        const batch = candidates.slice(i, i + 20)
        const texts = batch.map(entry => `${entry.title} ${entry.content}`.substring(0, EMBEDDING_TEXT_LIMIT))
        try {
          const embeddings = await llmClient.createEmbeddings(providerId, texts)
          if (!vectorModelPrepared && embeddings[0]?.length) {
            searchEngine.prepareVectorModel(modelLabel, embeddings[0].length, false)
            vectorModelPrepared = true
          }
          const batchEntries = []
          for (let j = 0; j < batch.length && j < embeddings.length; j++) {
            batchEntries.push({
              sourceType: batch[j].source_type,
              sourceId: batch[j].source_id,
              fileId: batch[j].file_id,
              embedding: embeddings[j],
              model: modelLabel,
            })
            const job = jobByKey.get(`${batch[j].file_id}:${batch[j].source_type}:${batch[j].source_id}`)
            if (job) this.completeJob(job)
          }
          if (batchEntries.length > 0) searchEngine.storeEmbeddingsBatch(batchEntries)
        } catch (err: any) {
          const message = err?.message || String(err)
          logger.error('Batch embedding generation failed:', message)
          for (const candidate of batch) {
            const job = jobByKey.get(`${candidate.file_id}:${candidate.source_type}:${candidate.source_id}`)
            if (job) this.failJob(job, message)
          }
        }
        totalProcessed += batch.length
        onProgress?.({ phase: 'embedding', current: totalProcessed, total: totalToProcess, message: `生成向量嵌入: ${totalProcessed}/${totalToProcess}` })
      }

      if (jobs.length < 100) break
    }

    searchEngine.invalidateAllCaches()
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
      const modelLabel = embConfig?.modelName || providerId

      const llmClient = LLMClientService.getInstance()
      const searchEngine = KMSSearchEngineService.getInstance()

      // 从主库查询该文件的所有待嵌入条目
      const fileRow = this.db.prepare('SELECT data_tier FROM kms_files WHERE id = ?').get(fileId) as any
      const fileTier = fileRow?.data_tier || 'cold'
      const candidates = this.db.prepare(`
        SELECT si.id, si.source_type, si.source_id, si.file_id, si.title, si.content
        FROM kms_search_index si
        WHERE si.content != ''
          AND si.file_id = ?
          AND (
            si.source_type IN ('document', 'file_title', 'file_summary')
            OR (si.source_type IN ('paragraph', 'content_paragraph') AND ? = 'hot')
          )
      `).all(fileId, fileTier) as any[]

      if (candidates.length === 0) return {}

      // 从向量库查询该文件已嵌入的 (source_type, source_id) 集合
      const existingRows = this.vectorDb.prepare(
        'SELECT source_type, source_id FROM kms_embeddings WHERE file_id = ? AND model = ?'
      ).all(fileId, modelLabel) as any[]
      const existingKeys = new Set<string>()
      for (const row of existingRows) {
        existingKeys.add(`${row.source_type}:${row.source_id}`)
      }

      // 应用层过滤未嵌入条目 + 同文件内 (source_type, source_id) 去重。
      // content_paragraph 每段 source_id 唯一，此处天然逐段保留
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
        const texts = batch.map(entry => `${entry.title} ${entry.content}`.substring(0, EMBEDDING_TEXT_LIMIT))
        try {
          const embeddings = await llmClient.createEmbeddings(providerId, texts)
          if (embeddings[0]?.length) {
            searchEngine.prepareVectorModel(modelLabel, embeddings[0].length, false)
          }
          const batchEntries = []
          for (let j = 0; j < batch.length && j < embeddings.length; j++) {
            batchEntries.push({
              sourceType: batch[j].source_type,
              sourceId: batch[j].source_id,
              fileId: batch[j].file_id,
              embedding: embeddings[j],
              model: modelLabel,
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
