export const EMPLOYEE_CHANNELS = {
  EMPLOYEE_LIST: 'employee:list',
  EMPLOYEE_GET: 'employee:get',
  EMPLOYEE_CREATE: 'employee:create',
  EMPLOYEE_UPDATE: 'employee:update',
  EMPLOYEE_DELETE: 'employee:delete',

  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_GET: 'conversation:get',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_UPDATE: 'conversation:update',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_DELETE_ALL: 'conversation:delete-all',

  EMPLOYEE_PROFILE_ANALYZE: 'employee:profile-analyze',
  EMPLOYEE_PROFILE_PROGRESS: 'employee:profile-progress',
  EMPLOYEE_PROFILE_REFINE: 'employee:profile-refine',

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
} as const

export interface EmployeeListParams {
  status?: string
}

export interface EmployeeCreateParams {
  name: string
  description?: string
  profile_json?: string
  workspace_path?: string
}

export interface EmployeeUpdateParams {
  id: string
  name?: string
  description?: string
  profile_json?: string
  status?: 'draft' | 'active' | 'paused' | 'error'
  review_mode?: boolean
  default_skill_id?: string
  llm_provider_id?: string
  llm_model?: string
  workspace_path?: string
  avatar_type?: string
  memory_enabled?: boolean
}

export interface ConversationListParams {
  employee_id: string
}

export interface ConversationCreateParams {
  employee_id: string
  skill_id?: string
  title?: string
}

export interface EmployeeProfileAnalyzeParams {
  kb_ids: string[]
  provider_id?: string
  model_id?: string
  additional_context?: string
}

export interface EmployeeProfileRefineParams {
  previous_messages: Array<{ role: string; content: string }>
  previous_profile: {
    roleName: string
    roleDescription: string
    suggestedTools: string[]
  }
  feedback: string
  provider_id: string
  model_id?: string
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
}

export interface EmployeeMemoryUpdateParams {
  id: string
  key?: string
  topic?: string
  content?: string
  is_pinned?: boolean
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
}
