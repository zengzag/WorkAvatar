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
  addLineNumbers,
  deduplicateTocEntries,
  validateTocEntries,
  buildTocContext,
  identifyParagraphsFromLLMToc,
  filterTocByContentVolume,
  buildTocWithPath,
  TOC_CHUNK_LINES,
  TOC_OVERLAP_LINES,
  MIN_CONTENT_WORDS,
  type LLMTocEntry,
  type ValidatedTocEntry,
} from './kms-paragraph-processor'
import { callLLMForJSON } from './kms-llm-helpers'

const logger = createLogger('KMS-Index')

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
  fileId?: string
  fileName?: string
  collectionId?: string
  collectionName?: string
  startedAt?: number
  cancelled?: boolean
}

export type ProgressCallback = (progress: IndexProgress) => void

export interface AutoIndexConfig {
  enabled: boolean
  intervalMinutes: number
  stableThresholdSeconds: number
}

export interface AutoIndexStatus {
  running: boolean
  config: AutoIndexConfig
  lastRunAt: number | null
  nextRunAt: number | null
  lastResult: { newFiles: number; modifiedFiles: number; deletedFiles: number; skippedUnstableFiles: number } | null
}

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

  async buildFullIndex(providerId?: string, onProgress?: ProgressCallback, withEmbedding: boolean = true): Promise<void> {
    return this.runIndexPipeline('full', onProgress, { providerId, withEmbedding })
  }

  async incrementalIndex(providerId?: string, onProgress?: ProgressCallback, withEmbedding: boolean = true): Promise<void> {
    return this.runIndexPipeline('incremental', onProgress, { providerId, withEmbedding })
  }

  async rebuildDirIndex(dirId: string, providerId?: string, onProgress?: ProgressCallback, withEmbedding: boolean = true): Promise<void> {
    return this.runIndexPipeline('rebuild-dir', onProgress, { providerId, withEmbedding, dirId })
  }

  private async runIndexPipeline(
    mode: 'full' | 'incremental' | 'rebuild-dir',
    onProgress?: ProgressCallback,
    options: { providerId?: string; withEmbedding?: boolean; dirId?: string } = {},
  ): Promise<void> {
    const { withEmbedding = true, dirId } = options
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
      onProgress?.({ phase: 'crawling', current: 0, total: 0, message: msgCrawl })
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
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'indexing')
          searchEngine.deleteIndexByFile(file.id)

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

          if (isFull && parseResult.fullText) {
            this.saveLightSummary(file.id, file.fileName, parseResult.fullText)
          }
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
      }

      if (!signal.aborted && withEmbedding) {
        await KMSEmbeddingService.getInstance().generateEmbeddings(undefined, onProgress, signal, false)
      }

      if (!signal.aborted && !isRebuildDir) {
        KMSDataTierService.getInstance().evaluateDataTiers()
      }

      if (!signal.aborted && isFull) {
        await this.generateDirSummaries(summaryProviderId, summaryModelId, summaryEnableThinking, llmClient, signal)
      }

      if (signal.aborted) {
        onProgress?.({ phase: 'done', current: processed, total, message: '已取消', cancelled: true })
      } else {
        onProgress?.({ phase: 'done', current: processed, total, message: `${msgDonePrefix}，共处理 ${processed} 个文件` })
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
        return { fileProcessed: 0, summaryGenerated: false, embeddingGenerated: false, error: 'Collection not found' }
      }
      const files = kmsService.listFilesInCollection(collectionId)
      if (files.length === 0) {
        return { fileProcessed: 0, summaryGenerated: false, embeddingGenerated: false, error: 'NO_FILES' }
      }

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

          searchEngine.deleteIndexByFile(file.id)
          searchEngine.indexFileTitle(file.id, file.file_name)
          searchEngine.indexContentParagraphs(file.id, parseResult.fullText, file.file_name)
          this.saveLightSummary(file.id, file.file_name, parseResult.fullText)

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

          KMSCrawlerService.getInstance().updateFileDataTier(file.id, 'hot')
          KMSCrawlerService.getInstance().updateFileStatus(file.id, 'completed')
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

      return { fileProcessed, summaryGenerated, embeddingGenerated }
    } catch (err: any) {
      logger.error('processCollectionDeep failed:', err)
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
        const restoredToc = await this.restoreTocWithLLM(
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
          this.updateParagraphSummaries(fileId, paragraphs, savedParagraphs, paragraphSummaries, searchEngine)
        }
        return paragraphSummaries
      }

      const p = paragraphMap.get(sp.paragraphIndex)
      if (!p) continue

      try {
        const summary = await this.generateParagraphSummary(
          p.content, p.title || fileName, providerId, modelId, llmClient, signal, enableThinking
        )
        paragraphSummaries.push(summary)
      } catch (err: any) {
        if (err?.name === 'AbortError' || signal?.aborted) {
          if (paragraphSummaries.length > 0) {
            this.updateParagraphSummaries(fileId, paragraphs, savedParagraphs, paragraphSummaries, searchEngine)
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

    this.updateParagraphSummaries(fileId, paragraphs, savedParagraphs, paragraphSummaries, searchEngine)
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
        const docSummary = await this.generateDocumentSummaryFromParagraphs(
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
      await this.generateFileSummary(fileId, fullText, providerId, modelId, llmClient, searchEngine, signal, enableThinking)
    }
  }

  private async callLLMForToc(
    numberedContent: string,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    existingTocContext?: string,
    signal?: AbortSignal,
    enableThinking?: boolean,
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

    const parsed = await callLLMForJSON<{ toc: LLMTocEntry[] }>(
      llmClient,
      providerId,
      modelId,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { toc: [] },
      { temperature: 0.1, signal, logSource: 'knowledge_toc', enable_thinking: enableThinking },
    )
    return Array.isArray(parsed.toc) ? parsed.toc : []
  }

  private async restoreTocWithLLM(
    text: string,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
    enableThinking?: boolean,
  ): Promise<ValidatedTocEntry[]> {
    const lines = text.split('\n')

    if (lines.length <= TOC_CHUNK_LINES) {
      const numberedContent = addLineNumbers(text)
      const entries = await this.callLLMForToc(numberedContent, providerId, modelId, llmClient, undefined, signal, enableThinking)
      return validateTocEntries(text, entries)
    }

    const allEntries: LLMTocEntry[] = []
    let startLine = 0
    let chunkIndex = 0

    let totalChunks = 0
    {
      let s = 0
      while (s < lines.length) {
        totalChunks++
        const e = Math.min(s + TOC_CHUNK_LINES, lines.length)
        if (e >= lines.length) break
        s = e - TOC_OVERLAP_LINES
      }
    }

    while (startLine < lines.length) {
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

      const endLine = Math.min(startLine + TOC_CHUNK_LINES, lines.length)
      const chunkLines = lines.slice(startLine, endLine)
      const numberedContent = addLineNumbers(chunkLines.join('\n'), startLine + 1)

      const existingTocContext = buildTocContext(allEntries)

      onProgress?.({
        phase: 'toc',
        current: chunkIndex + 1,
        total: totalChunks,
        message: `LLM目录分析: 第${chunkIndex + 1}/${totalChunks}块 (行${startLine + 1}-${endLine})`,
        startedAt: Math.floor(Date.now() / 1000),
      })

      const entries = await this.callLLMForToc(numberedContent, providerId, modelId, llmClient, existingTocContext, signal, enableThinking)
      allEntries.push(...entries)

      chunkIndex++
      if (endLine >= lines.length) break
      startLine = endLine - TOC_OVERLAP_LINES
    }

    const deduplicated = deduplicateTocEntries(allEntries)
    const validated = validateTocEntries(text, deduplicated)

    return validated
  }

  private async generateParagraphSummary(
    paragraphContent: string,
    paragraphTitle: string,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    signal?: AbortSignal,
    enableThinking?: boolean,
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

    return callLLMForJSON<{ title: string; summary: string; keywords: string[] }>(
      llmClient,
      providerId,
      modelId,
      [
        { role: 'system', content: 'You are a professional knowledge engineer. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ],
      { title: paragraphTitle, summary: '', keywords: [] },
      {
        signal,
        logSource: 'knowledge_paragraph_summary',
        throwOnError: true,
        enable_thinking: enableThinking,
        errorMessage: (err) => `Paragraph summary generation failed (${paragraphTitle}): ${err instanceof Error ? err.message : 'Unknown error'}`,
      },
    )
  }

  private async generateDocumentSummaryFromParagraphs(
    paragraphSummaries: Array<{ title: string; summary: string; keywords: string[] }>,
    documentTitle: string,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    signal?: AbortSignal,
    enableThinking?: boolean,
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

    return callLLMForJSON<{ summary: string; keywords: string[]; mainTopics: string[] }>(
      llmClient,
      providerId,
      modelId,
      [
        { role: 'system', content: 'You are a professional knowledge engineer. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ],
      { summary: '', keywords: [], mainTopics: [] },
      {
        signal,
        logSource: 'knowledge_document_summary',
        throwOnError: true,
        enable_thinking: enableThinking,
        errorMessage: (err) => `Document summary generation failed (${documentTitle}): ${err instanceof Error ? err.message : 'Unknown error'}`,
      },
    )
  }

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

      searchEngine.updateParagraphSummary(paraId, summary.summary, summary.keywords)

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

  private async generateFileSummary(
    fileId: string,
    fullText: string,
    providerId: string,
    modelId: string | undefined,
    llmClient: LLMClientService,
    searchEngine: KMSSearchEngineService,
    signal?: AbortSignal,
    enableThinking?: boolean,
  ): Promise<void> {
    if (!modelId) {
      throw new Error('MODEL_NOT_CONFIGURED')
    }
    const truncatedText = fullText.substring(0, 3000)
    const summaryPrompt = `请为以下文档内容生成简洁摘要（150字以内），并提取5-8个关键词和3-5个主要主题。\n\n文档内容：\n${truncatedText}\n\n请以JSON格式返回：{"summary": "...", "keywords": ["..."], "main_topics": ["..."]}`

    if (signal?.aborted) return

    const parsed = await callLLMForJSON<{ summary: string; keywords: string[]; main_topics: string[] }>(
      llmClient,
      providerId,
      modelId,
      [
        { role: 'system', content: '你是一个文档摘要助手。请严格按照JSON格式返回结果。' },
        { role: 'user', content: summaryPrompt },
      ],
      { summary: '', keywords: [], main_topics: [] },
      { temperature: 0.1, maxTokens: 500, signal, enable_thinking: enableThinking },
    )

    if (signal?.aborted) return

    const summary = parsed.summary || ''
    const keywords = parsed.keywords || []
    const mainTopics = parsed.main_topics || []

    this.saveFileSummary(fileId, summary, keywords, mainTopics)
    searchEngine.indexFileSummary(fileId, summary, keywords)
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

          const fileList = files.map(f => {
            const summary = f.summary || f.light_summary || ''
            return `- ${f.file_name} (${f.file_ext || '无扩展名'}, ${this.formatSize(f.file_size)})${summary ? ': ' + summary.substring(0, 80) : ''}`
          }).join('\n')

          let dirSummary: string
          let keywords: string[] = []

          if (providerId && modelId && files.length <= 100) {
            const prompt = `请为以下目录生成简洁摘要（200字以内），概括目录内容主题和结构，并提取5-10个关键词。

目录路径：${dir.dir_path}
文件数量：${files.length}
文件清单：
${fileList}

请以JSON格式返回：{"summary": "...", "keywords": ["..."]}`

            try {
              const parsed = await callLLMForJSON<{ summary: string; keywords: string[] }>(
                llmClient,
                providerId,
                modelId,
                [
                  { role: 'system', content: '你是一个目录内容摘要助手，输出简洁准确的JSON。' },
                  { role: 'user', content: prompt },
                ],
                { summary: '', keywords: [] },
                { temperature: 0.1, maxTokens: 400, signal, logSource: 'kms_dir_summary', enable_thinking: enableThinking },
              )
              dirSummary = parsed.summary || ''
              keywords = parsed.keywords || []
              if (!dirSummary) {
                dirSummary = this.generateSimpleDirSummary(files)
              }
            } catch {
              dirSummary = this.generateSimpleDirSummary(files)
            }
          } else {
            dirSummary = this.generateSimpleDirSummary(files)
          }

          this.saveDirSummary(dir.id, dir.dir_path, dirSummary, files.length, keywords)
        } catch (err) {
          logger.warn(`Failed to generate dir summary for ${dir.dir_path}:`, err)
        }
      }
    } catch (err) {
      logger.warn('Failed to generate dir summaries:', err)
    }
  }

  private generateSimpleDirSummary(files: any[]): string {
    const extCount: Record<string, number> = {}
    for (const f of files) {
      const ext = f.file_ext || '其他'
      extCount[ext] = (extCount[ext] || 0) + 1
    }
    const extList = Object.entries(extCount)
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => `${ext}(${count})`)
      .join(', ')

    const sampleFiles = files.slice(0, 10).map(f => f.file_name).join(', ')
    return `目录包含 ${files.length} 个文件（${extList}）。代表文件：${sampleFiles}`
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

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
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
          const parsed = await callLLMForJSON<{ summary: string; keywords: string[] }>(
            llmClient,
            llmConfig.providerId,
            modelId,
            [
              { role: 'system', content: '你是一个目录内容摘要助手，输出简洁准确的JSON。' },
              { role: 'user', content: prompt },
            ],
            { summary: '', keywords: [] },
            { temperature: 0.1, maxTokens: 400, logSource: 'kms_dir_summary_manual', enable_thinking: llmConfig.enableThinking },
          )
          dirSummary = parsed.summary || ''
          keywords = parsed.keywords || []
          if (!dirSummary) {
            dirSummary = this.generateSimpleDirSummary(files)
          }
        } catch {
          dirSummary = this.generateSimpleDirSummary(files)
        }
      } else {
        dirSummary = this.generateSimpleDirSummary(files)
      }

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
