import { Message } from '../core/types'

export type MemoryStrategy = 'sliding_window' | 'summary' | 'sliding_window_with_summary'

export interface MemoryConfig {
  maxTokens: number
  strategy: MemoryStrategy
  reservedResponseTokens: number
  recentTurnsToKeep: number
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
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxTokens: 128000,
  strategy: 'sliding_window',
  reservedResponseTokens: 4096,
  recentTurnsToKeep: 10,
}
