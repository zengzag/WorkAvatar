import { shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  WorkspaceListFilesParams,
  WorkspaceListFilesResult,
  WorkspaceFileEntry,
  WorkspaceOpenInExplorerParams,
} from '../../shared/ipc-channels'
import { safeHandle } from './_shared'
import WorkspaceManagerService from '../services/workspace-manager.service'
import { ensureDir } from '../services/common-utils'

export function registerWorkspaceHandlers() {
  safeHandle(IPC_CHANNELS.WORKSPACE_OPEN_IN_EXPLORER, async (params: WorkspaceOpenInExplorerParams) => {
    // 工作区懒创建：用户显式打开工作区时确保目录存在（任务从未写文件时目录尚未落盘）
    ensureDir(params.path)
    // shell.openPath 返回错误字符串（空字符串表示成功），需 await 并转换为统一协议
    const errMsg = await shell.openPath(params.path)
    return { success: !errMsg, error: errMsg || undefined }
  })

  // 列出任务工作区内某个目录的直接子项（工作区侧边栏文件树）
  safeHandle(IPC_CHANNELS.WORKSPACE_LIST_FILES, async (params: WorkspaceListFilesParams): Promise<WorkspaceListFilesResult> => {
    const target = path.resolve(String(params?.dirPath || ''))
    // 允许 employees/ 下的任务目录，以及用户指定的自定义工作区目录
    if (!WorkspaceManagerService.getInstance().isWithinWorkspaceBoundary(target)) {
      return { success: false, entries: [], error: 'outside' }
    }
    let dirents: fs.Dirent[]
    try {
      dirents = await fs.promises.readdir(target, { withFileTypes: true })
    } catch (error: any) {
      // 懒创建工作区：目录尚未落盘时按空目录处理，而不是报错
      if (error?.code === 'ENOENT') return { success: true, entries: [] }
      return { success: false, entries: [], error: String(error?.message || error) }
    }
    const entries: WorkspaceFileEntry[] = []
    for (const dirent of dirents) {
      const fullPath = path.join(target, dirent.name)
      let size = 0
      let mtime = 0
      try {
        const stat = await fs.promises.stat(fullPath)
        size = stat.size
        mtime = stat.mtimeMs
      } catch { /* 文件在读取间隙被删除：保留条目但不带元数据 */ }
      entries.push({
        name: dirent.name,
        path: fullPath,
        isDirectory: dirent.isDirectory(),
        ext: dirent.isDirectory() ? '' : path.extname(dirent.name).slice(1).toLowerCase(),
        size,
        mtime,
      })
    }
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
    return { success: true, entries }
  })

  // 删除任务工作区目录（移至回收站，含安全校验，路径必须位于数据目录 employees/ 下）
  safeHandle(IPC_CHANNELS.WORKSPACE_DELETE_TASK_DIR, async (path: string) => {
    const ok = await WorkspaceManagerService.getInstance().deleteTaskWorkspace(path)
    return { success: ok, error: ok ? undefined : '目录删除失败或不在合法工作区范围内' }
  })
}
