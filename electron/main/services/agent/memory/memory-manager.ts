import { Message } from '../core/types'
import { createHash } from 'node:crypto'
import {
  IMemoryManager,
  MemoryConfig,
  MemoryStats,
  MemoryStrategy,
  ManageContextOptions,
  DEFAULT_MEMORY_CONFIG,
} from './types'
import { buildCheckpointMessage } from './checkpoint'
import { createLogger } from '../../logger'

const logger = createLogger('MemoryManager')

/** 单张图片的 token 估算（对齐主流视觉模型单图典型开销，防止图片对话压缩触发滞后） */
const IMAGE_ESTIMATE_TOKENS = 1500

/**
 * 冻结的压缩结果：首次压缩后固定切点与摘要，后续轮次只要前缀未变就直接复用。
 * 否则每来一个新 user turn，最近 N 轮窗口滑动 → olderMessages 变化 → 摘要重新生成，
 * checkpoint 字节变化会让 system + 稳定头之后的整个前缀失效。
 */
interface FrozenCompression {
  strategy: MemoryStrategy
  /** 已压缩进摘要/丢弃的历史消息数量（history 下标） */
  cutoff: number
  /** 前 cutoff 条消息的内容指纹，用于识别编辑/删除等历史变更 */
  prefixHash: string
  /** 摘要策略下的 checkpoint 文本；sliding_window 无摘要 */
  summary?: string
}

export class MemoryManager implements IMemoryManager {
  private config: MemoryConfig
  private lastStats: MemoryStats | null = null
  /** 摘要缓存：长会话同一批历史不随每轮 run 重复调 LLM 摘要 */
  private lastSummaryKey: string | null = null
  private lastSummaryText = ''
  private lastSummaryPromise: Promise<string> | null = null
  /** 首次压缩后冻结的切点与摘要，保证后续轮次的 checkpoint 字节稳定 */
  private frozen: FrozenCompression | null = null

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

    // 稳定锚点（system 之后、历史之前）不参与压缩：字节冻结构成缓存前缀。
    // 易变任务上下文不再进入消息列表，而是由调用方作为「请求末尾追加文本」注入，
    // 这里只把它的 token 估算计入预算。
    const headAnchors = options?.headAnchors ?? []
    const requestTailTokens = options?.requestTailTokens ?? 0

    const fixedMessages = [systemMessage, ...headAnchors, userMessage]
    const fixedTokens = this.estimateTokens(fixedMessages) + requestTailTokens
    const availableForHistory = this.config.maxTokens - fixedTokens - this.config.reservedResponseTokens

    let managedHistory = [...history]
    let wasCompressed = false

    const historyTokens = this.estimateTokens(managedHistory)
    const shouldCompress = options?.forceCompress || historyTokens > availableForHistory

    if (shouldCompress && managedHistory.length > 0) {
      wasCompressed = true
      // 首次压缩后冻结切点/摘要：后续轮次只要前缀未变且压缩结果仍在预算内，直接复用，
      // 避免最近 N 轮窗口滑动导致摘要与 checkpoint 每轮重算。
      const frozen = options?.forceCompress ? null : this.buildFromFrozen(managedHistory, availableForHistory)
      managedHistory = frozen ?? await this.compressHistory(managedHistory, availableForHistory, systemPrompt)
    }

    const finalMessages = [systemMessage, ...headAnchors, ...managedHistory, userMessage]
    const totalTokens = this.estimateTokens(finalMessages) + requestTailTokens

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

  private async compressHistory(
    history: Message[],
    tokenBudget: number,
    systemPrompt: string
  ): Promise<Message[]> {
    // 每次重压缩都先清空冻结态；成功产出可复用结果的分支会重新写入
    this.frozen = null
    switch (this.config.strategy) {
      case 'sliding_window':
        return this.slidingWindowCompress(history, tokenBudget)
      case 'summary':
        return this.summaryCompress(history, tokenBudget, systemPrompt)
      case 'sliding_window_with_summary':
        return this.slidingWindowWithSummaryCompress(history, tokenBudget, systemPrompt)
      default:
        return this.slidingWindowCompress(history, tokenBudget)
    }
  }

  private slidingWindowCompress(history: Message[], tokenBudget: number): Message[] {
    const recentTurns = this.config.recentTurnsToKeep
    const recentMessages = this.getLastNTurns(history, recentTurns)
    const recentTokens = this.estimateTokens(recentMessages)

    if (recentTokens <= tokenBudget) {
      this.freeze('sliding_window', history, history.length - recentMessages.length)
      return recentMessages
    }

    // 保留轮次本身超预算：只能丢弃更早的整轮；冻结丢弃切点，避免下一轮窗口起点再次前移
    return this.freezeSuffix('sliding_window', history, this.truncateFromStart(recentMessages, tokenBudget))
  }

