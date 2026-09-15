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

/** 单张图片的 token 估算（对齐主流视觉模型单图典型开销，防止图片对话压缩触发滞后） */
const IMAGE_ESTIMATE_TOKENS = 1500

export class MemoryManager implements IMemoryManager {
  private config: MemoryConfig
  private lastStats: MemoryStats | null = null
  /** 摘要缓存：长会话同一批历史不随每轮 run 重复调 LLM 摘要 */
  private lastSummaryKey: string | null = null
  private lastSummaryText = ''
  private lastSummaryPromise: Promise<string> | null = null

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
    let imageCount = 0
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
      // 图片按视觉模型的典型单图开销估算，避免 base64 对话压缩触发滞后
      imageCount += (msg.images?.length ?? 0)
    }
    return Math.ceil(totalChars / 3.5) + imageCount * IMAGE_ESTIMATE_TOKENS
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

    return this.repairToolCallPairing(result)
  }

  /**
   * 修复截断造成的 tool_call 配对破坏：OpenAI 协议要求 assistant.tool_calls 与其
   * tool 结果消息必须成对出现，拆开发给 API 直接 400。
   * - 段首是孤儿 tool 消息 → 把所属 assistant(toolCalls) 补回段首
   * - 段尾是孤立 assistant(toolCalls)（其 tool 结果在段外）→ 丢弃该 assistant
   */
  private repairToolCallPairing(messages: Message[]): Message[] {
    if (messages.length === 0) return messages

    // 段首孤儿 tool：回退起点至所属 assistant(toolCalls)
    let start = 0
    while (start < messages.length && messages[start].role === 'tool') {
      const ownerId = messages[start].toolCallId
      let ownerIdx = -1
      for (let i = start - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role === 'assistant' && (m.toolCalls ?? []).some((tc) => tc.id === ownerId)) {
          ownerIdx = i
          break
        }
      }
      if (ownerIdx >= 0) {
        start = ownerIdx
      } else {
        // 找不到所属 assistant（异常序列），丢弃该孤儿 tool
        start++
      }
    }

    // 段尾孤立 assistant(toolCalls)：其后无对应 tool 结果则丢弃
    let end = messages.length
    while (end > start) {
      const last = messages[end - 1]
      if (last.role !== 'assistant' || !(last.toolCalls?.length)) break
      const keptToolIds = new Set(
        messages.slice(start, end - 1).filter(m => m.role === 'tool').map(m => m.toolCallId)
      )
      const allMatched = last.toolCalls.every((tc) => keptToolIds.has(tc.id))
      if (allMatched) break
      end--
    }

    return messages.slice(start, end)
  }

  private async generateSummary(messages: Message[]): Promise<string> {
    // 同一批历史（条数一致 + 首尾内容一致）复用上轮摘要，避免长会话每轮 run 重复调 LLM
    const cacheKey = `${messages.length}:${(messages[0]?.content ?? '').slice(0, 50)}:${(messages[messages.length - 1]?.content ?? '').slice(0, 50)}`
    if (this.lastSummaryKey === cacheKey && this.lastSummaryText) {
      return this.lastSummaryText
    }
    // 进行中的同 key 摘要调用直接复用
    if (this.lastSummaryPromise && this.lastSummaryKey === cacheKey) {
      return this.lastSummaryPromise
    }

    this.lastSummaryKey = cacheKey
    const pending = (async () => {
      if (this.config.summarizeFn) {
        try {
          return await this.config.summarizeFn(messages)
        } catch (err) {
          logger.warn('LLM摘要失败，回退到简单摘要', err)
        }
      }
      return this.generateSimpleSummary(messages)
    })().then((text) => {
      // 仅当 key 仍匹配才写缓存：并发调用不同 key 时后完成者不得污染前者的缓存条目
      if (this.lastSummaryKey === cacheKey) {
        this.lastSummaryText = text
      }
      // 仅清理自己的引用：期间可能有其它 key 的摘要正在进行中
      if (this.lastSummaryPromise === pending) {
        this.lastSummaryPromise = null
      }
      return text
    }).catch((err) => {
      if (this.lastSummaryKey === cacheKey) {
        this.lastSummaryKey = null
      }
      if (this.lastSummaryPromise === pending) {
        this.lastSummaryPromise = null
      }
      throw err
    })
    this.lastSummaryPromise = pending
    return pending
  }

  private generateSimpleSummary(messages: Message[]): string {
    const userMessages = messages.filter(m => m.role === 'user')
    const assistantMessages = messages.filter(m => m.role === 'assistant')

    const topics: string[] = []
    for (const msg of userMessages) {
      const content = msg.content ?? ''
      const preview = content.substring(0, 100).trim()
      if (preview) {
        topics.push(`- 用户询问: ${preview}${content.length > 100 ? '...' : ''}`)
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
