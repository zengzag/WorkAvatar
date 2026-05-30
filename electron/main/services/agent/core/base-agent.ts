import { OpenAIProvider } from '../llm/openai-provider'
import type { ILLMProvider } from '../llm/types'
import { MemoryManager } from '../memory/memory-manager'
import type { IMemoryManager, MemoryConfig } from '../memory/types'
import { ToolRegistry } from '../tools/tool-registry'
import { ToolDispatcher } from '../tools/tool-dispatcher'
import { ToolMiddlewareChain, createTimeoutMiddleware, createRetryMiddleware, createLoggingMiddleware, createResultSizeMiddleware } from '../tools/tool-middleware'
import type { ToolDefinition, OpenAIToolDefinition, ToolCallResult } from '../tools/types'
import { AgentEventEmitter } from './agent-events'
import { AgentContext } from './agent-context'
import { generateId } from '../../common-utils'
import type {
  AgentConfig,
  AgentRunOptions,
  AgentRunStreamCallbacks,
  AgentResponse,
  AgentResponseMetadata,
  Message,
  ToolCallRecord,
  TokenUsage,
} from './types'

const DEFAULT_MAX_ITERATIONS = 100
const DEFAULT_TOOL_TIMEOUT_MS = 30000
const DEFAULT_MAX_RESULT_SIZE = 50000
const DEFAULT_TOOL_MAX_RETRIES = 2

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

  private activeSkillInstructions: string[] = []

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
    const startTime = Date.now()
    const maxIterations = options.maxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS

    this.context.reset()
    this.context.setState('running')
    this.activeSkillInstructions = []

    this.eventEmitter.emit('run:start', { query: options.query, maxIterations })

    try {
      const systemPrompt = this.buildSystemPrompt(options)
      const { messages, stats } = this.memoryManager.manageContext(
        systemPrompt,
        options.history || [],
        options.query
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

      this.context.setMessages(messages)

      const activeTools = await this.resolveActiveTools(options.tools)

      const result = await this.executeLoop(messages, activeTools, maxIterations)

      this.context.setState('completed')
      this.eventEmitter.emit('run:end', { iterations: this.context.getIterationCount() })

      return {
        ...result,
        metadata: {
          totalLatencyMs: Date.now() - startTime,
          iterations: this.context.getIterationCount(),
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
    }
  }

  async runStream(
    options: AgentRunOptions,
    callbacks: AgentRunStreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    const startTime = Date.now()
    const maxIterations = options.maxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS

    this.context.reset()
    this.context.setState('running')
    this.activeSkillInstructions = []

    this.eventEmitter.emit('run:start', { query: options.query, maxIterations })

    try {
      const systemPrompt = this.buildSystemPrompt(options)
      const { messages, stats } = this.memoryManager.manageContext(
        systemPrompt,
        options.history || [],
        options.query
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

      this.context.setMessages(messages)

      const activeTools = await this.resolveActiveTools(options.tools)

      const streamMetadata = await this.executeLoopStream(messages, activeTools, maxIterations, callbacks, signal)

      this.context.setState('completed')
      this.eventEmitter.emit('run:end', { iterations: this.context.getIterationCount() })

      callbacks.onDone?.({
        totalLatencyMs: Date.now() - startTime,
        iterations: this.context.getIterationCount(),
        tokenUsage: streamMetadata?.tokenUsage,
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
    }
  }

  protected abstract buildSystemPrompt(options: AgentRunOptions): string

  protected async resolveActiveTools(runtimeToolNames?: string[]): Promise<OpenAIToolDefinition[]> {
    if (runtimeToolNames) {
      return this.toolRegistry.getOpenAISchemasByNames(runtimeToolNames)
    }
    return this.toolRegistry.getOpenAISchemas()
  }

  protected async onToolCallExecuted(toolName: string, _args: any, result: ToolCallResult): Promise<void> {
    if (toolName === 'activate_skill' && result.success) {
      const rawOutput = result.rawOutput as Record<string, any> | undefined
      const skillInstructions = rawOutput?.instructions as string | undefined
      if (skillInstructions && !this.activeSkillInstructions.includes(skillInstructions)) {
        this.activeSkillInstructions.push(skillInstructions)
        this.eventEmitter.emit('skill:activated', { skillName: _args.skill_name })
      }
    }
  }

  public getActiveSkillInstructions(): string[] {
    return [...this.activeSkillInstructions]
  }

  protected clearActiveSkillInstructions(): void {
    this.activeSkillInstructions = []
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
    return new MemoryManager(this.agentOptions.memoryConfig)
  }

  protected setupDefaultMiddleware(): void {
    this.middlewareChain
      .use(createLoggingMiddleware((level, action, data) => {
        this.log(level, action, data)
      }))
      .use(createTimeoutMiddleware(this.agentOptions.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS))
      .use(createRetryMiddleware(this.agentOptions.toolMaxRetries ?? DEFAULT_TOOL_MAX_RETRIES))
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
      this.eventEmitter.on('tool:call:error', (e) => handler('tool:call:error', e.data))
      this.eventEmitter.on('memory:compressed', (e) => handler('memory:compressed', e.data))
      this.eventEmitter.on('plan:generated', (e) => handler('plan:generated', e.data))
      this.eventEmitter.on('skill:activated', (e) => handler('skill:activated', e.data))
      this.eventEmitter.on('state:change', (e) => handler('state:change', e.data))
    }
  }

  protected setupEventListeners(): void {}

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
        const llmMessages = this.convertToLLMMessages(currentMessages)
        const response = await this.llmProvider.chat(llmMessages, tools)

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

        for (const toolCall of response.toolCalls) {
          const toolName = toolCall.function.name
          let args: any
          try {
            args = JSON.parse(toolCall.function.arguments)
          } catch {
            args = {}
          }

          this.eventEmitter.emit('tool:call:start', { tool: toolName, args })

          const result = await this.toolDispatcher.dispatch(toolName, args)
          usedToolCalls.push({
            name: toolName,
            args,
            result: result.success ? result.output : result.error,
            latencyMs: result.latencyMs,
            success: result.success,
          })

          this.eventEmitter.emit('tool:call:end', { tool: toolName, success: result.success })

          await this.onToolCallExecuted(toolName, args, result)

          currentMessages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            content: result.success ? String(result.output) : String(result.error),
          })
        }
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

      try {
        this.context.setState('running')
        const llmMessages = this.convertToLLMMessages(currentMessages)

        this.context.setState('responding')
        const streamResponse = await this.llmProvider.chatStream(
          llmMessages,
          tools,
          {
            onChunk: (chunk: string) => {
              callbacks.onChunk?.(chunk)
            },
            onThought: (thought: string) => {
              callbacks.onThought?.(thought)
            },
            onToolCall: (_toolCalls: any[]) => {},
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
        }
        currentMessages.push(assistantMessage)

        if (!streamResponse.toolCalls || streamResponse.toolCalls.length === 0) {
          this.eventEmitter.emit('iteration:end', { iteration })
          callbacks.onIterationEnd?.(iteration)
          return { tokenUsage: totalTokenUsage }
        }

        this.context.setState('tool_calling')
        for (const toolCall of streamResponse.toolCalls) {
          const toolName = toolCall.function.name
          let args: any
          try {
            args = JSON.parse(toolCall.function.arguments)
          } catch {
            args = {}
          }

          this.eventEmitter.emit('tool:call:start', { tool: toolName, args })
          callbacks.onToolCall?.({ name: toolName, args })

          const result = await this.toolDispatcher.dispatch(toolName, args)
          usedToolCalls.push({
            name: toolName,
            args,
            result: result.success ? result.output : result.error,
            latencyMs: result.latencyMs,
            success: result.success,
          })

          this.eventEmitter.emit('tool:call:end', { tool: toolName, success: result.success })
          callbacks.onToolResult?.({
            name: toolName,
            result: result.success ? result.output : result.error,
            rawResult: result.rawOutput,
          })

          await this.onToolCallExecuted(toolName, args, result)

          currentMessages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            content: result.success ? String(result.output) : String(result.error),
          })
        }
      } catch (error: any) {
        this.eventEmitter.emit('iteration:end', { iteration, error: error.message })
        callbacks.onIterationEnd?.(iteration)

        if (signal?.aborted) return { tokenUsage: totalTokenUsage }

        if (!this.isRetryableError(error)) {
          throw error
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

    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] [${level.toUpperCase()}] [${this.name}:${action}]`, data)
  }
}
