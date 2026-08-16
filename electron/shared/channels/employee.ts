export const EMPLOYEE_CHANNELS = {
  EMPLOYEE_LIST: 'employee:list',
  EMPLOYEE_GET: 'employee:get',
  EMPLOYEE_CREATE: 'employee:create',
  EMPLOYEE_UPDATE: 'employee:update',
  EMPLOYEE_DELETE: 'employee:delete',
  EMPLOYEE_ON_CHANGED: 'employee:on-changed',

  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_LIST_ALL: 'conversation:list-all',
  CONVERSATION_GET: 'conversation:get',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_UPDATE: 'conversation:update',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_DELETE_ALL: 'conversation:delete-all',
  CONVERSATION_SEARCH_GLOBAL: 'conversation:search-global',

  EMPLOYEE_PROFILE_ANALYZE: 'employee:profile-analyze',
  EMPLOYEE_PROFILE_PROGRESS: 'employee:profile-progress',
  EMPLOYEE_PROFILE_REFINE: 'employee:profile-refine',
  EMPLOYEE_GENERATE_DESCRIPTION: 'employee:generate-description',

  EMPLOYEE_EXPORT_CONFIG: 'employee:export-config',
  EMPLOYEE_IMPORT_CONFIG: 'employee:import-config',
  EMPLOYEE_EXPORT_PACKAGE: 'employee:export-package',
  EMPLOYEE_IMPORT_PACKAGE: 'employee:import-package',
  EMPLOYEE_EXPORT_PROGRESS: 'employee:export-progress',
  EMPLOYEE_IMPORT_PROGRESS: 'employee:import-progress',

  EMPLOYEE_MEMORY_LIST: 'employee:memory-list',
  EMPLOYEE_MEMORY_CREATE: 'employee:memory-create',
  EMPLOYEE_MEMORY_UPDATE: 'employee:memory-update',
  EMPLOYEE_MEMORY_DELETE: 'employee:memory-delete',
  EMPLOYEE_MEMORY_TOGGLE_PIN: 'employee:memory-toggle-pin',
  EMPLOYEE_MEMORY_SEARCH: 'employee:memory-search',
  EMPLOYEE_MEMORY_EXTRACT: 'employee:memory-extract',
  EMPLOYEE_MEMORY_CONSOLIDATE: 'employee:memory-consolidate',
  EMPLOYEE_MEMORY_STATS: 'employee:memory-stats',
  EMPLOYEE_MEMORY_EXTRACT_CONVERSATION: 'employee:memory-extract-conversation',
  EMPLOYEE_MEMORY_LIST_TRASH: 'employee:memory-list-trash',
  EMPLOYEE_MEMORY_RESTORE: 'employee:memory-restore',
  EMPLOYEE_MEMORY_PURGE: 'employee:memory-purge',
  EMPLOYEE_MEMORY_EMPTY_TRASH: 'employee:memory-empty-trash',
} as const

export interface EmployeeListParams {
}

export interface EmployeeCreateParams {
  name: string
  description?: string
  rules?: string
  profile_json?: string
  workspace_path?: string
}

export interface EmployeeUpdateParams {
  id: string
  name?: string
  description?: string
  rules?: string
  profile_json?: string
  default_skill_id?: string
  workspace_path?: string
  avatar_type?: string
  memory_enabled?: boolean
}

export interface EmployeeDeleteParams {
  id: string
  delete_workspace?: boolean
}

export interface ConversationListParams {
  employee_id?: string
}

export interface ConversationListWithEmployeeParams {
  employee_ids?: string[]
  limit?: number
  offset?: number
}

export interface ConversationCreateParams {
  employee_id: string
  skill_id?: string
  title?: string
  minimal_mode?: boolean
}

export interface ConversationSearchParams {
  query: string
  employee_ids?: string[]
  limit?: number
}

export interface ConversationSearchResultItem {
  conversationId: string
  employeeId: string
  employeeName: string
  title: string
  summary: string
  previewSnippet: string
  lastMessageAt: number | null
  messageCount: number
}

export interface EmployeeProfileAnalyzeParams {
  collection_ids: string[]
  provider_id?: string
  model_id?: string
  additional_context?: string
  context_file?: { name: string; content: string }
}

export interface EmployeeProfileRefineParams {
  previous_messages: Array<{ role: string; content: string }>
  previous_profile: {
    roleName: string
    roleDescription: string
    description?: string
    suggestedTools: string[]
  }
  feedback: string
  provider_id: string
  model_id?: string
}

export interface EmployeeGenerateDescriptionParams {
  employee_id: string
  provider_id?: string
  model_id?: string
  /** 未保存的表单值优先于 DB（用于设置界面即时生成） */
  name?: string
  rules?: string
}

export interface EmployeeExportConfigParams {
  employee_id: string
  export_path: string
}

export interface EmployeeImportConfigParams {
  import_path: string
  conflict_strategy: 'skip' | 'overwrite' | 'merge'
}

export interface EmployeeExportPackageParams {
  employee_id: string
  export_path: string
}

export interface EmployeeImportPackageParams {
  import_path: string
  conflict_strategy: 'skip' | 'overwrite' | 'merge'
}

export interface EmployeeMemoryListParams {
  employee_id: string
}

export interface EmployeeMemoryCreateParams {
  employee_id: string
  key: string
  topic: string
  content: string
  is_pinned?: boolean
  source?: 'auto' | 'manual'
  importance?: 'critical' | 'normal' | 'low'
}

export interface EmployeeMemoryUpdateParams {
  id: string
  key?: string
  topic?: string
  content?: string
  is_pinned?: boolean
  importance?: 'critical' | 'normal' | 'low'
}

export interface EmployeeMemorySearchParams {
  employee_id: string
  query: string
  limit?: number
}

export interface EmployeeMemoryExtractParams {
  employee_id: string
  messages: Array<{ role: string; content: string }>
  provider_id: string
  model_id?: string
  conversation_id?: string
}

export interface EmployeeMemoryConsolidateParams {
  employee_id: string
  provider_id: string
  model_id?: string
}

export interface EmployeeMemoryStatsParams {
  employee_id: string
}

export interface EmployeeMemoryExtractConversationParams {
  conversation_id: string
}
