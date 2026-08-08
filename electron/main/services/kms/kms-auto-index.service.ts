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
  private autoIndexConfig: AutoIndexConfig = { enabled: false, intervalMinutes: 1, stableThresholdMinutes: 5 }
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
    // 仅管理定时器，不取消正在运行的检查（stop 会 cancelCurrentRun）。
    // 保存设置时会反复调用 start()，如果每次都 cancel 会导致正在进行的爬虫/索引被中断。
    if (this.autoIndexTimer) {
      clearInterval(this.autoIndexTimer)
      this.autoIndexTimer = null
    }
    this.autoIndexConfig = config
    if (!config.enabled) return
    const intervalMs = Math.max(1, config.intervalMinutes) * 60 * 1000
    logger.info(`Auto-index enabled: interval=${config.intervalMinutes}min, stableThreshold=${config.stableThresholdMinutes}min`)
    this.autoIndexTimer = setInterval(() => {
      this.runCheck().catch((err) => {
        logger.error('Auto-index check failed:', err)
      })
    }, intervalMs)
  }

  /**
   * 取消当前正在执行的自动索引检查（不影响定时器）。
   *
   * 行为：
   * 1. 通过 Worker 客户端发送 'cancelAutoIndex' 消息，触发 Worker 内的 auto-index controller abort；
   * 2. 直接 abort 降级主线程路径上的 auto-index controller（如果有）。
   *
   * 用于"取消"按钮的即时响应场景（与 stop() 的语义区别：stop 还会停掉定时器）。
   */
  cancelCurrentRun(): void {
    try {
      const KMSIndexWorkerClientService = require('./kms-index-worker-client.service').default
      KMSIndexWorkerClientService.getInstance().cancelAutoIndex()
    } catch (err: any) {
      logger.debug('cancelAutoIndex in worker unavailable:', err?.message || err)
    }
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  stop(): void {
    if (this.autoIndexTimer) {
      clearInterval(this.autoIndexTimer)
      this.autoIndexTimer = null
      logger.info('Auto-index timer stopped')
    }
    this.cancelCurrentRun()
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
    if (this.autoIndexRunning) {
      logger.info('Auto-index skipped: already running')
      // 必须推送进度，否则前端点击"立即检索"后无任何反馈（release 下尤为明显）
      this.autoIndexProgressCallback?.({ phase: 'done', current: 0, total: 0, message: '自动索引正在运行中，请稍后' })
      return
    }
    this.autoIndexRunning = true
    try {
      // 通过 Worker 线程执行自动索引，避免爬虫同步 fs + 文件解析阻塞主线程 UI。
      // autoIndexCheck 是重 IO 任务（爬虫 + 解析 + LLM + embedding），绝不允许 fallback 到主线程，
      // 否则会卡死 UI（Worker 超时 600s → 主线程降级 → 同步 better-sqlite3 + file2md 阻塞主循环）。
      const KMSIndexWorkerClientService = require('./kms-index-worker-client.service').default
      const result = await KMSIndexWorkerClientService.getInstance().runTask(
        'autoIndexCheck',
        [this.autoIndexConfig],
        async () => {
          logger.error('Auto-index check refused to run on main thread (would block UI), treating as Worker-unavailable error')
          this.autoIndexProgressCallback?.({ phase: 'error', current: 0, total: 0, message: 'Worker 不可用，自动索引已跳过以避免阻塞 UI' })
          return null
        },
      )
      this.autoIndexLastRunAt = Math.floor(Date.now() / 1000)
      if (result) {
        this.autoIndexLastResult = result
      }
    } catch (err: any) {
      logger.error('Auto-index check failed:', err)
      this.autoIndexProgressCallback?.({ phase: 'error', current: 0, total: 0, message: err?.message || 'Unknown error' })
    } finally {
      this.autoIndexRunning = false
    }
  }

  /**
   * 自动索引检查的实际执行逻辑（在 Worker 线程或主线程降级模式下运行）。
   *
   * @param config 自动索引配置（Worker 模式下由主线程传入）
   * @returns 变更统计；爬虫阶段就失败时返回 null
   */
  async runCheckInternal(config: AutoIndexConfig): Promise<{ newFiles: number; modifiedFiles: number; deletedFiles: number; skippedUnstableFiles: number } | null> {
    if (this.abortController) {
      logger.info('Auto-index skipped: already in progress')
      // 推送进度，避免前端"立即检索"无反馈（Worker 内也会走到此处）
      this.autoIndexProgressCallback?.({ phase: 'done', current: 0, total: 0, message: '自动索引正在运行中，请稍后' })
      return null
    }
    this.autoIndexConfig = { ...config }
    this.abortController = new AbortController()
    const signal = this.abortController.signal
    const onProgress = this.autoIndexProgressCallback ?? undefined
    // 爬虫统计：即使后续处理失败也保留，供主线程更新 lastResult
    let crawlStats: { newFiles: number; modifiedFiles: number; deletedFiles: number; skippedUnstableFiles: number } | null = null

    try {
      const t0 = Date.now()
      onProgress?.({ phase: 'crawling', current: 0, total: 0, message: '自动检测文件变更...' })
      const crawlResult = await KMSCrawlerService.getInstance().crawlAllDirectories(
        signal,
        { stableThresholdMinutes: this.autoIndexConfig.stableThresholdMinutes },
        (current, total, dirPath) => {
          // 每个目录扫描开始时推送进度，避免大库场景下"自动检测文件变更"长时间无变化
          onProgress?.({ phase: 'crawling', current, total, message: `正在扫描目录 (${current + 1}/${total}): ${dirPath}` })
        },
      )
      logger.info(`Auto-index: crawl phase took ${(Date.now() - t0) / 1000}s`)

      const pendingFiles = KMSCrawlerService.getInstance().getPendingFiles()
      const total = pendingFiles.length

      crawlStats = {
        newFiles: crawlResult.newFiles,
        modifiedFiles: crawlResult.modifiedFiles,
        deletedFiles: crawlResult.deletedFiles,
        skippedUnstableFiles: crawlResult.skippedUnstableFiles,
      }

      if (total === 0 && crawlResult.deletedFiles === 0) {
        logger.info(`Auto-index: no changes detected (skipped unstable: ${crawlResult.skippedUnstableFiles}), total=${(Date.now() - t0) / 1000}s`)
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '未检测到文件变更' })
        return crawlStats
      }

      if (total === 0) {
        logger.info(`Auto-index: only deletions (deleted: ${crawlResult.deletedFiles}), total=${(Date.now() - t0) / 1000}s`)
        onProgress?.({ phase: 'done', current: 0, total: 0, message: `已清理 ${crawlResult.deletedFiles} 个已删除文件的索引` })
        return crawlStats
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
      const t1 = Date.now()
      for (const file of pendingFiles) {
        if (signal.aborted) break
        try {
          // 旧索引已在 crawl 的 applyChanges 阶段批量删除，此处只需更新状态
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'indexing')
          const parseResult = await fileParser.parseFilePath(file.filePath, signal, file.dataTier as 'hot' | 'cold')
          if (signal.aborted) break

          const parseMode = parseResult.metadata?.parser

          onProgress?.({ phase: 'indexing', current: processed + 1, total, message: `自动索引: ${file.fileName}` })

          KMSDatabaseService.getInstance().runInTransaction(() => {
            if (parseMode) {
              indexManager.saveParseMode(file.id, parseMode)
            }
            searchEngine.indexFileTitle(file.id, file.fileName, file.filePath)
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
        onProgress?.({ phase: 'parsing', current: processed, total, message: `已处理 ${processed}/${total} 个文件 - ${file.fileName}` })
        await new Promise((resolve) => setImmediate(resolve))
      }
      logger.info(`Auto-index: index phase took ${(Date.now() - t1) / 1000}s (${processed}/${total})`)

      if (!signal.aborted) {
        const t2 = Date.now()
        const KMSEmbeddingService = (await import('./kms-embedding.service')).default
        await KMSEmbeddingService.getInstance().generateEmbeddings(undefined, onProgress, signal)
        logger.info(`Auto-index: embedding phase took ${(Date.now() - t2) / 1000}s`)
      }

      if (!signal.aborted) {
        const t3 = Date.now()
        // 评估冷热数据层级，对晋升的冷文件执行热数据处理。
        // 此处直接调用 processPromotedFilesPublic，避免 evaluateAndPromote 在 Worker 内
        // 再次通过 workerClient 路由（会产生嵌套 Worker，浪费资源）。
        const KMSDataTierService = (await import('./kms-data-tier.service')).default
        const { promotedFileIds } = KMSDataTierService.getInstance().evaluateDataTiers(true)
        if (promotedFileIds.length > 0) {
          logger.info(`Auto-index: processing ${promotedFileIds.length} promoted file(s)`)
          await indexManager.processPromotedFilesPublic(promotedFileIds, signal)
        }
        logger.info(`Auto-index: data-tier promotion phase took ${(Date.now() - t3) / 1000}s`)
      }

      // 自动索引结束：主动触发 checkpoint，把累积的 WAL 内容合并回主库文件
      if (!signal.aborted) {
        try {
          KMSDatabaseService.getInstance().checkpoint('PASSIVE')
        } catch (err: any) {
          logger.warn('Post-auto-index checkpoint failed:', err?.message || err)
        }
      }

      if (signal.aborted) {
        logger.info(`Auto-index cancelled: processed=${processed}/${total}, total=${(Date.now() - t0) / 1000}s`)
        onProgress?.({ phase: 'done', current: processed, total, message: '已取消', cancelled: true })
      } else {
        logger.info(`Auto-index complete: processed=${processed}/${total}, total=${(Date.now() - t0) / 1000}s`)
        onProgress?.({ phase: 'done', current: processed, total, message: `自动索引完成，共处理 ${processed} 个文件` })
      }
      return crawlStats
    } catch (err: any) {
      logger.error('Auto-index check failed:', err)
      onProgress?.({ phase: 'error', current: 0, total: 0, message: err.message })
      return crawlStats
    } finally {
      this.abortController = null
    }
  }
}

export default KMSAutoIndexService
