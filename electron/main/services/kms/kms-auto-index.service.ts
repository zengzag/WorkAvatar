import KMSCrawlerService from './kms-crawler.service'
import KMSSearchEngineService from './kms-search-engine.service'
import KMSDatabaseService from './kms-database.service'
import FileParserService from '../file-parser.service'
import LLMClientService from '../llm-client.service'
import { createLogger } from '../logger'
import type { ProgressCallback, AutoIndexConfig, AutoIndexStatus } from './kms-index-manager.service'

const logger = createLogger('KMS-AutoIndex')

class KMSAutoIndexService {
  private static instance: KMSAutoIndexService
  private autoIndexTimer: NodeJS.Timeout | null = null
  private autoIndexConfig: AutoIndexConfig = { enabled: false, intervalMinutes: 10, stableThresholdSeconds: 300 }
  private autoIndexLastRunAt: number | null = null
  private autoIndexLastResult: { newFiles: number; modifiedFiles: number; deletedFiles: number; skippedUnstableFiles: number } | null = null
  private autoIndexRunning: boolean = false
  private autoIndexProgressCallback: ProgressCallback | null = null
  private abortController: AbortController | null = null

  private constructor() {
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

      // 摘要模型配置（用于文件摘要等 LLM 分析任务）
      let summaryProviderId: string | undefined
      let summaryEnableThinking: boolean | undefined
      try {
        const KMSService = (await import('./kms.service')).default
        const summaryConfig = KMSService.getInstance().getKmsSummaryLLMConfigPublic()
        if (summaryConfig) {
          summaryProviderId = summaryConfig.providerId
          summaryEnableThinking = summaryConfig.enableThinking
        }
      } catch (error) {
        logger.warn('Failed to resolve summary model config for auto-index', error)
      }

      // Lazy import to avoid circular dependency
      const KMSIndexManagerService = (await import('./kms-index-manager.service')).default
      const indexManager = KMSIndexManagerService.getInstance()

      let processed = 0
      for (const file of pendingFiles) {
        if (signal.aborted) break
        try {
          // 解析前：状态置为 indexing + 删除旧索引，合并为单个事务
          KMSDatabaseService.getInstance().runInTransaction(() => {
            KMSCrawlerService.getInstance().updateFileStatus(file.id, 'indexing')
            searchEngine.deleteIndexByFile(file.id)
          })
          const parseResult = await fileParser.parseFilePath(file.filePath, signal, file.dataTier as 'hot' | 'cold')
          if (signal.aborted) break

          // 保存解析模式
          const parseMode = parseResult.metadata?.parser

          onProgress?.({ phase: 'indexing', current: processed + 1, total, message: `自动索引: ${file.fileName}` })

          // 解析后：标题/段落/解析模式/轻量摘要合并为单个事务
          KMSDatabaseService.getInstance().runInTransaction(() => {
            if (parseMode) {
              indexManager.saveParseMode(file.id, parseMode)
            }
            searchEngine.indexFileTitle(file.id, file.fileName)
            if (parseResult.fullText) {
              searchEngine.indexContentParagraphs(file.id, parseResult.fullText, file.fileName)
              indexManager.saveLightSummary(file.id, file.fileName, parseResult.fullText)
            }
          })

          if (file.dataTier === 'hot' && summaryProviderId) {
            const llmClient = LLMClientService.getInstance()
            await indexManager.processHotFilePublic(
              file.id, parseResult.fullText, file.fileName, summaryProviderId, llmClient, searchEngine,
              signal, onProgress, { current: processed + 1, total }, summaryEnableThinking,
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
        // 评估冷热数据层级，对晋升的冷文件自动执行热数据处理
        // 通过 evaluateAndPromote 统一路由到 Worker 线程，避免 file2md 同步解析阻塞主线程
        await KMSIndexManagerService.getInstance().evaluateAndPromote(true)
      }

      // 自动索引结束：主动触发 checkpoint，把累积的 WAL 内容合并回主库文件
      if (!signal.aborted) {
        try {
          KMSDatabaseService.getInstance().checkpoint('PASSIVE')
        } catch (err: any) {
          logger.warn('Post-auto-index checkpoint failed:', err?.message || err)
        }
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
