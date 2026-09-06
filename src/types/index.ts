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
  EmployeeDelegationConfig,
} from '../../electron/shared/types'

export { parseEmployeeDelegation } from '../../electron/shared/types'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  isError?: boolean
}
