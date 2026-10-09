/** 员工来源：user=用户创建（DB 落库） / builtin=宿主内置（运行时注册） / plugin=插件声明（运行时注册） / inline=模板任务内联角色（仅运行期） */
export type EmployeeSource = 'user' | 'builtin' | 'plugin' | 'inline'

/**
 * 临时子智能体规格（阶段一）：由主管 LLM 经 delegate_to_employee / launch_agents
 * 的 ephemeral_role 参数现场声明，run 期注册为 inline 员工、run 结束下线。
 * 与 workflow 模板节点的 PluginWorkflowEphemeralRole（camelCase）同构，可在宿主侧互转。
 */
export interface EphemeralSubAgentSpec {
  /** 稳定 key（slug）：用于生成 inline id；缺省由 name 派生 */
  key?: string
  name: string
  description?: string
  /** 角色系统提示词（自包含：身份/职责/输出要求/约束），子会话看不到主管对话 */
  systemPrompt: string
  /** 宿主内置工具 id 白名单；缺省使用子会话默认工具集 */
  tools?: string[]
  /** 技能 id 列表 */
  skills?: string[]
  /** 可选模型覆盖（缺省继承主管解析结果） */
  providerId?: string
  modelId?: string
}

/** 工具层入参（snake_case）→ 内部 EphemeralSubAgentSpec；校验必填并生成可修正错误文案 */
export function parseEphemeralRoleInput(raw: unknown): { spec?: EphemeralSubAgentSpec; error?: string } {
  if (!raw || typeof raw !== 'object') return { error: 'ephemeral_role 缺失或格式无效' }
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const systemPrompt = typeof o.system_prompt === 'string' ? o.system_prompt.trim() : ''
  if (!name) return { error: 'ephemeral_role.name 不能为空' }
  if (!systemPrompt) return { error: 'ephemeral_role.system_prompt 不能为空（子会话看不到主管对话，角色设定必须自包含）' }
  const spec: EphemeralSubAgentSpec = {
    name,
    systemPrompt,
    description: typeof o.description === 'string' ? o.description.trim() : undefined,
    tools: Array.isArray(o.tools) ? o.tools.filter((x): x is string => typeof x === 'string') : undefined,
    skills: Array.isArray(o.skills) ? o.skills.filter((x): x is string => typeof x === 'string') : undefined,
    key: typeof o.key === 'string' ? o.key : undefined,
    providerId: typeof o.provider_id === 'string' ? o.provider_id : undefined,
    modelId: typeof o.model_id === 'string' ? o.model_id : undefined,
  }
  return { spec }
}

/** 可复用子智能体模板（阶段二，sub_agent_profiles 表） */
export interface SubAgentProfile {
  id: string
  name: string
  description: string
  system_prompt: string
  tools_json: string
  skills_json: string
  provider_id?: string | null
  model_id?: string | null
  source: 'user' | 'builtin'
  created_at: number
  updated_at: number
}

export interface Employee {
  id: string
  workspace_path?: string
  name: string
  description: string
  rules: string
  profile_json: string
  avatar_type: string
  /** 自定义头像图标 key（robot/user/team/... 空=按 avatar_type 预设或默认） */
  avatar_icon?: string
  /** 自定义头像颜色 hex（空=按 id 自动配色） */
  avatar_color?: string
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
  /** 对话绑定的资料库合集 ID 列表：各任务独立，JSON 形如 ["id1","id2"]，空数组表示不限范围 */
  collection_ids_json?: string
  /** 任务独立工作区目录（空字符串表示未分配，回退到员工工作区） */
  workspace_path?: string
  /** 父会话 ID：委托产生的子会话记录其主管会话 ID，空字符串表示顶层会话 */
  parent_conversation_id?: string
}

export type LLMProviderType = 'openai' | 'openai-compatible' | 'lmstudio' | 'deepseek' | 'qwen' | 'zhipu' | 'volcengine' | 'xiaomi' | 'moonshot' | 'yi' | 'groq' | 'mistral' | 'azure' | 'vertex' | 'bedrock' | 'xai' | 'opencode-go'

/**
 * 接口形式（API 协议）：
 * - chat-completions: v1/chat/completions（OpenAI 兼容，默认）
 * - anthropic-messages: v1/messages（Anthropic Messages）
 * - openai-responses: v1/responses（OpenAI Responses）
 */
export type LLMApiFormat = 'chat-completions' | 'anthropic-messages' | 'openai-responses'

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
  /** 图片（视觉）输入能力：未设置=自动（按供应商预设）；'on'/'off' 显式覆盖 */
  supports_image_input?: 'on' | 'off'
  is_default?: boolean
}

export interface LLMProvider {
  id: string
  name: string
  provider_type: LLMProviderType
  base_url?: string
  /** 接口形式（API 协议），缺省为 chat-completions */
  api_format?: LLMApiFormat
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

/**
 * 脚本触发权限确认时下发给渲染端的原始脚本内容。
 * 单独成字段而不拼进 message：长脚本会撑爆弹窗与系统通知文案，渲染端改用可滚动代码块展示。
 */
export interface ScriptDisclosure {
  /** 脚本语言标识（powershell / bash / javascript），仅用于代码块标注 */
  language: string
  /** 原始脚本内容 */
  content: string
  /** 内容是否已按上限截断（渲染端据此提示查看完整内容） */
  truncated: boolean
}

/**
 * 文件改动预览（unified diff），随权限确认弹窗下发。
 * 渲染端按行首 +/-/@@ 前缀着色展示。
 */
export interface DiffDisclosure {
  /** unified diff 文本（含 @@ 头，新增行 +、删除行 -） */
  content: string
  /** 内容是否已按上限截断 */
  truncated: boolean
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
