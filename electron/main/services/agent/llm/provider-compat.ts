/**
 * Per-provider pi-ai compat 配置表（单一数据源）。
 * pi-ai-provider.ts 与 pi-agent-adapter.ts 共用，消除重复逻辑。
 *
 * 设计原则：
 * - 只设置确定需要的字段，其余让 pi-ai 按 baseUrl 自动检测
 * - 国产 provider（不在 pi-ai 自动检测列表中）需显式设置全部字段
 * - 支持 prompt caching 的 provider 启用 sessionAffinity 以最大化 cache 命中
 */
export interface ProviderCompatConfig {
  thinkingFormat?: 'deepseek' | 'qwen'
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
}

const DEFAULT: ProviderCompatConfig = {
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  maxTokensField: 'max_completion_tokens',
  supportsStore: true,
  supportsStrictMode: true,
  sendSessionAffinityHeaders: false,
}

const PROVIDER_COMPAT: Record<string, ProviderCompatConfig> = {
  // OpenAI 原生：pi-ai 自动检测，仅需启用 session affinity
  openai: {
    ...DEFAULT,
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
  },

  // 通义千问（DashScope OpenAI 兼容模式）
  qwen: {
    ...DEFAULT,
    thinkingFormat: 'qwen',
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
  },

  // 智谱 AI（GLM）
  zhipu: {
    ...DEFAULT,
    thinkingFormat: 'deepseek',
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

  // Moonshot（Kimi）
  moonshot: {
    ...DEFAULT,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsStrictMode: false,
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
}

/**
 * 获取 provider 的 compat 配置，未知 provider 使用 DEFAULT。
 * 对有 thinkingFormat 的 provider，reasoning 必须始终为 true（见调用方）。
 */
export function getProviderCompat(providerType?: string): ProviderCompatConfig {
  return PROVIDER_COMPAT[providerType || ''] || DEFAULT
}
