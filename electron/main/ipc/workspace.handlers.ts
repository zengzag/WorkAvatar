import { shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  WorkspaceOpenInExplorerParams,
} from '../../shared/ipc-channels'
import { safeHandle } from './_shared'

export function registerWorkspaceHandlers() {
  safeHandle(IPC_CHANNELS.WORKSPACE_OPEN_IN_EXPLORER, (params: WorkspaceOpenInExplorerParams) => {
    shell.openPath(params.path)
    return { success: true }
  })
}
