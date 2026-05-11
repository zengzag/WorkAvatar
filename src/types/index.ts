export interface Project {
  id: string
  name: string
  description: string
  root_path: string
  llm_provider_id?: string
  created_at: number
  updated_at: number
}

export interface File {
  id: string
  project_id: string
  path: string
  original_name: string
  type: string
  size: number
  hash?: string
  status: 'pending' | 'parsing' | 'completed' | 'failed'
  parsed_json?: string
  thumbnail_text?: string
  rule_count: number
  qa_count: number
  error_message?: string
  created_at: number
  updated_at: number
}

export interface Employee {
  id: string
  project_id: string
  name: string
  description: string
  profile_json: string
  avatar_type: string
  status: 'draft' | 'active' | 'paused' | 'error'
  review_mode: boolean
  default_skill_id?: string
  llm_provider_id?: string
  llm_model?: string
  arch_version: number
  total_tasks: number
  total_approvals: number
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
  status: 'active' | 'archived'
  created_at: number
  updated_at: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  isError?: boolean
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
  entities: Array<{
    type: string
    value: string
    context: string
  }>
  metadata: Record<string, any>
}

export type LLMProviderType = 'openai' | 'openai-compatible' | 'lmstudio' | 'deepseek' | 'qwen' | 'zhipu' | 'volcengine' | 'moonshot' | 'yi' | 'groq' | 'mistral' | 'azure' | 'vertex' | 'bedrock' | 'xai'

export interface LLMModelConfig {
  id: string
  name: string
  model: string
  temperature: number
  max_tokens: number
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  enable_thinking?: boolean
  thinking_budget?: number
  max_retry?: number
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

export interface Feedback {
  id: string
  skill_id: string
  conversation_id?: string
  rating: 'positive' | 'negative'
  note?: string
  original_output?: string
  corrected_output?: string
  is_used_for_training: boolean
  created_at: number
}