  private async summaryCompress(
    history: Message[],
    tokenBudget: number,
    systemPrompt: string
  ): Promise<Message[]> {
    if (history.length <= 4) {
      return this.truncateFromStart(history, tokenBudget)
    }

    const olderMessages = history.slice(0, -4)
    const recentMessages = history.slice(-4)

    const summary = await this.generateSummary(olderMessages, systemPrompt)
    // checkpoint 是 user 消息，窗口首条若为孤儿 tool 消息会产生 [user, tool] 非法序列，需修复配对
    const compressed = this.repairToolCallPairing([buildCheckpointMessage(summary), ...recentMessages])

    const compressedTokens = this.estimateTokens(compressed)

    if (compressedTokens <= tokenBudget) {
      this.freeze('summary', history, history.length - 4, summary)
      return compressed
    }

    // 保留轮次本身超预算：丢弃摘要，冻结一个稳定的后缀切点
    return this.freezeSuffix('summary', history, this.truncateFromStart(recentMessages, tokenBudget))
  }

  private async slidingWindowWithSummaryCompress(
    history: Message[],
    tokenBudget: number,
    systemPrompt: string
  ): Promise<Message[]> {
    const recentTurns = this.config.recentTurnsToKeep
    const recentMessages = this.getLastNTurns(history, recentTurns)
    const recentTokens = this.estimateTokens(recentMessages)

    if (recentTokens <= tokenBudget) {
      const olderMessages = history.slice(0, history.length - recentMessages.length)
      if (olderMessages.length > 0) {
        const summary = await this.generateSummary(olderMessages, systemPrompt)
        const compressed = [buildCheckpointMessage(summary), ...recentMessages]
        // 压缩后仍超预算（保留轮次本身过大）时继续收窄，否则下一轮会反复触发压缩 +
        // 重算摘要，前缀每轮都被替换，KV cache 永远命中不了。
        if (this.estimateTokens(compressed) > tokenBudget) {
          return this.freezeSuffix('sliding_window_with_summary', history, this.truncateFromStart(recentMessages, tokenBudget))
        }
        this.freeze('sliding_window_with_summary', history, history.length - recentMessages.length, summary)
        return compressed
      }
      return recentMessages
    }

    return this.freezeSuffix('sliding_window_with_summary', history, this.truncateFromStart(recentMessages, tokenBudget))
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

  /** 复用冻结的切点/摘要；前缀被编辑或压缩结果已超预算时返回 null 并交由重新压缩处理 */
  private buildFromFrozen(history: Message[], tokenBudget: number): Message[] | null {
    const frozen = this.frozen
    if (!frozen || frozen.strategy !== this.config.strategy) return null
    if (frozen.cutoff <= 0 || frozen.cutoff > history.length) return null
    if (this.hashMessages(history.slice(0, frozen.cutoff)) !== frozen.prefixHash) {
      this.frozen = null
      return null
    }
    const suffix = history.slice(frozen.cutoff)
    const compressed = frozen.summary !== undefined
      ? (frozen.strategy === 'summary'
          // summary 策略的首次压缩会修复 tool 配对，复用路径必须与之一致
          ? this.repairToolCallPairing([buildCheckpointMessage(frozen.summary), ...suffix])
          : [buildCheckpointMessage(frozen.summary), ...suffix])
      : suffix
    return this.estimateTokens(compressed) <= tokenBudget ? compressed : null
  }

  /** 压缩成功后冻结切点与摘要：cutoff=0 表示没有实际压缩，不冻结 */
  private freeze(strategy: MemoryStrategy, history: Message[], cutoff: number, summary?: string): void {
    if (cutoff <= 0) {
      this.frozen = null
      return
    }
    this.frozen = {
      strategy,
      cutoff,
      prefixHash: this.hashMessages(history.slice(0, cutoff)),
      ...(summary !== undefined ? { summary } : {}),
    }
  }

  /**
   * 保留轮次本身超预算时的兜底：kept 是 history 的连续后缀，冻结其起点即可，
   * 下一轮仍按同一切点拼接新消息，不会因窗口滑动而每轮改变前缀。
   */
  private freezeSuffix(strategy: MemoryStrategy, history: Message[], kept: Message[]): Message[] {
    const cutoff = history.length - kept.length
    if (cutoff > 0) {
      this.frozen = {
        strategy,
        cutoff,
        prefixHash: this.hashMessages(history.slice(0, cutoff)),
      }
    }
    return kept
  }

  /** 前 cutoff 条消息的内容指纹：覆盖角色、正文、思考、工具调用与图片引用 */
  private hashMessages(messages: Message[]): string {
    const hash = createHash('sha1')
    for (const m of messages) {
      hash.update(m.role)
      hash.update('\u0000')
      hash.update(m.content || '')
      hash.update('\u0000')
      hash.update(m.reasoning_content || '')
      hash.update('\u0000')
      hash.update(m.toolCallId || '')
      hash.update('\u0000')
      if (m.images?.length) hash.update(m.images.join('|'))
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          hash.update(tc.id)
          hash.update('\u0000')
          hash.update(tc.function.name)
          hash.update('\u0000')
          hash.update(tc.function.arguments)
          hash.update('\u0000')
        }
      }
      hash.update('\u0001')
    }
    return hash.digest('hex')
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
      const toolCallId = messages[start].toolCallId
      let ownerIdx = -1
      for (let i = start - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role === 'assistant' && (m.toolCalls ?? []).some((tc) => tc.id === toolCallId)) {
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

  private async generateSummary(messages: Message[], systemPrompt: string): Promise<string> {
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
          return await this.config.summarizeFn(messages, { systemPrompt })
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
