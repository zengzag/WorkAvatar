export type {
  Employee,
  Skill,
  Conversation,
  ParseResult,
  LLMProviderType,
  LLMModelCategory,
  LLMModelConfig,
  LLMProvider,
  GeneratedFileInfo,
  ThinkingLevel,
} from '../../electron/shared/types'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  isError?: boolean
}
