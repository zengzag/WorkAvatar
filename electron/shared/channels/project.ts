export const PROJECT_CHANNELS = {
  PROJECT_LIST: 'project:list',
  PROJECT_GET: 'project:get',
  PROJECT_CREATE: 'project:create',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',

  FILE_LIST: 'file:list',
  FILE_GET: 'file:get',
  FILE_IMPORT: 'file:import',
  FILE_DELETE: 'file:delete',
  FILE_PARSE: 'file:parse',
  FILE_GET_CONTENT: 'file:get-content',

  WORKSPACE_INFO: 'workspace:info',
  WORKSPACE_LIST_FILES: 'workspace:list-files',
  WORKSPACE_READ_FILE: 'workspace:read-file',
  WORKSPACE_WRITE_FILE: 'workspace:write-file',
  WORKSPACE_CREATE_FOLDER: 'workspace:create-folder',
  WORKSPACE_DELETE_ITEM: 'workspace:delete-item',
  WORKSPACE_RENAME_ITEM: 'workspace:rename-item',
  WORKSPACE_IMPORT: 'workspace:import',
} as const

export interface ProjectListParams {
  limit?: number
  offset?: number
}

export interface ProjectCreateParams {
  name: string
  description?: string
  root_path: string
}

export interface ProjectUpdateParams {
  id: string
  name?: string
  description?: string
  root_path?: string
  llm_provider_id?: string
}

export interface ProjectDeleteParams {
  id: string
  delete_workspace?: boolean
}

export interface FileListParams {
  project_id: string
  status?: string
}

export interface FileImportParams {
  project_id: string
  paths: string[]
}

export interface FileParseParams {
  file_id: string
}

export interface FileGetContentParams {
  file_id: string
}

export interface WorkspaceInfoParams {
  project_id: string
}

export interface WorkspaceListFilesParams {
  project_id: string
  sub_path?: string
  recursive?: boolean
}

export interface WorkspaceReadFileParams {
  project_id: string
  file_path: string
}

export interface WorkspaceWriteFileParams {
  project_id: string
  file_path: string
  content: string
}

export interface WorkspaceCreateFolderParams {
  project_id: string
  folder_path: string
}

export interface WorkspaceDeleteItemParams {
  project_id: string
  item_path: string
}

export interface WorkspaceRenameItemParams {
  project_id: string
  item_path: string
  new_name: string
}

export interface WorkspaceImportParams {
  project_id: string
  source_paths: string[]
  target_folder?: string
}