import { OpenAIProvider } from '../llm/openai-provider'
import type { ILLMProvider } from '../llm/types'
import { MemoryManager } from '../memory/memory-manager'
import type { IMemoryManager, MemoryConfig, MemoryStats } from '../memory/types'
import { ToolRegistry } from '../tools/tool-registry'
import { ToolDispatcher } from '../tools/tool-dispatcher'
import { ToolMiddlewareChain, createTimeoutMiddleware, createRetryMiddleware, createLoggingMiddleware, createResultSizeMiddleware } from '../tools/tool-middleware'
import type { ToolDefinition, OpenAIToolDefinition, ToolCallResult } from '../tools/types'
import { AgentEventEmitter } from './agent-events'
import { AgentContext } from './agent-context'
import { generateId } from '../../common-utils'
import { createLogger } from '../../logger'
import type {
  AgentConfig,
  AgentRunOptions,
  AgentRunStreamCallbacks,
  AgentResponse,
  AgentResponseMetadata,
  Message,
  ToolCall,
  ToolCallRecord,
  TokenUsage,
} from './types'

const logger = createLogger('BaseAgent')

const DEFAULT_MAX_ITERATIONS = 100
const DEFAULT_TOOL_TIMEOUT_MS = 30000
const DEFAULT_MAX_RESULT_SIZE = 50000
const DEFAULT_TOOL_MAX_RETRIES = 2

