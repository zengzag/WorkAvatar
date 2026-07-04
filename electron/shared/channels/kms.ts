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
  // KMS 文件内容浏览（段落、TOC）
  KMS_GET_FILE_PARAGRAPHS: 'kms:get-file-paragraphs',
  KMS_GET_FILE_TOC: 'kms:get-file-toc',
  KMS_GET_PARAGRAPH_CONTENT: 'kms:get-paragraph-content',
  // KMS 自动索引
  KMS_GET_AUTO_INDEX_STATUS: 'kms:get-auto-index-status',
  KMS_RUN_AUTO_INDEX_CHECK: 'kms:run-auto-index-check',
  // KMS 搜索历史
  KMS_GET_SEARCH_HISTORY: 'kms:get-search-history',
  KMS_CLEAR_SEARCH_HISTORY: 'kms:clear-search-history',
  KMS_DELETE_SEARCH_HISTORY: 'kms:delete-search-history',
  KMS_RECORD_SEARCH_HISTORY: 'kms:record-search-history',
  // KMS 合集管理
  KMS_LIST_COLLECTIONS: 'kms:list-collections',
  KMS_CREATE_COLLECTION: 'kms:create-collection',
  KMS_UPDATE_COLLECTION: 'kms:update-collection',
  KMS_DELETE_COLLECTION: 'kms:delete-collection',
  KMS_GET_COLLECTION: 'kms:get-collection',
  KMS_ADD_FILE_TO_COLLECTION: 'kms:add-file-to-collection',
  KMS_ADD_FILES_TO_COLLECTION: 'kms:add-files-to-collection',
  KMS_REMOVE_FILE_FROM_COLLECTION: 'kms:remove-file-from-collection',
  KMS_LIST_FILES_IN_COLLECTION: 'kms:list-files-in-collection',
  KMS_GET_COLLECTION_STATS: 'kms:get-collection-stats',
  KMS_GET_COLLECTION_SUMMARY: 'kms:get-collection-summary',
  KMS_SET_COLLECTION_SUMMARY: 'kms:set-collection-summary',
  KMS_DELETE_COLLECTION_SUMMARY: 'kms:delete-collection-summary',
  KMS_GENERATE_COLLECTION_SUMMARY: 'kms:generate-collection-summary',
  KMS_SCAN_DIR_FILES: 'kms:scan-dir-files',
  // KMS 合集深度处理（段落切分/TOC/段落摘要/文件摘要/合集摘要向量化）
  // 进度事件复用 KMS_INDEX_PROGRESS 通道，含 collectionId 字段供前端按合集过滤
  KMS_PROCESS_COLLECTION_DEEP: 'kms:process-collection-deep',
  KMS_CANCEL_COLLECTION_DEEP: 'kms:cancel-collection-deep',
  // KMS 文件段落增量重新生成（从指定段落开始重新切分/摘要/向量化，保留前半部分）
  // 进度事件复用 KMS_INDEX_PROGRESS 通道，含 fileId 字段供前端按文件过滤
  KMS_REGENERATE_FILE_PARAGRAPH: 'kms:regenerate-file-paragraph',
  KMS_CANCEL_REGENERATE_FILE_PARAGRAPH: 'kms:cancel-regenerate-file-paragraph',
  // KMS 手动摘要生成（目录摘要/文件摘要）
  KMS_GENERATE_DIR_SUMMARY: 'kms:generate-dir-summary',
  KMS_GENERATE_FILE_SUMMARY: 'kms:generate-file-summary',
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
  /** 按合集过滤：只搜索属于指定合集的文件 */
  collectionIds?: string[]
}

export interface KMSAgentSearchParams {
  query: string
  maxRounds?: number
  topK?: number
  dirIds?: string[]
  collectionIds?: string[]
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
  collectionId?: string
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
  filters?: any
}

export interface KMSGetSearchHistoryParams {
  limit?: number
  searchMode?: string
}

export interface KMSCreateCollectionParams {
  name: string
  description?: string
}

export interface KMSUpdateCollectionParams {
  id: string
  name?: string
  description?: string
}

export interface KMSAddFileToCollectionParams {
  collectionId: string
  filePath: string
}

export interface KMSAddFilesToCollectionParams {
  collectionId: string
  filePaths: string[]
}

export interface KMSRemoveFileFromCollectionParams {
  collectionId: string
  fileId: string
}

export interface KMSSetCollectionSummaryParams {
  collectionId: string
  summary: string
  keyTopics?: string[]
}
