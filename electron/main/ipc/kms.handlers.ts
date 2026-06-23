import { ipcMain, BrowserWindow, shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  KMSAddDirParams,
  KMSUpdateDirParams,
  KMSSearchParams,
  KMSAgentSearchParams,
  KMSGetFileContentParams,
  KMSMCPSetConfigParams,
} from '../../shared/ipc-channels'
import KMSService from '../services/kms/kms.service'
import KMSMCPService from '../services/kms/kms-mcp.service'
import type { IndexProgress } from '../services/kms/kms-index-manager.service'
import { createLogger } from '../services/logger'

const logger = createLogger('KMS-Handler')

/**
 * 安全执行IPC handler，捕获错误并返回可序列化的结果
 * 避免Error对象中的不可序列化属性导致 "An object could not be cloned" 错误
 */
function safeHandle(channel: string, handler: (...args: any[]) => Promise<any>): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const result = await handler(...args)
      // 深度净化：确保返回值只包含可结构化克隆的简单类型
      return JSON.parse(JSON.stringify(result))
    } catch (err: any) {
      logger.error(`IPC handler error [${channel}]:`, err?.message || err)
      // 返回纯字符串错误信息，避免Error对象不可克隆
      return { error: String(err?.message || err) }
    }
  })
}

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
    })
  })

  // AI 智能检索（子智能体）
  safeHandle(IPC_CHANNELS.KMS_AGENT_SEARCH, async (params: KMSAgentSearchParams) => {
    return kmsService.agentSearch(params.query, {
      maxRounds: params.maxRounds,
      topK: params.topK,
      dirIds: params.dirIds,
      fileExtensions: params.fileExtensions,
      timeRangeStart: params.timeRangeStart,
      timeRangeEnd: params.timeRangeEnd,
    })
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
  ipcMain.on(IPC_CHANNELS.KMS_BUILD_INDEX, (_event, providerId?: string) => {
    logger.info('Build index requested')
    kmsService.buildFullIndex(providerId).catch((err: any) => {
      logger.error('buildFullIndex failed:', String(err?.message || err))
    })
  })

  ipcMain.on(IPC_CHANNELS.KMS_INCREMENTAL_INDEX, (_event, providerId?: string) => {
    logger.info('Incremental index requested')
    kmsService.incrementalIndex(providerId).catch((err: any) => {
      logger.error('incrementalIndex failed:', String(err?.message || err))
    })
  })

  ipcMain.on(IPC_CHANNELS.KMS_REBUILD_DIR_INDEX, (_event, dirId: string, providerId?: string) => {
    logger.info('Rebuild dir index requested:', dirId)
    kmsService.rebuildDirIndex(dirId, providerId).catch((err: any) => {
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
      })
    }
  })

  // ==================== KMS MCP 服务 ====================
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
