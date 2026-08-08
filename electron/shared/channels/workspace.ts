export const WORKSPACE_CHANNELS = {
  WORKSPACE_OPEN_IN_EXPLORER: 'workspace:open-in-explorer',
  WORKSPACE_DELETE_TASK_DIR: 'workspace:delete-task-dir',
} as const

export interface WorkspaceOpenInExplorerParams {
  path: string
}
