export interface Employee {
  id: string
  workspace_path?: string
  name: string
  description: string
  profile_json: string
  avatar_type: string
  default_skill_id?: string
  memory_enabled: boolean
  arch_version: number
  total_tasks: number
  total_approvals: number
  last_active_at?: number | null
  created_at: number
  updated_at: number
}

export interface Skill {
  id: string
  employee_id: string
  type: 'extraction' | 'qa' | 'generation' | 'classification' | 'query' | 'calculation'
  name: string
  description: string
  config_json: string
  prompt_template?: string
  rules_json: string
  test_cases_json: string
  input_schema_json?: string
  output_schema_json?: string
  priority: number
  is_enabled: boolean
  created_at: number
}

export interface Conversation {
  id: string
  employee_id: string
  skill_id?: string
  title: string
  messages_json: string
  message_count: number
  summary: string
  minimal_mode: boolean
  status: 'active' | 'archived'
  created_at: number
  updated_at: number
  last_message_at: number | null
  context_stats_json?: string
  /** 任务独立工作区目录（空字符串表示未分配，回退到员工工作区） */
  workspace_path?: string
  /** 父会话 ID：委托产生的子会话记录其主管会话 ID，空字符串表示顶层会话 */
  parent_conversation_id?: string
}

export type LLMProviderType = 'openai' | 'openai-compatible' | 'lmstudio' | 'deepseek' | 'qwen' | 'zhipu' | 'volcengine' | 'xiaomi' | 'moonshot' | 'yi' | 'groq' | 'mistral' | 'azure' | 'vertex' | 'bedrock' | 'xai'

export type LLMModelCategory = 'chat' | 'embedding'

export interface LLMModelConfig {
  id: string
  name: string
  model: string
  category: LLMModelCategory
  temperature: number
  max_tokens: number
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  enable_thinking?: boolean
  thinking_budget?: number
  max_retry?: number
  context_window?: number
  is_default: boolean
}

export interface LLMProvider {
  id: string
  name: string
  provider_type: LLMProviderType
  base_url?: string
  model: string
  embedding_model: string
  temperature: number
  max_tokens: number
  timeout_ms: number
  extra_headers_json?: string
  extra_body_json?: string
  is_default: boolean
  models_json?: string
  created_at: number
}

export interface GeneratedFileInfo {
  path: string
  name: string
  ext: string
  size: number
  mtime: number
}

export interface ParseResult {
  type: string
  fullText: string
  sections: Array<{
    title: string
    content: string
    level: number
  }>
  tables: Array<{
    headers: string[]
    rows: string[][]
    context: string
  }>
  metadata: Record<string, any>
}
