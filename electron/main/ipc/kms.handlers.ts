import { ipcMain, BrowserWindow, shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  KMSAddDirParams,
  KMSUpdateDirParams,
  KMSSearchParams,
  KMSAgentSearchParams,
  KMSGetFileContentParams,
  KMSMCPSetConfigParams,
  KMSGetFileSummariesParams,
  KMSSetSettingsParams,
  KMSRecordSearchHistoryParams,
  KMSGetSearchHistoryParams,
  KMSCreateCollectionParams,
  KMSUpdateCollectionParams,
  KMSAddFileToCollectionParams,
  KMSAddFilesToCollectionParams,
  KMSRemoveFileFromCollectionParams,
  KMSSetCollectionSummaryParams,
  KMSSearchFilesParams,
  KMSGetKnowledgeCardsParams,
  KMSUpdateKnowledgeCardParams,
  KMSSearchKnowledgeCardsParams,
} from '../../shared/ipc-channels'
import KMSService from '../services/kms/kms.service'
import KMSMCPService from '../services/kms/kms-mcp.service'
import type { IndexProgress } from '../services/kms/kms-index-manager.service'
import { createLogger } from '../services/logger'
import { safeHandle } from './_shared'

const logger = createLogger('KMS-Handler')

export function registerKMSHandlers(): void {
  const kmsService = KMSService.getInstance()
  const kmsMcpService = KMSMCPService.getInstance()

  // 索引目录管理
  safeHandle(IPC_CHANNELS.KMS_LIST_DIRS, async () => {
    return kmsService.listIndexDirs()
  })

  safeHandle(IPC_CHANNELS.KMS_ADD_DIR, async (params: KMSAddDirParams) => {
    return kmsService.addIndexDir(params.dirPath, params.displayName, params.recursive, params.fileExtensions)
  })

  safeHandle(IPC_CHANNELS.KMS_UPDATE_DIR, async (params: KMSUpdateDirParams) => {
    return kmsService.updateIndexDir(params.id, params)
  })

  safeHandle(IPC_CHANNELS.KMS_DELETE_DIR, async (id: string) => {
    kmsService.deleteIndexDir(id)
    return { success: true }
  })

  // 搜索
  safeHandle(IPC_CHANNELS.KMS_SEARCH, async (params: KMSSearchParams) => {
    return kmsService.search(params.query, {
      topK: params.topK,
      fileIds: params.fileIds,
      sourceTypes: params.sourceTypes as any[],
      useSemantic: params.useSemantic,
      timeRangeStart: params.timeRangeStart,
      timeRangeEnd: params.timeRangeEnd,
      fileExtensions: params.fileExtensions,
      collectionIds: params.collectionIds,
      dirIds: params.dirIds,
    })
  })

  // 文件搜索（按文件名匹配）
  safeHandle(IPC_CHANNELS.KMS_SEARCH_FILES, async (params: KMSSearchFilesParams) => {
    return kmsService.searchFiles(params.query, {
      dirIds: params.dirIds,
      collectionIds: params.collectionIds,
      fileExtensions: params.fileExtensions,
      timeRangeStart: params.timeRangeStart,
      timeRangeEnd: params.timeRangeEnd,
    })
  })

  // AI 智能检索（带实时进度推送）
  // 注意：此处未使用 safeHandle，因为需要透传 event 用于进度推送；
  // 同时需要在内部对 result 做序列化净化（与 safeHandle 行为一致）
  ipcMain.handle(IPC_CHANNELS.KMS_AGENT_SEARCH, async (event, params: KMSAgentSearchParams) => {
    try {
      const sender = event.sender
      const result = await kmsService.agentSearch(params.query, {
        maxRounds: params.maxRounds,
        topK: params.topK,
        dirIds: params.dirIds,
        collectionIds: params.collectionIds,
        fileExtensions: params.fileExtensions,
        timeRangeStart: params.timeRangeStart,
        timeRangeEnd: params.timeRangeEnd,
        onProgress: (step) => {
          try {
            if (!sender.isDestroyed()) {
              sender.send(IPC_CHANNELS.KMS_AGENT_SEARCH_PROGRESS, step)
            }
          } catch (e) {
            /* 进度推送失败忽略，避免阻塞搜索流程 */
          }
        },
      })
      return JSON.parse(JSON.stringify(result))
    } catch (err: any) {
      logger.error(`IPC handler error [KMS_AGENT_SEARCH]:`, err?.message || err)
      return { error: err?.message || 'Unknown error' }
    }
  })

  // 文件内容
  safeHandle(IPC_CHANNELS.KMS_GET_FILE_CONTENT, async (params: KMSGetFileContentParams) => {
    return kmsService.getFileContent(params.fileId, {
      paragraphId: params.paragraphId,
      startOffset: params.startOffset,
      endOffset: params.endOffset,
      startLine: params.startLine,
      maxChars: params.maxChars,
    })
  })

  // 文件摘要
  safeHandle(IPC_CHANNELS.KMS_GET_FILE_SUMMARY, async (fileId: string) => {
    return kmsService.getFileSummary(fileId)
  })

  // 索引管理 — 使用 ipcMain.on (fire-and-forget)，通过进度事件通知结果
  // 不使用 ipcMain.handle 避免返回值序列化问题
  // 第二个参数 withEmbedding（默认 true）控制是否同步生成向量嵌入（智能索引）
  // 用 Promise.resolve().then() 包裹，确保同步抛错也能被 catch 捕获，避免异常逃逸
  // catch 中必须推送 error 进度，否则 release 下失败被静默吞掉、UI 永久卡在"索引中"
  ipcMain.on(IPC_CHANNELS.KMS_BUILD_INDEX, (_event, providerId?: string, withEmbedding: boolean = true, resetHotData: boolean = false) => {
    logger.info(`Build index requested (withEmbedding=${withEmbedding}, resetHot=${resetHotData})`)
    Promise.resolve()
      .then(() => kmsService.buildFullIndex(providerId, withEmbedding, resetHotData))
      .catch((err: any) => {
        const msg = String(err?.message || err)
        logger.error('buildFullIndex failed:', msg)
        kmsService.notifyIndexError(msg)
      })
  })

  ipcMain.on(IPC_CHANNELS.KMS_INCREMENTAL_INDEX, (_event, providerId?: string, withEmbedding: boolean = true) => {
    logger.info(`Incremental index requested (withEmbedding=${withEmbedding})`)
    Promise.resolve()
      .then(() => kmsService.incrementalIndex(providerId, withEmbedding))
      .catch((err: any) => {
        const msg = String(err?.message || err)
        logger.error('incrementalIndex failed:', msg)
        kmsService.notifyIndexError(msg)
      })
  })

  ipcMain.on(IPC_CHANNELS.KMS_REBUILD_DIR_INDEX, (_event, dirId: string, providerId?: string, withEmbedding: boolean = true, resetHotData: boolean = false) => {
    logger.info(`Rebuild dir index requested: ${dirId} (withEmbedding=${withEmbedding}, resetHot=${resetHotData})`)
    Promise.resolve()
      .then(() => kmsService.rebuildDirIndex(dirId, providerId, withEmbedding, resetHotData))
      .catch((err: any) => {
        const msg = String(err?.message || err)
        logger.error('rebuildDirIndex failed:', msg)
        kmsService.notifyIndexError(msg)
      })
  })

  ipcMain.on(IPC_CHANNELS.KMS_CANCEL_INDEX, () => {
    logger.info('Cancel index requested')
    kmsService.cancelIndexing()
  })

  // 统计
  safeHandle(IPC_CHANNELS.KMS_GET_STATS, async () => {
    return kmsService.getStats()
  })

  // 数据库清理：获取占用统计（主库/向量库大小 + 残留数据条数）
  safeHandle(IPC_CHANNELS.KMS_GET_DATABASE_STATS, async () => {
    return kmsService.getDatabaseStats()
  })

  // 数据库清理：删除残留索引数据 + VACUUM 回收磁盘空间
  safeHandle(IPC_CHANNELS.KMS_CLEANUP_DATABASE, async () => {
    return kmsService.cleanupDatabase()
  })

  // 打开文件（使用系统默认程序）
  safeHandle(IPC_CHANNELS.KMS_OPEN_FILE, async (filePath: string) => {
    const result = await shell.openPath(filePath)
    if (result) {
      return { error: result }
    }
    return { success: true }
  })

  // 打开文件所在目录
  safeHandle(IPC_CHANNELS.KMS_OPEN_FILE_DIR, async (filePath: string) => {
    shell.showItemInFolder(filePath)
    return { success: true }
  })

  // 获取文件完整文本内容（用于预览）
  safeHandle(IPC_CHANNELS.KMS_GET_FILE_FULL_CONTENT, async (fileId: string) => {
    return kmsService.getFileFullContent(fileId)
  })

  // 进度通知（主进程 → 渲染进程）
  kmsService.onProgress((progress: IndexProgress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.KMS_INDEX_PROGRESS, {
        phase: progress.phase,
        current: progress.current,
        total: progress.total,
        message: progress.message,
        fileId: progress.fileId,
        fileName: progress.fileName,
        collectionId: progress.collectionId,
        collectionName: progress.collectionName,
        startedAt: progress.startedAt,
      })
    }
  })

  safeHandle(IPC_CHANNELS.KMS_GET_SETTINGS, async () => {
    return kmsService.getKmsSettings()
  })

  safeHandle(IPC_CHANNELS.KMS_SET_SETTINGS, async (params: KMSSetSettingsParams) => {
    kmsService.setKmsSettings(params)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.KMS_GET_AUTO_INDEX_STATUS, async () => {
    return kmsService.getAutoIndexStatus()
  })

  safeHandle(IPC_CHANNELS.KMS_RUN_AUTO_INDEX_CHECK, async () => {
    kmsService.runAutoIndexCheckNow().catch((err: any) => {
      const msg = String(err?.message || err)
      logger.error('runAutoIndexCheckNow failed:', msg)
      // 推送 error 进度，避免 release 下失败被静默吞掉、前端无反馈
      kmsService.notifyIndexError(msg)
    })
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.KMS_GET_DIR_SUMMARIES, async () => {
    return kmsService.getDirSummaries()
  })

  safeHandle(IPC_CHANNELS.KMS_GET_FILE_SUMMARIES, async (params: KMSGetFileSummariesParams) => {
    return kmsService.getFileSummaries(params)
  })

  // 文件内容浏览（段落、TOC）
  safeHandle(IPC_CHANNELS.KMS_GET_FILE_PARAGRAPHS, async (fileId: string) => {
    return kmsService.getFileParagraphs(fileId)
  })

  safeHandle(IPC_CHANNELS.KMS_GET_FILE_TOC, async (fileId: string) => {
    return kmsService.getFileToc(fileId)
  })

  safeHandle(IPC_CHANNELS.KMS_GET_PARAGRAPH_CONTENT, async (paragraphId: string) => {
    return kmsService.getParagraphContent(paragraphId)
  })

  safeHandle(IPC_CHANNELS.KMS_RECORD_SEARCH_HISTORY, async (params: KMSRecordSearchHistoryParams) => {
    kmsService.recordSearchHistory(params)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.KMS_GET_SEARCH_HISTORY, async (params: KMSGetSearchHistoryParams) => {
    return kmsService.getSearchHistory(params)
  })

  safeHandle(IPC_CHANNELS.KMS_CLEAR_SEARCH_HISTORY, async (searchMode?: string) => {
    kmsService.clearSearchHistory(searchMode)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.KMS_DELETE_SEARCH_HISTORY, async (id: string) => {
    kmsService.deleteSearchHistory(id)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.KMS_LIST_COLLECTIONS, async () => {
    return kmsService.listCollections()
  })

  safeHandle(IPC_CHANNELS.KMS_CREATE_COLLECTION, async (params: KMSCreateCollectionParams) => {
    return kmsService.createCollection(params.name, params.description || '')
  })

  safeHandle(IPC_CHANNELS.KMS_UPDATE_COLLECTION, async (params: KMSUpdateCollectionParams) => {
    return kmsService.updateCollection(params.id, params)
  })

  safeHandle(IPC_CHANNELS.KMS_DELETE_COLLECTION, async (id: string) => {
    kmsService.deleteCollection(id)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.KMS_GET_COLLECTION, async (id: string) => {
    return kmsService.getCollection(id)
  })

  safeHandle(IPC_CHANNELS.KMS_ADD_FILE_TO_COLLECTION, async (params: KMSAddFileToCollectionParams) => {
    return kmsService.addFileToCollection(params.collectionId, params.filePath)
  })

  safeHandle(IPC_CHANNELS.KMS_ADD_FILES_TO_COLLECTION, async (params: KMSAddFilesToCollectionParams) => {
    return kmsService.addFilesToCollection(params.collectionId, params.filePaths)
  })

  safeHandle(IPC_CHANNELS.KMS_REMOVE_FILE_FROM_COLLECTION, async (params: KMSRemoveFileFromCollectionParams) => {
    kmsService.removeFileFromCollection(params.collectionId, params.fileId)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.KMS_LIST_FILES_IN_COLLECTION, async (collectionId: string) => {
    return kmsService.listFilesInCollection(collectionId)
  })

  safeHandle(IPC_CHANNELS.KMS_GET_COLLECTION_STATS, async (collectionId: string) => {
    return kmsService.getCollectionStats(collectionId)
  })

  safeHandle(IPC_CHANNELS.KMS_GET_COLLECTION_SUMMARY, async (collectionId: string) => {
    return kmsService.getCollectionSummary(collectionId)
  })

  safeHandle(IPC_CHANNELS.KMS_SET_COLLECTION_SUMMARY, async (params: KMSSetCollectionSummaryParams) => {
    kmsService.setCollectionSummary(params.collectionId, params.summary, params.keyTopics || [])
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.KMS_DELETE_COLLECTION_SUMMARY, async (collectionId: string) => {
    kmsService.deleteCollectionSummary(collectionId)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.KMS_GENERATE_COLLECTION_SUMMARY, async (collectionId: string) => {
    return kmsService.generateCollectionSummary(collectionId)
  })

  safeHandle(IPC_CHANNELS.KMS_SCAN_DIR_FILES, async (params: { dirPath: string; extensions?: string[] }) => {
    return kmsService.scanDirFiles(params.dirPath, params.extensions)
  })

  // 触发合集深度处理，进度通过 KMS_INDEX_PROGRESS 通道推送（含 collectionId/collectionName 字段）
  // 第二个参数 incremental（默认 true）控制是否增量处理（跳过已深度处理的文件）
  ipcMain.on(IPC_CHANNELS.KMS_PROCESS_COLLECTION_DEEP, (_event, collectionId: string, incremental: boolean = true) => {
    logger.info(`Process collection deep requested: ${collectionId} (incremental=${incremental})`)
    Promise.resolve()
      .then(() => kmsService.processCollectionDeep(collectionId, incremental))
      .catch((err: any) => {
        const msg = String(err?.message || err)
        logger.error('processCollectionDeep failed:', msg)
        kmsService.notifyIndexError(msg, { collectionId })
      })
  })

  // 单文件深度处理（合集文件列表中的"深度处理"按钮）
  ipcMain.on(IPC_CHANNELS.KMS_PROCESS_FILE_DEEP, (_event, fileId: string, collectionId?: string) => {
    logger.info(`Process single file deep requested: ${fileId}${collectionId ? ` (collection=${collectionId})` : ''}`)
    Promise.resolve()
      .then(() => kmsService.processSingleFileDeep(fileId, collectionId))
      .catch((err: any) => {
        const msg = String(err?.message || err)
        logger.error('processSingleFileDeep failed:', msg)
        const extras = collectionId ? { collectionId } : {}
        kmsService.notifyIndexError(msg, extras)
      })
  })

  ipcMain.on(IPC_CHANNELS.KMS_CANCEL_COLLECTION_DEEP, () => {
    logger.info('Cancel collection deep process requested')
    kmsService.cancelCollectionDeepProcess()
  })

  safeHandle(IPC_CHANNELS.KMS_GENERATE_DIR_SUMMARY, async (dirId: string) => {
    return kmsService.generateDirSummaryManual(dirId)
  })

  safeHandle(IPC_CHANNELS.KMS_GENERATE_FILE_SUMMARY, async (fileId: string) => {
    return kmsService.generateFileSummaryManual(fileId)
  })

  safeHandle(IPC_CHANNELS.KMS_REBUILD_FILE_INDEX, async (fileId: string) => {
    return kmsService.rebuildFileIndex(fileId)
  })

  safeHandle(IPC_CHANNELS.KMS_MCP_START, async () => {
    return kmsMcpService.start()
  })

  safeHandle(IPC_CHANNELS.KMS_MCP_STOP, async () => {
    return kmsMcpService.stop()
  })

  safeHandle(IPC_CHANNELS.KMS_MCP_GET_STATUS, async () => {
    return kmsMcpService.getStatus()
  })

  safeHandle(IPC_CHANNELS.KMS_MCP_GET_CONFIG, async () => {
    return kmsMcpService.getConfig()
  })

  safeHandle(IPC_CHANNELS.KMS_MCP_SET_CONFIG, async (params: KMSMCPSetConfigParams) => {
    kmsMcpService.updateConfig(params)
    return { success: true }
  })

  // ==================== 知识卡片 ====================
  safeHandle(IPC_CHANNELS.KMS_GET_KEYWORD_STATS, async (params?: { limit?: number; minCount?: number; recentDays?: number }) => {
    return kmsService.getKeywordStats(params || {})
  })

  safeHandle(IPC_CHANNELS.KMS_GET_KNOWLEDGE_CARDS, async (params: KMSGetKnowledgeCardsParams) => {
    return kmsService.getKnowledgeCards(params)
  })

  safeHandle(IPC_CHANNELS.KMS_GET_KNOWLEDGE_CARD, async (id: string) => {
    return kmsService.getKnowledgeCard(id)
  })

  ipcMain.handle(IPC_CHANNELS.KMS_GENERATE_KNOWLEDGE_CARD, async (event, keyword: string) => {
    try {
      const sender = event.sender
      const result = await kmsService.generateKnowledgeCard(keyword, undefined, {
        onProgress: (step) => {
          try { if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.KMS_KNOWLEDGE_CARD_PROGRESS, step) } catch (e) { /* ignore */ }
        },
      })
      try { return structuredClone(result) } catch { return JSON.parse(JSON.stringify(result)) }
    } catch (err: any) {
      logger.error(`IPC handler error [KMS_GENERATE_KNOWLEDGE_CARD]:`, err?.message || err)
      return { error: String(err?.message || err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.KMS_REFRESH_KNOWLEDGE_CARD, async (event, id: string) => {
    try {
      const sender = event.sender
      const result = await kmsService.refreshKnowledgeCard(id, undefined, {
        onProgress: (step) => {
          try { if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.KMS_KNOWLEDGE_CARD_PROGRESS, step) } catch (e) { /* ignore */ }
        },
      })
      try { return structuredClone(result) } catch { return JSON.parse(JSON.stringify(result)) }
    } catch (err: any) {
      logger.error(`IPC handler error [KMS_REFRESH_KNOWLEDGE_CARD]:`, err?.message || err)
      return { error: String(err?.message || err) }
    }
  })

  safeHandle(IPC_CHANNELS.KMS_UPDATE_KNOWLEDGE_CARD, async (params: KMSUpdateKnowledgeCardParams) => {
    return kmsService.updateKnowledgeCard(params)
  })

  safeHandle(IPC_CHANNELS.KMS_DELETE_KNOWLEDGE_CARD, async (id: string) => {
    kmsService.deleteKnowledgeCard(id)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.KMS_PIN_KNOWLEDGE_CARD, async (params: { id: string; pinned: boolean }) => {
    kmsService.pinKnowledgeCard(params.id, params.pinned)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.KMS_SEARCH_KNOWLEDGE_CARDS, async (params: KMSSearchKnowledgeCardsParams) => {
    return kmsService.searchKnowledgeCards(params.query, params.topK)
  })
}
