export type {
  Employee,
  EmployeeSource,
  Skill,
  Conversation,
  ParseResult,
  LLMProviderType,
  LLMApiFormat,
  LLMModelCategory,
  LLMModelConfig,
  LLMProvider,
  GeneratedFileInfo,
  ThinkingLevel,
  EmployeeDelegationConfig,
} from '../../electron/shared/types'

export { parseEmployeeDelegation, SETTING_DELEGATION_ENABLED } from '../../electron/shared/types'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  isError?: boolean
}
