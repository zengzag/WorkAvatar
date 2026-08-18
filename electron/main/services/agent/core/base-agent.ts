import { PiAIProvider } from '../llm/pi-ai-provider'
import type { ILLMProvider } from '../llm/types'
import { MemoryManager } from '../memory/memory-manager'
import type { IMemoryManager, MemoryConfig, MemoryStats } from '../memory/types'
import { ToolRegistry } from '../tools/tool-registry'
import { ToolDispatcher } from '../tools/tool-dispatcher'
import { ToolMiddlewareChain, createTimeoutMiddleware, createRetryMiddleware, createLoggingMiddleware, createResultSizeMiddleware } from '../tools/tool-middleware'
import type { ToolDefinition, OpenAIToolDefinition, ToolCallResult } from '../tools/types'
import { AgentEventEmitter } from './agent-events'
import { AgentContext } from './agent-context'
import { runPiAgentLoop } from './pi-agent-adapter'
import { generateId } from '../../common-utils'
import { createLogger } from '../../logger'
import type {
  AgentConfig,
  AgentRunOptions,
  AgentRunStreamCallbacks,
  AgentResponse,
  AgentResponseMetadata,
  Message,
  ToolCallRecord,
} from './types'

const logger = createLogger('BaseAgent')

const DEFAULT_MAX_ITERATIONS = 100
const DEFAULT_TOOL_TIMEOUT_MS = 30000
const DEFAULT_MAX_RESULT_SIZE = 50000
const DEFAULT_TOOL_MAX_RETRIES = 2

const SUMMARY_SYSTEM_PROMPT = `你是对话摘要助手。请将给定的对话历史压缩为结构化摘要，用词精炼而内容完整，重点保留待办事项与尚未完成的计划。

保留以下信息：
1. 用户的核心请求和目标（包括所有具体的需求细节）
2. 已完成的关键操作及其结果（包括文件路径、配置值等关键参数）
3. 进行中的任务和待办事项（标注当前进度和阻塞点）
4. 重要的决策结论和上下文事实（包括用户偏好、技术选型理由等）
5. 未解决的问题和下一步计划（包括具体方案和优先级）

删除冗余的工具调用中间过程，但保留结论性信息。摘要长度不超过1万token。`

export interface BaseAgentOptions {
  memoryConfig?: Partial<MemoryConfig>
  toolTimeoutMs?: number
  toolMaxRetries?: number
  toolMaxResultSize?: number
  onEvent?: (event: string, data: any) => void
}

export abstract class BaseAgent {
  readonly version = '2.0.0'

  protected config: AgentConfig
  protected llmProvider: ILLMProvider
  protected toolRegistry: ToolRegistry
  protected toolDispatcher: ToolDispatcher
  protected memoryManager: IMemoryManager
  protected eventEmitter: AgentEventEmitter
  protected context: AgentContext
  protected middlewareChain: ToolMiddlewareChain
  protected agentOptions: BaseAgentOptions
  // 并发保护：同一 Agent 实例不允许并发执行 run/runStream
  private _running: boolean = false
  /** 当前 runStream 的 AbortSignal，用于检测 stale lock（前端已停止但后端工具未响应 abort） */
  private _currentSignal?: AbortSignal
  private _lastKnownPromptTokens: number | undefined

  constructor(config: AgentConfig, options?: BaseAgentOptions) {
    this.config = this.normalizeConfig(config)
    this.agentOptions = options || {}
    this.eventEmitter = new AgentEventEmitter({ enabled: true })
    this.context = new AgentContext({
      agentName: this.config.name || 'BaseAgent',
      eventEmitter: this.eventEmitter,
    })
    this.llmProvider = this.createLLMProvider()
    this.toolRegistry = new ToolRegistry()
    this.toolDispatcher = new ToolDispatcher(this.toolRegistry)
    this.memoryManager = this.createMemoryManager()
    this.middlewareChain = this.toolDispatcher.getMiddlewareChain()

    this.setupDefaultMiddleware()
    this.setupEventBridge()
    this.setupEventListeners()
  }

