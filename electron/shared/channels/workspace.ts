export const WORKSPACE_CHANNELS = {
  WORKSPACE_INFO: 'workspace:info',
  WORKSPACE_LIST_FILES: 'workspace:list-files',
  WORKSPACE_READ_FILE: 'workspace:read-file',
  WORKSPACE_WRITE_FILE: 'workspace:write-file',
  WORKSPACE_CREATE_FOLDER: 'workspace:create-folder',
  WORKSPACE_DELETE_ITEM: 'workspace:delete-item',
  WORKSPACE_RENAME_ITEM: 'workspace:rename-item',
  WORKSPACE_IMPORT: 'workspace:import',
  WORKSPACE_OPEN_IN_EXPLORER: 'workspace:open-in-explorer',
} as const

export interface WorkspaceOpenInExplorerParams {
  path: string
}

export interface WorkspaceInfoParams {
  employee_id: string
}

export interface WorkspaceListFilesParams {
  employee_id: string
  sub_path?: string
  recursive?: boolean
}

export interface WorkspaceReadFileParams {
  employee_id: string
  file_path: string
}

export interface WorkspaceWriteFileParams {
  employee_id: string
  file_path: string
  content: string
}

export interface WorkspaceCreateFolderParams {
  employee_id: string
  folder_path: string
}

export interface WorkspaceDeleteItemParams {
  employee_id: string
  item_path: string
}

export interface WorkspaceRenameItemParams {
  employee_id: string
  item_path: string
  new_name: string
}

export interface WorkspaceImportParams {
  employee_id: string
  source_paths: string[]
  target_folder?: string
}
