export const KMS_CHANNELS = {
  KMS_LIST_DIRS: 'kms:list-dirs',
  KMS_ADD_DIR: 'kms:add-dir',
  KMS_UPDATE_DIR: 'kms:update-dir',
  KMS_DELETE_DIR: 'kms:delete-dir',
  KMS_SEARCH: 'kms:search',
  KMS_AGENT_SEARCH: 'kms:agent-search',
  KMS_GET_FILE_CONTENT: 'kms:get-file-content',
  KMS_GET_FILE_SUMMARY: 'kms:get-file-summary',
  KMS_BUILD_INDEX: 'kms:build-index',
  KMS_INCREMENTAL_INDEX: 'kms:incremental-index',
  KMS_REBUILD_DIR_INDEX: 'kms:rebuild-dir-index',
  KMS_CANCEL_INDEX: 'kms:cancel-index',
  KMS_GET_STATS: 'kms:get-stats',
  KMS_INDEX_PROGRESS: 'kms:index-progress',
  KMS_OPEN_FILE: 'kms:open-file',
  KMS_OPEN_FILE_DIR: 'kms:open-file-dir',
  KMS_GET_FILE_FULL_CONTENT: 'kms:get-file-full-content',
  // KMS MCP 服务
  KMS_MCP_START: 'kms-mcp:start',
  KMS_MCP_STOP: 'kms-mcp:stop',
  KMS_MCP_GET_STATUS: 'kms-mcp:get-status',
  KMS_MCP_GET_CONFIG: 'kms-mcp:get-config',
  KMS_MCP_SET_CONFIG: 'kms-mcp:set-config',
} as const

export interface KMSAddDirParams {
  dirPath: string
  displayName?: string
  recursive?: boolean
  fileExtensions?: string[]
}

export interface KMSUpdateDirParams {
  id: string
  displayName?: string
  enabled?: boolean
  recursive?: boolean
  fileExtensions?: string[]
}

export interface KMSSearchParams {
  query: string
  topK?: number
  fileIds?: string[]
  sourceTypes?: string[]
  useSemantic?: boolean
  timeRangeStart?: number
  timeRangeEnd?: number
  fileExtensions?: string[]
  dirIds?: string[]
}

export interface KMSAgentSearchParams {
  query: string
  maxRounds?: number
  topK?: number
  dirIds?: string[]
  fileExtensions?: string[]
  timeRangeStart?: number
  timeRangeEnd?: number
}

export interface KMSGetFileContentParams {
  fileId: string
  paragraphId?: string
  startOffset?: number
  endOffset?: number
  startLine?: number
  maxChars?: number
}

export interface KMSMCPSetConfigParams {
  enabled?: boolean
  port?: number
  apiKey?: string
}
