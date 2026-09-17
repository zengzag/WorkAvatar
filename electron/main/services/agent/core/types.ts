import type { GeneratedFileInfo, ThinkingLevel } from '../../../../shared/types'

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning_content?: string
  toolCallId?: string
  toolCalls?: ToolCall[]
  timestamp?: number
  metadata?: MessageMetadata
  images?: string[]
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface MessageMetadata {
  tokenCount?: number
  latencyMs?: number
  model?: string
  finishReason?: string
}

/**
 * 传给 pi-ai stream 的采样与传输设置（由供应商 / 模型配置派生）。
 * 键名与 LLMCallOptions 保持一致，便于直接展开进 PiAIProvider.defaultOptions 或 pi-ai StreamOptions。
 */
export interface AgentStreamSettings {
  temperature?: number
  maxTokens?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  /** 思考 token 预算（映射到 pi-ai thinkingBudgets） */
  thinkingBudget?: number
  /** 单次请求超时（毫秒，映射到 pi-ai timeoutMs） */
  timeoutMs?: number
  /** 供应商级附加请求头（映射到 pi-ai options.headers） */
  extraHeaders?: Record<string, string>
  /** 供应商级附加请求体字段（映射到 pi-ai options.onPayload） */
  extraBody?: Record<string, any>
}

export interface AgentConfig {
  name?: string
  instructions?: string
  role?: string
  model: string
  apiKey?: string
  baseUrl?: string
  providerType?: string
  /** 模型是否支持图片（视觉）输入；由 provider 预设 + 模型设置 supports_image_input 解析 */
  supportsImageInput?: boolean
  enableThinking?: ThinkingLevel
  maxIterations?: number
  debug?: boolean
  logLevel?: LogLevel
  /** 会话 ID，用于支持 prompt caching 的 provider 最大化 cache 命中 */
  sessionId?: string
  /** 采样 / 传输设置（temperature、max_tokens、top_p、penalties、thinking budget、超时、附加头/体） */
  stream?: AgentStreamSettings
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AgentRunOptions {
  query: string
  tools?: string[]
  stream?: boolean
  maxIterations?: number
  history?: Message[]
  metadata?: Record<string, any>
  useSkills?: boolean
}

export interface AgentResponse {
  content: string
  reasoning_content?: string
  toolCalls?: ToolCallRecord[]
  success: boolean
  error?: string
  metadata?: AgentResponseMetadata
}

export interface ToolCallRecord {
  name: string
  args: any
  result: any
  latencyMs?: number
  success?: boolean
}

export interface AgentResponseMetadata {
  totalLatencyMs?: number
  iterations?: number
  /** 本次 run 是否被中止（用户停止/切换/异常中断），前端据此展示中断提醒 */
  aborted?: boolean
  /** 中断原因描述，便于排查 aborted 是用户主动停止还是底层异常 */
  abortReason?: string
  tokenUsage?: TokenUsage
  contextStats?: {
    totalMessages: number
    estimatedTokens: number
    actualPromptTokens?: number
    maxTokens: number
    utilizationPercent: number
    strategy: string
    wasCompressed: boolean
  }
}

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}

export interface AgentRunStreamCallbacks {
  onChunk?: (chunk: string) => void
  onThought?: (thought: string) => void
  onToolCall?: (toolCall: { id: string; name: string; args: any }) => void
  onToolCallDelta?: (delta: { index: number; id?: string; name?: string; arguments: string }) => void
  onToolResult?: (toolResult: { name: string; result: any; rawResult?: any; generatedFiles?: GeneratedFileInfo[]; images?: string[]; success?: boolean }) => void
  onToolProgress?: (progress: { toolCallId: string; name: string; progress: any }) => void
  onDone?: (metadata?: AgentResponseMetadata) => void
  onError?: (error: string) => void
  onPlan?: (plan: string) => void
  onIterationStart?: (iteration: number) => void
  onIterationEnd?: (iteration: number) => void
}

export type AgentState =
  | 'idle'
  | 'planning'
  | 'running'
  | 'tool_calling'
  | 'responding'
  | 'completed'
  | 'error'
  | 'aborted'
