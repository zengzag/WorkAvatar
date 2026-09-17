import type { ThinkingLevel } from '../../../../shared/types'

/**
 * Per-provider pi-ai compat 配置表（单一数据源）。
 * pi-ai-provider.ts 与 pi-agent-adapter.ts 共用，消除重复逻辑。
 *
 * 设计原则：
 * - 只设置确定需要的字段，其余让 pi-ai 按 baseUrl 自动检测
 * - 国产 provider（不在 pi-ai 自动检测列表中）需显式设置全部字段
 * - 支持 prompt caching 的 provider 启用 sessionAffinity 以最大化 cache 命中
 * - 与 pi-ai 内置 provider 目录（node_modules/@earendil-works/pi-ai/dist/providers/data/*.json）
 *   的 compat 保持一致，避免合成 Model 与官方目录行为漂移
 */
export interface ProviderCompatConfig {
  thinkingFormat?: 'deepseek' | 'qwen' | 'zai' | 'openai'
  supportsDeveloperRole: boolean
  supportsReasoningEffort: boolean
  maxTokensField: 'max_completion_tokens' | 'max_tokens'
  supportsStore: boolean
  supportsStrictMode: boolean
  /** 发送 session affinity headers（prompt_cache_key 等）以最大化 cache 命中 */
  sendSessionAffinityHeaders: boolean
  sessionAffinityFormat?: 'openai' | 'openai-nosession'
  /** 多轮工具调用+思考模式下，assistant 消息必须回传 reasoning_content */
  requiresReasoningContentOnAssistantMessages?: boolean
  /**
   * reasoning 必须始终开启：该 provider 下模型均为推理模型，
   * 且部分「always think」模型不可关闭思考（缺 reasoning 参数会被上游拒绝，如 OpenCode Go 报 1210）。
   * 开启后合成 Model 的 reasoning 恒为 true，并在未显式开启思考时注入 defaultReasoningEffort。
   */
  alwaysReasoning?: boolean
  /** alwaysReasoning 场景下，未显式开启思考时使用的默认强度 */
  defaultReasoningEffort?: 'low' | 'medium' | 'high'
  /**
   * 需随每个请求发送的附加 HTTP 头。
   * 值等于 '@sessionId' 时替换为当前会话 ID（用于会话路由/prompt cache 亲和）。
   */
  extraRequestHeaders?: Record<string, string>
  /** ZAI/GLM 的工具调用流式增量格式（对应 pi-ai compat.zaiToolStream） */
  zaiToolStream?: boolean
  /** 逐模型覆盖 provider 级 compat。
   * pi-ai 目录是「逐模型」的，同一 provider 下不同模型常需不同 compat
   * （如 deepseek-chat 与 deepseek 推理模型、Kimi K2.x 与 K3），
   * 用模型 ID 正则做最小覆盖，避免 provider 级一刀切误伤非推理模型。
   * patch 中显式写 `undefined` 可清除 provider 级取值（如把 thinkingFormat 清空）。
   */
  modelOverrides?: ModelCompatOverride[]
  /** 该 provider（或其某类模型）是否默认支持图片输入。未设置视为 false（保守降级 OCR），
   *  用户可在模型设置的「支持图片输入」中显式覆盖（on/off） */
  visionDefault?: boolean
}

/** 按模型 ID 正则覆盖 provider 级 compat（数组内首个命中生效） */
export interface ModelCompatOverride {
  match: RegExp
  patch: Partial<ProviderCompatConfig>
}

/** extraRequestHeaders 中代表当前会话 ID 的占位符 */
const SESSION_ID_PLACEHOLDER = '@sessionId'

const DEFAULT: ProviderCompatConfig = {
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  maxTokensField: 'max_completion_tokens',
  supportsStore: true,
  supportsStrictMode: true,
  sendSessionAffinityHeaders: false,
}

