export const WORKSPACE_CHANNELS = {
  WORKSPACE_OPEN_IN_EXPLORER: 'workspace:open-in-explorer',
  WORKSPACE_DELETE_TASK_DIR: 'workspace:delete-task-dir',
  WORKSPACE_LIST_FILES: 'workspace:list-files',
} as const

export interface WorkspaceOpenInExplorerParams {
  path: string
}

export interface WorkspaceListFilesParams {
  /** 任务工作区内的目录绝对路径 */
  dirPath: string
}

export interface WorkspaceFileEntry {
  name: string
  path: string
  isDirectory: boolean
  /** 扩展名（小写，不含点）；目录为空字符串 */
  ext: string
  size: number
  mtime: number
}

export interface WorkspaceListFilesResult {
  success: boolean
  entries: WorkspaceFileEntry[]
  error?: string
}
