import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSCrawlerService from './kms-crawler.service'
import KMSSearchEngineService from './kms-search-engine.service'
import KMSAutoIndexService from './kms-auto-index.service'
import KMSEmbeddingService from './kms-embedding.service'
import KMSDataTierService from './kms-data-tier.service'
import FileParserService from '../file-parser.service'
import LLMClientService from '../llm-client.service'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'
import {
  countWords,
  splitParagraphs,
  generateFileToc,
  needsTocRestoration,
  identifyParagraphsFromLLMToc,
  filterTocByContentVolume,
  buildTocWithPath,
  MIN_CONTENT_WORDS,
} from './kms-paragraph-processor'
import {
  restoreTocWithLLM,
  generateParagraphSummary,
  generateDocumentSummaryFromParagraphs,
  updateParagraphSummaries,
  generateFileSummary as generateFileSummaryViaLLM,
  generateDirSummaryViaLLM,
} from './kms-index-llm-helpers'
import type {
  IndexPhase,
  IndexProgress,
  ProgressCallback,
  AutoIndexConfig,
  AutoIndexStatus,
} from './kms-index-types'

export type { IndexPhase, IndexProgress, ProgressCallback, AutoIndexConfig, AutoIndexStatus }

const logger = createLogger('KMS-Index')

class KMSIndexManagerService {
  private db: Database.Database
  private static instance: KMSIndexManagerService
  private abortController: AbortController | null = null

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSIndexManagerService {
    if (!KMSIndexManagerService.instance) {
      KMSIndexManagerService.instance = new KMSIndexManagerService()
    }
    return KMSIndexManagerService.instance
  }

  async buildFullIndex(providerId?: string, onProgress?: ProgressCallback, withEmbedding: boolean = true, resetHotData: boolean = false): Promise<void> {
    return this.runIndexPipeline('full', onProgress, { providerId, withEmbedding, resetHotData })
  }

  async incrementalIndex(providerId?: string, onProgress?: ProgressCallback, withEmbedding: boolean = true): Promise<void> {
    return this.runIndexPipeline('incremental', onProgress, { providerId, withEmbedding })
  }

  async rebuildDirIndex(dirId: string, providerId?: string, onProgress?: ProgressCallback, withEmbedding: boolean = true, resetHotData: boolean = false): Promise<void> {
    return this.runIndexPipeline('rebuild-dir', onProgress, { providerId, withEmbedding, dirId, resetHotData })
  }