const PROVIDER_COMPAT: Record<string, ProviderCompatConfig> = {
  // OpenAI 原生：pi-ai 自动检测，仅需启用 session affinity；
  // gpt-4o/gpt-4.x/o/gpt-5 系列支持图片输入（o1-mini 等例外由用户设置 off 覆盖）
  openai: {
    ...DEFAULT,
    visionDefault: true,
    sendSessionAffinityHeaders: true,
    sessionAffinityFormat: 'openai',
  },

  // OpenAI 兼容接口（用户自定义端点）：保守配置
  'openai-compatible': {
    ...DEFAULT,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
  },

  // LM Studio（本地推理服务）
  lmstudio: {
    ...DEFAULT,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
  },

  // DeepSeek：pi-ai 自动检测 baseUrl，支持 prompt caching
  // 推理模型（deepseek-reasoner / deepseek-v4-*，见 pi-ai providers/data/deepseek.json）
  // 要求多轮 assistant 消息回传 reasoning_content；deepseek-chat 等非推理模型不设，
  // 避免向不接受该字段的模型回传空 reasoning_content 被上游拒绝。
  deepseek: {
    ...DEFAULT,
    thinkingFormat: 'deepseek',
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
    sendSessionAffinityHeaders: true,
    sessionAffinityFormat: 'openai',
    modelOverrides: [
      { match: /^deepseek-(reasoner|v4)/i, patch: { requiresReasoningContentOnAssistantMessages: true } },
    ],
  },

  // 通义千问（DashScope OpenAI 兼容模式）
  // 仅 qwen-vl 系支持图片输入，其余模型不设 visionDefault（保守 false）
  qwen: {
    ...DEFAULT,
    thinkingFormat: 'qwen',
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
    modelOverrides: [
      { match: /^qwen-vl/i, patch: { visionDefault: true } },
    ],
  },

  // 智谱 AI（GLM）：pi-ai 对 open.bigmodel.cn 的 zai provider 用 thinkingFormat='zai'
  // + zaiToolStream（thinking:{type,clear_thinking:false} + reasoning_effort），与官方目录一致
  zhipu: {
    ...DEFAULT,
    thinkingFormat: 'zai',
    zaiToolStream: true,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
  },

  // 火山引擎（豆包）
  volcengine: {
    ...DEFAULT,
    thinkingFormat: 'deepseek',
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
  },

  // 小米 MiMo：支持 developer role + prompt caching，多轮工具调用需回传 reasoning_content
  xiaomi: {
    ...DEFAULT,
    thinkingFormat: 'deepseek',
    supportsDeveloperRole: true,
    supportsReasoningEffort: false,
    maxTokensField: 'max_completion_tokens',
    supportsStore: false,
    supportsStrictMode: false,
    sendSessionAffinityHeaders: true,
    sessionAffinityFormat: 'openai',
    requiresReasoningContentOnAssistantMessages: true,
  },

  // Moonshot（Kimi）：pi-ai providers/data/moonshotai-cn.json 中 Kimi 系模型使用
  // thinkingFormat='deepseek' + supportsReasoningEffort=false + maxTokensField=max_tokens
  // + supportsStrictMode=false。逐模型覆盖：仅 Kimi 系启用 thinkingFormat，
  // legacy moonshot-v1-* 保持不发送 thinking 参数（历史兼容，避免老模型拒绝该字段）；
  // K3 改用 reasoning_effort 并要求回传 reasoning_content。
  moonshot: {
    ...DEFAULT,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
    modelOverrides: [
      {
        match: /^kimi-k3/i,
        patch: {
          thinkingFormat: undefined,
          supportsReasoningEffort: true,
          requiresReasoningContentOnAssistantMessages: true,
        },
      },
      { match: /^kimi-k2/i, patch: { thinkingFormat: 'deepseek' } },
    ],
  },

  // 零一万物（Yi）
  yi: {
    ...DEFAULT,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
  },

  // Groq
  groq: {
    ...DEFAULT,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
  },

  // Mistral
  mistral: {
    ...DEFAULT,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
  },

  // Azure OpenAI
  azure: {
    ...DEFAULT,
    sendSessionAffinityHeaders: true,
    sessionAffinityFormat: 'openai',
  },

  // Google Vertex AI（通过 OpenAI 兼容端点）
  vertex: {
    ...DEFAULT,
    supportsStrictMode: false,
  },

  // AWS Bedrock（通过 OpenAI 兼容端点）
  bedrock: {
    ...DEFAULT,
    supportsStrictMode: false,
  },

  // xAI (Grok)：pi-ai 自动检测 baseUrl
  xai: {
    ...DEFAULT,
    supportsStore: false,
    supportsStrictMode: false,
  },

  // OpenCode Go（opencode.ai/zen/go）：低成本开源编程模型订阅网关（OpenAI 兼容端点）。
  // 依据 pi-ai 0.85.1 内置的 opencode-go provider（providers/data/opencode-go.json）：
  // - 全部模型 reasoning=true；部分「always think」模型不可关闭思考，缺 reasoning 参数报 1210
  // - 聚合 GLM / Kimi / DeepSeek / MiMo / MiniMax / Qwen 等异构模型，统一 max_tokens 字段
  // - 不支持 store / developer role；聚合网关不做严格 schema，保守关闭 strict mode
  // - deepseek-v4 / kimi 系模型多轮工具调用需回传 reasoning_content
  // - 要求客户端携带会话路由头 x-opencode-session + 客户端标识 x-opencode-client，
  //   以便把同一会话固定到同一上游实例、提升 prompt cache 命中（官方公告：缺失该头的请求可能被逐步拒绝）
  'opencode-go': {
    ...DEFAULT,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
    alwaysReasoning: true,
    defaultReasoningEffort: 'low',
    sendSessionAffinityHeaders: true,
    // 使用 openai-nosession：只发送亲和头，不发送 OpenAI 专用的 session_id 头
    sessionAffinityFormat: 'openai-nosession',
    requiresReasoningContentOnAssistantMessages: true,
    extraRequestHeaders: {
      'x-opencode-client': 'workavatar',
      'x-opencode-session': SESSION_ID_PLACEHOLDER,
    },
  },
}

