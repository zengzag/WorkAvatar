import type { LLMProvider } from '../types'

export const LLM_CHANNELS = {
  LLM_PROVIDER_LIST: 'llm:provider-list',
  LLM_PROVIDER_GET: 'llm:provider-get',
  LLM_PROVIDER_CREATE: 'llm:provider-create',
  LLM_PROVIDER_UPDATE: 'llm:provider-update',
  LLM_PROVIDER_DELETE: 'llm:provider-delete',
  LLM_TEST_CONNECTION: 'llm:test-connection',
  LLM_CHAT: 'llm:chat',
  LLM_CHAT_STREAM: 'llm:chat-stream',
  EMPLOYEE_CHAT_STREAM: 'employee:chat-stream',
  LLM_ABORT_CHAT: 'llm:abort-chat',
  LLM_CHAT_CHUNK: 'llm:chat-chunk',
  LLM_CHAT_DONE: 'llm:chat-done',
  LLM_CHAT_ERROR: 'llm:chat-error',
  LLM_THOUGHT: 'llm:thought',
  AGENT_TOOL_CALL: 'agent:tool-call',
  AGENT_TOOL_RESULT: 'agent:tool-result',
  INTERACTION_REQUEST: 'interaction:request',
  INTERACTION_RESPONSE: 'interaction:response',
} as const

export interface LLMProviderCreateParams {
  name: string
  provider_type: LLMProvider['provider_type']
  base_url?: string
  model: string
  api_key?: string
  temperature?: number
  max_tokens?: number
  timeout_ms?: number
  is_default?: boolean
}

export interface LLMProviderUpdateParams {
  id: string
  name?: string
  provider_type?: LLMProvider['provider_type']
  base_url?: string
  model?: string
  api_key?: string
  temperature?: number
  max_tokens?: number
  timeout_ms?: number
  is_default?: boolean
}

export interface LLMTestConnectionParams {
  provider_id: string
}

export interface LLMChatParams {
  provider_id: string
  model_id?: string
  messages: Array<{ role: string; content: string }>
  options?: {
    temperature?: number
    max_tokens?: number
  }
}

export interface LLMChatStreamParams {
  provider_id: string
  model_id?: string
  messages: Array<{ role: string; content: string }>
  options?: {
    temperature?: number
    max_tokens?: number
    stream?: boolean
  }
  enable_thinking?: boolean
}

export interface EmployeeChatStreamParams {
  employee_id: string
  provider_id: string
  model_id?: string
  messages: Array<{ role: string; content: string }>
  options?: {
    temperature?: number
    max_tokens?: number
  }
  use_skills?: boolean
  enable_thinking?: boolean
}