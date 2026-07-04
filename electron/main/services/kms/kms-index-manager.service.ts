import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSCrawlerService from './kms-crawler.service'
import KMSSearchEngineService from './kms-search-engine.service'
import FileParserService from '../file-parser.service'
import LLMClientService from '../llm-client.service'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'

const logger = createLogger('KMS-Index')

/**
 * 索引进度阶段
 * - crawling/parsing/indexing/embedding/done/error: 原有粗粒度阶段
 * - toc: 目录章节识别（段落切分后从标题派生TOC）
 * - paragraph_split: 段落切分（按Markdown标题层级拆分文档）
 * - paragraph_summary: 段落级LLM摘要生成
 * - doc_summary: 文件级LLM摘要生成
 * - collection_summary: 合集级LLM摘要生成
 * - collection_embedding: 合集摘要向量化
 */
export type IndexPhase =
  | 'crawling'
  | 'parsing'
  | 'indexing'
  | 'toc'
  | 'paragraph_split'
  | 'paragraph_summary'
  | 'doc_summary'
  | 'collection_summary'
  | 'collection_embedding'
  | 'embedding'
  | 'done'
  | 'error'

export interface IndexProgress {
  phase: IndexPhase
  current: number
  total: number
  message: string
  /** 当前处理的文件ID（文件级阶段时填充，便于前端展示文件粒度进度） */
  fileId?: string
  /** 当前处理的文件名 */
  fileName?: string
  /** 当前处理的合集ID（合集级阶段时填充） */
  collectionId?: string
  /** 当前处理的合集名称 */
  collectionName?: string
  /** 阶段开始时间（秒），用于前端展示耗时） */
  startedAt?: number
}

interface LLMTocEntry {
  title: string
  level: number
  lineNumber: number
}

interface ValidatedTocEntry {
  title: string
  level: number
  lineNumber: number
  offset: number
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

