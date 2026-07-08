import { shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  WorkspaceOpenInExplorerParams,
} from '../../shared/ipc-channels'
import { safeHandle } from './_shared'

export function registerWorkspaceHandlers() {
  safeHandle(IPC_CHANNELS.WORKSPACE_OPEN_IN_EXPLORER, async (params: WorkspaceOpenInExplorerParams) => {
    // shell.openPath 返回错误字符串（空字符串表示成功），需 await 并转换为统一协议
    const errMsg = await shell.openPath(params.path)
    return { success: !errMsg, error: errMsg || undefined }
  })
}
