export const KMS_CHANNELS = {
  KMS_LIST_DIRS: 'kms:list-dirs',
  KMS_ADD_DIR: 'kms:add-dir',
  KMS_UPDATE_DIR: 'kms:update-dir',
  KMS_DELETE_DIR: 'kms:delete-dir',
  KMS_SEARCH: 'kms:search',
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
  // KMS 单文件深度处理（合集文件列表中单个文件的深度处理）
  KMS_PROCESS_FILE_DEEP: 'kms:process-file-deep',
  // KMS 手动摘要生成（目录摘要/文件摘要）
  KMS_GENERATE_DIR_SUMMARY: 'kms:generate-dir-summary',
  KMS_GENERATE_FILE_SUMMARY: 'kms:generate-file-summary',
  KMS_REBUILD_FILE_INDEX: 'kms:rebuild-file-index',
  // KMS 文件搜索（按文件名匹配）
  KMS_SEARCH_FILES: 'kms:search-files',
  // KMS 文件搜索目录（仅参与文件名/路径匹配搜索，不建立索引）
  KMS_LIST_SEARCH_DIRS: 'kms:list-search-dirs',
  KMS_ADD_SEARCH_DIR: 'kms:add-search-dir',
  KMS_UPDATE_SEARCH_DIR: 'kms:update-search-dir',
  KMS_DELETE_SEARCH_DIR: 'kms:delete-search-dir',
  KMS_REFRESH_SEARCH_DIR: 'kms:refresh-search-dir',
  // KMS MCP 服务（已扩展为通用内置工具 MCP）
  KMS_MCP_START: 'kms-mcp:start',
  KMS_MCP_STOP: 'kms-mcp:stop',
  KMS_MCP_GET_STATUS: 'kms-mcp:get-status',
  KMS_MCP_GET_CONFIG: 'kms-mcp:get-config',
  KMS_MCP_SET_CONFIG: 'kms-mcp:set-config',
  // 列出工具类别（含工具数、默认启用状态）
  KMS_MCP_LIST_CATEGORIES: 'kms-mcp:list-categories',
  // 列出当前配置启用的所有对外工具（MCP 格式），可选传入自定义类别做预览
  KMS_MCP_LIST_EXPOSED_TOOLS: 'kms-mcp:list-exposed-tools',
  // KMS 数据库清理（回收磁盘空间 + 清理残留索引数据）
  KMS_GET_DATABASE_STATS: 'kms:get-database-stats',
  KMS_CLEANUP_DATABASE: 'kms:cleanup-database',
  // KMS 知识卡片
  KMS_GET_KEYWORD_STATS: 'kms:get-keyword-stats',
  KMS_GET_KNOWLEDGE_CARDS: 'kms:get-knowledge-cards',
  KMS_GET_KNOWLEDGE_CARD: 'kms:get-knowledge-card',
  KMS_GENERATE_KNOWLEDGE_CARD: 'kms:generate-knowledge-card',
  KMS_REFRESH_KNOWLEDGE_CARD: 'kms:refresh-knowledge-card',
  KMS_UPDATE_KNOWLEDGE_CARD: 'kms:update-knowledge-card',
  KMS_DELETE_KNOWLEDGE_CARD: 'kms:delete-knowledge-card',
  KMS_DISABLE_KNOWLEDGE_CARD: 'kms:disable-knowledge-card',
  KMS_ENABLE_KNOWLEDGE_CARD: 'kms:enable-knowledge-card',
  KMS_PIN_KNOWLEDGE_CARD: 'kms:pin-knowledge-card',
  KMS_SEARCH_KNOWLEDGE_CARDS: 'kms:search-knowledge-cards',
  KMS_KNOWLEDGE_CARD_PROGRESS: 'kms:knowledge-card-progress',
  // KMS 停用词管理
  KMS_GET_STOP_WORDS: 'kms:get-stop-words',
  KMS_ADD_STOP_WORD: 'kms:add-stop-word',
  KMS_DELETE_STOP_WORD: 'kms:delete-stop-word',
  KMS_CLEAR_AUTO_STOP_WORDS: 'kms:clear-auto-stop-words',
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

export interface KMSAddSearchDirParams {
  dirPath: string
  displayName?: string
  recursive?: boolean
  fileExtensions?: string[]
}

export interface KMSUpdateSearchDirParams {
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

export interface KMSGetFileContentParams {
  fileId: string
  paragraphId?: string
  startOffset?: number
  endOffset?: number
  startLine?: number
  maxChars?: number
}

import type { BuiltinToolCategoryId } from '../../main/services/mcp/builtin-mcp-converter'

export interface KMSMCPSetConfigParams {
  enabled?: boolean
  port?: number
  apiKey?: string
  tool_categories?: BuiltinToolCategoryId[]
}

export interface KMSMCPToolCategoryInfo {
  id: BuiltinToolCategoryId
  toolIds: string[]
  defaultEnabled: boolean
  toolCount: number
  /** 插件类别对应的插件 id（用于前端以插件命名空间解析类别名） */
  pluginId?: string
}

export interface KMSMCPExposedTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
  /** 所属工具类别（用于前端标签颜色区分、过滤显示），可能为 'unknown' 当无法匹配到任何 BUILTIN_TOOL_CATEGORIES 时 */
  category: BuiltinToolCategoryId | 'unknown'
  /** 对应 ToolDefinition 的 id（用于调试/关联）*/
  toolId: string
}

export interface KMSGetFileSummariesParams {
  dirId?: string
  collectionId?: string
  dataTier?: 'cold' | 'hot'
  indexStatus?: string
  keyword?: string
  page?: number
  pageSize?: number
}

export interface KMSAutoIndexConfig {
  enabled: boolean
  intervalMinutes: number
  stableThresholdMinutes: number
}

export interface KMSModelConfig {
  provider_id: string
  model_id: string
  enable_thinking?: boolean
}

export interface KMSSetSettingsParams {
  embeddingModel?: KMSModelConfig | null
  summaryModel?: KMSModelConfig | null
  searchParams?: {
    maxRounds?: number
    topK?: number
    resultLimit?: number
    autoReparseHotData?: boolean
    enableKnowledgeCards?: boolean
    knowledgeCardThreshold?: number
    autoRefreshStaleCards?: boolean
  }
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

export interface KMSSearchFilesParams {
  query: string
  dirIds?: string[]
  collectionIds?: string[]
  fileExtensions?: string[]
  timeRangeStart?: number
  timeRangeEnd?: number
}

export interface KMSGetKnowledgeCardsParams {
  status?: 'active' | 'stale' | 'archived' | 'disabled'
  keyword?: string
  pinnedOnly?: boolean
  limit?: number
  offset?: number
}

export interface KMSUpdateKnowledgeCardParams {
  id: string
  summary?: string
  keyPoints?: Array<{ point: string; sourceIndex: number }>
  requirement?: string
  pinned?: boolean
}

export interface KMSSearchKnowledgeCardsParams {
  query: string
  topK?: number
}