  get name(): string {
    return this.config.name || 'BaseAgent'
  }

  get instructions(): string {
    return this.config.instructions || ''
  }

  getTools(): OpenAIToolDefinition[] {
    return this.toolRegistry.getOpenAISchemas()
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry
  }

  getToolDispatcher(): ToolDispatcher {
    return this.toolDispatcher
  }

  getMemoryManager(): IMemoryManager {
    return this.memoryManager
  }

  getContextStats(): MemoryStats | null {
    return this.memoryManager.getStats()
  }

  getEventEmitter(): AgentEventEmitter {
    return this.eventEmitter
  }

  getContext(): AgentContext {
    return this.context
  }

  getLLMProvider(): ILLMProvider {
    return this.llmProvider
  }

  registerTool(tool: ToolDefinition): boolean {
    return this.toolRegistry.registerTool(tool)
  }

  registerTools(tools: ToolDefinition[]): boolean {
    return this.toolRegistry.registerTools(tools)
  }

  unregisterTool(name: string): boolean {
    return this.toolRegistry.unregisterTool(name)
  }

  async run(options: AgentRunOptions): Promise<AgentResponse> {
    if (this._running) {
      if (this._currentSignal?.aborted) {
        logger.warn(`Agent "${this.name}" has stale _running flag (previous signal aborted), force-resetting`)
        this._running = false
      } else {
        throw new Error(`Agent "${this.name}" is already running, cannot start concurrent run`)
      }
    }
    this._running = true
    this._currentSignal = undefined
    const startTime = Date.now()
    const maxIterations = options.maxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS

    this.context.reset()
    this.context.setState('running')

    this.eventEmitter.emit('run:start', { query: options.query, maxIterations })

    try {
      // 每次 run 启动先重置 _lastKnownPromptTokens，避免跨对话（缓存 agent）泄漏旧值
      this._lastKnownPromptTokens = undefined

      const systemPrompt = this.buildSystemPrompt(options)
      const { messages, stats } = await this.memoryManager.manageContext(
        systemPrompt,
        options.history || [],
        options.query,
        { lastKnownPromptTokens: this._lastKnownPromptTokens }
      )

      const queryImages = options.metadata?.queryImages as string[] | undefined
      if (queryImages && queryImages.length > 0 && messages.length > 0) {
        const lastMsg = messages[messages.length - 1]
        if (lastMsg.role === 'user') {
          lastMsg.images = queryImages
        }
      }

      if (stats.wasCompressed) {
        this.eventEmitter.emit('memory:compressed', stats)
      }

      const activeTools = await this.resolveActiveTools(options.tools)

      const result = await this.executeLoop(messages, activeTools, maxIterations)

      this.context.setState('completed')
      this.eventEmitter.emit('run:end', { iterations: this.context.getIterationCount() })

      return {
        ...result,
        metadata: {
          totalLatencyMs: Date.now() - startTime,
          iterations: this.context.getIterationCount(),
          contextStats: this.memoryManager.getStats() ?? undefined,
        },
      }
    } catch (error: any) {
      this.context.setState('error')
      this.eventEmitter.emit('run:error', { error: error.message })

      return {
        content: '',
        success: false,
        error: error.message,
        metadata: {
          totalLatencyMs: Date.now() - startTime,
          iterations: this.context.getIterationCount(),
        },
      }
    } finally {
      // run 不使用 signal，直接清除（run 与 runStream 不会并发，因为 _running 保护）
      this._running = false
      this._currentSignal = undefined
    }
  }

