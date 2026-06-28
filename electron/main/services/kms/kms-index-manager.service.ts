import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSCrawlerService from './kms-crawler.service'
import KMSSearchEngineService from './kms-search-engine.service'
import FileParserService from '../file-parser.service'
import LLMClientService from '../llm-client.service'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'

const logger = createLogger('KMS-Index')

export interface IndexProgress {
  phase: 'crawling' | 'parsing' | 'indexing' | 'embedding' | 'done' | 'error'
  current: number
  total: number
  message: string
}

type ProgressCallback = (progress: IndexProgress) => void

/** 自动索引配置 */
export interface AutoIndexConfig {
  /** 是否启用自动索引 */
  enabled: boolean
  /** 检查间隔（分钟） */
  intervalMinutes: number
  /** 文件稳定阈值（秒）：文件最后修改时间距今不足该值时跳过，避免用户正在编辑时频繁更新 */
  stableThresholdSeconds: number
}

/** 自动索引状态 */
export interface AutoIndexStatus {
  running: boolean
  config: AutoIndexConfig
  lastRunAt: number | null
  nextRunAt: number | null
  lastResult: { newFiles: number; modifiedFiles: number; deletedFiles: number; skippedUnstableFiles: number } | null
}

/** 热数据晋升阈值：30天内被搜索命中 >= 5 次 或被读取 >= 3 次 */
const HOT_PROMOTE_HIT_THRESHOLD = 5
const HOT_PROMOTE_READ_THRESHOLD = 3
const HOT_PROMOTE_DAYS = 30

/** 冷数据降级阈值：90天无访问 */
const COLD_DEMOTE_DAYS = 90

/**
 * KMS 索引管理器
 * 负责文件解析、索引构建、增量更新、冷热数据管理
 */
class KMSIndexManagerService {
  private db: Database.Database
  private static instance: KMSIndexManagerService
  private abortController: AbortController | null = null
  // 自动索引相关
  private autoIndexTimer: NodeJS.Timeout | null = null
  private autoIndexConfig: AutoIndexConfig = { enabled: false, intervalMinutes: 10, stableThresholdSeconds: 300 }
  private autoIndexLastRunAt: number | null = null
  private autoIndexLastResult: { newFiles: number; modifiedFiles: number; deletedFiles: number; skippedUnstableFiles: number } | null = null
  private autoIndexRunning: boolean = false
  // 自动索引进度回调（由 kms.service.ts 注入）
  private autoIndexProgressCallback: ProgressCallback | null = null

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSIndexManagerService {
    if (!KMSIndexManagerService.instance) {
      KMSIndexManagerService.instance = new KMSIndexManagerService()
    }
    return KMSIndexManagerService.instance
  }

  /**
   * 构建全量索引（扫描所有目录 → 解析文件 → 建立索引）
   */
  async buildFullIndex(providerId?: string, onProgress?: ProgressCallback): Promise<void> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      // 阶段1：爬取目录
      onProgress?.({ phase: 'crawling', current: 0, total: 0, message: '正在扫描目录...' })
      await KMSCrawlerService.getInstance().crawlAllDirectories(signal)

      if (signal.aborted) return

      // 阶段2：解析和索引
      const pendingFiles = KMSCrawlerService.getInstance().getPendingFiles()
      const total = pendingFiles.length