/**
 * 获取 provider 的 compat 配置，未知 provider 使用 DEFAULT。
 * 传入 modelId 时应用 modelOverrides 中首个命中的逐模型覆盖。
 * 对有 thinkingFormat / alwaysReasoning 的 provider，reasoning 必须始终为 true（见调用方）。
 */
export function getProviderCompat(providerType?: string, modelId?: string): ProviderCompatConfig {
  // provider_type 来自 DB 配置，大小写可能不一致：统一小写查表，避免落回 DEFAULT 丢失差异配置
  const key = (providerType || '').toLowerCase()
  const base = PROVIDER_COMPAT[key] || DEFAULT
  if (!modelId || !base.modelOverrides?.length) return base
  for (const override of base.modelOverrides) {
    if (override.match.test(modelId)) return { ...base, ...override.patch }
  }
  return base
}

/**
 * 解析实际发送给 pi-ai 的思考强度。
 * - 用户/模型显式开启思考 → 使用该强度
 * - 否则若 provider 要求 alwaysReasoning（如 OpenCode Go 不可关闭思考）→ 注入 defaultReasoningEffort（默认 low）
 * - 其余情况返回 false（沿用 pi-ai 默认关闭行为）
 */
export function resolveReasoningEffort(
  providerType: string | undefined,
  modelId: string | undefined,
  enableThinking?: ThinkingLevel,
): ThinkingLevel {
  if (enableThinking) return enableThinking
  const compat = getProviderCompat(providerType, modelId)
  return compat.alwaysReasoning ? (compat.defaultReasoningEffort ?? 'low') : false
}

/**
 * 解析模型是否支持图片（视觉）输入。
 * 优先级：模型设置显式 on/off > provider visionDefault（可经 modelOverrides 按模型 ID 正则预设）> false。
 * 聚合网关（如 opencode-go）下异构模型风格各异，未预设的一律按 false 保守处理，
 * 用户可在模型设置中显式开启。
 */
export function resolveImageSupport(
  providerType: string | undefined,
  modelId?: string,
  modelSetting?: 'on' | 'off',
): boolean {
  if (modelSetting === 'on') return true
  if (modelSetting === 'off') return false
  return getProviderCompat(providerType, modelId).visionDefault === true
}

/**
 * 构建 provider 的附加请求头（会话路由等）。
 * 仅含 extraRequestHeaders 的 provider 才返回；@sessionId 占位符在无会话 ID 时跳过该头。
 */
export function getProviderExtraRequestHeaders(
  providerType: string | undefined,
  modelId: string | undefined,
  sessionId?: string,
): Record<string, string> | undefined {
  const template = getProviderCompat(providerType, modelId).extraRequestHeaders
  if (!template) return undefined
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(template)) {
    if (value === SESSION_ID_PLACEHOLDER) {
      if (sessionId) headers[name] = sessionId
    } else {
      headers[name] = value
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}