const SUMMARY_SYSTEM_PROMPT = `你是对话摘要助手。请将给定的对话历史压缩为结构化摘要，要求精炼用词但尽量详尽，务必把事情尤其是待办事项和未完成的计划说清楚。

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
      throw new Error(`Agent "${this.name}" is already running, cannot start concurrent run`)
    }
    this._running = true
    const startTime = Date.now()
    const maxIterations = options.maxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS

    this.context.reset()
    this.context.setState('running')

    this.eventEmitter.emit('run:start', { query: options.query, maxIterations })

    try {
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
      this._running = false
    }
  }

  async runStream(
    options: AgentRunOptions,
    callbacks: AgentRunStreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    if (this._running) {
      throw new Error(`Agent "${this.name}" is already running, cannot start concurrent runStream`)
    }
    this._running = true
    const startTime = Date.now()
    const maxIterations = options.maxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS

    this.context.reset()
    this.context.setState('running')

    this.eventEmitter.emit('run:start', { query: options.query, maxIterations })

    try {
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

      this.context.setState('completed')
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
        callbacks.onDone?.({
          totalLatencyMs: Date.now() - startTime,
          iterations: this.context.getIterationCount(),
        })
        return
      }

      this.context.setState('error')
      this.eventEmitter.emit('run:error', { error: error.message })
      callbacks.onError?.(error.message)
    } finally {
      this._running = false
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
    return new OpenAIProvider({
      model: this.config.model,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      providerType: this.config.providerType,
      defaultOptions: {
        enableThinking: this.config.enableThinking,
        providerType: this.config.providerType,
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

  /**
   * 当消息累积过大时，截断较早的 tool 结果内容，防止上下文溢出。
   * 保留最近 KEEP_RECENT 条 tool 消息完整，更早的截断为摘要。
   * 不删除消息，保持 tool_call/tool_response 配对完整。
   */
  private trimToolResultsIfNeeded(messages: Message[]): void {
    const MAX_ESTIMATED_TOKENS = 80000
    const KEEP_RECENT = 6
    const SUMMARY_PREFIX = '[已截断] '

    let totalChars = 0
    for (const msg of messages) {
      totalChars += (msg.content?.length ?? 0)
    }
    if (totalChars / 3.5 < MAX_ESTIMATED_TOKENS) return

    const toolIndices: number[] = []
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') toolIndices.push(i)
    }

    const keepCount = Math.min(KEEP_RECENT, toolIndices.length)
    const toTrim = toolIndices.slice(0, toolIndices.length - keepCount)
    for (const idx of toTrim) {
      const msg = messages[idx]
      const content = msg.content || ''
      if (content.length > 500 && !content.startsWith(SUMMARY_PREFIX)) {
        msg.content = SUMMARY_PREFIX + content.slice(0, 300) + `\n…(原 ${content.length} 字符，已截断以节省上下文)`
      }
    }
  }

  private async executeLoop(
    messages: Message[],
    tools: OpenAIToolDefinition[],
    maxIterations: number
  ): Promise<AgentResponse> {
    let currentMessages = [...messages]
    const usedToolCalls: ToolCallRecord[] = []

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      this.context.incrementIteration()
      this.eventEmitter.emit('iteration:start', { iteration })

      try {
        this.trimToolResultsIfNeeded(currentMessages)
        const llmMessages = this.convertToLLMMessages(currentMessages)
        const response = await this.llmProvider.chat(llmMessages, tools)

        if (response.usage?.promptTokens) {
          this._lastKnownPromptTokens = response.usage.promptTokens
        }

        const assistantMessage: Message = {
          role: 'assistant',
          content: response.content,
          reasoning_content: response.reasoningContent,
          toolCalls: response.toolCalls,
          metadata: {
            latencyMs: response.latencyMs,
            model: this.config.model,
            finishReason: response.finishReason,
          },
        }
        currentMessages.push(assistantMessage)

        if (!response.toolCalls || response.toolCalls.length === 0) {
          this.eventEmitter.emit('iteration:end', { iteration })
          return {
            content: response.content,
            reasoning_content: response.reasoningContent,
            toolCalls: usedToolCalls,
            success: true,
          }
        }

        await this.processToolCalls(response.toolCalls, usedToolCalls, currentMessages)
      } catch (error: any) {
        this.eventEmitter.emit('iteration:end', { iteration, error: error.message })

        if (!this.isRetryableError(error)) {
          return {
            content: '',
            success: false,
            error: error.message,
            toolCalls: usedToolCalls,
          }
        }

        if (iteration === maxIterations - 1) {
          return {
            content: '',
            success: false,
            error: `Max iterations (${maxIterations}) reached: ${error.message}`,
            toolCalls: usedToolCalls,
          }
        }

        await this.exponentialBackoff(iteration)
        continue
      }

      this.eventEmitter.emit('iteration:end', { iteration })
    }

    return {
      content: '',
      success: false,
      error: `Max iterations (${maxIterations}) reached`,
      toolCalls: usedToolCalls,
    }
  }

  private async executeLoopStream(
    messages: Message[],
    tools: OpenAIToolDefinition[],
    maxIterations: number,
    callbacks: AgentRunStreamCallbacks,
    signal?: AbortSignal
  ): Promise<AgentResponseMetadata> {
    let currentMessages = [...messages]
    const usedToolCalls: ToolCallRecord[] = []
    let totalTokenUsage: TokenUsage = {}

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (signal?.aborted) return { tokenUsage: totalTokenUsage }

      this.context.incrementIteration()
      this.eventEmitter.emit('iteration:start', { iteration })
      callbacks.onIterationStart?.(iteration)

      // 跟踪本次迭代是否已向客户端推送过流式数据
      // 若已推送则不重试，避免重试导致重复内容
      // 声明在 try 外，catch 中可访问
      let chunksSentThisIteration = false

      try {
        this.context.setState('running')
        this.trimToolResultsIfNeeded(currentMessages)
        const llmMessages = this.convertToLLMMessages(currentMessages)

        this.context.setState('responding')
        const streamResponse = await this.llmProvider.chatStream(
          llmMessages,
          tools,
          {
            onChunk: (chunk: string) => {
              chunksSentThisIteration = true
              callbacks.onChunk?.(chunk)
            },
            onThought: (thought: string) => {
              callbacks.onThought?.(thought)
            },
            onToolCall: (_toolCalls: any[]) => {},
            onToolCallDelta: (delta) => {
              callbacks.onToolCallDelta?.(delta)
            },
          },
          signal
        )

        const assistantMessage: Message = {
          role: 'assistant',
          content: streamResponse.content,
          reasoning_content: streamResponse.reasoningContent,
          toolCalls: streamResponse.toolCalls,
          metadata: {
            latencyMs: streamResponse.latencyMs,
            model: this.config.model,
          },
        }

        if (streamResponse.usage) {
          totalTokenUsage = {
            promptTokens: (totalTokenUsage.promptTokens || 0) + (streamResponse.usage.promptTokens || 0),
            completionTokens: (totalTokenUsage.completionTokens || 0) + (streamResponse.usage.completionTokens || 0),
            totalTokens: (totalTokenUsage.totalTokens || 0) + (streamResponse.usage.totalTokens || 0),
            cachedTokens: (totalTokenUsage.cachedTokens || 0) + (streamResponse.usage.cachedTokens || 0),
          }
          if (streamResponse.usage.promptTokens) {
            this._lastKnownPromptTokens = streamResponse.usage.promptTokens
          }
        }
        currentMessages.push(assistantMessage)

        if (!streamResponse.toolCalls || streamResponse.toolCalls.length === 0) {
          this.eventEmitter.emit('iteration:end', { iteration })
          callbacks.onIterationEnd?.(iteration)
          return { tokenUsage: totalTokenUsage }
        }

        this.context.setState('tool_calling')
        await this.processToolCalls(streamResponse.toolCalls, usedToolCalls, currentMessages, {
          onToolCall: callbacks.onToolCall,
          onToolResult: callbacks.onToolResult,
          onToolProgress: callbacks.onToolProgress,
        }, signal)
      } catch (error: any) {
        this.eventEmitter.emit('iteration:end', { iteration, error: error.message })
        callbacks.onIterationEnd?.(iteration)

        if (signal?.aborted) return { tokenUsage: totalTokenUsage }

        if (!this.isRetryableError(error)) {
          throw error
        }

        // 已向客户端推送过流式数据时不重试，避免重复内容破坏消息序列
        if (chunksSentThisIteration) {
          throw new Error(`Stream failed after partial content was sent: ${error.message}`)
        }

        if (iteration === maxIterations - 1) {
          throw new Error(`Max iterations (${maxIterations}) reached: ${error.message}`)
        }

        await this.exponentialBackoff(iteration)
        continue
      }

      this.eventEmitter.emit('iteration:end', { iteration })
      callbacks.onIterationEnd?.(iteration)
    }

    return { tokenUsage: totalTokenUsage }
  }

  private async processToolCalls(
    toolCalls: ToolCall[],
    usedToolCalls: ToolCallRecord[],
    currentMessages: Message[],
    streamCallbacks?: {
      onToolCall?: AgentRunStreamCallbacks['onToolCall']
      onToolResult?: AgentRunStreamCallbacks['onToolResult']
      onToolProgress?: AgentRunStreamCallbacks['onToolProgress']
    },
    signal?: AbortSignal
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      if (signal?.aborted) return

      const toolName = toolCall.function.name
      let args: any
      let parseError: string | null = null
      try {
        args = JSON.parse(toolCall.function.arguments)
      } catch (e: any) {
        args = {}
        parseError = e?.message || String(e)
      }

      this.eventEmitter.emit('tool:call:start', { tool: toolName, args })
      streamCallbacks?.onToolCall?.({ id: toolCall.id, name: toolName, args })

      const toolContext = streamCallbacks?.onToolProgress
        ? {
            onProgress: (progress: any) => {
              streamCallbacks.onToolProgress?.({ toolCallId: toolCall.id, name: toolName, progress })
            },
          }
        : undefined

      let result: ToolCallResult
      if (parseError) {
        // 参数 JSON 解析失败：不调用工具，直接返回结构化错误，便于 LLM 修正后重试
        result = {
          success: false,
          error: this.formatParseError(toolName, toolCall.function.arguments, parseError),
          toolName,
        }
      } else {
        result = await this.toolDispatcher.dispatch(toolName, args, toolContext)
      }

      if (signal?.aborted) return

      usedToolCalls.push({
        name: toolName,
        args,
        result: result.success ? result.output : result.error,
        latencyMs: result.latencyMs,
        success: result.success,
      })

      this.eventEmitter.emit('tool:call:end', { tool: toolName, success: result.success })
      streamCallbacks?.onToolResult?.({
        name: toolName,
        result: result.success ? result.output : result.error,
        rawResult: result.rawOutput,
        generatedFiles: result.generatedFiles,
      })

      await this.onToolCallExecuted(toolName, args, result)

      currentMessages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        content: this.formatToolMessageContent(result),
      })
    }
  }

  /**
   * 格式化工具参数 JSON 解析失败错误
   *
   * 不静默吞错，把解析错误信息 + 原始 arguments 片段返回给 LLM，
   * 便于 LLM 定位是引号/转义/括号不匹配等问题并修正后重试
   */
  private formatParseError(toolName: string, rawArguments: string, parseError: string): string {
    const raw = typeof rawArguments === 'string' ? rawArguments : String(rawArguments ?? '')
    // 截断过长的原始参数，避免爆掉 LLM 上下文
    const maxLen = 800
    const truncated = raw.length > maxLen
      ? raw.slice(0, maxLen) + `\n…(${raw.length} 字符，已截断)`
      : raw

    return [
      `工具 "${toolName}" 的参数 JSON 解析失败，未执行工具。`,
      `解析错误: ${parseError}`,
      '',
      '--- 原始 arguments ---',
      truncated || '(空)',
      '',
      '请检查并修正 JSON：',
      '- 字符串值需用双引号包裹，内部双引号需转义为 \\"',
      '- 不要在 JSON 中使用注释、尾随逗号、单引号',
      '- 多行字符串需转义换行为 \\n，或拆分为字符串数组',
      '- 复杂代码可作为字符串传入，避免裸花括号被误解析',
    ].join('\n')
  }

  /**
   * 格式化工具结果为 LLM tool message 内容
   *
   * - 成功：返回 output（兜底提示无输出）
   * - 失败：合并 error + output（如 invoke_tool 已提供结构化失败上下文，
   *   或 office_exec 等工具返回的 console 日志/已写入文件），让 LLM 能据此判断
   *   具体错误原因并修正参数或代码后重试
   */
  private formatToolMessageContent(result: ToolCallResult): string {
    if (result.success) {
      return result.output !== undefined && result.output !== null && result.output !== ''
        ? String(result.output)
        : '(工具执行成功，无输出)'
    }

    const parts: string[] = []
    const err = result.error || '(无错误信息)'
    parts.push(`[错误] ${err}`)

    if (result.output !== undefined && result.output !== null && result.output !== '') {
      const outputStr = typeof result.output === 'string'
        ? result.output
        : (() => { try { return JSON.stringify(result.output, null, 2) } catch { return String(result.output) } })()
      if (outputStr.trim()) {
        parts.push(outputStr)
      }
    }

    return parts.join('\n\n')
  }

  private convertToLLMMessages(messages: Message[]): any[] {
    return messages.map(m => {
      const msg: any = {
        role: m.role,
        content: m.content,
      }
      if (m.images && m.images.length > 0) {
        const contentParts: any[] = []
        if (m.content) {
          contentParts.push({ type: 'text', text: m.content })
        }
        for (const imgUrl of m.images) {
          contentParts.push({
            type: 'image_url',
            image_url: { url: imgUrl, detail: 'auto' }
          })
        }
        msg.content = contentParts
      }
      if (m.toolCalls) {
        msg.tool_calls = m.toolCalls
      }
      if (m.toolCallId) {
        msg.tool_call_id = m.toolCallId
      }
      if (m.reasoning_content) {
        msg.reasoning_content = m.reasoning_content
      }
      return msg
    })
  }

  private isRetryableError(error: any): boolean {
    if (error?.retryable === true) return true
    if (error?.status === 429 || error?.status >= 500) return true
    if (error?.message?.includes('rate limit')) return true
    if (error?.message?.includes('timeout')) return true
    if (error?.message?.includes('ECONNRESET')) return true
    return false
  }

  private async exponentialBackoff(iteration: number, baseDelayMs: number = 1000): Promise<void> {
    const delay = baseDelayMs * Math.pow(2, Math.min(iteration, 5))
    const jitter = Math.random() * 500
    await new Promise(resolve => setTimeout(resolve, delay + jitter))
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
