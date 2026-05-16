export interface LLMCallOptions {
  temperature?: number
  maxTokens?: number
  topP?: number
  stopSequences?: string[]
  enableThinking?: boolean
  providerType?: string
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
}

export interface LLMStreamCallbacks {
  onChunk: (chunk: string) => void
  onThought: (thought: string) => void
  onToolCall: (toolCalls: LLMToolCall[]) => void
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
    signal?: AbortSignal
  ): Promise<LLMResponse>

  estimateTokens(messages: LLMMessage[]): number
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning_content?: string
  tool_calls?: LLMToolCall[]
  tool_call_id?: string
}

export interface LLMProviderConfig {
  model: string
  apiKey?: string
  baseUrl?: string
  providerType?: string
  defaultOptions?: LLMCallOptions
}
