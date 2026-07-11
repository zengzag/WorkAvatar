import type { GeneratedFileInfo } from '../../../../shared/types'

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

export interface AgentConfig {
  name?: string
  instructions?: string
  role?: string
  model: string
  apiKey?: string
  baseUrl?: string
  providerType?: string
  enableThinking?: boolean
  maxIterations?: number
  debug?: boolean
  logLevel?: LogLevel
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
  tokenUsage?: TokenUsage
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
  onToolResult?: (toolResult: { name: string; result: any; rawResult?: any; generatedFiles?: GeneratedFileInfo[] }) => void
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
