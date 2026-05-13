import type { Skill } from '../types'

export const EMPLOYEE_CHANNELS = {
  EMPLOYEE_LIST: 'employee:list',
  EMPLOYEE_GET: 'employee:get',
  EMPLOYEE_CREATE: 'employee:create',
  EMPLOYEE_UPDATE: 'employee:update',
  EMPLOYEE_DELETE: 'employee:delete',

  SKILL_LIST: 'skill:list',
  SKILL_CREATE: 'skill:create',
  SKILL_UPDATE: 'skill:update',
  SKILL_DELETE: 'skill:delete',

  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_GET: 'conversation:get',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_UPDATE: 'conversation:update',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_DELETE_ALL: 'conversation:delete-all',

  EMPLOYEE_PROFILE_ANALYZE: 'employee:profile-analyze',
  EMPLOYEE_PROFILE_PROGRESS: 'employee:profile-progress',

  EMPLOYEE_EXPORT_CONFIG: 'employee:export-config',
  EMPLOYEE_IMPORT_CONFIG: 'employee:import-config',
  EMPLOYEE_EXPORT_PACKAGE: 'employee:export-package',
  EMPLOYEE_IMPORT_PACKAGE: 'employee:import-package',
  EMPLOYEE_EXPORT_PROGRESS: 'employee:export-progress',
  EMPLOYEE_IMPORT_PROGRESS: 'employee:import-progress',
} as const

export interface EmployeeListParams {
  project_id?: string
  status?: string
}

export interface EmployeeCreateParams {
  project_id: string
  name: string
  description?: string
  profile_json?: string
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
}

export interface SkillListParams {
  employee_id: string
}

export interface SkillCreateParams {
  employee_id: string
  type: Skill['type']
  name: string
  description?: string
  prompt_template?: string
}

export interface SkillUpdateParams {
  id: string
  name?: string
  description?: string
  config_json?: string
  prompt_template?: string
  rules_json?: string
  priority?: number
  is_enabled?: boolean
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
  project_id: string
  kb_ids: string[]
  provider_id?: string
  model_id?: string
  additional_context?: string
}

export interface EmployeeExportConfigParams {
  employee_id: string
  export_path: string
}

export interface EmployeeImportConfigParams {
  import_path: string
  project_id: string
  conflict_strategy: 'skip' | 'overwrite' | 'merge'
}

export interface EmployeeExportPackageParams {
  employee_id: string
  export_path: string
}

export interface EmployeeImportPackageParams {
  import_path: string
  project_id: string
  conflict_strategy: 'skip' | 'overwrite' | 'merge'
}