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

  // AI 智能检索（带实时进度推送）
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
          } catch {}
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
  ipcMain.on(IPC_CHANNELS.KMS_BUILD_INDEX, (_event, providerId?: string, withEmbedding: boolean = true) => {
    logger.info(`Build index requested (withEmbedding=${withEmbedding})`)
    kmsService.buildFullIndex(providerId, withEmbedding).catch((err: any) => {
      logger.error('buildFullIndex failed:', String(err?.message || err))
    })
  })

  ipcMain.on(IPC_CHANNELS.KMS_INCREMENTAL_INDEX, (_event, providerId?: string, withEmbedding: boolean = true) => {
    logger.info(`Incremental index requested (withEmbedding=${withEmbedding})`)
    kmsService.incrementalIndex(providerId, withEmbedding).catch((err: any) => {
      logger.error('incrementalIndex failed:', String(err?.message || err))
    })
  })

  ipcMain.on(IPC_CHANNELS.KMS_REBUILD_DIR_INDEX, (_event, dirId: string, providerId?: string, withEmbedding: boolean = true) => {
    logger.info(`Rebuild dir index requested: ${dirId} (withEmbedding=${withEmbedding})`)
    kmsService.rebuildDirIndex(dirId, providerId, withEmbedding).catch((err: any) => {
      logger.error('rebuildDirIndex failed:', String(err?.message || err))
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
      logger.error('runAutoIndexCheckNow failed:', String(err?.message || err))
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
  ipcMain.on(IPC_CHANNELS.KMS_PROCESS_COLLECTION_DEEP, (_event, collectionId: string) => {
    logger.info('Process collection deep requested:', collectionId)
    kmsService.processCollectionDeep(collectionId).catch((err: any) => {
      logger.error('processCollectionDeep failed:', String(err?.message || err))
    })
  })

  ipcMain.on(IPC_CHANNELS.KMS_CANCEL_COLLECTION_DEEP, () => {
    logger.info('Cancel collection deep process requested')
    kmsService.cancelCollectionDeepProcess()
  })

  // 从指定段落开始重新切分/摘要/向量化，保留前半部分段落不变
  // 进度通过 KMS_INDEX_PROGRESS 通道推送（含 fileId/fileName，不含 collectionId）
  ipcMain.on(IPC_CHANNELS.KMS_REGENERATE_FILE_PARAGRAPH, (_event, params: { fileId: string; paragraphId: string }) => {
    logger.info('Regenerate file paragraph requested:', params)
    kmsService.regenerateFileParagraph(params.fileId, params.paragraphId).catch((err: any) => {
      logger.error('regenerateFileParagraph failed:', String(err?.message || err))
    })
  })

  ipcMain.on(IPC_CHANNELS.KMS_CANCEL_REGENERATE_FILE_PARAGRAPH, () => {
    logger.info('Cancel regenerate file paragraph requested')
    kmsService.cancelFileParagraphRegenerate()
  })

  safeHandle(IPC_CHANNELS.KMS_GENERATE_DIR_SUMMARY, async (dirId: string) => {
    return kmsService.generateDirSummaryManual(dirId)
  })

  safeHandle(IPC_CHANNELS.KMS_GENERATE_FILE_SUMMARY, async (fileId: string) => {
    return kmsService.generateFileSummaryManual(fileId)
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
}
