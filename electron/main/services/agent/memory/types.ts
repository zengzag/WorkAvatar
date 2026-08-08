import { Message } from '../core/types'

export type MemoryStrategy = 'sliding_window' | 'summary' | 'sliding_window_with_summary'

export type SummarizeFn = (messages: Message[]) => Promise<string>

export interface MemoryConfig {
  maxTokens: number
  strategy: MemoryStrategy
  reservedResponseTokens: number
  recentTurnsToKeep: number
  summarizeFn?: SummarizeFn
}

export interface MemoryStats {
  totalMessages: number
  estimatedTokens: number
  actualPromptTokens?: number
  maxTokens: number
  utilizationPercent: number
  strategy: MemoryStrategy
  wasCompressed: boolean
}

export interface ManageContextOptions {
  forceCompress?: boolean
  lastKnownPromptTokens?: number
}

export interface IMemoryManager {
  manageContext(
    systemPrompt: string,
    history: Message[],
    currentQuery: string,
    options?: ManageContextOptions
  ): Promise<{ messages: Message[]; stats: MemoryStats }>

  estimateTokens(messages: Message[]): number

  getStats(): MemoryStats | null

  /** LLM 返回真实 prompt tokens 后回写，修正 lastStats */
  setActualPromptTokens(promptTokens: number): void
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxTokens: 128000,
  strategy: 'sliding_window',
  reservedResponseTokens: 4096,
  recentTurnsToKeep: 10,
}
