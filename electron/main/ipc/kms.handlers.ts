import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  KMSAddDirParams,
  KMSUpdateDirParams,
  KMSSearchParams,
  KMSGetFileContentParams,
} from '../../shared/ipc-channels'
import KMSService from '../services/kms/kms.service'
import type { IndexProgress } from '../services/kms/kms-index-manager.service'

export function registerKMSHandlers(): void {
  const kmsService = KMSService.getInstance()

  // 索引目录管理
  ipcMain.handle(IPC_CHANNELS.KMS_LIST_DIRS, async () => {
    return kmsService.listIndexDirs()
  })

  ipcMain.handle(IPC_CHANNELS.KMS_ADD_DIR, async (_event, params: KMSAddDirParams) => {
    return kmsService.addIndexDir(params.dirPath, params.displayName, params.recursive, params.fileExtensions)
  })

  ipcMain.handle(IPC_CHANNELS.KMS_UPDATE_DIR, async (_event, params: KMSUpdateDirParams) => {
    return kmsService.updateIndexDir(params.id, params)
  })

  ipcMain.handle(IPC_CHANNELS.KMS_DELETE_DIR, async (_event, id: string) => {
    kmsService.deleteIndexDir(id)
    return { success: true }
  })

  // 搜索
  ipcMain.handle(IPC_CHANNELS.KMS_SEARCH, async (_event, params: KMSSearchParams) => {
    return kmsService.search(params.query, {
      topK: params.topK,
      fileIds: params.fileIds,
      sourceTypes: params.sourceTypes as any[],
      useSemantic: params.useSemantic,
      timeRangeStart: params.timeRangeStart,
      timeRangeEnd: params.timeRangeEnd,
      fileExtensions: params.fileExtensions,
    })
  })

  // 文件内容
  ipcMain.handle(IPC_CHANNELS.KMS_GET_FILE_CONTENT, async (_event, params: KMSGetFileContentParams) => {
    return kmsService.getFileContent(params.fileId, {
      paragraphId: params.paragraphId,
      startOffset: params.startOffset,
      endOffset: params.endOffset,
      startLine: params.startLine,
      maxChars: params.maxChars,
    })
  })

  // 文件摘要
  ipcMain.handle(IPC_CHANNELS.KMS_GET_FILE_SUMMARY, async (_event, fileId: string) => {
    return kmsService.getFileSummary(fileId)
  })

  // 索引管理
  ipcMain.handle(IPC_CHANNELS.KMS_BUILD_INDEX, async (_event, providerId?: string) => {
    await kmsService.buildFullIndex(providerId)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.KMS_INCREMENTAL_INDEX, async (_event, providerId?: string) => {
    await kmsService.incrementalIndex(providerId)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.KMS_REBUILD_DIR_INDEX, async (_event, dirId: string, providerId?: string) => {
    await kmsService.rebuildDirIndex(dirId, providerId)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.KMS_CANCEL_INDEX, async () => {
    kmsService.cancelIndexing()
    return { success: true }
  })

  // 统计
  ipcMain.handle(IPC_CHANNELS.KMS_GET_STATS, async () => {
    return kmsService.getStats()
  })

  // 进度通知（主进程 → 渲染进程）
  kmsService.onProgress((progress: IndexProgress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.KMS_INDEX_PROGRESS, progress)
    }
  })
}