      if (total === 0) {
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '没有需要索引的文件' })
        return
      }

      onProgress?.({ phase: 'parsing', current: 0, total, message: `开始解析 ${total} 个文件...` })

      const searchEngine = KMSSearchEngineService.getInstance()
      const fileParser = FileParserService.getInstance()
      const llmClient = LLMClientService.getInstance()

      let processed = 0
      for (const file of pendingFiles) {
        if (signal.aborted) break

        try {
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'indexing')

          // 先删除旧索引（处理modified文件的情况）
          searchEngine.deleteIndexByFile(file.id)

          // 解析文件
          const parseResult = await fileParser.parseFilePath(file.filePath, signal)
          if (signal.aborted) break

          // 构建索引
          onProgress?.({
            phase: 'indexing',
            current: processed + 1,
            total,
            message: `索引: ${file.fileName}`,
          })

          // 索引文件标题
          searchEngine.indexFileTitle(file.id, file.fileName)

          // 索引原文内容段落
          if (parseResult.fullText) {
            searchEngine.indexContentParagraphs(file.id, parseResult.fullText, file.fileName)
          }

          // 冷数据：生成轻量摘要（文件开头内容提取，不调用LLM，节省资源）
          // 热数据：额外生成LLM摘要和段落索引
          const isHot = file.dataTier === 'hot'
          if (parseResult.fullText) {
            this.saveLightSummary(file.id, file.fileName, file.filePath, parseResult.fullText)
          }
          if (isHot && providerId) {
            await this.processHotFile(file.id, parseResult.fullText, providerId, llmClient, searchEngine, signal)
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
      }

      // 阶段3：生成向量嵌入（如果有provider）
      if (providerId && !signal.aborted) {
        await this.generateEmbeddings(providerId, onProgress, signal)
      }

      // 执行冷热数据评估
      if (!signal.aborted) {
        this.evaluateDataTiers()
      }

      // 阶段4：生成/更新目录摘要（冷热知识渐进沉淀）
      if (!signal.aborted) {
        await this.generateDirSummaries(providerId, llmClient, signal)
      }

      onProgress?.({ phase: 'done', current: processed, total, message: `索引完成，共处理 ${processed} 个文件` })
    } catch (err: any) {
      logger.error('Build full index failed:', err)
      onProgress?.({ phase: 'error', current: 0, total: 0, message: err.message })
    } finally {
      this.abortController = null
    }
  }

  /**
   * 增量索引（仅处理新增和修改的文件，不重新扫描全部目录）
   */
  async incrementalIndex(providerId?: string, onProgress?: ProgressCallback): Promise<void> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      // 增量扫描：只检测变更（新增/修改/删除），不重新注册已存在的文件
      onProgress?.({ phase: 'crawling', current: 0, total: 0, message: '正在检测文件变更...' })
      await KMSCrawlerService.getInstance().crawlAllDirectories(signal)

      if (signal.aborted) return

      // 只处理 pending 和 modified 状态的文件
      const pendingFiles = KMSCrawlerService.getInstance().getPendingFiles()
      const total = pendingFiles.length

      if (total === 0) {
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '没有需要更新的文件' })
        return
      }

      onProgress?.({ phase: 'parsing', current: 0, total, message: `增量解析 ${total} 个文件...` })

      const searchEngine = KMSSearchEngineService.getInstance()
      const fileParser = FileParserService.getInstance()
      const llmClient = LLMClientService.getInstance()

      let processed = 0
      for (const file of pendingFiles) {
        if (signal.aborted) break

        try {
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'indexing')

          // 先删除旧索引（处理modified文件的情况）
          searchEngine.deleteIndexByFile(file.id)

          // 解析文件
          const parseResult = await fileParser.parseFilePath(file.filePath, signal)
          if (signal.aborted) break

          onProgress?.({
            phase: 'indexing',
            current: processed + 1,
            total,
            message: `索引: ${file.fileName}`,
          })

          // 索引文件标题
          searchEngine.indexFileTitle(file.id, file.fileName)

          // 索引原文内容段落
          if (parseResult.fullText) {
            searchEngine.indexContentParagraphs(file.id, parseResult.fullText, file.fileName)
          }

          // 热数据：额外生成摘要
          const isHot = file.dataTier === 'hot'
          if (isHot && providerId) {
            await this.processHotFile(file.id, parseResult.fullText, providerId, llmClient, searchEngine, signal)
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
      }

      // 生成向量嵌入
      if (providerId && !signal.aborted) {
        await this.generateEmbeddings(providerId, onProgress, signal)
      }

      // 冷热数据评估
      if (!signal.aborted) {
        this.evaluateDataTiers()
      }

      onProgress?.({ phase: 'done', current: processed, total, message: `增量索引完成，共处理 ${processed} 个文件` })
    } catch (err: any) {
      logger.error('Incremental index failed:', err)
      onProgress?.({ phase: 'error', current: 0, total: 0, message: err.message })
    } finally {
      this.abortController = null
    }
  }

  /**
   * 重建指定目录的索引（只处理该目录的文件）
   */
  async rebuildDirIndex(dirId: string, providerId?: string, onProgress?: ProgressCallback): Promise<void> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      // 爬取目录（检测变更）
      onProgress?.({ phase: 'crawling', current: 0, total: 0, message: '正在扫描目录...' })
      await KMSCrawlerService.getInstance().crawlDirectory(dirId, signal)

      if (signal.aborted) return

      // 获取该目录下所有文件，重置为pending状态
      const files = KMSCrawlerService.getInstance().getFilesByDir(dirId)
      const searchEngine = KMSSearchEngineService.getInstance()

      for (const file of files) {
        searchEngine.deleteIndexByFile(file.id)
        KMSCrawlerService.getInstance().updateFileStatus(file.id, 'pending')
      }

      // 获取pending文件并索引
      const pendingFiles = KMSCrawlerService.getInstance().getPendingFiles()
      const total = pendingFiles.length

      if (total === 0) {
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '没有需要索引的文件' })
        return
      }

      onProgress?.({ phase: 'parsing', current: 0, total, message: `重建索引 ${total} 个文件...` })

      const fileParser = FileParserService.getInstance()
      const llmClient = LLMClientService.getInstance()

      let processed = 0
      for (const file of pendingFiles) {
        if (signal.aborted) break

        try {
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'indexing')

          const parseResult = await fileParser.parseFilePath(file.filePath, signal)
          if (signal.aborted) break

          onProgress?.({
            phase: 'indexing',
            current: processed + 1,
            total,
            message: `索引: ${file.fileName}`,
          })

          searchEngine.indexFileTitle(file.id, file.fileName)

          if (parseResult.fullText) {
            searchEngine.indexContentParagraphs(file.id, parseResult.fullText, file.fileName)
          }

          const isHot = file.dataTier === 'hot'
          if (isHot && providerId) {
            await this.processHotFile(file.id, parseResult.fullText, providerId, llmClient, searchEngine, signal)
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
      }

      if (providerId && !signal.aborted) {
        await this.generateEmbeddings(providerId, onProgress, signal)
      }

      onProgress?.({ phase: 'done', current: processed, total, message: `重建索引完成，共处理 ${processed} 个文件` })
    } catch (err: any) {
      logger.error('Rebuild dir index failed:', err)
      onProgress?.({ phase: 'error', current: 0, total: 0, message: err.message })
    } finally {
      this.abortController = null
    }
  }

  /**
   * 取消当前索引任务
   */
  cancelIndexing(): void {
    this.abortController?.abort()
    this.abortController = null
  }

  // ==================== 自动索引 ====================

  /**
   * 设置自动索引进度回调
   */
  setAutoIndexProgressCallback(cb: ProgressCallback | null): void {
    this.autoIndexProgressCallback = cb
  }

  /**
   * 启动自动索引定时器
   */
  startAutoIndex(config: AutoIndexConfig): void {
    // 先停止现有定时器
    this.stopAutoIndex()
    this.autoIndexConfig = config

    if (!config.enabled) return

    const intervalMs = Math.max(1, config.intervalMinutes) * 60 * 1000
    logger.info(`Auto-index enabled: interval=${config.intervalMinutes}min, stableThreshold=${config.stableThresholdSeconds}s`)

    this.autoIndexTimer = setInterval(() => {
      this.runAutoIndexCheck().catch((err) => {
        logger.error('Auto-index check failed:', err)
      })
    }, intervalMs)
  }

  /**
   * 停止自动索引定时器
   */
  stopAutoIndex(): void {
    if (this.autoIndexTimer) {
      clearInterval(this.autoIndexTimer)
      this.autoIndexTimer = null
      logger.info('Auto-index timer stopped')
    }
  }

  /**
   * 暂停自动索引定时器（窗口失焦时调用，避免后台 CPU 占用）
   * 保留配置，仅清除定时器，下次 resumeAutoIndex 时按原配置重启
   */
  pauseAutoIndex(): void {
    if (this.autoIndexTimer && !this.autoIndexRunning) {
      clearInterval(this.autoIndexTimer)
      this.autoIndexTimer = null
      logger.info('Auto-index timer paused (window blurred)')
    }
  }

  /**
   * 恢复自动索引定时器（窗口获焦时调用）
   */
  resumeAutoIndex(): void {
    if (!this.autoIndexTimer && this.autoIndexConfig.enabled && !this.autoIndexRunning) {
      const intervalMs = Math.max(1, this.autoIndexConfig.intervalMinutes) * 60 * 1000
      this.autoIndexTimer = setInterval(() => {
        this.runAutoIndexCheck().catch((err) => {
          logger.error('Auto-index check failed:', err)
        })
      }, intervalMs)
      logger.info('Auto-index timer resumed (window focused)')
    }
  }

  /**
   * 获取自动索引状态
   */
  getAutoIndexStatus(): AutoIndexStatus {
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

  /**
   * 立即执行一次自动索引检查（不受定时器控制）
   * 如果有手动索引任务正在运行则跳过
   */
  async runAutoIndexCheck(): Promise<void> {
    // 正在手动索引或自动索引中则跳过
    if (this.abortController) {
      logger.info('Auto-index skipped: manual indexing in progress')
      return
    }
    if (this.autoIndexRunning) {
      logger.info('Auto-index skipped: already running')
      return
    }

    this.autoIndexRunning = true
    const signal = new AbortController().signal
    const onProgress = this.autoIndexProgressCallback ?? undefined

    try {
      // 阶段1：带稳定阈值扫描目录，检测变更
      onProgress?.({ phase: 'crawling', current: 0, total: 0, message: '自动检测文件变更...' })
      const crawlResult = await KMSCrawlerService.getInstance().crawlAllDirectories(signal, {
        stableThresholdSeconds: this.autoIndexConfig.stableThresholdSeconds,
      })

      // 获取需要索引的文件（新增+修改）
      const pendingFiles = KMSCrawlerService.getInstance().getPendingFiles()
      const total = pendingFiles.length

      this.autoIndexLastResult = {
        newFiles: crawlResult.newFiles,
        modifiedFiles: crawlResult.modifiedFiles,
        deletedFiles: crawlResult.deletedFiles,
        skippedUnstableFiles: crawlResult.skippedUnstableFiles,
      }
      this.autoIndexLastRunAt = Math.floor(Date.now() / 1000)

      // 没有变更则结束
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

      // 阶段2：解析和索引变更文件
      onProgress?.({ phase: 'parsing', current: 0, total, message: `自动索引 ${total} 个文件...` })

      const searchEngine = KMSSearchEngineService.getInstance()
      const fileParser = FileParserService.getInstance()

      // 获取 KMS 配置的 embedding provider
      let providerId: string | undefined
      try {
        const defaultEmbConfig = LLMClientService.getInstance().getDefaultEmbeddingConfig()
        if (defaultEmbConfig) providerId = defaultEmbConfig.providerId
      } catch {}

      let processed = 0
      for (const file of pendingFiles) {
        if (signal.aborted) break

        try {
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'indexing')
          // 先删除旧索引（处理 modified 文件）
          searchEngine.deleteIndexByFile(file.id)

          const parseResult = await fileParser.parseFilePath(file.filePath, signal)
          if (signal.aborted) break

          onProgress?.({ phase: 'indexing', current: processed + 1, total, message: `自动索引: ${file.fileName}` })

          searchEngine.indexFileTitle(file.id, file.fileName)
          if (parseResult.fullText) {
            searchEngine.indexContentParagraphs(file.id, parseResult.fullText, file.fileName)
          }

          // 冷数据：生成轻量摘要
          if (parseResult.fullText) {
            this.saveLightSummary(file.id, file.fileName, file.filePath, parseResult.fullText)
          }

          // 热数据：额外生成 LLM 摘要
          if (file.dataTier === 'hot' && providerId) {
            const llmClient = LLMClientService.getInstance()
            await this.processHotFile(file.id, parseResult.fullText, providerId, llmClient, searchEngine, signal)
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

      // 生成向量嵌入
      if (providerId && !signal.aborted) {
        await this.generateEmbeddings(providerId, onProgress, signal)
      }

      // 冷热数据评估
      if (!signal.aborted) {
        this.evaluateDataTiers()
      }

      onProgress?.({ phase: 'done', current: processed, total, message: `自动索引完成，共处理 ${processed} 个文件` })
    } catch (err: any) {
      logger.error('Auto-index check failed:', err)
      onProgress?.({ phase: 'error', current: 0, total: 0, message: err.message })
    } finally {
      this.autoIndexRunning = false
    }
  }

  /**
   * 生成向量嵌入
   */
  async generateEmbeddings(providerId?: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<void> {
    if (!providerId) {
      const defaultConfig = LLMClientService.getInstance().getDefaultEmbeddingConfig()
      if (!defaultConfig) {
        logger.warn('No embedding provider configured, skipping embedding generation')
        return
      }
      providerId = defaultConfig.providerId
    }

    const searchEngine = KMSSearchEngineService.getInstance()
    const llmClient = LLMClientService.getInstance()

    // 获取没有嵌入的索引条目
    const unembedded = this.db.prepare(`
      SELECT si.id, si.source_type, si.source_id, si.file_id, si.title, si.content
      FROM kms_search_index si
      LEFT JOIN kms_embeddings e ON si.source_type = e.source_type AND si.source_id = e.source_id
      WHERE e.id IS NULL AND si.content != ''
      LIMIT 500
    `).all() as any[]

    if (unembedded.length === 0) {
      logger.info('No unembedded entries found')
      return
    }

    onProgress?.({ phase: 'embedding', current: 0, total: unembedded.length, message: `生成向量嵌入: 0/${unembedded.length}` })

    const batchSize = 20
    let processed = 0

    for (let i = 0; i < unembedded.length; i += batchSize) {
      if (signal?.aborted) break

      const batch = unembedded.slice(i, i + batchSize)
      const texts = batch.map(entry => {
        const text = `${entry.title} ${entry.content}`.substring(0, 500)
        return text
      })

      try {
        const embeddings = await llmClient.createEmbeddings(providerId, texts)

        for (let j = 0; j < batch.length && j < embeddings.length; j++) {
          searchEngine.storeEmbedding(
            batch[j].source_type,
            batch[j].source_id,
            batch[j].file_id,
            embeddings[j],
            providerId
          )
        }
      } catch (err) {
        logger.error('Batch embedding generation failed:', err)
      }

      processed += batch.length
      onProgress?.({ phase: 'embedding', current: processed, total: unembedded.length, message: `生成向量嵌入: ${processed}/${unembedded.length}` })
    }

    searchEngine.invalidateCache()
  }

  /**
   * 评估冷热数据层级并执行晋升/降级
   * 使用批量聚合查询，避免 N+1（原实现 6N+2 次查询，现仅 2 次聚合查询）
   */
  evaluateDataTiers(): void {
    const crawler = KMSCrawlerService.getInstance()
    const now = Math.floor(Date.now() / 1000)

    // 获取所有热数据文件
    const hotFiles = this.db.prepare("SELECT id FROM kms_files WHERE data_tier = 'hot'").all() as any[]
    const hotFileIds = hotFiles.map(f => f.id)

    // 降级：90天无访问的热数据 → 冷数据（批量查询）
    const coldThreshold = now - COLD_DEMOTE_DAYS * 86400
    if (hotFileIds.length > 0) {
      const statsMap = crawler.getFileAccessStatsBatch(hotFileIds, COLD_DEMOTE_DAYS)
      for (const fileId of hotFileIds) {
        const stats = statsMap.get(fileId)!
        if (stats.lastAccessed && stats.lastAccessed < coldThreshold) {
          crawler.updateFileDataTier(fileId, 'cold')
          logger.info(`Demoted file ${fileId} from hot to cold (no access in ${COLD_DEMOTE_DAYS} days)`)
        }
      }
    }

    // 获取所有冷数据文件
    const coldFiles = this.db.prepare("SELECT id FROM kms_files WHERE data_tier = 'cold'").all() as any[]
    const coldFileIds = coldFiles.map(f => f.id)

    // 晋升：高频访问的冷数据 → 热数据（批量查询）
    if (coldFileIds.length > 0) {
      const statsMap = crawler.getFileAccessStatsBatch(coldFileIds, HOT_PROMOTE_DAYS)
      for (const fileId of coldFileIds) {
        const stats = statsMap.get(fileId)!
        if (stats.hitCount >= HOT_PROMOTE_HIT_THRESHOLD || stats.readCount >= HOT_PROMOTE_READ_THRESHOLD) {
          crawler.updateFileDataTier(fileId, 'hot')
          logger.info(`Promoted file ${fileId} from cold to hot (hits: ${stats.hitCount}, reads: ${stats.readCount})`)
        }
      }
    }
  }

  /**
   * 处理热数据文件：生成段落摘要和文档摘要
   */
  private async processHotFile(
    fileId: string,
    fullText: string,
    providerId: string,
    llmClient: LLMClientService,
    searchEngine: KMSSearchEngineService,
    signal?: AbortSignal
  ): Promise<void> {
    if (!fullText || fullText.length < 50) return

    try {
      // 获取 provider 配置以确定使用的模型
      const providerConfig = await llmClient.getProviderConfig(providerId)
      const modelId = providerConfig?.model || undefined

      // 生成文档摘要
      const truncatedText = fullText.substring(0, 3000)
      const summaryPrompt = `请为以下文档内容生成简洁摘要（150字以内），并提取5-8个关键词和3-5个主要主题。\n\n文档内容：\n${truncatedText}\n\n请以JSON格式返回：{"summary": "...", "keywords": ["..."], "main_topics": ["..."]}`

      const summaryResult = await llmClient.chat(providerId, [
        { role: 'system', content: '你是一个文档摘要助手。请严格按照JSON格式返回结果。' },
        { role: 'user', content: summaryPrompt },
      ], { temperature: 0.1, max_tokens: 500, model: modelId })

      if (signal?.aborted) return

      try {
        const parsed = JSON.parse(summaryResult || '{}')
        const summary = parsed.summary || ''
        const keywords = parsed.keywords || []
        const mainTopics = parsed.main_topics || []

        // 保存摘要到数据库
        this.saveFileSummary(fileId, summary, keywords, mainTopics)

        // 索引文件摘要
        searchEngine.indexFileSummary(fileId, summary, keywords)
      } catch {
        logger.warn(`Failed to parse summary result for file ${fileId}`)
      }
    } catch (err) {
      logger.warn(`Failed to generate summary for file ${fileId}:`, err)
    }
  }

  /**
   * 保存文件摘要
   */
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

  /**
   * 保存冷数据轻量摘要（不调用LLM，基于文件名+文件开头内容提取）
   * 用于冷热知识渐进沉淀的冷启动阶段，以最低资源成本提供基础摘要能力
   */
  private saveLightSummary(fileId: string, fileName: string, _filePath: string, fullText: string): void {
    try {
      // 提取文件开头500字符作为预览文本
      const previewText = fullText.substring(0, 500).replace(/\s+/g, ' ').trim()
      // 轻量摘要：文件名 + 路径 + 开头内容片段（不调用LLM）
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

  /**
   * 生成/更新目录摘要（冷热知识渐进沉淀）
   * 基于目录下文件名 + 轻量摘要，调用LLM生成目录级内容概述
   * 如果没有LLM provider，降级为基于文件名的简单聚合
   */
  private async generateDirSummaries(providerId: string | undefined, llmClient: LLMClientService, signal?: AbortSignal): Promise<void> {
    try {
      const dirs = this.db.prepare('SELECT id, dir_path, display_name FROM kms_index_dirs WHERE enabled = 1').all() as any[]
      if (dirs.length === 0) return

      let modelId: string | undefined
      if (providerId) {
        const config = await llmClient.getProviderConfig(providerId)
        modelId = config?.model || undefined
      }

      for (const dir of dirs) {
        if (signal?.aborted) break

        try {
          // 获取目录下所有文件的信息（文件名 + 轻量摘要）
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

          // 构建目录内容清单
          const fileList = files.map(f => {
            const summary = f.summary || f.light_summary || ''
            return `- ${f.file_name} (${f.file_ext || '无扩展名'}, ${this.formatSize(f.file_size)})${summary ? ': ' + summary.substring(0, 80) : ''}`
          }).join('\n')

          let dirSummary: string
          let keywords: string[] = []

          if (providerId && modelId && files.length <= 100) {
            // 调用LLM生成目录摘要
            const prompt = `请为以下目录生成简洁摘要（200字以内），概括目录内容主题和结构，并提取5-10个关键词。

目录路径：${dir.dir_path}
文件数量：${files.length}
文件清单：
${fileList}

请以JSON格式返回：{"summary": "...", "keywords": ["..."]}`

            try {
              const result = await llmClient.chat(providerId, [
                { role: 'system', content: '你是一个目录内容摘要助手，输出简洁准确的JSON。' },
                { role: 'user', content: prompt },
              ], { temperature: 0.1, max_tokens: 400, model: modelId, signal, logSource: 'kms_dir_summary' })

              const parsed = JSON.parse(result)
              dirSummary = parsed.summary || ''
              keywords = parsed.keywords || []
            } catch {
              // LLM失败，降级为简单聚合
              dirSummary = this.generateSimpleDirSummary(dir.dir_path, files)
            }
          } else {
            // 无LLM或文件过多，使用简单聚合
            dirSummary = this.generateSimpleDirSummary(dir.dir_path, files)
          }

          // 保存目录摘要
          this.saveDirSummary(dir.id, dir.dir_path, dirSummary, files.length, keywords)
        } catch (err) {
          logger.warn(`Failed to generate dir summary for ${dir.dir_path}:`, err)
        }
      }
    } catch (err) {
      logger.warn('Failed to generate dir summaries:', err)
    }
  }

  /**
   * 生成简单目录摘要（不调用LLM，基于文件名聚合）
   */
  private generateSimpleDirSummary(_dirPath: string, files: any[]): string {
    const extCount: Record<string, number> = {}
    for (const f of files) {
      const ext = f.file_ext || '其他'
      extCount[ext] = (extCount[ext] || 0) + 1
    }
    const extList = Object.entries(extCount)
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => `${ext}(${count})`)
      .join(', ')

    // 取前10个文件名作为示例
    const sampleFiles = files.slice(0, 10).map(f => f.file_name).join(', ')
    return `目录包含 ${files.length} 个文件（${extList}）。代表文件：${sampleFiles}`
  }

  /**
   * 保存目录摘要
   */
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

  /**
   * 格式化文件大小
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }
}

export default KMSIndexManagerService
