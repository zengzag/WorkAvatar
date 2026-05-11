export type {
  Project,
  File,
  Employee,
  Skill,
  Conversation,
  ParseResult,
  LLMProviderType,
  LLMModelConfig,
  LLMProvider,
} from '../../electron/shared/types'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  isError?: boolean
}