  private async runIndexPipeline(
    mode: 'full' | 'incremental' | 'rebuild-dir',
    onProgress?: ProgressCallback,
    options: { providerId?: string; withEmbedding?: boolean; dirId?: string; resetHotData?: boolean } = {},
  ): Promise<void> {
    const { withEmbedding = true, dirId, resetHotData = false } = options
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    const isFull = mode === 'full'
    const isIncremental = mode === 'incremental'
    const isRebuildDir = mode === 'rebuild-dir'

    const msgCrawl = isIncremental ? '正在检测文件变更...' : '正在扫描目录...'
    const msgParsePrefix = isFull ? '开始解析' : isIncremental ? '增量解析' : '重建索引'
    const msgDonePrefix = isFull ? '索引完成' : isIncremental ? '增量索引完成' : '重建索引完成'
    const msgEmpty = isIncremental ? '没有需要更新的文件' : '没有需要索引的文件'
    const errorLabel = isFull ? 'Build full index failed:'
      : isIncremental ? 'Incremental index failed:'
      : 'Rebuild dir index failed:'

    try {
      logger.info(`Index pipeline started: mode=${mode}, withEmbedding=${withEmbedding}${dirId ? `, dirId=${dirId}` : ''}${resetHotData ? ', resetHotData=true' : ''}`)
      onProgress?.({ phase: 'crawling', current: 0, total: 0, message: msgCrawl })

      // 全量重建：批量重置所有文件为 pending 并清除旧索引，确保重新索引
      if (isFull) {
        onProgress?.({ phase: 'crawling', current: 0, total: 0, message: '正在重置索引...' })
        // 主库事务：清理 FTS5/搜索索引/段落，重置文件状态
        this.db.transaction(() => {
          this.db.prepare("DELETE FROM kms_fts").run()
          this.db.prepare("DELETE FROM kms_search_index").run()
          this.db.prepare("DELETE FROM kms_paragraphs").run()
          // 默认不重置热数据（保留 data_tier），勾选后才将热数据降级为 cold
          if (resetHotData) {
            this.db.prepare("UPDATE kms_files SET index_status = 'pending', data_tier = 'cold'").run()
          } else {
            this.db.prepare("UPDATE kms_files SET index_status = 'pending'").run()
          }
        })()
        // 向量库独立事务：清理 embedding（跨库不能同事务）
        const vectorDb = KMSDatabaseService.getInstance().getVectorDb()
        try {
          vectorDb.transaction(() => {
            vectorDb.prepare("DELETE FROM kms_embeddings").run()
            try { vectorDb.prepare("DELETE FROM vec_kms_embeddings").run() } catch (err: any) {
              // vec0 表可能尚未创建（首次全量重建前），忽略
              logger.debug('vec_kms_embeddings cleanup skipped (table may not exist):', err?.message || err)
            }
          })()
        } catch (err: any) {
          logger.warn('全量重建清理向量库失败:', err?.message || err)
        }
        KMSSearchEngineService.getInstance().invalidateCache()
      }

      if (isRebuildDir) {
        await KMSCrawlerService.getInstance().crawlDirectory(dirId!, signal)
      } else {
        await KMSCrawlerService.getInstance().crawlAllDirectories(signal)
      }

      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '已取消', cancelled: true })
        return
      }

      if (isRebuildDir) {
        const files = KMSCrawlerService.getInstance().getFilesByDir(dirId!)
        const searchEngine = KMSSearchEngineService.getInstance()
        for (const file of files) {
          searchEngine.deleteIndexByFile(file.id)
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'pending')
        }
      }

      const pendingFiles = KMSCrawlerService.getInstance().getPendingFiles()
      const total = pendingFiles.length

      logger.info(`Index pipeline: ${total} file(s) to process (mode=${mode})`)

      if (total === 0) {
        if (withEmbedding) {
          await KMSEmbeddingService.getInstance().generateEmbeddings(undefined, onProgress, signal, false)
        }
        onProgress?.({ phase: 'done', current: 0, total: 0, message: msgEmpty })
        return
      }

      onProgress?.({ phase: 'parsing', current: 0, total, message: `${msgParsePrefix} ${total} 个文件...` })

      const searchEngine = KMSSearchEngineService.getInstance()
      const fileParser = FileParserService.getInstance()
      const llmClient = LLMClientService.getInstance()

      // 摘要模型配置（用于文件摘要/目录摘要等 LLM 分析任务）
      let summaryProviderId: string | undefined
      let summaryModelId: string | undefined
      let summaryEnableThinking: boolean | undefined
      try {
        const KMSService = (await import('./kms.service')).default
        const summaryConfig = KMSService.getInstance().getKmsSummaryLLMConfigPublic()
        if (summaryConfig) {
          summaryProviderId = summaryConfig.providerId
          summaryModelId = summaryConfig.modelId
          summaryEnableThinking = summaryConfig.enableThinking
        }
      } catch (error) {
        logger.warn('Failed to resolve summary model config', error)
      }

      let processed = 0
      for (const file of pendingFiles) {
        if (signal.aborted) break

        try {
          // 解析前：状态置为 indexing + 删除旧索引，合并为单个事务
          // 内层各方法的 transaction 会变成 SAVEPOINT，最终只触发一次 commit
          KMSDatabaseService.getInstance().runInTransaction(() => {
            KMSCrawlerService.getInstance().updateFileStatus(file.id, 'indexing')
            searchEngine.deleteIndexByFile(file.id)
          })

          const parseResult = await fileParser.parseFilePath(file.filePath, signal, file.dataTier as 'hot' | 'cold')
          if (signal.aborted) break

          // 保存解析模式，确保预览时用相同解析器
          const parseMode = parseResult.metadata?.parser

          onProgress?.({
            phase: 'indexing',
            current: processed + 1,
            total,
            message: `索引: ${file.fileName}`,
          })

          // 解析后：标题索引 + 段落索引 + 解析模式 + 轻量摘要，合并为单个事务
          // 把原本 4-5 次小事务提交合并为 1 次，减少 fsync 次数（synchronous=NORMAL 下也减少 WAL 写入）
          KMSDatabaseService.getInstance().runInTransaction(() => {
            if (parseMode) {
              this.saveParseMode(file.id, parseMode)
            }
            searchEngine.indexFileTitle(file.id, file.fileName)
            if (parseResult.fullText) {
              searchEngine.indexContentParagraphs(file.id, parseResult.fullText, file.fileName)
            }
            if (isFull && parseResult.fullText) {
              this.saveLightSummary(file.id, file.fileName, parseResult.fullText)
            }
          })

          const isHot = file.dataTier === 'hot'
          if (isHot && summaryProviderId) {
            await this.processHotFile(file.id, parseResult.fullText, file.fileName, summaryProviderId, llmClient, searchEngine, signal, onProgress, { current: processed + 1, total }, summaryModelId, summaryEnableThinking)
          }

          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'completed')
        } catch (err: any) {
          if (signal.aborted) break
          logger.error(`Failed to index file "${file.fileName}":`, err)
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'failed', err.message)
        }

        processed++
        onProgress?.({
          phase: 'parsing',
          current: processed,
          total,
          message: `已处理 ${processed}/${total} 个文件`,
        })

        // 每处理完一个文件主动让出事件循环：
        // - Worker 模式下可及时响应 cancel 消息；
        // - 主线程降级模式下避免长时间独占事件循环导致 UI 卡死。
        await new Promise((resolve) => setImmediate(resolve))
      }

      if (!signal.aborted && withEmbedding) {
        await KMSEmbeddingService.getInstance().generateEmbeddings(undefined, onProgress, signal, false)
      }

      if (!signal.aborted && !isRebuildDir) {
        const { promotedFileIds } = KMSDataTierService.getInstance().evaluateDataTiers(true)
        if (promotedFileIds.length > 0 && !signal.aborted) {
          logger.info(`Processing ${promotedFileIds.length} promoted file(s) with hot-data pipeline...`)
          await this.processPromotedFiles(promotedFileIds, signal)
        }
      }

      if (!signal.aborted && isFull) {
        await this.generateDirSummaries(summaryProviderId, summaryModelId, summaryEnableThinking, llmClient, signal)
      }

      if (signal.aborted) {
        logger.info(`Index pipeline cancelled: mode=${mode}, processed=${processed}/${total}`)
        onProgress?.({ phase: 'done', current: processed, total, message: '已取消', cancelled: true })
      } else {
        logger.info(`Index pipeline completed: mode=${mode}, processed=${processed}/${total} files`)
        onProgress?.({ phase: 'done', current: processed, total, message: `${msgDonePrefix}，共处理 ${processed} 个文件` })
      }

      // 索引流程结束：主动触发 PASSIVE checkpoint，让 WAL 内容尽快合并回主库文件，
      // 避免长期运行后 WAL 文件膨胀（即使 wal_autocheckpoint 已设阈值，主动 checkpoint 可让磁盘占用更可控）
      try {
        KMSDatabaseService.getInstance().checkpoint('PASSIVE')
      } catch (err: any) {
        logger.warn('Post-index checkpoint failed:', err?.message || err)
      }
    } catch (err: any) {
      logger.error(errorLabel, err)
      onProgress?.({ phase: 'error', current: 0, total: 0, message: err.message })
    } finally {
      this.abortController = null
    }
  }

  cancelIndexing(): void {
    this.abortController?.abort()
    this.abortController = null
  }

  setAutoIndexProgressCallback(cb: ProgressCallback | null): void {
    KMSAutoIndexService.getInstance().setProgressCallback(cb)
  }

  startAutoIndex(config: AutoIndexConfig): void {
    KMSAutoIndexService.getInstance().start(config)
  }

  stopAutoIndex(): void {
    KMSAutoIndexService.getInstance().stop()
  }

  pauseAutoIndex(): void {
    KMSAutoIndexService.getInstance().pause()
  }

  resumeAutoIndex(): void {
    KMSAutoIndexService.getInstance().resume()
  }

  getAutoIndexStatus(): AutoIndexStatus {
    return KMSAutoIndexService.getInstance().getStatus()
  }

  async runAutoIndexCheck(): Promise<void> {
    await KMSAutoIndexService.getInstance().runCheck()
  }

  async processCollectionDeep(collectionId: string, onProgress?: ProgressCallback): Promise<{ fileProcessed: number; summaryGenerated: boolean; embeddingGenerated: boolean; error?: string }> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      const KMSService = (await import('./kms.service')).default
      const kmsService = KMSService.getInstance()
      const collection = kmsService.getCollection(collectionId)
      if (!collection) {
        logger.warn(`Collection deep process skipped: collection ${collectionId} not found`)
        return { fileProcessed: 0, summaryGenerated: false, embeddingGenerated: false, error: 'Collection not found' }
      }
      const files = kmsService.listFilesInCollection(collectionId)
      if (files.length === 0) {
        logger.warn(`Collection deep process skipped: collection "${collection.name}" has no files`)
        return { fileProcessed: 0, summaryGenerated: false, embeddingGenerated: false, error: 'NO_FILES' }
      }

      logger.info(`Collection deep process started: collection="${collection.name}"(${collectionId}), files=${files.length}`)

      const llmConfig = kmsService.getKmsSummaryLLMConfigPublic()
      if (!llmConfig) {
        return { fileProcessed: 0, summaryGenerated: false, embeddingGenerated: false, error: 'NO_LLM_PROVIDER' }
      }

      const searchEngine = KMSSearchEngineService.getInstance()
      const fileParser = FileParserService.getInstance()
      const llmClient = LLMClientService.getInstance()
      const total = files.length

      const reportProgress = this.makeCollectionProgress(collectionId, collection.name, onProgress)

      reportProgress({
        phase: 'parsing',
        current: 0,
        total,
        message: `合集深度处理: ${collection.name}（${total} 个文件）`,
      })

      let fileProcessed = 0
      for (const file of files) {
        if (signal.aborted) break

        try {
          const parseResult = await fileParser.parseFilePath(file.file_path, signal)
          if (signal.aborted) break
          if (!parseResult.fullText) {
            fileProcessed++
            continue
          }

          // 解析后写入：删除旧索引 + 标题/段落索引 + 轻量摘要合并为单个事务
          KMSDatabaseService.getInstance().runInTransaction(() => {
            searchEngine.deleteIndexByFile(file.id)
            searchEngine.indexFileTitle(file.id, file.file_name)
            searchEngine.indexContentParagraphs(file.id, parseResult.fullText, file.file_name)
            this.saveLightSummary(file.id, file.file_name, parseResult.fullText)
          })

          await this.processHotFile(
            file.id,
            parseResult.fullText,
            file.file_name,
            llmConfig.providerId,
            llmClient,
            searchEngine,
            signal,
            reportProgress,
            { current: fileProcessed + 1, total },
            llmConfig.modelId,
            llmConfig.enableThinking,
          )

          // tier 和 status 更新也合并到一个事务
          KMSDatabaseService.getInstance().runInTransaction(() => {
            KMSCrawlerService.getInstance().updateFileDataTier(file.id, 'hot')
            KMSCrawlerService.getInstance().updateFileStatus(file.id, 'completed')
          })
        } catch (err: any) {
          if (signal.aborted) break
          logger.error(`Collection deep process failed for "${file.file_name}":`, err)
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'failed', err.message)
        }

        fileProcessed++
        reportProgress({
          phase: 'parsing',
          current: fileProcessed,
          total,
          message: `已处理 ${fileProcessed}/${total} 个文件`,
        })
      }

      if (signal.aborted) {
        reportProgress({
          phase: 'done',
          current: fileProcessed,
          total,
          message: `已取消处理: ${collection.name}（已处理 ${fileProcessed}/${total} 个文件）`,
          cancelled: true,
        })
        return { fileProcessed, summaryGenerated: false, embeddingGenerated: false, error: 'ABORTED' }
      }

      reportProgress({
        phase: 'embedding',
        current: 0,
        total: 0,
        message: `生成段落向量嵌入...`,
      })
      await KMSEmbeddingService.getInstance().generateEmbeddings(llmConfig.providerId, reportProgress, signal)

      if (signal.aborted) {
        reportProgress({
          phase: 'done',
          current: fileProcessed,
          total,
          message: `已取消处理: ${collection.name}`,
          cancelled: true,
        })
        return { fileProcessed, summaryGenerated: false, embeddingGenerated: false, error: 'ABORTED' }
      }

      reportProgress({
        phase: 'collection_summary',
        current: 0,
        total: 1,
        message: `生成合集摘要: ${collection.name}`,
      })
      const summaryResult = await kmsService.generateCollectionSummary(collectionId, signal)
      const summaryGenerated = !('error' in summaryResult)

      if (signal.aborted) {
        reportProgress({
          phase: 'done',
          current: fileProcessed,
          total,
          message: `已取消处理: ${collection.name}`,
          cancelled: true,
        })
        return { fileProcessed, summaryGenerated, embeddingGenerated: false, error: 'ABORTED' }
      }

      let embeddingGenerated = false
      if (summaryGenerated) {
        reportProgress({
          phase: 'collection_embedding',
          current: 0,
          total: 1,
          message: `合集摘要向量化: ${collection.name}`,
        })
        embeddingGenerated = await this.generateCollectionSummaryEmbedding(collectionId, signal)
      }

      reportProgress({
        phase: 'done',
        current: fileProcessed,
        total,
        message: `合集处理完成: ${collection.name}（${fileProcessed} 个文件，摘要${summaryGenerated ? '已' : '未'}生成）`,
      })

      // 合集深处理结束：主动触发 checkpoint，把大量写入的 WAL 内容合并回主库
      try {
        KMSDatabaseService.getInstance().checkpoint('PASSIVE')
      } catch (err: any) {
        logger.warn('Post-collection checkpoint failed:', err?.message || err)
      }

      logger.info(`Collection deep process completed: collection="${collection.name}"(${collectionId}), files=${fileProcessed}, summary=${summaryGenerated}, embedding=${embeddingGenerated}`)
      return { fileProcessed, summaryGenerated, embeddingGenerated }
    } catch (err: any) {
      logger.error(`Collection deep process failed (collection=${collectionId}):`, err?.message || err)
      onProgress?.({ phase: 'error', current: 0, total: 0, message: err?.message || 'Unknown error', collectionId })
      return { fileProcessed: 0, summaryGenerated: false, embeddingGenerated: false, error: err?.message || 'Unknown error' }
    } finally {
      this.abortController = null
    }
  }

  private makeCollectionProgress(
    collectionId: string,
    collectionName: string,
    onProgress?: ProgressCallback,
  ): ProgressCallback {
    return (p) => {
      onProgress?.({
        ...p,
        collectionId,
        collectionName,
        startedAt: Math.floor(Date.now() / 1000),
      })
    }
  }

  private async generateCollectionSummaryEmbedding(
    collectionId: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const summaryRow = this.db.prepare(
        'SELECT id, summary, key_topics_json FROM kms_collection_summaries WHERE collection_id = ?'
      ).get(collectionId) as any
      if (!summaryRow || !summaryRow.summary) return false

      const keyTopics: string[] = (() => {
        try { return JSON.parse(summaryRow.key_topics_json || '[]') } catch { return [] }
      })()

      const text = `${summaryRow.summary} ${keyTopics.join(' ')}`.trim()
      if (!text) return false

      const KMSService = (await import('./kms.service')).default
      const kmsService = KMSService.getInstance()
      const embConfig = kmsService.getKmsEmbeddingConfigPublic()
      if (!embConfig) return false

      const llmClient = LLMClientService.getInstance()
      const embedding = await llmClient.createEmbedding(embConfig.providerId, text, embConfig.modelName)
      if (signal?.aborted) return false

      const buffer = Buffer.from(embedding.buffer)
      this.db.prepare(`
        UPDATE kms_collection_summaries
        SET embedding = ?, dimension = ?, embedding_model = ?, updated_at = unixepoch()
        WHERE collection_id = ?
      `).run(buffer, embedding.length, embConfig.modelName, collectionId)

      logger.info(`Collection summary embedding generated for ${collectionId} (dim=${embedding.length})`)
      return true
    } catch (err: any) {
      logger.warn('generateCollectionSummaryEmbedding failed:', err?.message || err)
      return false
    }
  }

  cancelCollectionDeepProcess(): void {
    this.abortController?.abort()
    this.abortController = null
  }

  // ════════════════════════════════════════════════════════════════
  // 冷热数据晋升处理
  // ════════════════════════════════════════════════════════════════

  /** 晋升处理是否正在运行，避免并发 */
  private promotionRunning: boolean = false
  /** 晋升处理专用取消信号 */
  private promotionAbortController: AbortController | null = null

  /**
   * 评估冷热数据层级，并对晋升的冷文件自动执行热数据处理（file2md 重新解析 + LLM 摘要 + 向量嵌入）
   *
   * 处理通过 Worker 线程路由，避免 file2md 的同步原生解析阻塞 Electron 主线程导致 UI 卡死。
   * Worker 不可用时降级为主线程直接执行。
   *
   * @param force 是否强制评估（忽略去抖间隔）。索引流程结束后传 true；
   *              搜索触发的评估传 false，受 MIN_EVALUATION_INTERVAL_MS 去抖控制
   */
  async evaluateAndPromote(force: boolean = false): Promise<void> {
    // 索引进行中或晋升处理进行中时跳过，避免冲突
    if (this.abortController) return
    if (this.promotionRunning) return

    this.promotionRunning = true

    try {
      const { promotedFileIds } = KMSDataTierService.getInstance().evaluateDataTiers(force)
      if (promotedFileIds.length === 0) return

      logger.info(`Processing ${promotedFileIds.length} promoted file(s) with hot-data pipeline...`)

      // 通过 Worker 线程路由晋升处理，避免 file2md 同步解析阻塞主线程 UI
      const KMSIndexWorkerClientService = require('./kms-index-worker-client.service').default
      await KMSIndexWorkerClientService.getInstance().runTask(
        'processPromotedFiles',
        [promotedFileIds],
        async () => {
          // 降级：Worker 不可用时在主线程直接执行（会阻塞 UI，但保证功能可用）
          this.promotionAbortController = new AbortController()
          try {
            await this.processPromotedFiles(promotedFileIds, this.promotionAbortController.signal)
          } finally {
            this.promotionAbortController = null
          }
        },
      )
    } catch (err: any) {
      logger.error('evaluateAndPromote failed:', err?.message || err)
    } finally {
      this.promotionRunning = false
    }
  }

  /** 取消正在进行的晋升处理（Worker 内或降级主线程） */
  cancelPromotion(): void {
    // 优先取消 Worker 内的处理
    try {
      const KMSIndexWorkerClientService = require('./kms-index-worker-client.service').default
      KMSIndexWorkerClientService.getInstance().cancelPromotion()
    } catch (err: any) {
      logger.debug('cancelPromotion in worker unavailable:', err?.message || err)
    }
    // 降级模式下取消主线程处理
    this.promotionAbortController?.abort()
    this.promotionAbortController = null
    this.promotionRunning = false
  }

  /**
   * 公开接口：批量处理晋升的文件（供 auto-index 等外部调用方使用，传入自己的 AbortSignal）
   */
  async processPromotedFilesPublic(fileIds: string[], signal: AbortSignal): Promise<void> {
    return this.processPromotedFiles(fileIds, signal)
  }

  /**
   * 批量处理晋升的文件：对每个文件重新解析（file2md）、生成摘要、段落索引和向量嵌入
   */
  private async processPromotedFiles(fileIds: string[], signal: AbortSignal): Promise<void> {
    const KMSService = (await import('./kms.service')).default
    const kmsService = KMSService.getInstance()
    const llmConfig = kmsService.getKmsSummaryLLMConfigPublic()

    if (!llmConfig) {
      logger.warn('Promoted files skipped: no LLM provider configured for summary generation')
      return
    }

    const searchEngine = KMSSearchEngineService.getInstance()
    const fileParser = FileParserService.getInstance()
    const llmClient = LLMClientService.getInstance()

    for (const fileId of fileIds) {
      if (signal.aborted) break

      try {
        const file = this.db.prepare('SELECT id, file_name, file_path FROM kms_files WHERE id = ?').get(fileId) as any
        if (!file) continue

        logger.info(`Processing promoted file: ${file.file_name}`)

        // 1. 用热数据解析器（file2md）重新解析
        const parseResult = await fileParser.parseFilePath(file.file_path, signal, 'hot')
        if (signal.aborted) break
        if (!parseResult.fullText) continue

        const parseMode = parseResult.metadata?.parser

        // 2. 删除旧索引并重新索引（标题 + 内容段落 + 解析模式 + 轻量摘要）
        KMSDatabaseService.getInstance().runInTransaction(() => {
          searchEngine.deleteIndexByFile(file.id)
          if (parseMode) {
            this.saveParseMode(file.id, parseMode)
          }
          searchEngine.indexFileTitle(file.id, file.file_name)
          searchEngine.indexContentParagraphs(file.id, parseResult.fullText, file.file_name)
          this.saveLightSummary(file.id, file.file_name, parseResult.fullText)
        })

        // 3. 热数据处理：LLM 目录分析 + 段落切分 + 段落摘要 + 文件摘要
        await this.processHotFile(
          file.id, parseResult.fullText, file.file_name,
          llmConfig.providerId, llmClient, searchEngine,
          signal, undefined, undefined,
          llmConfig.modelId, llmConfig.enableThinking,
        )

        if (signal.aborted) break

        // 4. 为该文件生成向量嵌入
        try {
          await KMSEmbeddingService.getInstance().generateEmbeddingsForFile(file.id, llmConfig.providerId)
        } catch (embErr: any) {
          logger.warn(`Embedding generation failed for promoted file ${file.file_name}:`, embErr?.message || embErr)
        }

        KMSCrawlerService.getInstance().updateFileStatus(file.id, 'completed')
      } catch (err: any) {
        if (signal.aborted) break
        logger.error(`Failed to process promoted file ${fileId}:`, err?.message || err)
      }
    }

    // 晋升处理结束：主动 checkpoint
    try {
      KMSDatabaseService.getInstance().checkpoint('PASSIVE')
    } catch (err: any) {
      logger.warn('Post-promotion checkpoint failed:', err?.message || err)
    }
  }

  private async processHotFile(
    fileId: string,
    fullText: string,
    fileName: string,
    providerId: string,
    llmClient: LLMClientService,
    searchEngine: KMSSearchEngineService,
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
    progressBase?: { current: number; total: number },
    kmsModelId?: string,
    enableThinking?: boolean,
  ): Promise<void> {
    if (!fullText || fullText.length < 50) return

    try {
      const modelId = await this.resolveHotFileModelId(providerId, llmClient, kmsModelId)

      const { paragraphs, savedParagraphs } = await this.splitAndIndexParagraphs(
        fileId, fullText, fileName, providerId, modelId, llmClient, searchEngine,
        signal, onProgress, progressBase, enableThinking,
      )
      if (signal?.aborted) return

      const paragraphSummaries = await this.generateParagraphSummaries(
        fileId, fileName, paragraphs, savedParagraphs, providerId, modelId, llmClient, searchEngine,
        signal, onProgress, enableThinking,
      )
      if (signal?.aborted) return

      await this.generateDocSummary(
        fileId, fullText, fileName, paragraphSummaries, providerId, modelId, llmClient, searchEngine,
        signal, onProgress, progressBase, enableThinking,
      )
    } catch (err) {
      if (signal?.aborted) return
      logger.warn(`Failed to process hot file ${fileId}:`, err)
      throw err
    }
  }

  async processHotFilePublic(
    fileId: string,
    fullText: string,
    fileName: string,
    providerId: string,
    llmClient: LLMClientService,
    searchEngine: KMSSearchEngineService,
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
    progressBase?: { current: number; total: number },
    enableThinking?: boolean,
  ): Promise<void> {
    return this.processHotFile(fileId, fullText, fileName, providerId, llmClient, searchEngine, signal, onProgress, progressBase, undefined, enableThinking)
  }

  private async resolveHotFileModelId(
    providerId: string,
    llmClient: LLMClientService,
    kmsModelId?: string,
  ): Promise<string | undefined> {
    const providerConfig = await llmClient.getProviderConfig(providerId)
    let modelId = kmsModelId || providerConfig?.model || undefined

    if (!modelId) {
      try {
        const KMSService = (await import('./kms.service')).default
        const kmsService = KMSService.getInstance()
        const kmsConfig = kmsService.getKmsSummaryLLMConfigPublic()
        if (kmsConfig?.modelId) {
          modelId = kmsConfig.modelId
        }
      } catch (error) {
        logger.warn('Failed to resolve modelId from KMS summary config', error)
      }
    }
    return modelId
  }

  private async splitAndIndexParagraphs(
    fileId: string,
    fullText: string,
    fileName: string,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    searchEngine: KMSSearchEngineService,
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
    progressBase?: { current: number; total: number },
    enableThinking?: boolean,
  ): Promise<{ paragraphs: ReturnType<typeof splitParagraphs>; savedParagraphs: Array<{ id: string; paragraphIndex: number }> }> {
    if (signal?.aborted) return { paragraphs: [], savedParagraphs: [] }

    onProgress?.({
      phase: 'paragraph_split',
      current: progressBase?.current ?? 0,
      total: progressBase?.total ?? 0,
      message: `段落切分: ${fileName}`,
      fileId,
      fileName,
      startedAt: Math.floor(Date.now() / 1000),
    })
    let paragraphs = splitParagraphs(fullText, fileName)
    let llmTocRestored = false

    if (needsTocRestoration(fullText)) {
      onProgress?.({
        phase: 'toc',
        current: progressBase?.current ?? 0,
        total: progressBase?.total ?? 0,
        message: `LLM目录分析: ${fileName}`,
        fileId,
        fileName,
        startedAt: Math.floor(Date.now() / 1000),
      })

      try {
        const restoredToc = await restoreTocWithLLM(
          fullText, providerId, modelId, llmClient, onProgress, signal, enableThinking
        )

        if (!signal?.aborted && restoredToc.length > 0) {
          llmTocRestored = true

          const newParagraphs = identifyParagraphsFromLLMToc(fullText, restoredToc)
          if (newParagraphs.length > 0) {
            paragraphs = newParagraphs
          }

          const filteredToc = filterTocByContentVolume(fullText, restoredToc)
          const tocForSave = buildTocWithPath(filteredToc)
          searchEngine.saveFileToc(fileId, JSON.stringify(
            tocForSave.map(e => ({
              id: e.offset,
              title: e.title,
              titlePath: e.path,
              level: e.level,
              paragraphIndex: 0,
              startOffset: e.offset,
              endOffset: e.offset + 1,
            }))
          ))
        }
      } catch (tocError: any) {
        if (tocError?.name === 'AbortError' || (signal?.aborted)) {
          return { paragraphs: [], savedParagraphs: [] }
        }
        logger.warn(`TOC restoration failed for ${fileName}, fallback to regex-based paragraphs:`, tocError?.message || tocError)
      }
    }

    if (signal?.aborted) return { paragraphs: [], savedParagraphs: [] }

    const savedParagraphs = searchEngine.saveParagraphs(fileId, paragraphs)

    if (signal?.aborted) return { paragraphs, savedParagraphs }
    if (!llmTocRestored) {
      onProgress?.({
        phase: 'toc',
        current: progressBase?.current ?? 0,
        total: progressBase?.total ?? 0,
        message: `生成目录: ${fileName}（${paragraphs.length} 个章节）`,
        fileId,
        fileName,
        startedAt: Math.floor(Date.now() / 1000),
      })
      generateFileToc(fileId, paragraphs, searchEngine)
    }

    const paragraphMap = new Map(paragraphs.map(p => [p.paragraphIndex, p]))

    for (const sp of savedParagraphs) {
      if (signal?.aborted) return { paragraphs, savedParagraphs }
      const p = paragraphMap.get(sp.paragraphIndex)
      if (!p) continue
      searchEngine.indexParagraph(
        fileId,
        sp.id,
        p.title,
        p.titlePath,
        '',
        [],
        p.startOffset,
        p.endOffset
      )
    }

    return { paragraphs, savedParagraphs }
  }

  private async generateParagraphSummaries(
    fileId: string,
    fileName: string,
    paragraphs: ReturnType<typeof splitParagraphs>,
    savedParagraphs: Array<{ id: string; paragraphIndex: number }>,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    searchEngine: KMSSearchEngineService,
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
    enableThinking?: boolean,
  ): Promise<Array<{ title: string; summary: string; keywords: string[] }>> {
    const paragraphMap = new Map(paragraphs.map(p => [p.paragraphIndex, p]))

    const summaryCandidates = savedParagraphs.filter(sp => {
      const p = paragraphMap.get(sp.paragraphIndex)
      return p && p.content && countWords(p.content) >= MIN_CONTENT_WORDS
    })

    const paragraphSummaries: Array<{ title: string; summary: string; keywords: string[] }> = []

    if (summaryCandidates.length === 0 || !providerId || !modelId) {
      return paragraphSummaries
    }

    onProgress?.({
      phase: 'paragraph_summary',
      current: 0,
      total: summaryCandidates.length,
      message: `段落摘要: ${fileName}（0/${summaryCandidates.length}）`,
      fileId,
      fileName,
      startedAt: Math.floor(Date.now() / 1000),
    })

    let processed = 0
    for (const sp of summaryCandidates) {
      if (signal?.aborted) {
        if (paragraphSummaries.length > 0) {
          updateParagraphSummaries(fileId, paragraphs, savedParagraphs, paragraphSummaries, searchEngine)
        }
        return paragraphSummaries
      }

      const p = paragraphMap.get(sp.paragraphIndex)
      if (!p) continue

      try {
        const summary = await generateParagraphSummary(
          p.content, p.title || fileName, providerId, modelId, llmClient, signal, enableThinking
        )
        paragraphSummaries.push(summary)
      } catch (err: any) {
        if (err?.name === 'AbortError' || signal?.aborted) {
          if (paragraphSummaries.length > 0) {
            updateParagraphSummaries(fileId, paragraphs, savedParagraphs, paragraphSummaries, searchEngine)
          }
          return paragraphSummaries
        }
        logger.warn(`Paragraph summary failed for ${p.title}:`, err?.message || err)
        paragraphSummaries.push({ title: p.title, summary: '', keywords: [] })
      }

      processed++
      onProgress?.({
        phase: 'paragraph_summary',
        current: processed,
        total: summaryCandidates.length,
        message: `段落摘要: ${fileName}（${processed}/${summaryCandidates.length}）`,
        fileId,
        fileName,
        startedAt: Math.floor(Date.now() / 1000),
      })
    }

    updateParagraphSummaries(fileId, paragraphs, savedParagraphs, paragraphSummaries, searchEngine)
    return paragraphSummaries
  }

  private async generateDocSummary(
    fileId: string,
    fullText: string,
    fileName: string,
    paragraphSummaries: Array<{ title: string; summary: string; keywords: string[] }>,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    searchEngine: KMSSearchEngineService,
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
    progressBase?: { current: number; total: number },
    enableThinking?: boolean,
  ): Promise<void> {
    if (!providerId || !modelId) return

    if (paragraphSummaries.length > 0) {
      onProgress?.({
        phase: 'doc_summary',
        current: progressBase?.current ?? 0,
        total: progressBase?.total ?? 0,
        message: `文件摘要: ${fileName}`,
        fileId,
        fileName,
        startedAt: Math.floor(Date.now() / 1000),
      })

      try {
        const docSummary = await generateDocumentSummaryFromParagraphs(
          paragraphSummaries, fileName, providerId, modelId, llmClient, signal, enableThinking
        )
        this.saveFileSummary(fileId, docSummary.summary, docSummary.keywords, docSummary.mainTopics)
        searchEngine.indexFileSummary(fileId, docSummary.summary, docSummary.keywords)
      } catch (err: any) {
        if (err?.name === 'AbortError' || signal?.aborted) return
        logger.warn(`Document summary generation failed for ${fileName}:`, err?.message || err)
      }
    } else {
      onProgress?.({
        phase: 'doc_summary',
        current: progressBase?.current ?? 0,
        total: progressBase?.total ?? 0,
        message: `文件摘要: ${fileName}`,
        fileId,
        fileName,
        startedAt: Math.floor(Date.now() / 1000),
      })
      await generateFileSummaryViaLLM(fileId, fullText, providerId, modelId, llmClient, searchEngine, signal, enableThinking, (fid, summary, keywords, mainTopics) => this.saveFileSummary(fid, summary, keywords, mainTopics))
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 文件摘要与轻量摘要
  // ════════════════════════════════════════════════════════════════

  private saveFileSummary(fileId: string, summary: string, keywords: string[], mainTopics: string[]): void {
    const existing = this.db.prepare('SELECT id FROM kms_file_summaries WHERE file_id = ?').get(fileId) as any

    if (existing) {
      this.db.prepare(`
        UPDATE kms_file_summaries SET summary = ?, keywords_json = ?, main_topics_json = ?, updated_at = unixepoch()
        WHERE file_id = ?
      `).run(summary, JSON.stringify(keywords), JSON.stringify(mainTopics), fileId)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kms_file_summaries (id, file_id, summary, keywords_json, main_topics_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, fileId, summary, JSON.stringify(keywords), JSON.stringify(mainTopics))
    }
  }

  saveLightSummary(fileId: string, fileName: string, fullText: string): void {
    try {
      const previewText = fullText.substring(0, 500).replace(/\s+/g, ' ').trim()
      const lightSummary = `[${fileName}] ${previewText.substring(0, 200)}`

      const existing = this.db.prepare('SELECT id FROM kms_file_summaries WHERE file_id = ?').get(fileId) as any
      if (existing) {
        this.db.prepare(`
          UPDATE kms_file_summaries SET light_summary = ?, preview_text = ?, updated_at = unixepoch()
          WHERE file_id = ?
        `).run(lightSummary, previewText, fileId)
      } else {
        const id = generateId()
        this.db.prepare(`
          INSERT INTO kms_file_summaries (id, file_id, summary, light_summary, preview_text, keywords_json, main_topics_json, created_at, updated_at)
          VALUES (?, ?, '', ?, ?, '[]', '[]', unixepoch(), unixepoch())
        `).run(id, fileId, lightSummary, previewText)
      }
    } catch (err) {
      logger.warn(`Failed to save light summary for file ${fileId}:`, err)
    }
  }

  saveParseMode(fileId: string, parseMode: string): void {
    try {
      const existing = this.db.prepare('SELECT id FROM kms_file_summaries WHERE file_id = ?').get(fileId) as any
      if (existing) {
        this.db.prepare('UPDATE kms_file_summaries SET parse_mode = ?, updated_at = unixepoch() WHERE file_id = ?').run(parseMode, fileId)
      } else {
        this.db.prepare(
          'INSERT INTO kms_file_summaries (id, file_id, summary, light_summary, preview_text, parse_mode, keywords_json, main_topics_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())'
        ).run(generateId(), fileId, '', '', '', parseMode, '[]', '[]')
      }
    } catch (err) {
      logger.warn(`Failed to save parse_mode for file ${fileId}:`, err)
    }
  }

  private async generateDirSummaries(
    providerId: string | undefined,
    modelId: string | undefined,
    enableThinking: boolean | undefined,
    llmClient: LLMClientService,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const dirs = this.db.prepare('SELECT id, dir_path, display_name FROM kms_index_dirs WHERE enabled = 1').all() as any[]
      if (dirs.length === 0) return

      if (!modelId && providerId) {
        const config = await llmClient.getProviderConfig(providerId)
        modelId = config?.model || undefined
      }
      if (!modelId) {
        try {
          const KMSService = (await import('./kms.service')).default
          const kmsService = KMSService.getInstance()
          const kmsConfig = kmsService.getKmsSummaryLLMConfigPublic()
          if (kmsConfig?.modelId) {
            modelId = kmsConfig.modelId
          }
        } catch (error) {
          logger.warn('Failed to resolve modelId from KMS summary config for dir summaries', error)
        }
      }

      for (const dir of dirs) {
        if (signal?.aborted) break

        try {
          const files = this.db.prepare(`
            SELECT f.file_name, f.file_ext, f.file_size, f.data_tier,
                   COALESCE(s.light_summary, '') as light_summary,
                   COALESCE(s.summary, '') as summary
            FROM kms_files f
            LEFT JOIN kms_file_summaries s ON s.file_id = f.id
            WHERE f.dir_id = ? AND f.index_status = 'completed'
            ORDER BY f.file_name
          `).all(dir.id) as any[]

          if (files.length === 0) continue

          const { summary: dirSummary, keywords } = await generateDirSummaryViaLLM(
            dir.dir_path, files, providerId, modelId, llmClient, signal, enableThinking,
          )

          this.saveDirSummary(dir.id, dir.dir_path, dirSummary, files.length, keywords)
        } catch (err) {
          logger.warn(`Failed to generate dir summary for ${dir.dir_path}:`, err)
        }
      }
    } catch (err) {
      logger.warn('Failed to generate dir summaries:', err)
    }
  }

  private saveDirSummary(dirId: string, dirPath: string, summary: string, fileCount: number, keywords: string[]): void {
    const existing = this.db.prepare('SELECT id FROM kms_dir_summaries WHERE dir_id = ?').get(dirId) as any
    if (existing) {
      this.db.prepare(`
        UPDATE kms_dir_summaries SET dir_path = ?, summary = ?, file_count = ?, keywords_json = ?, updated_at = unixepoch()
        WHERE dir_id = ?
      `).run(dirPath, summary, fileCount, JSON.stringify(keywords), dirId)
    } else {
      this.db.prepare(`
        INSERT INTO kms_dir_summaries (id, dir_id, dir_path, summary, file_count, keywords_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
      `).run(generateId(), dirId, dirPath, summary, fileCount, JSON.stringify(keywords))
    }
  }

  async generateDirSummaryManual(dirId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const dir = this.db.prepare('SELECT id, dir_path, display_name FROM kms_index_dirs WHERE id = ?').get(dirId) as any
      if (!dir) return { success: false, error: 'DIR_NOT_FOUND' }

      const files = this.db.prepare(`
        SELECT f.file_name, f.file_ext, f.file_size, f.data_tier,
               COALESCE(s.light_summary, '') as light_summary,
               COALESCE(s.summary, '') as summary
        FROM kms_files f
        LEFT JOIN kms_file_summaries s ON s.file_id = f.id
        WHERE f.dir_id = ? AND f.index_status = 'completed'
        ORDER BY f.file_name
      `).all(dirId) as any[]

      if (files.length === 0) return { success: false, error: 'NO_FILES' }

      const KMSService = (await import('./kms.service')).default
      const kmsService = KMSService.getInstance()
      const llmConfig = kmsService.getKmsSummaryLLMConfigPublic()
      const llmClient = LLMClientService.getInstance()

      let modelId: string | undefined
      if (llmConfig?.providerId) {
        const config = await llmClient.getProviderConfig(llmConfig.providerId)
        modelId = llmConfig.modelId || config?.model || undefined
      }

      const { summary: dirSummary, keywords } = await generateDirSummaryViaLLM(
        dir.dir_path, files, llmConfig?.providerId, modelId, llmClient, undefined, llmConfig?.enableThinking, 'kms_dir_summary_manual',
      )

      this.saveDirSummary(dir.id, dir.dir_path, dirSummary, files.length, keywords)
      return { success: true }
    } catch (err: any) {
      logger.error(`Failed to generate dir summary manually for ${dirId}:`, err)
      return { success: false, error: err?.message || 'UNKNOWN' }
    }
  }

  async generateFileSummaryManual(fileId: string): Promise<{ success: boolean; error?: string; embeddingError?: string }> {
    try {
      const file = this.db.prepare('SELECT id, file_name, file_path, file_ext, data_tier FROM kms_files WHERE id = ?').get(fileId) as any
      if (!file) return { success: false, error: 'FILE_NOT_FOUND' }

      const KMSService = (await import('./kms.service')).default
      const kmsService = KMSService.getInstance()
      const llmConfig = kmsService.getKmsSummaryLLMConfigPublic()
      if (!llmConfig?.providerId) {
        return { success: false, error: 'NO_LLM_PROVIDER' }
      }

      const llmClient = LLMClientService.getInstance()
      const searchEngine = KMSSearchEngineService.getInstance()
      const fileParser = FileParserService.getInstance()

      const parseResult = await fileParser.parseFilePath(file.file_path)
      if (!parseResult.fullText) return { success: false, error: 'EMPTY_CONTENT' }

      this.saveLightSummary(file.id, file.file_name, parseResult.fullText)

      await this.processHotFile(
        file.id,
        parseResult.fullText,
        file.file_name,
        llmConfig.providerId,
        llmClient,
        searchEngine,
        undefined,
        undefined,
        undefined,
        llmConfig.modelId,
        llmConfig.enableThinking,
      )

      const embResult = await KMSEmbeddingService.getInstance().generateEmbeddingsForFile(file.id, llmConfig.providerId)

      return { success: true, embeddingError: embResult.error }
    } catch (err: any) {
      logger.error(`Failed to generate file summary manually for ${fileId}:`, err)
      const errMsg = err?.message || 'UNKNOWN'
      if (errMsg.includes('MissingParameter') || errMsg.includes('model')) {
        return { success: false, error: 'MODEL_NOT_CONFIGURED' }
      }
      return { success: false, error: errMsg }
    }
  }
}

export default KMSIndexManagerService