  async runStream(
    options: AgentRunOptions,
    callbacks: AgentRunStreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    if (this._running) {
      // stale lock 检测：若前一次 runStream 的 signal 已被 abort（前端已停止/切换），
      // 说明 _running 是残留状态（工具未响应 abort 导致 finally 未执行），强制恢复
      if (this._currentSignal?.aborted) {
        logger.warn(`Agent "${this.name}" has stale _running flag (previous signal aborted), force-resetting`)
        this._running = false
      } else {
        throw new Error(`Agent "${this.name}" is already running, cannot start concurrent runStream`)
      }
    }
    this._running = true
    this._currentSignal = signal
    // 捕获本次 run 的 signal，finally 中仅当 _currentSignal 仍是本次时才清除
    // 避免旧 run（stale）的 finally 覆盖新 run 的 _running/_currentSignal
    const runSignal = signal
    const startTime = Date.now()
    const maxIterations = options.maxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS

    this.context.reset()
    this.context.setState('running')

    this.eventEmitter.emit('run:start', { query: options.query, maxIterations })

    try {
      // 每次 runStream 启动先重置 _lastKnownPromptTokens，避免跨对话（缓存 agent）泄漏旧值
      this._lastKnownPromptTokens = undefined

      const systemPrompt = this.buildSystemPrompt(options)
      const { messages, stats } = await this.memoryManager.manageContext(
        systemPrompt,
        options.history || [],
        options.query,
        { lastKnownPromptTokens: this._lastKnownPromptTokens }
      )

      const queryImages = options.metadata?.queryImages as string[] | undefined
      if (queryImages && queryImages.length > 0 && messages.length > 0) {
        const lastMsg = messages[messages.length - 1]
        if (lastMsg.role === 'user') {
          lastMsg.images = queryImages
        }
      }

      if (stats.wasCompressed) {
        this.eventEmitter.emit('memory:compressed', stats)
      }

      const activeTools = await this.resolveActiveTools(options.tools)

      const streamMetadata = await this.executeLoopStream(messages, activeTools, maxIterations, callbacks, signal)

      // aborted 走正常返回路径（pi-agent-adapter 已捕获 AbortError），仍透传 tokenUsage/contextStats
      this.context.setState(streamMetadata?.aborted ? 'aborted' : 'completed')
      this.eventEmitter.emit('run:end', { iterations: this.context.getIterationCount() })

      callbacks.onDone?.({
        totalLatencyMs: Date.now() - startTime,
        iterations: this.context.getIterationCount(),
        tokenUsage: streamMetadata?.tokenUsage,
        contextStats: this.memoryManager.getStats() ?? undefined,
      })
    } catch (error: any) {
      if (signal?.aborted) {
        this.context.setState('aborted')
        this.eventEmitter.emit('run:end', { iterations: this.context.getIterationCount() })
        // catch 兜底：底层异常路径下无法拿到 tokenUsage，但仍刷新 contextStats
        callbacks.onDone?.({
          totalLatencyMs: Date.now() - startTime,
          iterations: this.context.getIterationCount(),
          contextStats: this.memoryManager.getStats() ?? undefined,
        })
        return
      }

      this.context.setState('error')
      this.eventEmitter.emit('run:error', { error: error.message })
      callbacks.onError?.(error.message)
    } finally {
      // 仅当 _currentSignal 仍是本次 run 的 signal 时才清除
      // 避免被 stale run 的 finally 覆盖新 run 的状态
      if (this._currentSignal === runSignal) {
        this._running = false
        this._currentSignal = undefined
      }
    }
  }

  protected abstract buildSystemPrompt(options: AgentRunOptions): string

  protected async resolveActiveTools(runtimeToolNames?: string[]): Promise<OpenAIToolDefinition[]> {
    if (runtimeToolNames) {
      return this.toolRegistry.getOpenAISchemasByNames(runtimeToolNames)
    }
    return this.toolRegistry.getOpenAISchemas()
  }

  protected async onToolCallExecuted(_toolName: string, _args: any, _result: ToolCallResult): Promise<void> {
  }

  protected createLLMProvider(): ILLMProvider {
    return new PiAIProvider({
      model: this.config.model,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      providerType: this.config.providerType,
      defaultOptions: {
        enableThinking: this.config.enableThinking,
        providerType: this.config.providerType,
        sessionId: this.config.sessionId,
      },
    })
  }

