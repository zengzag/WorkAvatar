import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSCrawlerService from './kms-crawler.service'
import KMSSearchEngineService from './kms-search-engine.service'
import FileParserService from '../file-parser.service'
import LLMClientService from '../llm-client.service'
import { createLogger } from '../logger'
import type { IndexProgress, ProgressCallback, AutoIndexConfig, AutoIndexStatus } from './kms-index-manager.service'

const logger = createLogger('KMS-AutoIndex')

class KMSAutoIndexService {
  private db: Database.Database
  private static instance: KMSAutoIndexService
  private autoIndexTimer: NodeJS.Timeout | null = null
  private autoIndexConfig: AutoIndexConfig = { enabled: false, intervalMinutes: 10, stableThresholdSeconds: 300 }
  private autoIndexLastRunAt: number | null = null
  private autoIndexLastResult: { newFiles: number; modifiedFiles: number; deletedFiles: number; skippedUnstableFiles: number } | null = null
  private autoIndexRunning: boolean = false
  private autoIndexProgressCallback: ProgressCallback | null = null
  private abortController: AbortController | null = null

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSAutoIndexService {
    if (!KMSAutoIndexService.instance) {
      KMSAutoIndexService.instance = new KMSAutoIndexService()
    }
    return KMSAutoIndexService.instance
  }

  setProgressCallback(cb: ProgressCallback | null): void {
    this.autoIndexProgressCallback = cb
  }

  getRunning(): boolean {
    return this.autoIndexRunning
  }

  getAbortController(): AbortController | null {
    return this.abortController
  }

  setAbortController(ac: AbortController | null): void {
    this.abortController = ac
  }

  start(config: AutoIndexConfig): void {
    this.stop()
    this.autoIndexConfig = config
    if (!config.enabled) return
    const intervalMs = Math.max(1, config.intervalMinutes) * 60 * 1000
    logger.info(`Auto-index enabled: interval=${config.intervalMinutes}min, stableThreshold=${config.stableThresholdSeconds}s`)
    this.autoIndexTimer = setInterval(() => {
      this.runCheck().catch((err) => {
        logger.error('Auto-index check failed:', err)
      })
    }, intervalMs)
  }

