import { Message } from '../core/types'

export type MemoryStrategy = 'sliding_window' | 'summary' | 'sliding_window_with_summary'

/** 摘要回调：systemPrompt 为主会话系统提示词，使摘要调用复用主前缀缓存 */
export type SummarizeFn = (
  messages: Message[],
  context?: { systemPrompt?: string }
) => Promise<string>

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
  /** 锚定在 system 之后、历史之前的稳定上下文消息（agent 生命周期字节冻结，永不参与压缩） */
  headAnchors?: Message[]
  /** 置于历史之后、真实 query 之前的易变任务上下文消息（不参与压缩，变化只影响尾部） */
  tailContext?: Message[]
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
