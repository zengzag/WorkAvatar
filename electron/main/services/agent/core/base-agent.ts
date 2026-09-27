import { PiAIProvider } from '../llm/pi-ai-provider'
import type { ILLMProvider } from '../llm/types'
import { MemoryManager } from '../memory/memory-manager'
import type { IMemoryManager, MemoryConfig, MemoryStats } from '../memory/types'
import { ToolRegistry } from '../tools/tool-registry'
import { ToolDispatcher } from '../tools/tool-dispatcher'
import { ToolMiddlewareChain, createTimeoutMiddleware, createRetryMiddleware, createLoggingMiddleware, createResultSizeMiddleware, type ToolMiddleware } from '../tools/tool-middleware'
import { createToolPermissionGate } from '../tools/tool-permission'
import type { ToolDefinition, OpenAIToolDefinition, ToolCallResult } from '../tools/types'
import { AgentEventEmitter } from './agent-events'
import { AgentContext } from './agent-context'
import { runPiAgentLoop } from './pi-agent-adapter'
import { COMPACTION_INSTRUCTION } from './compaction-prompt'
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
/** 压缩输入中单条消息的最大字符数：保护摘要调用体积，同时保留路径/错误串等关键细节 */
const SUMMARY_MESSAGE_MAX_CHARS = 4000

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
  /** runStream 令牌：finally 仅在自己仍是最新 run 时才清锁（signal 引用对比在复用同一 signal 时会误判） */
  private _runToken: number = 0
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
    // 前置权限门：先于全部中间件（含插件链首中间件）执行，保证权限判定不可绕过
    this.toolDispatcher.setPreExecuteGate(createToolPermissionGate())
    this.memoryManager = this.createMemoryManager()
    this.middlewareChain = this.toolDispatcher.getMiddlewareChain()

    this.setupDefaultMiddleware()
    this.setupEventBridge()
    this.setupEventListeners()
  }

  get name(): string {
    return this.config.name || 'BaseAgent'
  }

  /** 当前是否有正在执行的 run（供宿主热更新时跳过运行中 agent，避免打断生成流程） */
  isRunning(): boolean {
    return this._running
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

  /**
   * 向本 agent 追加工具调用中间件（与 toolDispatcher 共享的链）。
   * before（默认）插入链首，先于内置 logging/retry/timeout/result_size 执行，可短路阻断；
   * after 追加链尾，仅在结果截断后执行。插件中间件经此挂载。
   */
  useToolMiddleware(middleware: ToolMiddleware, position: 'before' | 'after' = 'before'): void {
    if (position === 'after') this.middlewareChain.use(middleware)
    else this.middlewareChain.useFront(middleware)
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
    ++this._runToken
    const startTime = Date.now()
    const maxIterations = options.maxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS

    this.context.reset()
    this.context.setState('running')
    this.onRunStart()

    this.eventEmitter.emit('run:start', { query: options.query, maxIterations })

    try {
      // 每次 run 启动先重置 _lastKnownPromptTokens，避免跨对话（缓存 agent）泄漏旧值
      this._lastKnownPromptTokens = undefined

      // run 级覆盖优先：插件注入的 system 只作用于本轮，不写 agent 缓存（避免污染后续会话）
      const systemPrompt = options.systemPromptOverride ?? this.buildSystemPrompt(options)
      const { messages, stats } = await this.memoryManager.manageContext(
        systemPrompt,
        options.history || [],
        options.query,
        {
          lastKnownPromptTokens: this._lastKnownPromptTokens,
          headAnchors: options.contextHead,
          tailContext: options.contextTail,
        }
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
    // 本次 run 令牌：finally 中仅当自己仍是最新 run 时才清锁，
    // 避免旧 run（stale）的 finally 覆盖新 run 的 _running/_currentSignal
    // （不用 signal 引用对比：调用方可能复用同一个 AbortSignal 实例）
    const runToken = ++this._runToken
    const startTime = Date.now()
    const maxIterations = options.maxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS

    this.context.reset()
    this.context.setState('running')
    this.onRunStart()

    this.eventEmitter.emit('run:start', { query: options.query, maxIterations })

    try {
      // 每次 runStream 启动先重置 _lastKnownPromptTokens，避免跨对话（缓存 agent）泄漏旧值
      this._lastKnownPromptTokens = undefined

      // run 级覆盖优先：插件注入的 system 只作用于本轮，不写 agent 缓存（避免污染后续会话）
      const systemPrompt = options.systemPromptOverride ?? this.buildSystemPrompt(options)
      const { messages, stats } = await this.memoryManager.manageContext(
        systemPrompt,
        options.history || [],
        options.query,
        {
          lastKnownPromptTokens: this._lastKnownPromptTokens,
          headAnchors: options.contextHead,
          tailContext: options.contextTail,
        }
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
      if (streamMetadata?.aborted) {
        logger.warn(`Agent "${this.name}" run aborted: ${streamMetadata.abortReason || '未知原因'} (iterations=${this.context.getIterationCount()}, latencyMs=${Date.now() - startTime})`)
      }
      this.eventEmitter.emit('run:end', { iterations: this.context.getIterationCount() })

      callbacks.onDone?.({
        totalLatencyMs: Date.now() - startTime,
        iterations: this.context.getIterationCount(),
        aborted: !!streamMetadata?.aborted,
        abortReason: streamMetadata?.abortReason,
        tokenUsage: streamMetadata?.tokenUsage,
        contextStats: this.memoryManager.getStats() ?? undefined,
      })
    } catch (error: any) {
      if (signal?.aborted) {
        this.context.setState('aborted')
        logger.warn(`Agent "${this.name}" run aborted via catch: ${error?.message || String(error)} (iterations=${this.context.getIterationCount()}, latencyMs=${Date.now() - startTime})`)
        this.eventEmitter.emit('run:end', { iterations: this.context.getIterationCount() })
        // catch 兜底：底层异常路径下无法拿到 tokenUsage，但仍刷新 contextStats
        callbacks.onDone?.({
          totalLatencyMs: Date.now() - startTime,
          iterations: this.context.getIterationCount(),
          aborted: true,
          abortReason: error?.message || String(error),
          contextStats: this.memoryManager.getStats() ?? undefined,
        })
        return
      }

      this.context.setState('error')
      this.eventEmitter.emit('run:error', { error: error.message })
      callbacks.onError?.(error.message)
    } finally {
      // 仅当自己仍是最新一次 runStream 时才清除锁（旧 run 的 finally 不得释放新 run 的锁）
      if (this._runToken === runToken) {
        this._running = false
        this._currentSignal = undefined
      }
    }
  }

  protected abstract buildSystemPrompt(options: AgentRunOptions): string

  /** 每次 run/runStream 启动时回调（context.reset 之后）：子类用于重置每轮易变状态 */
  protected onRunStart(): void {}

  /**
   * 每轮模型请求前的节流提醒（如任务清单提醒、收尾窗口警告）。
   * 返回的文本作为合成 user 消息追加在当次请求尾部，不回写历史；返回 undefined 表示本轮不提醒。
   */
  protected buildLoopReminder(_turn: number, _maxIterations: number): string | undefined {
    return undefined
  }

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
        // 采样 / 传输设置（temperature、max_tokens、top_p、penalties、thinking budget、超时、附加头/体）
        ...this.config.stream,
      },
    })
  }

  protected createMemoryManager(): IMemoryManager {
    const config = { ...this.agentOptions.memoryConfig }
    // 压缩指令作为最后一条 user 消息追加在待压缩对话之后，
    // system 使用主会话系统提示词，使摘要调用复用主前缀的 KV cache。
    config.summarizeFn = async (
      messages: Message[],
      context?: { systemPrompt?: string }
    ): Promise<string> => {
      const llmMessages = [
        { role: 'system' as const, content: context?.systemPrompt || '' },
        {
          role: 'user' as const,
          content: `${this.formatMessagesForSummary(messages)}\n\n${COMPACTION_INSTRUCTION}`,
        },
      ]
      const response = await this.llmProvider.chat(llmMessages, [], {
        temperature: 0.3,
        maxTokens: 10000,
        logSource: 'compact_summary',
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
      getLoopReminder: (turn: number) => this.buildLoopReminder(turn, maxIterations),
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
  ): Promise<AgentResponseMetadata & { aborted?: boolean; abortReason?: string }> {
    const { tokenUsage, aborted, abortReason } = await runPiAgentLoop({
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
      getLoopReminder: (turn: number) => this.buildLoopReminder(turn, maxIterations),
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

    return { tokenUsage, aborted, abortReason }
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
      if (content.length > SUMMARY_MESSAGE_MAX_CHARS) {
        content = content.slice(0, SUMMARY_MESSAGE_MAX_CHARS) + '...'
      }
      parts.push(`[${roleLabel}] ${content}`)
    }
    return parts.join('\n')
  }

  private generateFallbackSummary(messages: Message[]): string {
    const userMessages = messages.filter(m => m.role === 'user')
    // content 可能为 undefined（LLM 空回复/工具消息），与 formatMessagesForSummary/estimateTokens 保持一致做空值兜底
    const topics = userMessages.map(m => `- ${(m.content || '').substring(0, 80).trim()}`).slice(0, 10)
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

    // 与自动压缩保持同一协议：主 system prompt + （对话 + 压缩指令）作为最后一条 user 消息
    const systemPrompt = this.buildSystemPrompt({ query: '' })
    const llmMessages = [
      { role: 'system' as const, content: systemPrompt },
      {
        role: 'user' as const,
        content: `${this.formatMessagesForSummary(history)}\n\n${COMPACTION_INSTRUCTION}`,
      },
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