  // 段落处理常量（对齐旧知识库 KnowledgeProcessorService）
  private static readonly MAX_PARAGRAPH_CHARS = 5000
  private static readonly PARAGRAPH_OVERLAP_CHARS = 500
  private static readonly MAX_HEADING_LINE_RATIO = 0.25
  private static readonly TOC_CHUNK_LINES = 100
  private static readonly TOC_OVERLAP_LINES = 10
  private static readonly TOC_MIN_HEADING_DENSITY = 8000
  private static readonly MIN_CONTENT_WORDS = 50

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
   * withEmbedding=true 时同步生成向量嵌入，false 时跳过（仅构建全文索引）
   */
  async buildFullIndex(providerId?: string, onProgress?: ProgressCallback, withEmbedding: boolean = true): Promise<void> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      // 阶段1：爬取目录
      onProgress?.({ phase: 'crawling', current: 0, total: 0, message: '正在扫描目录...' })
      await KMSCrawlerService.getInstance().crawlAllDirectories(signal)

      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '已取消' })
        return
      }

      // 阶段2：解析和索引
      const pendingFiles = KMSCrawlerService.getInstance().getPendingFiles()
      const total = pendingFiles.length

      if (total === 0) {
        // 没有新文件需要索引，但可能仍有未生成 embedding 的条目
        if (withEmbedding) {
          await this.generateEmbeddings(undefined, onProgress, signal, false)
        }
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
            await this.processHotFile(file.id, parseResult.fullText, file.fileName, providerId, llmClient, searchEngine, signal, onProgress, { current: processed + 1, total })
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

      // 阶段3：生成向量嵌入（独立于 chat providerId，使用 KMS Embedding 配置）
      if (!signal.aborted && withEmbedding) {
        await this.generateEmbeddings(undefined, onProgress, signal, false)
      }

      // 执行冷热数据评估
      if (!signal.aborted) {
        this.evaluateDataTiers()
      }

      // 阶段4：生成/更新目录摘要（冷热知识渐进沉淀）
      if (!signal.aborted) {
        await this.generateDirSummaries(providerId, llmClient, signal)
      }

      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: processed, total, message: '已取消' })
      } else {
        onProgress?.({ phase: 'done', current: processed, total, message: `索引完成，共处理 ${processed} 个文件` })
      }
    } catch (err: any) {
      logger.error('Build full index failed:', err)
      onProgress?.({ phase: 'error', current: 0, total: 0, message: err.message })
    } finally {
      this.abortController = null
    }
  }

  /**
   * 增量索引（仅处理新增和修改的文件，不重新扫描全部目录）
   * withEmbedding=true 时同步生成向量嵌入，false 时跳过（仅构建全文索引）
   */
  async incrementalIndex(providerId?: string, onProgress?: ProgressCallback, withEmbedding: boolean = true): Promise<void> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      // 增量扫描：只检测变更（新增/修改/删除），不重新注册已存在的文件
      onProgress?.({ phase: 'crawling', current: 0, total: 0, message: '正在检测文件变更...' })
      await KMSCrawlerService.getInstance().crawlAllDirectories(signal)

      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '已取消' })
        return
      }

      // 只处理 pending 和 modified 状态的文件
      const pendingFiles = KMSCrawlerService.getInstance().getPendingFiles()
      const total = pendingFiles.length

      if (total === 0) {
        // 没有文件变更，但可能仍有未生成 embedding 的条目
        if (withEmbedding) {
          await this.generateEmbeddings(undefined, onProgress, signal, false)
        }
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
            await this.processHotFile(file.id, parseResult.fullText, file.fileName, providerId, llmClient, searchEngine, signal, onProgress, { current: processed + 1, total })
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

      // 生成向量嵌入（独立于 chat providerId，使用 KMS Embedding 配置）
      if (!signal.aborted && withEmbedding) {
        await this.generateEmbeddings(undefined, onProgress, signal, false)
      }

      // 冷热数据评估
      if (!signal.aborted) {
        this.evaluateDataTiers()
      }

      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: processed, total, message: '已取消' })
      } else {
        onProgress?.({ phase: 'done', current: processed, total, message: `增量索引完成，共处理 ${processed} 个文件` })
      }
    } catch (err: any) {
      logger.error('Incremental index failed:', err)
      onProgress?.({ phase: 'error', current: 0, total: 0, message: err.message })
    } finally {
      this.abortController = null
    }
  }

  /**
   * 重建指定目录的索引（只处理该目录的文件）
   * withEmbedding=true 时同步生成向量嵌入，false 时跳过（仅构建全文索引）
   */
  async rebuildDirIndex(dirId: string, providerId?: string, onProgress?: ProgressCallback, withEmbedding: boolean = true): Promise<void> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      // 爬取目录（检测变更）
      onProgress?.({ phase: 'crawling', current: 0, total: 0, message: '正在扫描目录...' })
      await KMSCrawlerService.getInstance().crawlDirectory(dirId, signal)

      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '已取消' })
        return
      }

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
        // 没有文件需要重建，但可能仍有未生成 embedding 的条目
        if (withEmbedding) {
          await this.generateEmbeddings(undefined, onProgress, signal, false)
        }
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
            await this.processHotFile(file.id, parseResult.fullText, file.fileName, providerId, llmClient, searchEngine, signal, onProgress, { current: processed + 1, total })
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

      if (!signal.aborted && withEmbedding) {
        await this.generateEmbeddings(undefined, onProgress, signal, false)
      }

      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: processed, total, message: '已取消' })
      } else {
        onProgress?.({ phase: 'done', current: processed, total, message: `重建索引完成，共处理 ${processed} 个文件` })
      }
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
   * 合集深度处理：对合集内所有文件做"段落切分→TOC→段落摘要→文件摘要"，再生成合集摘要并向量化
   * 适用场景：用户主动添加文件到合集后，对合集执行一次性深度处理，使合集具备完整的章节检索、段落摘要、合集摘要能力
   * 与全量/增量索引流程不同，本方法不依赖冷热数据机制，强制对所有文件做深度处理
   */
  async processCollectionDeep(collectionId: string, onProgress?: ProgressCallback): Promise<{ fileProcessed: number; summaryGenerated: boolean; embeddingGenerated: boolean; error?: string }> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      // 通过 kms.service.ts 获取合集信息和文件列表
      const KMSService = (await import('./kms.service')).default
      const kmsService = KMSService.getInstance()
      const collection = kmsService.getCollection(collectionId)
      if (!collection) {
        return { fileProcessed: 0, summaryGenerated: false, embeddingGenerated: false, error: 'Collection not found' }
      }
      const files = kmsService.listFilesInCollection(collectionId)
      if (files.length === 0) {
        return { fileProcessed: 0, summaryGenerated: false, embeddingGenerated: false, error: 'NO_FILES' }
      }

      // 获取 LLM 配置
      const llmConfig = kmsService.getKmsLLMConfigPublic()
      if (!llmConfig) {
        return { fileProcessed: 0, summaryGenerated: false, embeddingGenerated: false, error: 'NO_LLM_PROVIDER' }
      }

      const searchEngine = KMSSearchEngineService.getInstance()
      const fileParser = FileParserService.getInstance()
      const llmClient = LLMClientService.getInstance()
      const total = files.length

      onProgress?.({
        phase: 'parsing',
        current: 0,
        total,
        message: `合集深度处理: ${collection.name}（${total} 个文件）`,
        collectionId,
        collectionName: collection.name,
        startedAt: Math.floor(Date.now() / 1000),
      })

      let fileProcessed = 0
      for (const file of files) {
        if (signal.aborted) break

        try {
          // 解析文件
          const parseResult = await fileParser.parseFilePath(file.file_path, signal)
          if (signal.aborted) break
          if (!parseResult.fullText) {
            fileProcessed++
            continue
          }

          // 清除旧索引和段落，确保从干净状态开始
          searchEngine.deleteIndexByFile(file.id)
          searchEngine.indexFileTitle(file.id, file.file_name)
          searchEngine.indexContentParagraphs(file.id, parseResult.fullText, file.file_name)
          this.saveLightSummary(file.id, file.file_name, file.file_path, parseResult.fullText)

          // 调用 processHotFile 完成段落切分/TOC/段落摘要/文件摘要
          // 包装进度回调：processHotFile 内部事件不含 collectionId，需补充以便前端按合集过滤展示
          const hotFileProgress: ProgressCallback = (p) => {
            onProgress?.({ ...p, collectionId, collectionName: collection.name })
          }
          await this.processHotFile(
            file.id,
            parseResult.fullText,
            file.file_name,
            llmConfig.providerId,
            llmClient,
            searchEngine,
            signal,
            hotFileProgress,
            { current: fileProcessed + 1, total },
            llmConfig.modelId
          )

          // 标记为热数据并完成
          KMSCrawlerService.getInstance().updateFileDataTier(file.id, 'hot')
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'completed')
        } catch (err: any) {
          if (signal.aborted) break
          logger.error(`Collection deep process failed for "${file.file_name}":`, err)
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'failed', err.message)
        }

        fileProcessed++
        onProgress?.({
          phase: 'parsing',
          current: fileProcessed,
          total,
          message: `已处理 ${fileProcessed}/${total} 个文件`,
          collectionId,
          collectionName: collection.name,
          startedAt: Math.floor(Date.now() / 1000),
        })
      }

      if (signal.aborted) {
        onProgress?.({
          phase: 'done',
          current: fileProcessed,
          total,
          message: `已取消处理: ${collection.name}（已处理 ${fileProcessed}/${total} 个文件）`,
          collectionId,
          collectionName: collection.name,
          startedAt: Math.floor(Date.now() / 1000),
        })
        return { fileProcessed, summaryGenerated: false, embeddingGenerated: false, error: 'ABORTED' }
      }

      // 生成段落向量嵌入
      onProgress?.({
        phase: 'embedding',
        current: 0,
        total: 0,
        message: `生成段落向量嵌入...`,
        collectionId,
        collectionName: collection.name,
        startedAt: Math.floor(Date.now() / 1000),
      })
      await this.generateEmbeddings(llmConfig.providerId, onProgress, signal)

      // 取消检查：embedding 阶段可能被中断
      if (signal.aborted) {
        onProgress?.({
          phase: 'done',
          current: fileProcessed,
          total,
          message: `已取消处理: ${collection.name}`,
          collectionId,
          collectionName: collection.name,
          startedAt: Math.floor(Date.now() / 1000),
        })
        return { fileProcessed, summaryGenerated: false, embeddingGenerated: false, error: 'ABORTED' }
      }

      // 生成合集摘要
      onProgress?.({
        phase: 'collection_summary',
        current: 0,
        total: 1,
        message: `生成合集摘要: ${collection.name}`,
        collectionId,
        collectionName: collection.name,
        startedAt: Math.floor(Date.now() / 1000),
      })
      const summaryResult = await kmsService.generateCollectionSummary(collectionId, signal)
      const summaryGenerated = !('error' in summaryResult)

      // 取消检查：合集摘要生成阶段可能被中断
      if (signal.aborted) {
        onProgress?.({
          phase: 'done',
          current: fileProcessed,
          total,
          message: `已取消处理: ${collection.name}`,
          collectionId,
          collectionName: collection.name,
          startedAt: Math.floor(Date.now() / 1000),
        })
        return { fileProcessed, summaryGenerated, embeddingGenerated: false, error: 'ABORTED' }
      }

      // 合集摘要向量化
      let embeddingGenerated = false
      if (summaryGenerated) {
        onProgress?.({
          phase: 'collection_embedding',
          current: 0,
          total: 1,
          message: `合集摘要向量化: ${collection.name}`,
          collectionId,
          collectionName: collection.name,
          startedAt: Math.floor(Date.now() / 1000),
        })
        embeddingGenerated = await this.generateCollectionSummaryEmbedding(collectionId, llmConfig.providerId, signal)
      }

      onProgress?.({
        phase: 'done',
        current: fileProcessed,
        total,
        message: `合集处理完成: ${collection.name}（${fileProcessed} 个文件，摘要${summaryGenerated ? '已' : '未'}生成）`,
        collectionId,
        collectionName: collection.name,
        startedAt: Math.floor(Date.now() / 1000),
      })

      return { fileProcessed, summaryGenerated, embeddingGenerated }
    } catch (err: any) {
      logger.error('processCollectionDeep failed:', err)
      onProgress?.({ phase: 'error', current: 0, total: 0, message: err?.message || 'Unknown error', collectionId })
      return { fileProcessed: 0, summaryGenerated: false, embeddingGenerated: false, error: err?.message || 'Unknown error' }
    } finally {
      this.abortController = null
    }
  }

  /**
   * 合集摘要向量化：将合集摘要文本转为向量嵌入，直接写入 kms_collection_summaries.embedding 字段
   * 不存入 kms_embeddings 表（避免破坏 file_id 外键约束），独立存储便于按合集语义检索
   */
  private async generateCollectionSummaryEmbedding(
    collectionId: string,
    _providerId: string,
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

      // 通过 kms.service 获取 embedding 配置（KMS 专属 → 默认 embedding 配置）
      const KMSService = (await import('./kms.service')).default
      const kmsService = KMSService.getInstance()
      const embConfig = kmsService.getKmsEmbeddingConfigPublic()
      if (!embConfig) return false

      const llmClient = LLMClientService.getInstance()
      const embedding = await llmClient.createEmbedding(embConfig.providerId, text, embConfig.modelName)
      if (signal?.aborted) return false

      // 直接将向量写入 kms_collection_summaries 表的新字段
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

  /**
   * 取消合集深度处理（与取消索引共用同一 AbortController）
   */
  cancelCollectionDeepProcess(): void {
    this.abortController?.abort()
    this.abortController = null
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
            await this.processHotFile(file.id, parseResult.fullText, file.fileName, providerId, llmClient, searchEngine, signal, onProgress, { current: processed + 1, total })
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

      // 生成向量嵌入（独立于 chat providerId，使用 KMS Embedding 配置）
      if (!signal.aborted) {
        await this.generateEmbeddings(undefined, onProgress, signal)
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
   * providerId 未指定时，优先使用 KMS 专属 Embedding 配置，再回退到默认 Embedding 配置
   * forceRegenerate=true 时先清除所有现有 embedding，强制全部重新生成（用于显式触发智能索引重建）
   */
  async generateEmbeddings(providerId?: string, onProgress?: ProgressCallback, signal?: AbortSignal, forceRegenerate: boolean = false): Promise<void> {
    if (!providerId) {
      // 优先使用 KMS 专属 Embedding 配置
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

    // 强制重建：先清除所有现有 embedding，让所有条目都进入待嵌入列表
    if (forceRegenerate) {
      logger.info('Force regenerate embeddings: clearing all existing embeddings')
      this.db.prepare('DELETE FROM kms_embeddings').run()
      searchEngine.invalidateCache()
    }

    // 循环获取并处理没有嵌入的索引条目，直到全部处理完毕
    const batchSize = 20
    const pageLimit = 500
    let totalProcessed = 0
    let embeddingError: string | undefined

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

      onProgress?.({ phase: 'embedding', current: totalProcessed, total: totalProcessed + unembedded.length, message: `生成向量嵌入: ${totalProcessed}/${totalProcessed + unembedded.length}` })

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
        } catch (err: any) {
          logger.error('Batch embedding generation failed:', err)
          if (!embeddingError) {
            embeddingError = err?.message || String(err)
            onProgress?.({
              phase: 'error',
              current: totalProcessed,
              total: totalProcessed + unembedded.length,
              message: `向量嵌入失败: ${embeddingError}`,
            })
          }
          break
        }

        totalProcessed += batch.length
        onProgress?.({ phase: 'embedding', current: totalProcessed, total: totalProcessed + (unembedded.length - i - batchSize), message: `生成向量嵌入: ${totalProcessed}/${totalProcessed + unembedded.length - i - batchSize}` })
      }

      // 如果本轮不足 pageLimit，说明已处理完毕
      if (unembedded.length < pageLimit) break
      // 如果出错则退出循环
      if (embeddingError) break
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
   * 处理热数据文件：生成段落切分 + TOC + 段落摘要 + 文件摘要
   * 与原知识库处理流程对齐：先做目录章节切分，再为每个段落生成摘要，最后生成文件摘要
   */
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
    kmsModelId?: string
  ): Promise<void> {
    if (!fullText || fullText.length < 50) return

    try {
      const providerConfig = await llmClient.getProviderConfig(providerId)
      let modelId = kmsModelId || providerConfig?.model || undefined

      // 如果仍未获取到 modelId，尝试从 KMS 配置解析
      if (!modelId) {
        try {
          const KMSService = (await import('./kms.service')).default
          const kmsService = KMSService.getInstance()
          const kmsConfig = kmsService.getKmsLLMConfigPublic()
          if (kmsConfig?.modelId) {
            modelId = kmsConfig.modelId
          }
        } catch {}
      }

      // ========== 第一阶段：段落识别（对齐旧知识库 parseDocument 流程） ==========
      // 先尝试通过 detectHeading 识别标题并切分段落
      if (signal?.aborted) return
      onProgress?.({
        phase: 'paragraph_split',
        current: progressBase?.current ?? 0,
        total: progressBase?.total ?? 0,
        message: `段落切分: ${fileName}`,
        fileId,
        fileName,
        startedAt: Math.floor(Date.now() / 1000),
      })
      let paragraphs = this.splitParagraphs(fullText, fileName)
      let llmTocRestored = false

      // ========== 第二阶段：LLM TOC 恢复（对齐旧知识库 processDocument 流程） ==========
      // 当文档缺少明显的标题结构时（如 PDF/DOC 解析的纯文本），使用 LLM 识别章节结构
      if (this.needsTocRestoration(fullText)) {
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
          const restoredToc = await this.restoreTocWithLLM(
            fullText, providerId, modelId, llmClient, onProgress, signal
          )

          if (!signal?.aborted && restoredToc.length > 0) {
            llmTocRestored = true

            // 基于 LLM 还原的 TOC 重新切分段落
            const newParagraphs = this.identifyParagraphsFromLLMToc(fullText, restoredToc)
            if (newParagraphs.length > 0) {
              paragraphs = newParagraphs
            }

            // 过滤内容不足的 TOC 条目，构建层级目录
            const filteredToc = this.filterTocByContentVolume(fullText, restoredToc)
            const tocForSave = this.buildTocWithPath(filteredToc)
            // 将 LLM 还原的 TOC 写入文件
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
          if (tocError?.name === 'AbortError' || (signal?.aborted)) return
          logger.warn(`TOC restoration failed for ${fileName}, fallback to regex-based paragraphs:`, tocError?.message || tocError)
        }
      }

      if (signal?.aborted) return

      // 保存段落到数据库
      const savedParagraphs = searchEngine.saveParagraphs(fileId, paragraphs)

      // ========== 第三阶段：生成正则识别的TOC ==========
      // 当 LLM TOC 恢复已生效时，跳过以免覆盖 LLM 还原的更精确目录
      if (signal?.aborted) return
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
        this.generateFileToc(fileId, paragraphs, searchEngine)
      }

      // 将段落写入搜索索引
      for (const sp of savedParagraphs) {
        if (signal?.aborted) return
        const p = paragraphs.find(x => x.paragraphIndex === sp.paragraphIndex)
        if (!p) continue
        searchEngine.indexParagraph(
          fileId,
          sp.id,
          p.title,
          p.titlePath,
          '', // 摘要稍后填充
          [],
          p.startOffset,
          p.endOffset
        )
      }

      if (signal?.aborted) return

      // ========== 第四阶段：逐段生成段落摘要（对齐旧知识库 processDocument 流程） ==========
      // 仅对内容超过 50 字的段落生成摘要
      const summaryCandidates = savedParagraphs.filter(sp => {
        const p = paragraphs.find(x => x.paragraphIndex === sp.paragraphIndex)
        return p && p.content && this.countWords(p.content) >= KMSIndexManagerService.MIN_CONTENT_WORDS
      })

      const paragraphSummaries: Array<{ title: string; summary: string; keywords: string[] }> = []

      if (summaryCandidates.length > 0 && providerId && modelId) {
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
            // 保存已生成的摘要
            if (paragraphSummaries.length > 0) {
              this.updateParagraphSummaries(fileId, paragraphs, savedParagraphs, paragraphSummaries, searchEngine)
            }
            return
          }

          const p = paragraphs.find(x => x.paragraphIndex === sp.paragraphIndex)
          if (!p) continue

          try {
            const summary = await this.generateParagraphSummary(
              p.content, p.title || fileName, providerId, modelId, llmClient, signal
            )
            paragraphSummaries.push(summary)
          } catch (err: any) {
            if (err?.name === 'AbortError' || signal?.aborted) {
              if (paragraphSummaries.length > 0) {
                this.updateParagraphSummaries(fileId, paragraphs, savedParagraphs, paragraphSummaries, searchEngine)
              }
              return
            }
            logger.warn(`Paragraph summary failed for ${p.title}:`, err?.message || err)
            // 生成失败的段落也记录一条空摘要，保证索引一致
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

        // 批量更新段落摘要到数据库和搜索索引
        this.updateParagraphSummaries(fileId, paragraphs, savedParagraphs, paragraphSummaries, searchEngine)
      }

      if (signal?.aborted) return

      // ========== 第五阶段：生成文件摘要（对齐旧知识库 generateDocumentSummary，基于段落摘要） ==========
      if (paragraphSummaries.length > 0 && providerId && modelId) {
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
          // 获取当前 TOC
          const tocRow = this.db.prepare(
            'SELECT toc_json FROM kms_file_summaries WHERE file_id = ?'
          ).get(fileId) as any
          const tocData = tocRow?.toc_json ? (() => { try { return JSON.parse(tocRow.toc_json) } catch { return [] } })() : []

          const docSummary = await this.generateDocumentSummaryFromParagraphs(
            paragraphSummaries, fileName, tocData, providerId, modelId, llmClient, signal
          )

          this.saveFileSummary(fileId, docSummary.summary, docSummary.keywords, docSummary.mainTopics)
          searchEngine.indexFileSummary(fileId, docSummary.summary, docSummary.keywords)
        } catch (err: any) {
          if (err?.name === 'AbortError' || signal?.aborted) return
          logger.warn(`Document summary generation failed for ${fileName}:`, err?.message || err)
        }
      } else if (providerId && modelId) {
        // 无段落摘要时，降级为基于全文生成摘要
        onProgress?.({
          phase: 'doc_summary',
          current: progressBase?.current ?? 0,
          total: progressBase?.total ?? 0,
          message: `文件摘要: ${fileName}`,
          fileId,
          fileName,
          startedAt: Math.floor(Date.now() / 1000),
        })
        await this.generateFileSummary(fileId, fullText, providerId, modelId, llmClient, searchEngine, signal)
      }
    } catch (err) {
      // 取消时不算错误
      if (signal?.aborted) return
      logger.warn(`Failed to process hot file ${fileId}:`, err)
      throw err
    }
  }

  private countWords(text: string): number {
    const trimmed = text.trim()
    if (!trimmed) return 0
    const cjkCount = (trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
    const nonCjkText = trimmed.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ')
    const latinWords = nonCjkText.split(/\s+/).filter(w => w.length > 0).length
    return cjkCount + latinWords
  }

  private splitIntoChunks(text: string, chunkSize: number, overlap: number): string[] {
    if (text.length <= chunkSize) return [text]
    const chunks: string[] = []
    let start = 0
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length)
      chunks.push(text.substring(start, end))
      if (end >= text.length) break
      start = end - overlap
    }
    return chunks.filter(c => c.length > 50)
  }

  private chunkParagraphs(text: string): Array<{
    title: string
    titlePath: string
    level: number
    paragraphIndex: number
    startOffset: number
    endOffset: number
    content: string
  }> {
    const chunks = this.splitIntoChunks(text, KMSIndexManagerService.MAX_PARAGRAPH_CHARS, KMSIndexManagerService.PARAGRAPH_OVERLAP_CHARS)
    return chunks.map((chunk, i) => {
      const startOff = text.indexOf(chunk)
      return {
        title: `段落 ${i + 1}`,
        titlePath: `段落 ${i + 1}`,
        level: 1,
        paragraphIndex: i,
        startOffset: startOff >= 0 ? startOff : i * (KMSIndexManagerService.MAX_PARAGRAPH_CHARS - KMSIndexManagerService.PARAGRAPH_OVERLAP_CHARS),
        endOffset: startOff >= 0 ? startOff + chunk.length : (i + 1) * KMSIndexManagerService.MAX_PARAGRAPH_CHARS,
        content: chunk,
      }
    })
  }

  /**
   * 检测一行是否为标题，返回 { level, title } 或 null
   * 支持 Markdown 标题与中文常见标题格式：
   * - # / ## / ###（Markdown）
   * - 第X章 / 第X节
   * - 1. / 1.1 / 1.1.1（数字编号，最多3级）
   * - 一、 二、 三、（中文数字）
   * - （一） （二）（中文括号数字）
   * 标题行约束：trim 后非空、长度 < 100、不含句末标点（。！？；）
   */
  private detectHeading(line: string): { level: number; title: string } | null {
    const trimmed = line.trim()
    if (!trimmed || trimmed.length >= 100) return null
    // 含句末标点的行视为正文，避免误识别
    if (/[。！？；]/.test(trimmed)) return null

    // Markdown 标题: # / ## / ###
    const mdMatch = trimmed.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/)
    if (mdMatch) {
      return { level: mdMatch[1].length, title: mdMatch[2].trim() }
    }

    // 第X章 / 第X节（中文数字或阿拉伯数字）
    const chapterMatch = trimmed.match(/^第([一二三四五六七八九十百千\d]+)(章|节)\s*(.*)$/)
    if (chapterMatch) {
      const level = chapterMatch[2] === '章' ? 1 : 2
      return { level, title: trimmed }
    }

    // 数字编号: 1. / 1.1 / 1.1.1（最多3级，点号分隔）
    const numericMatch = trimmed.match(/^(\d{1,2}(?:\.\d{1,2}){0,2})[\.、\s]\s*(.+)$/)
    if (numericMatch) {
      const level = numericMatch[1].split('.').length
      if (level >= 1 && level <= 3) {
        return { level, title: trimmed }
      }
    }

    // 中文数字: 一、 二、 三、
    const cnNumericMatch = trimmed.match(/^([一二三四五六七八九十]+)、\s*(.+)$/)
    if (cnNumericMatch) {
      return { level: 1, title: trimmed }
    }

    // 中文括号数字: （一） （二）
    const cnParenMatch = trimmed.match(/^[（(]([一二三四五六七八九十]+)[)）]\s*(.+)$/)
    if (cnParenMatch) {
      return { level: 2, title: trimmed }
    }

    return null
  }

  /**
   * 段落切分：识别文档标题层级并拆分为带层级的段落
   * - 支持 Markdown 标题（# / ## / ###）与中文常见标题（第X章/节、数字编号、中文数字）
   * - 首个标题前的正文作为"前言"段落保留
   * - 长段落（超过 2000 字）按双换行二次切分，避免单段过大
   * - 计算 start_offset/end_offset（基于原文偏移）
   */
  /**
   * 段落识别（对齐旧知识库 KnowledgeProcessorService.identifyParagraphs）
   * - 通过 detectHeading 识别 Markdown + 中文标题（第X章/节、数字编号等）
   * - 标题比例过高（>25% 非空行）则降级为固定大小分块
   * - 首个标题前的正文作为"前言"段落
   * - 内容不足 MIN_CONTENT_WORDS 词时忽略该段落
   * - 超长段落按 MAX_PARAGRAPH_CHARS 二次切分（带 PARAGRAPH_OVERLAP_CHARS 重叠）
   */
  private splitParagraphs(
    fullText: string,
    fileName: string
  ): Array<{
    title: string
    titlePath: string
    level: number
    paragraphIndex: number
    startOffset: number
    endOffset: number
    content: string
  }> {
    const paragraphs: Array<any> = []
    const lines = fullText.split('\n')
    let currentOffset = 0
    const headingPositions: Array<{ title: string; offset: number; level: number; lineIndex: number }> = []

    // 第一遍：扫描所有标题行
    for (let i = 0; i < lines.length; i++) {
      const heading = this.detectHeading(lines[i])
      if (heading) {
        headingPositions.push({
          title: heading.title,
          offset: currentOffset,
          level: heading.level,
          lineIndex: i,
        })
      }
      currentOffset += lines[i].length + 1
    }

    // 无标题 → 固定大小分块
    if (headingPositions.length === 0) {
      return this.chunkParagraphs(fullText)
    }

    // 标题比例过高 → 可能不是真正的结构标题，降级为分块
    const nonEmptyLines = lines.filter(l => l.trim().length > 0).length
    const headingRatio = headingPositions.length / Math.max(nonEmptyLines, 1)
    if (headingRatio > KMSIndexManagerService.MAX_HEADING_LINE_RATIO) {
      return this.chunkParagraphs(fullText)
    }

    // 标题栈：维护路径
    const headingStack: Array<{ title: string; level: number }> = []
    let paraIdx = 0

    // 首个标题前的内容 → "前言"
    const firstHeadingOffset = headingPositions[0].offset
    if (firstHeadingOffset > 0) {
      const prefaceContent = fullText.substring(0, firstHeadingOffset).trim()
      if (this.countWords(prefaceContent) >= KMSIndexManagerService.MIN_CONTENT_WORDS) {
        if (prefaceContent.length > KMSIndexManagerService.MAX_PARAGRAPH_CHARS) {
          const subChunks = this.splitIntoChunks(prefaceContent, KMSIndexManagerService.MAX_PARAGRAPH_CHARS, KMSIndexManagerService.PARAGRAPH_OVERLAP_CHARS)
          for (let si = 0; si < subChunks.length; si++) {
            paragraphs.push({
              title: subChunks.length > 1 ? `前言 (${si + 1})` : '前言',
              titlePath: subChunks.length > 1 ? `前言 (${si + 1})` : '前言',
              level: 1,
              paragraphIndex: paraIdx++,
              startOffset: 0,
              endOffset: firstHeadingOffset,
              content: subChunks[si],
            })
          }
        } else {
          paragraphs.push({
            title: '前言',
            titlePath: '前言',
            level: 1,
            paragraphIndex: paraIdx++,
            startOffset: 0,
            endOffset: firstHeadingOffset,
            content: prefaceContent,
          })
        }
      }
    }

    // 按标题切分段落
    for (let i = 0; i < headingPositions.length; i++) {
      const heading = headingPositions[i]

      // 维护标题栈
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= heading.level) {
        headingStack.pop()
      }
      headingStack.push({ title: heading.title, level: heading.level })

      const titlePath = headingStack.map(h => h.title).join(' > ')

      const nextHeading = headingPositions[i + 1]
      const startOff = heading.offset
      const endOff = nextHeading ? nextHeading.offset : fullText.length
      const content = fullText.substring(startOff, endOff).trim()

      // 内容太少 → 跳过该段落
      if (this.countWords(content) < KMSIndexManagerService.MIN_CONTENT_WORDS) continue

      if (content.length > KMSIndexManagerService.MAX_PARAGRAPH_CHARS) {
        const subChunks = this.splitIntoChunks(content, KMSIndexManagerService.MAX_PARAGRAPH_CHARS, KMSIndexManagerService.PARAGRAPH_OVERLAP_CHARS)
        for (let si = 0; si < subChunks.length; si++) {
          const subStartInContent = content.indexOf(subChunks[si])
          const absStartOff = startOff + (subStartInContent >= 0 ? subStartInContent : si * (KMSIndexManagerService.MAX_PARAGRAPH_CHARS - KMSIndexManagerService.PARAGRAPH_OVERLAP_CHARS))
          paragraphs.push({
            title: subChunks.length > 1 ? `${heading.title} (${si + 1})` : heading.title,
            titlePath: subChunks.length > 1 ? `${titlePath} (${si + 1})` : titlePath,
            level: heading.level,
            paragraphIndex: paraIdx++,
            startOffset: absStartOff,
            endOffset: absStartOff + subChunks[si].length,
            content: subChunks[si],
          })
        }
      } else {
        paragraphs.push({
          title: heading.title,
          titlePath,
          level: heading.level,
          paragraphIndex: paraIdx++,
          startOffset: startOff,
          endOffset: endOff,
          content,
        })
      }
    }

    // 兜底：无有效段落时，全文作为单一段落
    if (paragraphs.length === 0) {
      paragraphs.push({
        title: fileName,
        titlePath: fileName,
        level: 1,
        paragraphIndex: 0,
        startOffset: 0,
        endOffset: fullText.length,
        content: fullText.trim(),
      })
    }

    return paragraphs
  }

  /**
   * 生成文件 TOC（从段落表派生目录结构，写入 kms_file_summaries.toc_json）
   * TOC 仅包含标题与层级，不含正文内容
   */
  private generateFileToc(
    fileId: string,
    paragraphs: Array<{ title: string; titlePath: string; level: number; paragraphIndex: number; startOffset: number; endOffset: number }>,
    searchEngine: KMSSearchEngineService
  ): void {
    const toc = paragraphs
      .filter(p => p.title && p.title !== '前言')
      .map(p => ({
        id: p.paragraphIndex,
        title: p.title,
        titlePath: p.titlePath,
        level: p.level,
        paragraphIndex: p.paragraphIndex,
        startOffset: p.startOffset,
        endOffset: p.endOffset,
      }))

    searchEngine.saveFileToc(fileId, JSON.stringify(toc))
  }

  // ==================== LLM TOC 恢复（对齐旧知识库 KnowledgeProcessorService） ====================

  /**
   * 判断是否需要 LLM TOC 恢复
   * 条件：无标题 或 标题密度过低（平均每个标题承载超过 8000 字符）
   */
  private needsTocRestoration(text: string): boolean {
    const lines = text.split('\n')
    let headingCount = 0
    for (const line of lines) {
      if (this.detectHeading(line)) {
        headingCount++
      }
    }
    if (headingCount === 0) return true
    if (text.length / headingCount > KMSIndexManagerService.TOC_MIN_HEADING_DENSITY) return true
    return false
  }

  private addLineNumbers(text: string, startLine: number = 1): string {
    const lines = text.split('\n')
    return lines.map((line, i) => `[L${startLine + i}] ${line}`).join('\n')
  }

  private lineContainsTitle(lineContent: string, title: string): boolean {
    const normalize = (s: string) => s.replace(/[\s\u3000]+/g, '').toLowerCase()
    const normalizedLine = normalize(lineContent)
    const normalizedTitle = normalize(title)
    if (!normalizedLine || !normalizedTitle) return false
    if (normalizedLine === normalizedTitle) return true
    if (normalizedLine.includes(normalizedTitle) || normalizedTitle.includes(normalizedLine)) return true
    const titleChars = [...normalizedTitle]
    const lineChars = [...normalizedLine]
    let matchCount = 0
    for (const ch of titleChars) {
      if (lineChars.includes(ch)) matchCount++
    }
    return matchCount / titleChars.length >= 0.6
  }

  private deduplicateTocEntries(entries: LLMTocEntry[]): LLMTocEntry[] {
    const sorted = [...entries].sort((a, b) => a.lineNumber - b.lineNumber)
    const result: LLMTocEntry[] = []
    for (const entry of sorted) {
      const isDuplicate = result.some(existing =>
        Math.abs(existing.lineNumber - entry.lineNumber) <= 3 &&
        this.lineContainsTitle(existing.title, entry.title)
      )
      if (!isDuplicate) result.push(entry)
    }
    return result
  }

  private validateTocEntries(text: string, entries: LLMTocEntry[]): ValidatedTocEntry[] {
    const lines = text.split('\n')
    const lineOffsets: number[] = []
    let offset = 0
    for (const line of lines) {
      lineOffsets.push(offset)
      offset += line.length + 1
    }

    const validated: ValidatedTocEntry[] = []

    for (const entry of entries) {
      if (!entry.title || entry.lineNumber == null || entry.level == null) continue
      if (entry.level < 1 || entry.level > 3) continue

      const targetLineIndex = entry.lineNumber - 1
      let foundLineIndex = -1

      if (targetLineIndex >= 0 && targetLineIndex < lines.length) {
        if (this.lineContainsTitle(lines[targetLineIndex], entry.title)) {
          foundLineIndex = targetLineIndex
        }
      }

      if (foundLineIndex === -1) {
        for (let delta = -5; delta <= 5; delta++) {
          const idx = targetLineIndex + delta
          if (idx >= 0 && idx < lines.length && this.lineContainsTitle(lines[idx], entry.title)) {
            foundLineIndex = idx
            break
          }
        }
      }

      if (foundLineIndex === -1) {
        for (let i = 0; i < lines.length; i++) {
          if (this.lineContainsTitle(lines[i], entry.title)) {
            foundLineIndex = i
            break
          }
        }
      }

      if (foundLineIndex >= 0) {
        validated.push({
          title: entry.title,
          level: entry.level,
          lineNumber: foundLineIndex + 1,
          offset: lineOffsets[foundLineIndex],
        })
      } else if (targetLineIndex >= 0 && targetLineIndex < lines.length) {
        const trimmedLine = lines[targetLineIndex].trim()
        if (trimmedLine.length > 0 && trimmedLine.length <= 10) {
          validated.push({
            title: entry.title,
            level: entry.level,
            lineNumber: targetLineIndex + 1,
            offset: lineOffsets[targetLineIndex],
          })
        }
      }
    }

    return validated
  }

  private buildTocContext(entries: LLMTocEntry[]): string {
    if (entries.length === 0) return ''
    const recentEntries = entries.slice(-5)
    const contextLines = recentEntries.map(e => `${'  '.repeat(e.level - 1)}[L${e.level}] ${e.title}`)
    return contextLines.join('\n')
  }

  private async callLLMForToc(
    numberedContent: string,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    existingTocContext?: string,
    signal?: AbortSignal
  ): Promise<LLMTocEntry[]> {
    const systemPrompt = `你是一个专业的文档结构分析专家。你的任务是分析文档内容，准确识别其中的章节标题、层级关系和位置。

识别规则：
1. 只识别真正的结构性标题，不要把正文中的强调文本、列表项、表格内容误认为标题
2. 标题特征：通常是独立成行的短文本（一般不超过60字），具有概括性
3. 常见标题模式：
   - 编号型："第X章/节/部分"、"1."/"1.1"/"1.1.1"、"一、"/"二、"
   - 无编号型：独立成行的概括性短句，后续跟随详细说明内容
4. level表示层级深度，最大3级：1=最高级（章/部分），2=次级（节），3=最细粒度（小节），不允许超过3级
5. lineNumber必须精确对应内容中的行号标记[L数字]
6. 标题对应的正文内容太少（例如小于50词）时，忽略该标题
7. 如果提供了已识别的上层目录上下文，请参考该上下文来确定当前标题的层级，避免将低层级标题误判为高层级${existingTocContext ? `\n\n已识别的上层目录上下文（供参考）：\n${existingTocContext}` : ''}

输出要求：
- 严格按照JSON格式输出
- 只返回JSON，不要包含任何解释文字
- 如果无法识别任何标题结构，返回{"toc":[]}`

    const userPrompt = `请分析以下文档内容，识别所有章节标题及其位置。

文档内容：
${numberedContent}

返回格式：
{"toc":[{"title":"标题文字","level":1,"lineNumber":5}]}`

    try {
      const result = await llmClient.chat(providerId, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], {
        temperature: 0.1,
        ...(modelId ? { model: modelId } : {}),
        signal,
        logSource: 'knowledge_toc',
      })

      const parsed = this.parseJSON<{ toc: LLMTocEntry[] }>(result, { toc: [] })
      return Array.isArray(parsed.toc) ? parsed.toc : []
    } catch {
      return []
    }
  }

  /**
   * 使用 LLM 恢复文档目录结构（对齐旧知识库 restoreTocWithLLM）
   * 将文档分段，逐段调用 LLM 识别章节标题
   */
  private async restoreTocWithLLM(
    text: string,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<ValidatedTocEntry[]> {
    const lines = text.split('\n')

    // 小文档：一次性分析
    if (lines.length <= KMSIndexManagerService.TOC_CHUNK_LINES) {
      const numberedContent = this.addLineNumbers(text)
      const entries = await this.callLLMForToc(numberedContent, providerId, modelId, llmClient, undefined, signal)
      return this.validateTocEntries(text, entries)
    }

    // 大文档：分块分析
    const allEntries: LLMTocEntry[] = []
    let startLine = 0
    let chunkIndex = 0

    // 计算总块数
    let totalChunks = 0
    {
      let s = 0
      while (s < lines.length) {
        totalChunks++
        const e = Math.min(s + KMSIndexManagerService.TOC_CHUNK_LINES, lines.length)
        if (e >= lines.length) break
        s = e - KMSIndexManagerService.TOC_OVERLAP_LINES
      }
    }

    while (startLine < lines.length) {
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

      const endLine = Math.min(startLine + KMSIndexManagerService.TOC_CHUNK_LINES, lines.length)
      const chunkLines = lines.slice(startLine, endLine)
      const numberedContent = this.addLineNumbers(chunkLines.join('\n'), startLine + 1)

      const existingTocContext = this.buildTocContext(allEntries)

      onProgress?.({
        phase: 'toc',
        current: chunkIndex + 1,
        total: totalChunks,
        message: `LLM目录分析: 第${chunkIndex + 1}/${totalChunks}块 (行${startLine + 1}-${endLine})`,
        startedAt: Math.floor(Date.now() / 1000),
      })

      const entries = await this.callLLMForToc(numberedContent, providerId, modelId, llmClient, existingTocContext, signal)
      allEntries.push(...entries)

      chunkIndex++
      if (endLine >= lines.length) break
      startLine = endLine - KMSIndexManagerService.TOC_OVERLAP_LINES
    }

    const deduplicated = this.deduplicateTocEntries(allEntries)
    const validated = this.validateTocEntries(text, deduplicated)

    return validated
  }

  /**
   * 基于 LLM 还原的 TOC 重新切分段落（对齐旧知识库 identifyParagraphsFromLLMToc）
   */
  private identifyParagraphsFromLLMToc(
    text: string,
    tocEntries: ValidatedTocEntry[],
  ): Array<{
    title: string
    titlePath: string
    level: number
    paragraphIndex: number
    startOffset: number
    endOffset: number
    content: string
  }> {
    if (tocEntries.length === 0) return []

    const paragraphs: Array<any> = []
    const sortedEntries = [...tocEntries].sort((a, b) => a.offset - b.offset)
    const headingStack: Array<{ title: string; level: number }> = []
    let paraIdx = 0

    // 首个TOC条目之前的内容 → "前言"
    const firstEntryOffset = sortedEntries[0].offset
    if (firstEntryOffset > 0) {
      const prefaceContent = text.substring(0, firstEntryOffset).trim()
      if (this.countWords(prefaceContent) >= KMSIndexManagerService.MIN_CONTENT_WORDS) {
        if (prefaceContent.length > KMSIndexManagerService.MAX_PARAGRAPH_CHARS) {
          const subChunks = this.splitIntoChunks(prefaceContent, KMSIndexManagerService.MAX_PARAGRAPH_CHARS, KMSIndexManagerService.PARAGRAPH_OVERLAP_CHARS)
          for (let si = 0; si < subChunks.length; si++) {
            paragraphs.push({
              title: subChunks.length > 1 ? `前言 (${si + 1})` : '前言',
              titlePath: subChunks.length > 1 ? `前言 (${si + 1})` : '前言',
              level: 1,
              paragraphIndex: paraIdx++,
              startOffset: 0,
              endOffset: firstEntryOffset,
              content: subChunks[si],
            })
          }
        } else {
          paragraphs.push({
            title: '前言',
            titlePath: '前言',
            level: 1,
            paragraphIndex: paraIdx++,
            startOffset: 0,
            endOffset: firstEntryOffset,
            content: prefaceContent,
          })
        }
      }
    }

    for (let i = 0; i < sortedEntries.length; i++) {
      const entry = sortedEntries[i]

      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= entry.level) {
        headingStack.pop()
      }
      headingStack.push({ title: entry.title, level: entry.level })

      const titlePath = headingStack.map(h => h.title).join(' > ')
      const nextEntry = sortedEntries[i + 1]
      const startOff = entry.offset
      const endOff = nextEntry ? nextEntry.offset : text.length
      const content = text.substring(startOff, endOff).trim()

      if (this.countWords(content) < KMSIndexManagerService.MIN_CONTENT_WORDS) continue

      if (content.length > KMSIndexManagerService.MAX_PARAGRAPH_CHARS) {
        const subChunks = this.splitIntoChunks(content, KMSIndexManagerService.MAX_PARAGRAPH_CHARS, KMSIndexManagerService.PARAGRAPH_OVERLAP_CHARS)
        for (let si = 0; si < subChunks.length; si++) {
          const subStartInContent = content.indexOf(subChunks[si])
          const absStartOff = startOff + (subStartInContent >= 0 ? subStartInContent : si * (KMSIndexManagerService.MAX_PARAGRAPH_CHARS - KMSIndexManagerService.PARAGRAPH_OVERLAP_CHARS))
          paragraphs.push({
            title: subChunks.length > 1 ? `${entry.title} (${si + 1})` : entry.title,
            titlePath: subChunks.length > 1 ? `${titlePath} (${si + 1})` : titlePath,
            level: entry.level,
            paragraphIndex: paraIdx++,
            startOffset: absStartOff,
            endOffset: absStartOff + subChunks[si].length,
            content: subChunks[si],
          })
        }
      } else {
        paragraphs.push({
          title: entry.title,
          titlePath,
          level: entry.level,
          paragraphIndex: paraIdx++,
          startOffset: startOff,
          endOffset: endOff,
          content,
        })
      }
    }

    return paragraphs
  }

  /**
   * 按内容量过滤 TOC 条目（移除正文不足 MIN_CONTENT_WORDS 词的条目）
   */
  private filterTocByContentVolume(text: string, entries: ValidatedTocEntry[]): ValidatedTocEntry[] {
    if (entries.length === 0) return entries
    const sorted = [...entries].sort((a, b) => a.offset - b.offset)
    return sorted.filter((entry, i) => {
      const nextEntry = sorted[i + 1]
      const startOff = entry.offset
      const endOff = nextEntry ? nextEntry.offset : text.length
      const content = text.substring(startOff, endOff).trim()
      return this.countWords(content) >= KMSIndexManagerService.MIN_CONTENT_WORDS
    })
  }

  /**
   * 基于已验证的 TOC 条目构建带层级路径的目录
   */
  private buildTocWithPath(entries: ValidatedTocEntry[]): Array<{ title: string; level: number; path: string; offset: number }> {
    const sorted = [...entries].sort((a, b) => a.offset - b.offset)
    const headingStack: Array<{ title: string; level: number }> = []
    return sorted.map(entry => {
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= entry.level) {
        headingStack.pop()
      }
      headingStack.push({ title: entry.title, level: entry.level })
      return {
        title: entry.title,
        level: entry.level,
        path: headingStack.map(h => h.title).join(' > '),
        offset: entry.offset,
      }
    })
  }

  private parseJSON<T>(raw: string, fallback: T): T {
    try {
      let jsonStr = raw.trim()
      const fenceMatch = jsonStr.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m)
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim()
      } else {
        const firstBrace = jsonStr.indexOf('{')
        const lastBrace = jsonStr.lastIndexOf('}')
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          jsonStr = jsonStr.substring(firstBrace, lastBrace + 1)
        }
      }
      return JSON.parse(jsonStr) as T
    } catch {
      try {
        const repaired = this.repairJSON(raw)
        return JSON.parse(repaired) as T
      } catch {
        return fallback
      }
    }
  }

  private repairJSON(raw: string): string {
    let result = ''
    let inString = false
    let escaped = false
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (escaped) { result += ch; escaped = false; continue }
      if (ch === '\\') { result += ch; escaped = true; continue }
      if (ch === '"') { inString = !inString; result += ch; continue }
      if (inString) {
        if (ch === '\n') result += '\\n'
        else if (ch === '\r') result += '\\r'
        else if (ch === '\t') result += '\\t'
        else result += ch
      } else {
        result += ch
      }
    }
    return result
  }

  /**
   * 生成段落级摘要（对齐旧知识库 generateParagraphSummary）
   * 逐段生成，使用旧 KB 提示词
   */
  private async generateParagraphSummary(
    paragraphContent: string,
    paragraphTitle: string,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    signal?: AbortSignal,
  ): Promise<{ title: string; summary: string; keywords: string[] }> {
    const prompt = `为以下段落生成摘要，JSON格式返回。
段落标题：${paragraphTitle}
段落内容：
${paragraphContent.substring(0, 8000)}

返回字段：
- title: 段落标题
- summary: 摘要（50字以内，简洁精炼）
- keywords: 关键词列表（3-5个）

只返回JSON。`

    try {
      const result = await llmClient.chat(providerId, [
        { role: 'system', content: 'You are a professional knowledge engineer. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ], {
        ...(modelId ? { model: modelId } : {}),
        signal,
        logSource: 'knowledge_paragraph_summary',
      })

      return this.parseJSON<{ title: string; summary: string; keywords: string[] }>(result, {
        title: paragraphTitle,
        summary: '',
        keywords: [],
      })
    } catch (error) {
      throw new Error(`Paragraph summary generation failed (${paragraphTitle}): ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * 生成文件级摘要（对齐旧知识库 generateDocumentSummary）
   * 基于段落摘要汇总生成，而非直接基于全文
   */
  private async generateDocumentSummaryFromParagraphs(
    paragraphSummaries: Array<{ title: string; summary: string; keywords: string[] }>,
    documentTitle: string,
    _toc: Array<{ title: string; level: number; path: string; offset: number }>,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    signal?: AbortSignal,
  ): Promise<{ summary: string; keywords: string[]; mainTopics: string[] }> {
    const summariesText = paragraphSummaries.map((ps, i) =>
      `### 段落${i + 1}: ${ps.title}\n${ps.summary}\n关键词: ${ps.keywords.join(', ')}`
    ).join('\n\n')

    const prompt = `基于段落摘要生成文档全局摘要，JSON格式返回。
文档标题：${documentTitle}
段落摘要：
${summariesText.substring(0, 15000)}

返回字段：
- summary: 全局摘要（150字以内，简洁精炼）
- keywords: 关键词列表（5-8个）
- mainTopics: 主要主题列表（3-5个）

只返回JSON。`

    try {
      const result = await llmClient.chat(providerId, [
        { role: 'system', content: 'You are a professional knowledge engineer. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ], {
        ...(modelId ? { model: modelId } : {}),
        signal,
        logSource: 'knowledge_document_summary',
      })

      const parsed = this.parseJSON<{ summary: string; keywords: string[]; mainTopics: string[] }>(result, {
        summary: '',
        keywords: [],
        mainTopics: [],
      })

      return parsed
    } catch (error) {
      throw new Error(`Document summary generation failed (${documentTitle}): ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * 批量更新段落摘要到数据库和搜索索引
   */
  private updateParagraphSummaries(
    fileId: string,
    paragraphs: Array<{ title: string; titlePath: string; level: number; paragraphIndex: number; startOffset: number; endOffset: number; content?: string }>,
    savedParagraphs: Array<{ id: string; paragraphIndex: number }>,
    summaries: Array<{ title: string; summary: string; keywords: string[] }>,
    searchEngine: KMSSearchEngineService,
  ): void {
    const paraById = new Map<number, string>()
    for (const sp of savedParagraphs) paraById.set(sp.paragraphIndex, sp.id)
    const paraByIndex = new Map<number, any>()
    for (const p of paragraphs) paraByIndex.set(p.paragraphIndex, p)

    for (let i = 0; i < summaries.length; i++) {
      const summary = summaries[i]
      if (!summary.summary && summary.keywords.length === 0) continue

      const paraId = paraById.get(i)
      if (!paraId) continue

      // 更新数据库
      searchEngine.updateParagraphSummary(paraId, summary.summary, summary.keywords)

      // 同步更新搜索索引
      const p = paraByIndex.get(i)
      if (p) {
        searchEngine.indexParagraph(
          fileId,
          paraId,
          p.title,
          p.titlePath,
          summary.summary,
          summary.keywords,
          p.startOffset,
          p.endOffset
        )
      }
    }
  }

  /**
   * 生成文件级 LLM 摘要（含关键词和主题）
   */
  private async generateFileSummary(
    fileId: string,
    fullText: string,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    searchEngine: KMSSearchEngineService,
    signal?: AbortSignal
  ): Promise<void> {
    if (!modelId) {
      throw new Error('MODEL_NOT_CONFIGURED')
    }
    const truncatedText = fullText.substring(0, 3000)
    const summaryPrompt = `请为以下文档内容生成简洁摘要（150字以内），并提取5-8个关键词和3-5个主要主题。\n\n文档内容：\n${truncatedText}\n\n请以JSON格式返回：{"summary": "...", "keywords": ["..."], "main_topics": ["..."]}`

    const summaryResult = await llmClient.chat(providerId, [
      { role: 'system', content: '你是一个文档摘要助手。请严格按照JSON格式返回结果。' },
      { role: 'user', content: summaryPrompt },
    ], { temperature: 0.1, max_tokens: 500, model: modelId, signal })

    if (signal?.aborted) return

    try {
      const parsed = JSON.parse(summaryResult || '{}')
      const summary = parsed.summary || ''
      const keywords = parsed.keywords || []
      const mainTopics = parsed.main_topics || []

      this.saveFileSummary(fileId, summary, keywords, mainTopics)
      searchEngine.indexFileSummary(fileId, summary, keywords)
    } catch {
      logger.warn(`Failed to parse summary result for file ${fileId}`)
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
      // 如果未获取到 modelId，尝试从 KMS 配置解析
      if (!modelId) {
        try {
          const KMSService = (await import('./kms.service')).default
          const kmsService = KMSService.getInstance()
          const kmsConfig = kmsService.getKmsLLMConfigPublic()
          if (kmsConfig?.modelId) {
            modelId = kmsConfig.modelId
          }
        } catch {}
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

  // ==================== 手动摘要生成 ====================

  /**
   * 手动生成单个目录的摘要
   * 使用 KMS LLM 配置，对指定目录下的已完成文件生成摘要
   */
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

      // 获取 KMS LLM 配置
      const KMSService = (await import('./kms.service')).default
      const kmsService = KMSService.getInstance()
      const llmConfig = kmsService.getKmsLLMConfigPublic()
      const llmClient = LLMClientService.getInstance()

      let modelId: string | undefined
      if (llmConfig?.providerId) {
        const config = await llmClient.getProviderConfig(llmConfig.providerId)
        modelId = llmConfig.modelId || config?.model || undefined
      }

      // 构建目录内容清单
      const fileList = files.map(f => {
        const summary = f.summary || f.light_summary || ''
        return `- ${f.file_name} (${f.file_ext || '无扩展名'}, ${this.formatSize(f.file_size)})${summary ? ': ' + summary.substring(0, 80) : ''}`
      }).join('\n')

      let dirSummary: string
      let keywords: string[] = []

      if (llmConfig?.providerId && modelId && files.length <= 100) {
        const prompt = `请为以下目录生成简洁摘要（200字以内），概括目录内容主题和结构，并提取5-10个关键词。

目录路径：${dir.dir_path}
文件数量：${files.length}
文件清单：
${fileList}

请以JSON格式返回：{"summary": "...", "keywords": ["..."]}`

        try {
          const result = await llmClient.chat(llmConfig.providerId, [
            { role: 'system', content: '你是一个目录内容摘要助手，输出简洁准确的JSON。' },
            { role: 'user', content: prompt },
          ], { temperature: 0.1, max_tokens: 400, model: modelId, logSource: 'kms_dir_summary_manual' })

          const parsed = JSON.parse(result)
          dirSummary = parsed.summary || ''
          keywords = parsed.keywords || []
        } catch {
          dirSummary = this.generateSimpleDirSummary(dir.dir_path, files)
        }
      } else {
        dirSummary = this.generateSimpleDirSummary(dir.dir_path, files)
      }

      this.saveDirSummary(dir.id, dir.dir_path, dirSummary, files.length, keywords)
      return { success: true }
    } catch (err: any) {
      logger.error(`Failed to generate dir summary manually for ${dirId}:`, err)
      return { success: false, error: err?.message || 'UNKNOWN' }
    }
  }

  /**
   * 手动生成单个文件的摘要（含段落切分/TOC/段落摘要/文件摘要）
   * 使用 KMS LLM 配置，对指定文件执行深度处理
   */
  async generateFileSummaryManual(fileId: string): Promise<{ success: boolean; error?: string; embeddingError?: string }> {
    try {
      const file = this.db.prepare('SELECT id, file_name, file_path, file_ext, data_tier FROM kms_files WHERE id = ?').get(fileId) as any
      if (!file) return { success: false, error: 'FILE_NOT_FOUND' }

      // 获取 KMS LLM 配置
      const KMSService = (await import('./kms.service')).default
      const kmsService = KMSService.getInstance()
      const llmConfig = kmsService.getKmsLLMConfigPublic()
      if (!llmConfig?.providerId) {
        return { success: false, error: 'NO_LLM_PROVIDER' }
      }

      const llmClient = LLMClientService.getInstance()

      const searchEngine = KMSSearchEngineService.getInstance()
      const fileParser = FileParserService.getInstance()

      // 解析文件
      const parseResult = await fileParser.parseFilePath(file.file_path)
      if (!parseResult.fullText) return { success: false, error: 'EMPTY_CONTENT' }

      // 生成轻量摘要（确保至少有基础摘要）
      this.saveLightSummary(file.id, file.file_name, file.file_path, parseResult.fullText)

      // 执行深度处理（段落切分/TOC/段落摘要/文件摘要），传入 KMS 配置的 modelId
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
        llmConfig.modelId
      )

      // 为该文件的索引条目生成向量嵌入
      const embResult = await this.generateEmbeddingsForFile(file.id, llmConfig.providerId)

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

  /**
   * 增量重新生成：从指定段落开始重新切分、生成摘要、向量化
   * 保留该段落之前的所有段落不变，仅重新处理该段落及之后的内容
   * 适用于：文件后半部分有更新、或某段落摘要质量不好需要重新生成
   * 进度通过 onProgress 推送（带 fileId/fileName，不带 collectionId，便于前端区分）
   */
  async regenerateFileParagraph(
    fileId: string,
    fromParagraphId: string,
    onProgress?: ProgressCallback
  ): Promise<{ success: boolean; error?: string }> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      // 1. 读取文件信息
      const file = this.db.prepare('SELECT id, file_name, file_path, file_ext FROM kms_files WHERE id = ?').get(fileId) as any
      if (!file) return { success: false, error: 'FILE_NOT_FOUND' }

      // 2. 查询 fromParagraphId 对应的 paragraphIndex 和 startOffset
      const fromPara = this.db.prepare(
        'SELECT id, paragraph_index, start_offset FROM kms_paragraphs WHERE id = ? AND file_id = ?'
      ).get(fromParagraphId, fileId) as any
      if (!fromPara) return { success: false, error: 'PARAGRAPH_NOT_FOUND' }

      const fromIndex = fromPara.paragraph_index
      const fromStartOffset = fromPara.start_offset

      // 3. 获取 KMS LLM 配置
      const KMSService = (await import('./kms.service')).default
      const kmsService = KMSService.getInstance()
      const llmConfig = kmsService.getKmsLLMConfigPublic()
      if (!llmConfig?.providerId) {
        return { success: false, error: 'NO_LLM_PROVIDER' }
      }

      const llmClient = LLMClientService.getInstance()
      const searchEngine = KMSSearchEngineService.getInstance()
      const fileParser = FileParserService.getInstance()

      // 4. 解析文件获取 fullText
      onProgress?.({
        phase: 'parsing',
        current: 0,
        total: 0,
        message: `重新解析文件: ${file.file_name}`,
        fileId,
        fileName: file.file_name,
        startedAt: Math.floor(Date.now() / 1000),
      })
      const parseResult = await fileParser.parseFilePath(file.file_path, signal)
      if (!parseResult.fullText) return { success: false, error: 'EMPTY_CONTENT' }
      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '已取消', fileId, fileName: file.file_name })
        return { success: false, error: 'ABORTED' }
      }

      // 5. 删除 fromIndex 及之后的所有段落（含搜索索引、向量嵌入）
      searchEngine.deleteParagraphsFromFileIndex(fileId, fromIndex)

      // 6. 从 fromStartOffset 开始，对后续内容重新切分
      const remainingText = parseResult.fullText.substring(fromStartOffset)

      // 辅助函数：从当前所有段落派生 TOC 并保存
      const refreshToc = () => {
        const allParas = this.db.prepare(
          'SELECT title, title_path, level, paragraph_index, start_offset, end_offset FROM kms_paragraphs WHERE file_id = ? ORDER BY paragraph_index ASC'
        ).all(fileId) as any[]
        this.generateFileToc(fileId, allParas.map(p => ({
          title: p.title,
          titlePath: p.title_path,
          level: p.level,
          paragraphIndex: p.paragraph_index,
          startOffset: p.start_offset,
          endOffset: p.end_offset,
        })), searchEngine)
      }

      if (!remainingText.trim()) {
        // 没有后续内容，直接更新 TOC 并完成
        refreshToc()
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '重新生成完成（无后续内容）', fileId, fileName: file.file_name })
        return { success: true }
      }

      // 对后续内容切分（使用文件名作为兜底标题）
      const newParas = this.splitParagraphs(remainingText, file.file_name)

      // 7. 调整新段落的 paragraphIndex（从 fromIndex 开始连续编号）和 startOffset（加上 fromStartOffset 偏移）
      const adjustedParas = newParas.map((p, idx) => ({
        ...p,
        paragraphIndex: fromIndex + idx,
        startOffset: p.startOffset + fromStartOffset,
        endOffset: p.endOffset + fromStartOffset,
      }))

      // 8. 保存新段落（增量插入，不删除已有）
      onProgress?.({
        phase: 'paragraph_split',
        current: 0,
        total: adjustedParas.length,
        message: `段落切分: ${file.file_name}（${adjustedParas.length} 个新段落）`,
        fileId,
        fileName: file.file_name,
        startedAt: Math.floor(Date.now() / 1000),
      })
      const savedNewParas = searchEngine.insertParagraphs(fileId, adjustedParas)

      // 9. 重新生成 TOC（从所有段落派生，包括保留的前半部分和新追加的后半部分）
      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '已取消', fileId, fileName: file.file_name })
        return { success: false, error: 'ABORTED' }
      }
      onProgress?.({
        phase: 'toc',
        current: 0,
        total: 0,
        message: `生成目录: ${file.file_name}`,
        fileId,
        fileName: file.file_name,
        startedAt: Math.floor(Date.now() / 1000),
      })
      refreshToc()

      // 10. 将新段落写入搜索索引
      for (const sp of savedNewParas) {
        if (signal.aborted) break
        const p = adjustedParas.find(x => x.paragraphIndex === sp.paragraphIndex)
        if (!p) continue
        searchEngine.indexParagraph(
          fileId,
          sp.id,
          p.title,
          p.titlePath,
          '', // 摘要稍后填充
          [],
          p.startOffset,
          p.endOffset
        )
      }

      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '已取消', fileId, fileName: file.file_name })
        return { success: false, error: 'ABORTED' }
      }

      // 11. 重新生成新段落的摘要（逐段生成）
      const summaryCandidates = savedNewParas.filter(sp => {
        const p = adjustedParas.find(x => x.paragraphIndex === sp.paragraphIndex)
        return p && p.content && this.countWords(p.content) >= KMSIndexManagerService.MIN_CONTENT_WORDS
      })

      const paraSummaries: Array<{ title: string; summary: string; keywords: string[] }> = []

      if (summaryCandidates.length > 0 && llmConfig.providerId && llmConfig.modelId) {
        onProgress?.({
          phase: 'paragraph_summary',
          current: 0,
          total: summaryCandidates.length,
          message: `段落摘要: ${file.file_name}（${summaryCandidates.length} 段）`,
          fileId,
          fileName: file.file_name,
          startedAt: Math.floor(Date.now() / 1000),
        })

        let paraProcessed = 0
        for (const sp of summaryCandidates) {
          if (signal.aborted) {
            if (paraSummaries.length > 0) {
              this.updateParagraphSummaries(fileId, adjustedParas, savedNewParas, paraSummaries, searchEngine)
            }
            onProgress?.({ phase: 'done', current: 0, total: 0, message: '已取消', fileId, fileName: file.file_name })
            return { success: false, error: 'ABORTED' }
          }

          const p = adjustedParas.find(x => x.paragraphIndex === sp.paragraphIndex)
          if (!p) continue

          try {
            const summary = await this.generateParagraphSummary(
              p.content, p.title || file.file_name, llmConfig.providerId, llmConfig.modelId, llmClient, signal
            )
            paraSummaries.push(summary)
          } catch (err: any) {
            if (err?.name === 'AbortError' || signal.aborted) {
              if (paraSummaries.length > 0) {
                this.updateParagraphSummaries(fileId, adjustedParas, savedNewParas, paraSummaries, searchEngine)
              }
              onProgress?.({ phase: 'done', current: 0, total: 0, message: '已取消', fileId, fileName: file.file_name })
              return { success: false, error: 'ABORTED' }
            }
            logger.warn(`Paragraph summary failed for ${p.title}:`, err?.message || err)
            paraSummaries.push({ title: p.title, summary: '', keywords: [] })
          }

          paraProcessed++
          onProgress?.({
            phase: 'paragraph_summary',
            current: paraProcessed,
            total: summaryCandidates.length,
            message: `段落摘要: ${file.file_name}（${paraProcessed}/${summaryCandidates.length}）`,
            fileId,
            fileName: file.file_name,
            startedAt: Math.floor(Date.now() / 1000),
          })
        }

        this.updateParagraphSummaries(fileId, adjustedParas, savedNewParas, paraSummaries, searchEngine)
      }

      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '已取消', fileId, fileName: file.file_name })
        return { success: false, error: 'ABORTED' }
      }

      // 12. 重新生成文件摘要
      onProgress?.({
        phase: 'doc_summary',
        current: 0,
        total: 0,
        message: `文件摘要: ${file.file_name}`,
        fileId,
        fileName: file.file_name,
        startedAt: Math.floor(Date.now() / 1000),
      })
      await this.generateFileSummary(fileId, parseResult.fullText, llmConfig.providerId, llmConfig.modelId, llmClient, searchEngine, signal)

      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: 0, total: 0, message: '已取消', fileId, fileName: file.file_name })
        return { success: false, error: 'ABORTED' }
      }

      // 13. 重新生成新段落的向量嵌入
      onProgress?.({
        phase: 'embedding',
        current: 0,
        total: savedNewParas.length,
        message: `向量嵌入: ${file.file_name}`,
        fileId,
        fileName: file.file_name,
        startedAt: Math.floor(Date.now() / 1000),
      })
      await this.generateEmbeddingsForFile(fileId, llmConfig.providerId)

      onProgress?.({ phase: 'done', current: 0, total: 0, message: '重新生成完成', fileId, fileName: file.file_name })
      return { success: true }
    } catch (err: any) {
      logger.error(`Failed to regenerate file paragraph for ${fileId}:`, err)
      const errMsg = err?.message || 'UNKNOWN'
      if (errMsg.includes('MissingParameter') || errMsg.includes('model')) {
        return { success: false, error: 'MODEL_NOT_CONFIGURED' }
      }
      return { success: false, error: errMsg }
    } finally {
      this.abortController = null
    }
  }

  /**
   * 取消文件段落增量重新生成（与取消索引共用同一 AbortController）
   */
  cancelFileParagraphRegenerate(): void {
    this.abortController?.abort()
    this.abortController = null
  }

  /**
   * 为单个文件的索引条目生成向量嵌入
   */
  private async generateEmbeddingsForFile(fileId: string, chatProviderId: string): Promise<{ error?: string }> {
    try {
      // 优先使用 KMS Embedding 配置
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
          for (let j = 0; j < batch.length && j < embeddings.length; j++) {
            searchEngine.storeEmbedding(
              batch[j].source_type,
              batch[j].source_id,
              batch[j].file_id,
              embeddings[j],
              providerId
            )
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

export default KMSIndexManagerService
