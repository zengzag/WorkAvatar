import type { ThinkingLevel } from '../../../../shared/types'

export interface LLMCallOptions {
  temperature?: number
  maxTokens?: number
  topP?: number
  stopSequences?: string[]
  enableThinking?: ThinkingLevel
  providerType?: string
  logSource?: string
  /** 会话 ID，用于支持 prompt caching 的 provider 最大化 cache 命中 */
  sessionId?: string
  /** 取消信号（chat 非流式调用同样支持取消） */
  signal?: AbortSignal
  /** 频率惩罚（映射到 pi-ai samplingParams.frequency_penalty） */
  frequencyPenalty?: number
  /** 存在惩罚（映射到 pi-ai samplingParams.presence_penalty） */
  presencePenalty?: number
  /** 思考 token 预算（映射到 pi-ai thinkingBudgets，按强度档位统一设置） */
  thinkingBudget?: number
  /** 单次请求超时（毫秒，映射到 pi-ai timeoutMs） */
  timeoutMs?: number
  /** 供应商级附加请求头（映射到 pi-ai options.headers，优先级高于内置会话路由头） */
  extraHeaders?: Record<string, string>
  /** 供应商级附加请求体字段（映射到 pi-ai options.onPayload，浅合并进请求体） */
  extraBody?: Record<string, any>
}

export interface LLMResponse {
  content: string
  reasoningContent?: string
  toolCalls?: LLMToolCall[]
  finishReason?: string
  usage?: LLMUsage
  latencyMs?: number
}

export interface LLMToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface LLMUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}

export interface LLMToolCallDelta {
  index: number
  id?: string
  name?: string
  arguments: string
}

export interface LLMStreamCallbacks {
  onChunk: (chunk: string) => void
  onThought: (thought: string) => void
  onToolCall: (toolCalls: LLMToolCall[]) => void
  onToolCallDelta?: (delta: LLMToolCallDelta) => void
}

export interface ILLMProvider {
  readonly name: string

  chat(
    messages: LLMMessage[],
    tools?: any[],
    options?: LLMCallOptions
  ): Promise<LLMResponse>

  chatStream(
    messages: LLMMessage[],
    tools: any[],
    callbacks: LLMStreamCallbacks,
    signal?: AbortSignal,
    options?: LLMCallOptions
  ): Promise<LLMResponse>

  estimateTokens(messages: LLMMessage[]): number
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LLMMessageContentPart[]
  reasoning_content?: string
  tool_calls?: LLMToolCall[]
  tool_call_id?: string
}

export interface LLMMessageContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: {
    url: string
    detail?: 'low' | 'high' | 'auto'
  }
}

export interface LLMProviderConfig {
  model: string
  apiKey?: string
  baseUrl?: string
  providerType?: string
  defaultOptions?: LLMCallOptions
}