  stop(): void {
    if (this.autoIndexTimer) {
      clearInterval(this.autoIndexTimer)
      this.autoIndexTimer = null
      logger.info('Auto-index timer stopped')
    }
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  pause(): void {
    if (this.autoIndexTimer && !this.autoIndexRunning) {
      clearInterval(this.autoIndexTimer)
      this.autoIndexTimer = null
      logger.info('Auto-index timer paused')
    }
  }

  resume(): void {
    if (!this.autoIndexTimer && this.autoIndexConfig.enabled && !this.autoIndexRunning) {
      const intervalMs = Math.max(1, this.autoIndexConfig.intervalMinutes) * 60 * 1000
      this.autoIndexTimer = setInterval(() => {
        this.runCheck().catch((err) => {
          logger.error('Auto-index check failed:', err)
        })
      }, intervalMs)
      logger.info('Auto-index timer resumed')
    }
  }

  getStatus(): AutoIndexStatus {
    const nextRunAt = this.autoIndexTimer && this.autoIndexLastRunAt
      ? this.autoIndexLastRunAt + Math.max(1, this.autoIndexConfig.intervalMinutes) * 60
      : null
    return {
      running: this.autoIndexRunning,
      config: { ...this.autoIndexConfig },
      lastRunAt: this.autoIndexLastRunAt,
      nextRunAt,
      lastResult: this.autoIndexLastResult ? { ...this.autoIndexLastResult } : null,
    }
  }

  async runCheck(): Promise<void> {
    if (this.abortController) {
      logger.info('Auto-index skipped: manual indexing in progress')
      return
    }
    if (this.autoIndexRunning) {
      logger.info('Auto-index skipped: already running')
      return
    }

    this.autoIndexRunning = true
    this.abortController = new AbortController()
    const signal = this.abortController.signal
    const onProgress = this.autoIndexProgressCallback ?? undefined

    try {
      onProgress?.({ phase: 'crawling', current: 0, total: 0, message: '自动检测文件变更...' })
      const crawlResult = await KMSCrawlerService.getInstance().crawlAllDirectories(signal, {
        stableThresholdSeconds: this.autoIndexConfig.stableThresholdSeconds,
      })

      const pendingFiles = KMSCrawlerService.getInstance().getPendingFiles()
      const total = pendingFiles.length

      this.autoIndexLastResult = {
        newFiles: crawlResult.newFiles,
        modifiedFiles: crawlResult.modifiedFiles,
        deletedFiles: crawlResult.deletedFiles,
        skippedUnstableFiles: crawlResult.skippedUnstableFiles,
      }
      this.autoIndexLastRunAt = Math.floor(Date.now() / 1000)

      if (total === 0 && crawlResult.deletedFiles === 0) {
        logger.info(`Auto-index: no changes detected (skipped unstable: ${crawlResult.skippedUnstableFiles})`)
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '未检测到文件变更' })
        return
      }

      if (total === 0) {
        logger.info(`Auto-index: only deletions (deleted: ${crawlResult.deletedFiles})`)
        onProgress?.({ phase: 'done', current: 0, total: 0, message: `已清理 ${crawlResult.deletedFiles} 个已删除文件的索引` })
        return
      }

      logger.info(`Auto-index: processing ${total} files (new: ${crawlResult.newFiles}, modified: ${crawlResult.modifiedFiles}, deleted: ${crawlResult.deletedFiles}, skipped: ${crawlResult.skippedUnstableFiles})`)

      onProgress?.({ phase: 'parsing', current: 0, total, message: `自动索引 ${total} 个文件...` })

      const searchEngine = KMSSearchEngineService.getInstance()
      const fileParser = FileParserService.getInstance()

      let providerId: string | undefined
      try {
        const defaultEmbConfig = LLMClientService.getInstance().getDefaultEmbeddingConfig()
        if (defaultEmbConfig) providerId = defaultEmbConfig.providerId
      } catch (error) {
        logger.warn('Failed to get default embedding config for auto-index', error)
      }

      // Lazy import to avoid circular dependency
      const KMSIndexManagerService = (await import('./kms-index-manager.service')).default
      const indexManager = KMSIndexManagerService.getInstance()

      let processed = 0
      for (const file of pendingFiles) {
        if (signal.aborted) break
        try {
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'indexing')
          searchEngine.deleteIndexByFile(file.id)
          const parseResult = await fileParser.parseFilePath(file.filePath, signal)
          if (signal.aborted) break

          onProgress?.({ phase: 'indexing', current: processed + 1, total, message: `自动索引: ${file.fileName}` })

          searchEngine.indexFileTitle(file.id, file.fileName)
          if (parseResult.fullText) {
            searchEngine.indexContentParagraphs(file.id, parseResult.fullText, file.fileName)
            indexManager.saveLightSummary(file.id, file.fileName, parseResult.fullText)
          }

          if (file.dataTier === 'hot' && providerId) {
            const llmClient = LLMClientService.getInstance()
            await indexManager.processHotFilePublic(
              file.id, parseResult.fullText, file.fileName, providerId, llmClient, searchEngine,
              signal, onProgress, { current: processed + 1, total },
            )
          }

          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'completed')
        } catch (err: any) {
          if (signal.aborted) break
          logger.error(`Auto-index failed for "${file.fileName}":`, err)
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'failed', err.message)
        }
        processed++
        onProgress?.({ phase: 'parsing', current: processed, total, message: `已处理 ${processed}/${total} 个文件` })
      }

      if (!signal.aborted) {
        const KMSEmbeddingService = (await import('./kms-embedding.service')).default
        await KMSEmbeddingService.getInstance().generateEmbeddings(undefined, onProgress, signal)
      }

      if (!signal.aborted) {
        const KMSDataTierService = (await import('./kms-data-tier.service')).default
        KMSDataTierService.getInstance().evaluateDataTiers()
      }

      onProgress?.({ phase: 'done', current: processed, total, message: `自动索引完成，共处理 ${processed} 个文件` })
    } catch (err: any) {
      logger.error('Auto-index check failed:', err)
      onProgress?.({ phase: 'error', current: 0, total: 0, message: err.message })
    } finally {
      this.autoIndexRunning = false
      this.abortController = null
    }
  }
}

export default KMSAutoIndexService
