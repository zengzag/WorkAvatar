export const KMS_CHANNELS = {
  KMS_LIST_DIRS: 'kms:list-dirs',
  KMS_ADD_DIR: 'kms:add-dir',
  KMS_UPDATE_DIR: 'kms:update-dir',
  KMS_DELETE_DIR: 'kms:delete-dir',
  KMS_SEARCH: 'kms:search',
  KMS_AGENT_SEARCH: 'kms:agent-search',
  KMS_AGENT_SEARCH_PROGRESS: 'kms:agent-search-progress',
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
  // KMS 设置与知识沉淀
  KMS_GET_SETTINGS: 'kms:get-settings',
  KMS_SET_SETTINGS: 'kms:set-settings',
  KMS_GET_DIR_SUMMARIES: 'kms:get-dir-summaries',
  KMS_GET_FILE_SUMMARIES: 'kms:get-file-summaries',
  // KMS 自动索引
  KMS_GET_AUTO_INDEX_STATUS: 'kms:get-auto-index-status',
  KMS_RUN_AUTO_INDEX_CHECK: 'kms:run-auto-index-check',
  // KMS 搜索历史
  KMS_GET_SEARCH_HISTORY: 'kms:get-search-history',
  KMS_GET_SEARCH_HISTORY_DETAIL: 'kms:get-search-history-detail',
  KMS_CLEAR_SEARCH_HISTORY: 'kms:clear-search-history',
  KMS_DELETE_SEARCH_HISTORY: 'kms:delete-search-history',
  KMS_RECORD_SEARCH_HISTORY: 'kms:record-search-history',
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

export interface KMSGetFileSummariesParams {
  dirId?: string
  dataTier?: 'cold' | 'hot'
  keyword?: string
  page?: number
  pageSize?: number
}

export interface KMSAutoIndexConfig {
  enabled: boolean
  intervalMinutes: number
  stableThresholdSeconds: number
}

export interface KMSSetSettingsParams {
  model?: { provider_id: string; model_id: string } | null
  embeddingModel?: { provider_id: string; model_id: string } | null
  searchParams?: { maxRounds?: number; topK?: number }
  autoIndex?: KMSAutoIndexConfig
}

export interface KMSRecordSearchHistoryParams {
  query: string
  searchMode: string
  resultCount: number
  resultData?: any
  filters?: any
}

export interface KMSGetSearchHistoryParams {
  limit?: number
  searchMode?: string
}
