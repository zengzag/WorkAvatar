import type { Project, File, Skill, ParseResult, LLMProvider } from './types'

export const IPC_CHANNELS = {
  PING: 'ping',

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
  CONVERSATION_SEND_MESSAGE: 'conversation:send-message',

  LLM_PROVIDER_LIST: 'llm:provider-list',
  LLM_PROVIDER_GET: 'llm:provider-get',
  LLM_PROVIDER_CREATE: 'llm:provider-create',
  LLM_PROVIDER_UPDATE: 'llm:provider-update',
  LLM_PROVIDER_DELETE: 'llm:provider-delete',
  LLM_TEST_CONNECTION: 'llm:test-connection',
  LLM_CHAT_STREAM: 'llm:chat-stream',
  LLM_CHAT_STREAM_WITH_RAG: 'llm:chat-stream-with-rag',
  EMPLOYEE_CHAT_STREAM: 'employee:chat-stream',

  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_KEY_SET: 'settings:key-set',
  SETTINGS_KEY_GET: 'settings:key-get',

  APP_GET_PATH: 'app:get-path',
  APP_SHOW_OPEN_DIALOG: 'app:show-open-dialog',
  APP_SHOW_MESSAGE_BOX: 'app:show-message-box',

  RAG_INDEX_PROJECT: 'rag:index-project',
  RAG_SEARCH: 'rag:search',
  RAG_INDEX_STATUS: 'rag:index-status',
  RAG_DELETE_INDEX: 'rag:delete-index',

  WIKI_INITIALIZE: 'wiki:initialize',
  WIKI_COMPILE: 'wiki:compile',
  WIKI_SEARCH: 'wiki:search',
  WIKI_GET_STATUS: 'wiki:get-status',
  WIKI_GET_PAGES: 'wiki:get-pages',
  WIKI_GET_PAGE: 'wiki:get-page',
  WIKI_GET_RAW_FILES: 'wiki:get-raw-files',
  WIKI_INGEST_SOURCE: 'wiki:ingest-source',
  WIKI_QUERY: 'wiki:query',
  WIKI_LINT: 'wiki:lint',
  WIKI_AUDIT: 'wiki:audit',
  WIKI_CHAT_WITH_WIKI: 'wiki:chat-with-wiki',

  OCR_RECOGNIZE: 'ocr:recognize',
  OCR_STATUS: 'ocr:status',

  RULE_EXTRACT_FILE: 'rule:extract-file',
  RULE_EXTRACT_PROJECT: 'rule:extract-project',

  SANDBOX_TEST_SKILL: 'sandbox:test-skill',
  SANDBOX_TEST_EMPLOYEE: 'sandbox:test-employee',
  SANDBOX_GENERATE_CASES: 'sandbox:generate-cases',

  EMPLOYEE_PROFILE_ANALYZE: 'employee:profile-analyze',
  EMPLOYEE_PROFILE_PROGRESS: 'employee:profile-progress',

  TOOL_LIST_BUILTIN: 'tool:list-builtin',
  TOOL_EXECUTE: 'tool:execute',
  TOOL_GET_EMPLOYEE_TOOLS: 'tool:get-employee-tools',
  TOOL_ASSIGN_TO_EMPLOYEE: 'tool:assign-to-employee',
  TOOL_REMOVE_FROM_EMPLOYEE: 'tool:remove-from-employee',

  MCP_SERVER_LIST: 'mcp:server-list',
  MCP_SERVER_CREATE: 'mcp:server-create',
  MCP_SERVER_UPDATE: 'mcp:server-update',
  MCP_SERVER_DELETE: 'mcp:server-delete',
  MCP_SERVER_CONNECT: 'mcp:server-connect',
  MCP_SERVER_DISCONNECT: 'mcp:server-disconnect',

  SKILL_REGISTRY_LIST: 'skill-registry:list',
  SKILL_REGISTRY_INSTALL: 'skill-registry:install',
  SKILL_REGISTRY_UNINSTALL: 'skill-registry:uninstall',
  SKILL_REGISTRY_GET: 'skill-registry:get',
  SKILL_REGISTRY_TOGGLE: 'skill-registry:toggle',
  SKILL_REGISTRY_GET_EMPLOYEE_SKILLS: 'skill-registry:get-employee-skills',
  SKILL_REGISTRY_ASSIGN_TO_EMPLOYEE: 'skill-registry:assign-to-employee',
  SKILL_REGISTRY_REMOVE_FROM_EMPLOYEE: 'skill-registry:remove-from-employee',
} as const

export interface ProjectListParams {
  limit?: number
  offset?: number
}

