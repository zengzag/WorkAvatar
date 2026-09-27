/** 文件改动类型：与 file-snapshot.service 的 FileChangeKind 对齐 */
export type FileChangeKind = 'write' | 'append' | 'edit' | 'delete'

export const SNAPSHOT_CHANNELS = {
  /** 列出某任务（会话）的文件改动记录 */
  SNAPSHOT_LIST: 'snapshot:list',
  /** 回滚指定改动（不传 ids 则回滚该任务全部改动） */
  SNAPSHOT_REVERT: 'snapshot:revert',
} as const

export interface SnapshotListParams {
  conversationId: string
}

export interface SnapshotRevertParams {
  conversationId: string
  /** 要回滚的改动 id；不传表示回滚全部 */
  ids?: string[]
}

export interface FileChangeItem {
  id: string
  toolName: string
  changeKind: FileChangeKind
  path: string
  /** 改动前文件是否存在（false 表示该操作新建了文件，回滚即删除） */
  existed: boolean
  /** 是否可在应用内还原（目录、超大文件为 false） */
  restorable: boolean
  createdAt: number
}

export interface SnapshotRevertResult {
  reverted: number
  skipped: Array<{ path: string; reason: string }>
}
