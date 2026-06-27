export const WORKSPACE_CHANNELS = {
  WORKSPACE_OPEN_IN_EXPLORER: 'workspace:open-in-explorer',
} as const

export interface WorkspaceOpenInExplorerParams {
  path: string
}
