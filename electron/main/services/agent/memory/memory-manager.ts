import { Message } from '../core/types'
import {
  IMemoryManager,
  MemoryConfig,
  MemoryStats,
  ManageContextOptions,
  DEFAULT_MEMORY_CONFIG,
} from './types'
import { createLogger } from '../../logger'

const logger = createLogger('MemoryManager')

export class MemoryManager implements IMemoryManager {
  private config: MemoryConfig
  private lastStats: MemoryStats | null = null

  constructor(config?: Partial<MemoryConfig>) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config }
  }

  async manageContext(
    systemPrompt: string,
    history: Message[],
    currentQuery: string,
    options?: ManageContextOptions
  ): Promise<{ messages: Message[]; stats: MemoryStats }> {
    const systemMessage: Message = {
      role: 'system',
      content: systemPrompt,
    }

    const userMessage: Message = {
      role: 'user',
      content: currentQuery,
    }

    const fixedMessages = [systemMessage, userMessage]
    const fixedTokens = this.estimateTokens(fixedMessages)
    const availableForHistory = this.config.maxTokens - fixedTokens - this.config.reservedResponseTokens

    let managedHistory = [...history]
    let wasCompressed = false

    const historyTokens = this.estimateTokens(managedHistory)
    const shouldCompress = options?.forceCompress || historyTokens > availableForHistory

    if (shouldCompress && managedHistory.length > 0) {
      wasCompressed = true
      managedHistory = await this.compressHistory(managedHistory, availableForHistory)
    }

    const finalMessages = [systemMessage, ...managedHistory, userMessage]
    const totalTokens = this.estimateTokens(finalMessages)

    const stats: MemoryStats = {
      totalMessages: finalMessages.length,
      estimatedTokens: totalTokens,
      actualPromptTokens: options?.lastKnownPromptTokens,
      maxTokens: this.config.maxTokens,
      utilizationPercent: Math.round((totalTokens / this.config.maxTokens) * 100),
      strategy: this.config.strategy,
      wasCompressed,
    }
    this.lastStats = stats

    return { messages: finalMessages, stats }
  }

  estimateTokens(messages: Message[]): number {
    let totalChars = 0
    for (const msg of messages) {
      // 每条消息的结构开销（role、分隔符、JSON 包装），
      // OpenAI 系列 chat template 平均每条额外 4-6 token，这里按 5 token ≈ 17 字符估算
      totalChars += 17
      totalChars += (msg.role?.length ?? 0)
      totalChars += (msg.content?.length ?? 0)
      totalChars += (msg.reasoning_content?.length ?? 0)
      if (msg.toolCallId) {
        totalChars += msg.toolCallId.length + 20 // "tool_call_id":"..." 包装
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          // 工具调用结构开销：id、type、function、name、arguments 包装
          totalChars += 60
          totalChars += (tc.id?.length ?? 0)
          totalChars += (tc.type?.length ?? 0)
          totalChars += (tc.function.name?.length ?? 0)
          totalChars += (tc.function.arguments?.length ?? 0)
        }
      }
    }
    return Math.ceil(totalChars / 3.5)
  }

  getStats(): MemoryStats | null {
    return this.lastStats
  }

  setActualPromptTokens(promptTokens: number): void {
    if (this.lastStats) {
      this.lastStats.actualPromptTokens = promptTokens
      this.lastStats.utilizationPercent = Math.round((promptTokens / this.lastStats.maxTokens) * 100)
    }
  }

  private async compressHistory(history: Message[], tokenBudget: number): Promise<Message[]> {
    switch (this.config.strategy) {
      case 'sliding_window':
        return this.slidingWindowCompress(history, tokenBudget)
      case 'summary':
        return this.summaryCompress(history, tokenBudget)
      case 'sliding_window_with_summary':
        return this.slidingWindowWithSummaryCompress(history, tokenBudget)
      default:
        return this.slidingWindowCompress(history, tokenBudget)
    }
  }

  private slidingWindowCompress(history: Message[], tokenBudget: number): Message[] {
    const recentTurns = this.config.recentTurnsToKeep
    const recentMessages = this.getLastNTurns(history, recentTurns)
    const recentTokens = this.estimateTokens(recentMessages)

    if (recentTokens <= tokenBudget) {
      return recentMessages
    }

    return this.truncateFromStart(recentMessages, tokenBudget)
  }

  private async summaryCompress(history: Message[], tokenBudget: number): Promise<Message[]> {
    if (history.length <= 4) {
      return this.truncateFromStart(history, tokenBudget)
    }

    const olderMessages = history.slice(0, -4)
    const recentMessages = history.slice(-4)

    const summary = await this.generateSummary(olderMessages)
    const summaryMessage: Message = {
      role: 'system',
      content: `[对话历史摘要]\n${summary}`,
    }

    const compressed = [summaryMessage, ...recentMessages]
    const compressedTokens = this.estimateTokens(compressed)

    if (compressedTokens <= tokenBudget) {
      return compressed
    }

    return this.truncateFromStart(recentMessages, tokenBudget)
  }

  private async slidingWindowWithSummaryCompress(history: Message[], tokenBudget: number): Promise<Message[]> {
    const recentTurns = this.config.recentTurnsToKeep
    const recentMessages = this.getLastNTurns(history, recentTurns)
    const recentTokens = this.estimateTokens(recentMessages)

    if (recentTokens <= tokenBudget) {
      const olderMessages = history.slice(0, history.length - recentMessages.length)
      if (olderMessages.length > 0) {
        const summary = await this.generateSummary(olderMessages)
        const summaryMessage: Message = {
          role: 'system',
          content: `[对话历史摘要]\n${summary}`,
        }
        return [summaryMessage, ...recentMessages]
      }
      return recentMessages
    }

    return this.truncateFromStart(recentMessages, tokenBudget)
  }

  private getLastNTurns(history: Message[], turns: number): Message[] {
    let turnCount = 0
    let startIndex = history.length

    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        turnCount++
        if (turnCount >= turns) {
          startIndex = i
          break
        }
      }
      startIndex = i
    }

    return history.slice(startIndex)
  }

  private truncateFromStart(messages: Message[], tokenBudget: number): Message[] {
    const totalTokens = this.estimateTokens(messages)

    if (totalTokens <= tokenBudget) {
      return messages
    }

    const result: Message[] = []
    let keptTokens = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.estimateTokens([messages[i]])
      if (result.length === 0 || keptTokens + msgTokens <= tokenBudget) {
        result.unshift(messages[i])
        keptTokens += msgTokens
      } else {
        break
      }
    }

    return result
  }

  private async generateSummary(messages: Message[]): Promise<string> {
    if (this.config.summarizeFn) {
      try {
        return await this.config.summarizeFn(messages)
      } catch (err) {
        logger.warn('LLM摘要失败，回退到简单摘要', err)
      }
    }
    return this.generateSimpleSummary(messages)
  }

  private generateSimpleSummary(messages: Message[]): string {
    const userMessages = messages.filter(m => m.role === 'user')
    const assistantMessages = messages.filter(m => m.role === 'assistant')

    const topics: string[] = []
    for (const msg of userMessages) {
      const preview = msg.content.substring(0, 100).trim()
      if (preview) {
        topics.push(`- 用户询问: ${preview}${msg.content.length > 100 ? '...' : ''}`)
      }
    }

    const summaryParts: string[] = []
    if (topics.length > 0) {
      summaryParts.push(`讨论了 ${topics.length} 个话题：`)
      summaryParts.push(...topics.slice(0, 10))
    }
    summaryParts.push(`共 ${userMessages.length} 条用户消息，${assistantMessages.length} 条助手回复。`)

    return summaryParts.join('\n')
  }
}