  protected createMemoryManager(): IMemoryManager {
    const config = { ...this.agentOptions.memoryConfig }
    config.summarizeFn = async (messages: Message[]): Promise<string> => {
      const llmMessages = [
        { role: 'system' as const, content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user' as const, content: this.formatMessagesForSummary(messages) },
      ]
      const response = await this.llmProvider.chat(llmMessages, [], {
        temperature: 0.3,
        maxTokens: 10000,
      })
      return response.content || this.generateFallbackSummary(messages)
    }
    return new MemoryManager(config)
  }

  protected setupDefaultMiddleware(): void {
    // 顺序：logging(外) → retry → timeout(内) → result_size
    // retry 在 timeout 外层：每次重试获得完整 timeout，避免首次失败后剩余时间不足
    this.middlewareChain
      .use(createLoggingMiddleware((level, action, data) => {
        this.log(level, action, data)
      }))
      .use(createRetryMiddleware(this.agentOptions.toolMaxRetries ?? DEFAULT_TOOL_MAX_RETRIES))
      .use(createTimeoutMiddleware(this.agentOptions.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS))
      .use(createResultSizeMiddleware(this.agentOptions.toolMaxResultSize ?? DEFAULT_MAX_RESULT_SIZE))
  }

  protected setupEventBridge(): void {
    if (this.agentOptions.onEvent) {
      const handler = this.agentOptions.onEvent
      this.eventEmitter.on('run:start', (e) => handler('run:start', e.data))
      this.eventEmitter.on('run:end', (e) => handler('run:end', e.data))
      this.eventEmitter.on('run:error', (e) => handler('run:error', e.data))
      this.eventEmitter.on('iteration:start', (e) => handler('iteration:start', e.data))
      this.eventEmitter.on('iteration:end', (e) => handler('iteration:end', e.data))
      this.eventEmitter.on('tool:call:start', (e) => handler('tool:call:start', e.data))
      this.eventEmitter.on('tool:call:end', (e) => handler('tool:call:end', e.data))
      this.eventEmitter.on('memory:compressed', (e) => handler('memory:compressed', e.data))
      this.eventEmitter.on('plan:generated', (e) => handler('plan:generated', e.data))
      this.eventEmitter.on('state:change', (e) => handler('state:change', e.data))
    }
  }

  protected setupEventListeners(): void {}

  private async executeLoop(
    messages: Message[],
    tools: OpenAIToolDefinition[],
    maxIterations: number
  ): Promise<AgentResponse> {
    let content = ''
    let reasoningContent = ''
    const usedToolCalls: ToolCallRecord[] = []

    await runPiAgentLoop({
      config: this.config,
      messages,
      toolDefinitions: tools,
      toolDispatcher: this.toolDispatcher,
      toolRegistry: this.toolRegistry,
      maxIterations,
      eventEmitter: this.eventEmitter,
      agentContext: this.context,
      sessionId: this.config.sessionId,
      onToolCallExecuted: async (toolName, args, result) => {
        usedToolCalls.push({
          name: toolName,
          args,
          result: result.success ? result.output : result.error,
          latencyMs: result.latencyMs,
          success: result.success,
        })
        await this.onToolCallExecuted(toolName, args, result)
      },
      onPromptTokens: (tokens) => {
        this._lastKnownPromptTokens = tokens
        this.memoryManager.setActualPromptTokens(tokens)
      },
      callbacks: {
        onChunk: (chunk: string) => { content += chunk },
        onThought: (thought: string) => { reasoningContent += thought },
      },
    })

    return {
      content,
      reasoning_content: reasoningContent || undefined,
      toolCalls: usedToolCalls,
      success: true,
    }
  }

  private async executeLoopStream(
    messages: Message[],
    tools: OpenAIToolDefinition[],
    maxIterations: number,
    callbacks: AgentRunStreamCallbacks,
    signal?: AbortSignal
  ): Promise<AgentResponseMetadata & { aborted?: boolean }> {
    this.context.setState('running')

    const { tokenUsage, aborted } = await runPiAgentLoop({
      config: this.config,
      messages,
      toolDefinitions: tools,
      toolDispatcher: this.toolDispatcher,
      toolRegistry: this.toolRegistry,
      maxIterations,
      eventEmitter: this.eventEmitter,
      agentContext: this.context,
      signal,
      sessionId: this.config.sessionId,
      onToolCallExecuted: this.onToolCallExecuted.bind(this),
      onPromptTokens: (tokens) => {
        this._lastKnownPromptTokens = tokens
        this.memoryManager.setActualPromptTokens(tokens)
      },
      callbacks: {
        onChunk: callbacks.onChunk,
        onThought: callbacks.onThought,
        onToolCall: ({ id, name, args }) => {
          callbacks.onToolCall?.({ id, name, args })
        },
        onToolCallDelta: callbacks.onToolCallDelta,
        onToolResult: callbacks.onToolResult,
        onToolProgress: callbacks.onToolProgress,
        onIterationStart: callbacks.onIterationStart,
        onIterationEnd: callbacks.onIterationEnd,
      },
    })

    return { tokenUsage, aborted }
  }

  private normalizeConfig(config: AgentConfig): AgentConfig {
    return {
      ...config,
      name: config.name || `Agent_${generateId()}`,
      instructions: config.instructions || 'You are a helpful assistant.',
      maxIterations: config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      debug: config.debug ?? false,
      logLevel: config.logLevel ?? 'info',
    }
  }

  protected log(level: string, action: string, data: any): void {
    const levels: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 }
    const configLevel = levels[this.config.logLevel ?? 'info'] ?? 2
    const msgLevel = levels[level] ?? 2
    if (msgLevel > configLevel) return

    const fn = (logger as any)[level] ?? logger.info
    fn.call(logger, `[${this.name}:${action}]`, data)
  }

