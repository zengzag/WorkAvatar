import { Message } from '../core/types'

export type MemoryStrategy = 'sliding_window' | 'summary' | 'sliding_window_with_summary'

export type LLMSummaryFn = (messages: Array<{ role: string; content: string }>) => Promise<string>

export interface MemoryConfig {
  maxTokens: number
  strategy: MemoryStrategy
  reservedSystemTokens: number
  reservedResponseTokens: number
  recentTurnsToKeep: number
  summaryMaxTokens: number
}

export interface MemoryStats {
  totalMessages: number
  estimatedTokens: number
  maxTokens: number
  utilizationPercent: number
  strategy: MemoryStrategy
  wasCompressed: boolean
}

export interface IMemoryManager {
  manageContext(
    systemPrompt: string,
    history: Message[],
    currentQuery: string
  ): { messages: Message[]; stats: MemoryStats }

  estimateTokens(messages: Message[]): number

  setLLMSummaryFn(fn: LLMSummaryFn): void
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxTokens: 128000,
  strategy: 'sliding_window',
  reservedSystemTokens: 4096,
  reservedResponseTokens: 4096,
  recentTurnsToKeep: 10,
  summaryMaxTokens: 2000,
}
