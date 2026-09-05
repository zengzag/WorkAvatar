/** 员工来源：user=用户创建（DB 落库） / builtin=宿主内置（运行时注册） / plugin=插件声明（运行时注册） */
export type EmployeeSource = 'user' | 'builtin' | 'plugin'

export interface Employee {
  id: string
  workspace_path?: string
  name: string
  description: string
  rules: string
  profile_json: string
  avatar_type: string
  default_skill_id?: string
  /** 员工来源，缺省视为 user（旧数据兼容） */
  source?: EmployeeSource
  /** 注册表内唯一 key（内置员工如 knowledge-base，插件员工如 calendar-assistant） */
  source_key?: string
  /** 归属插件 id（仅 source=plugin），用于 UI 按插件分组与禁用时下线 */
  plugin_id?: string
  /** 归属插件显示名（仅 source=plugin，随列表下发） */
  plugin_name?: string
  /** 是否启用（缺省 true）。禁用后任务界面不可被选为发起任务的员工 */
  is_enabled?: boolean
  /** 注册员工默认启用的工具 id 列表（内置/插件声明，随列表下发，仅注册员工有） */
  defaultTools?: string[]
  /** 委托能力设置 JSON（EmployeeDelegationConfig 序列化），空串/缺失表示未配置 */
  delegation_json?: string | null
  memory_enabled: boolean
  /** 注册员工影子记录标记（DB 占位行，仅外键引用用，不参与列表展示） */
  is_registered?: number
  arch_version: number
  total_tasks: number
  total_approvals: number
  last_active_at?: number | null
  created_at: number
  updated_at: number
}

/** 数字员工委托能力设置（存储于 employees.delegation_json） */
export interface EmployeeDelegationConfig {
  /** 是否允许本员工将子任务委托给其他数字员工 */
  enabled: boolean
  /** 可委托的目标数字员工 id 列表（不含自己） */
  targetIds: string[]
  /** 是否允许被其他数字员工委托任务（默认 true，保持旧行为） */
  acceptDelegation: boolean
}

/** 解析 delegation_json，容错缺失/非法 JSON，返回默认配置 */
export function parseEmployeeDelegation(json?: string | null): EmployeeDelegationConfig {
  if (!json) return { enabled: false, targetIds: [], acceptDelegation: true }
  try {
    const o = JSON.parse(json)
    return {
      enabled: o?.enabled === true,
      targetIds: Array.isArray(o?.targetIds)
        ? o.targetIds.filter((x: unknown): x is string => typeof x === 'string')
        : [],
      acceptDelegation: o?.acceptDelegation !== false,
    }
  } catch {
    return { enabled: false, targetIds: [], acceptDelegation: true }
  }
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
  /** 对话绑定的默认模型（输入框模型按钮）：各任务独立，JSON 形如 {"providerId":"","modelId":""} */
  default_model_json?: string
  /** 任务独立工作区目录（空字符串表示未分配，回退到员工工作区） */
  workspace_path?: string
  /** 父会话 ID：委托产生的子会话记录其主管会话 ID，空字符串表示顶层会话 */
  parent_conversation_id?: string
}

export type LLMProviderType = 'openai' | 'openai-compatible' | 'lmstudio' | 'deepseek' | 'qwen' | 'zhipu' | 'volcengine' | 'xiaomi' | 'moonshot' | 'yi' | 'groq' | 'mistral' | 'azure' | 'vertex' | 'bedrock' | 'xai'

/** 思考级别：false=关闭，'low'/'medium'/'high'=开启并指定强度 */
export type ThinkingLevel = false | 'low' | 'medium' | 'high'

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
  enable_thinking?: ThinkingLevel
  thinking_budget?: number
  max_retry?: number
  context_window?: number
  is_default?: boolean
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