export interface ProjectListResult {
  projects: Project[]
  total: number
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

export interface FileListParams {
  project_id: string
  status?: string
}

export interface FileListResult {
  files: File[]
  total: number
}

export interface FileImportParams {
  project_id: string
  paths: string[]
}

export interface FileImportResult {
  success: boolean
  imported: Array<{ id: string; path: string; original_name: string }>
  errors: Array<{ path: string; error: string }>
}

export interface FileParseParams {
  file_id: string
}

export interface FileParseResult {
  success: boolean
  result?: ParseResult
  error?: string
}

export interface FileGetContentParams {
  file_id: string
}

export interface FileGetContentResult {
  success: boolean
  content?: string
  error?: string
}

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

export interface ConversationSendMessageParams {
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
}

export interface LLMProviderCreateParams {
  name: string
  provider_type: LLMProvider['provider_type']
  base_url?: string
  model: string
  api_key?: string
  temperature?: number
  max_tokens?: number
  timeout_ms?: number
  is_default?: boolean
}

export interface LLMProviderUpdateParams {
  id: string
  name?: string
  provider_type?: LLMProvider['provider_type']
  base_url?: string
  model?: string
  api_key?: string
  temperature?: number
  max_tokens?: number
  timeout_ms?: number
  is_default?: boolean
}

export interface LLMTestConnectionParams {
  provider_id: string
}

export interface LLMTestConnectionResult {
  success: boolean
  error?: string
  latency?: number
}

export interface LLMChatStreamParams {
  provider_id: string
  model_id?: string
  messages: Array<{ role: string; content: string }>
  options?: {
    temperature?: number
    max_tokens?: number
    stream?: boolean
  }
}

export interface LLMChatStreamWithRAGParams {
  provider_id: string
  model_id?: string
  project_id: string
  messages: Array<{ role: string; content: string }>
  options?: {
    temperature?: number
    max_tokens?: number
    stream?: boolean
  }
  rag_options?: {
    top_k?: number
    min_score?: number
  }
}

export interface EmployeeChatStreamParams {
  employee_id: string
  provider_id: string
  model_id?: string
  messages: Array<{ role: string; content: string }>
  options?: {
    temperature?: number
    max_tokens?: number
  }
  use_skills?: boolean
}

export interface SettingsGetParams {
  key: string
}

export interface SettingsSetParams {
  key: string
  value: string
}

export interface AppGetPathParams {
  name: 'home' | 'appData' | 'userData' | 'temp' | 'documents' | 'downloads'
}

export interface AppShowOpenDialogParams {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: Array<{ name: string; extensions: string[] }>
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles'>
}

export interface EmployeeProfileAnalyzeParams {
  project_id: string
  file_ids: string[]
  provider_id?: string
  model_id?: string
  additional_context?: string
}

export interface ToolExecuteParams {
  tool_id: string
  args: Record<string, any>
}

export interface ToolAssignParams {
  employee_id: string
  tool_id: string
  is_enabled?: boolean
}

export interface MCPServerCreateParams {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface MCPServerUpdateParams {
  id: string
  name?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  is_enabled?: boolean
}

export interface WikiCompileParams {
  project_id: string
  provider_id?: string
  model_id?: string
  force?: boolean
}

export interface WikiSearchParams {
  project_id: string
  query: string
  top_k?: number
}

export interface WikiChatParams {
  provider_id: string
  model_id?: string
  project_id: string
  messages: Array<{ role: string; content: string }>
  options?: {
    temperature?: number
    max_tokens?: number
    stream?: boolean
  }
  use_wiki?: boolean
  use_rag?: boolean
}

export interface WikiIngestParams {
  project_id: string
  raw_file_path: string
  provider_id?: string
  model_id?: string
}

export interface WikiIngestResult {
  success: boolean
  pages_created: number
  errors: string[]
}

export interface WikiQueryParams {
  project_id: string
  query: string
  provider_id?: string
  model_id?: string
}

export interface WikiQueryResult {
  answer: string
  sources: Array<{
    page: {
      id: string
      title: string
      type: 'concept' | 'entity' | 'summary'
      content: string
      tags: string[]
      sources: string[]
      created_at: number
      updated_at: number
      path: string
    }
    relevance: number
    matched_sections: string[]
  }>
}

export interface WikiLintResult {
  dead_links: Array<{ source: string; link: string }>
  orphan_pages: string[]
  missing_index: string[]
  total_issues: number
}

export interface WikiAuditResult {
  open: Array<{
    id: string
    target: string
    target_lines: [number, number]
    anchor_before: string
    anchor_text: string
    anchor_after: string
    severity: 'info' | 'suggest' | 'warn' | 'error'
    author: string
    source: 'obsidian-plugin' | 'web-viewer' | 'manual'
    created: string
    status: 'open' | 'resolved'
    comment: string
    resolution?: string
  }>
  resolved: Array<{
    id: string
    target: string
    target_lines: [number, number]
    anchor_before: string
    anchor_text: string
    anchor_after: string
    severity: 'info' | 'suggest' | 'warn' | 'error'
    author: string
    source: 'obsidian-plugin' | 'web-viewer' | 'manual'
    created: string
    status: 'open' | 'resolved'
    comment: string
    resolution?: string
  }>
}

export interface WikiStatusResult {
  initialized: boolean
  raw_count: number
  wiki_page_count: number
  concept_count: number
  entity_count: number
  summary_count: number
  open_audits: number
  last_operation_at: number
}

export interface WikiPageListResult {
  pages: Array<{
    id: string
    title: string
    type: 'concept' | 'entity' | 'summary'
    path: string
    tags: string[]
    summary: string
  }>
}

export interface WikiRawFilesResult {
  files: Array<{
    path: string
    name: string
    type: string
  }>
}