  private formatMessagesForSummary(messages: Message[]): string {
    const parts: string[] = []
    for (const msg of messages) {
      const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : msg.role === 'tool' ? '工具' : '系统'
      let content = msg.content || ''
      if (content.length > 2000) {
        content = content.slice(0, 2000) + '...'
      }
      parts.push(`[${roleLabel}] ${content}`)
    }
    return parts.join('\n')
  }

  private generateFallbackSummary(messages: Message[]): string {
    const userMessages = messages.filter(m => m.role === 'user')
    const topics = userMessages.map(m => `- ${m.content.substring(0, 80).trim()}`).slice(0, 10)
    return `讨论了 ${topics.length} 个话题：\n${topics.join('\n')}`
  }

  async compactConversation(
    history: Message[]
  ): Promise<{ summary: string; stats: MemoryStats }> {
    const summary = await this.summarizeForCompact(history)
    const stats = this.memoryManager.getStats() ?? {
      totalMessages: history.length,
      estimatedTokens: this.memoryManager.estimateTokens(history),
      maxTokens: this.agentOptions.memoryConfig?.maxTokens ?? 128000,
      utilizationPercent: 0,
      strategy: this.agentOptions.memoryConfig?.strategy ?? 'sliding_window',
      wasCompressed: true,
    }
    return { summary, stats }
  }

  private async summarizeForCompact(history: Message[]): Promise<string> {
    if (history.length < 2) return ''

    const summaryContent = this.formatMessagesForSummary(history)
    const llmMessages = [
      { role: 'system' as const, content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user' as const, content: summaryContent },
    ]

    try {
      const response = await this.llmProvider.chat(llmMessages, [], {
        temperature: 0.3,
        maxTokens: 10000,
        logSource: 'compact_summary',
      })
      return response.content || this.generateFallbackSummary(history)
    } catch (err: any) {
      return this.generateFallbackSummary(history)
    }
  }
}
