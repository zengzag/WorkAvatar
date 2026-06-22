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

          // 冷数据：仅索引文件名和关键词
          // 热数据：额外生成摘要和段落索引
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

      // 阶段3：生成向量嵌入（如果有provider）
      if (providerId && !signal.aborted) {
        await this.generateEmbeddings(providerId, onProgress, signal)
      }

      // 执行冷热数据评估
      if (!signal.aborted) {
        this.evaluateDataTiers()
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
   * 增量索引（仅处理新增和修改的文件）
   */
  async incrementalIndex(providerId?: string, onProgress?: ProgressCallback): Promise<void> {
    return this.buildFullIndex(providerId, onProgress)
  }

  /**
   * 重建指定目录的索引
   */
  async rebuildDirIndex(dirId: string, providerId?: string, onProgress?: ProgressCallback): Promise<void> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      // 爬取目录
      onProgress?.({ phase: 'crawling', current: 0, total: 0, message: '正在扫描目录...' })
      await KMSCrawlerService.getInstance().crawlDirectory(dirId, signal)

      if (signal.aborted) return

      // 删除该目录下所有旧索引
      const files = KMSCrawlerService.getInstance().getFilesByDir(dirId)
      const searchEngine = KMSSearchEngineService.getInstance()

      for (const file of files) {
        searchEngine.deleteIndexByFile(file.id)
        KMSCrawlerService.getInstance().updateFileStatus(file.id, 'pending')
      }

      // 重新构建
      await this.buildFullIndex(providerId, onProgress)
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
   */
  evaluateDataTiers(): void {
    const crawler = KMSCrawlerService.getInstance()
    const now = Math.floor(Date.now() / 1000)

    // 获取所有热数据文件
    const hotFiles = this.db.prepare("SELECT id FROM kms_files WHERE data_tier = 'hot'").all() as any[]

    // 降级：90天无访问的热数据 → 冷数据
    const coldThreshold = now - COLD_DEMOTE_DAYS * 86400
    for (const file of hotFiles) {
      const stats = crawler.getFileAccessStats(file.id, COLD_DEMOTE_DAYS)
      if (stats.lastAccessed && stats.lastAccessed < coldThreshold) {
        crawler.updateFileDataTier(file.id, 'cold')
        logger.info(`Demoted file ${file.id} from hot to cold (no access in ${COLD_DEMOTE_DAYS} days)`)
      }
    }

    // 获取所有冷数据文件
    const coldFiles = this.db.prepare("SELECT id FROM kms_files WHERE data_tier = 'cold'").all() as any[]

    // 晋升：高频访问的冷数据 → 热数据
    for (const file of coldFiles) {
      const stats = crawler.getFileAccessStats(file.id, HOT_PROMOTE_DAYS)
      if (stats.hitCount >= HOT_PROMOTE_HIT_THRESHOLD || stats.readCount >= HOT_PROMOTE_READ_THRESHOLD) {
        crawler.updateFileDataTier(file.id, 'hot')
        logger.info(`Promoted file ${file.id} from cold to hot (hits: ${stats.hitCount}, reads: ${stats.readCount})`)
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
      // 生成文档摘要
      const truncatedText = fullText.substring(0, 3000)
      const summaryPrompt = `请为以下文档内容生成简洁摘要（150字以内），并提取5-8个关键词和3-5个主要主题。\n\n文档内容：\n${truncatedText}\n\n请以JSON格式返回：{"summary": "...", "keywords": ["..."], "main_topics": ["..."]}`

      const summaryResult = await llmClient.chat(providerId, [
        { role: 'system', content: '你是一个文档摘要助手。请严格按照JSON格式返回结果。' },
        { role: 'user', content: summaryPrompt },
      ], { temperature: 0.1, max_tokens: 500 })

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
}

export default KMSIndexManagerService
