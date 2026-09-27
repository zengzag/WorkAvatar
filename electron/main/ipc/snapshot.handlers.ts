import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { SnapshotListParams, SnapshotRevertParams } from '../../shared/ipc-channels'
import FileSnapshotService from '../services/file-snapshot.service'
import { safeHandle } from './_shared'

export function registerSnapshotHandlers(): void {
  const service = FileSnapshotService.getInstance()

  safeHandle(IPC_CHANNELS.SNAPSHOT_LIST, (params: SnapshotListParams) => {
    return service.list(params?.conversationId || '')
  })

  safeHandle(IPC_CHANNELS.SNAPSHOT_REVERT, (params: SnapshotRevertParams) => {
    return service.revert(params?.conversationId || '', params?.ids)
  })
}
