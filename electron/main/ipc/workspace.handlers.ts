import { shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  WorkspaceOpenInExplorerParams,
} from '../../shared/ipc-channels'
import { safeHandle } from './_shared'
import WorkspaceManagerService from '../services/workspace-manager.service'

export function registerWorkspaceHandlers() {
  safeHandle(IPC_CHANNELS.WORKSPACE_OPEN_IN_EXPLORER, async (params: WorkspaceOpenInExplorerParams) => {
    // shell.openPath 返回错误字符串（空字符串表示成功），需 await 并转换为统一协议
    const errMsg = await shell.openPath(params.path)
    return { success: !errMsg, error: errMsg || undefined }
  })

  // 删除任务工作区目录（移至回收站，含安全校验，路径必须位于数据目录 employees/ 下）
  safeHandle(IPC_CHANNELS.WORKSPACE_DELETE_TASK_DIR, (path: string) => {
    const ok = WorkspaceManagerService.getInstance().deleteTaskWorkspace(path)
    return { success: ok, error: ok ? undefined : '目录删除失败或不在合法工作区范围内' }
  })
}
