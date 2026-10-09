import {
  type Context,
  type Message as PiMessage,
  type UserMessage,
  type AssistantMessage as PiAssistantMessage,
  type ToolResultMessage,
  type TextContent,
  type ThinkingContent,
  type ImageContent,
  type ToolCall as PiToolCall,
  type AssistantMessageEvent,
  type Usage as PiUsage,
} from '@earendil-works/pi-ai'
import {
  ILLMProvider,
  LLMProviderConfig,
  LLMCallOptions,
  LLMResponse,
  LLMStreamCallbacks,
  LLMMessage,
  LLMToolCall,
  LLMMessageContentPart,
  LLMUsage,
  LLMToolCallDelta,
} from './types'
import LLMLoggerService from '../../llm-logger.service'
import { buildPiModel, normalizeApiFormat, resolvePiApi, resolvePiStreamFn } from './api-format'
import { buildPiStreamOptions } from './pi-stream-options'

const now = () => Date.now()


/** LLMMessage → pi UserMessage | AssistantMessage | ToolResultMessage */
function toPiMessages(
  messages: LLMMessage[],
  providerType?: string,
  modelId?: string,
  apiFormat?: string,
): { systemPrompt?: string; piMessages: PiMessage[] } {
  let systemPrompt: string | undefined
  const piMessages: PiMessage[] = []
  const provider = providerType || 'openai'
  const piApi = resolvePiApi(apiFormat)
  // 仅 chat-completions 回放 reasoning_content（以 reasoning_content 作为占位签名）；
  // anthropic/responses 的历史思考需真实签名/加密内容，缺失时回放会报错，故丢弃
  const replayReasoning = normalizeApiFormat(apiFormat) === 'chat-completions'

  for (const m of messages) {
    if (m.role === 'system') {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${typeof m.content === 'string' ? m.content : ''}` : (typeof m.content === 'string' ? m.content : '')
      continue
    }

    if (m.role === 'user') {
      const content = parseUserContent(m.content)
      const userMsg: UserMessage = { role: 'user', content, timestamp: now() }
      piMessages.push(userMsg)
      continue
    }

    if (m.role === 'assistant') {
      const contentParts: (TextContent | ThinkingContent | PiToolCall)[] = []
      const text = typeof m.content === 'string' ? m.content : ''
      if (text) contentParts.push({ type: 'text', text })
      if (m.reasoning_content && replayReasoning) {
        contentParts.push({ type: 'thinking', thinking: m.reasoning_content, thinkingSignature: 'reasoning_content' })
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let args: Record<string, any> = {}
          try { args = JSON.parse(tc.function.arguments) } catch { /* 保留空对象 */ }
          const piTc: PiToolCall = {
            type: 'toolCall',
            id: tc.id,
            name: tc.function.name,
            arguments: args,
          }
          contentParts.push(piTc)
        }
      }
      const asstMsg: PiAssistantMessage = {
        role: 'assistant',
        content: contentParts,
        api: piApi,
        provider,
        model: modelId || '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: now(),
      }
      piMessages.push(asstMsg)
      continue
    }

    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : ''
      const toolMsg: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: m.tool_call_id || '',
        toolName: '',
        content: text ? [{ type: 'text', text }] : [],
        isError: false,
        timestamp: now(),
      }
      piMessages.push(toolMsg)
    }
  }

  return { systemPrompt, piMessages }
}

function parseUserContent(content: string | LLMMessageContentPart[]): string | (TextContent | ImageContent)[] {
  if (typeof content === 'string') return content
  const parts: (TextContent | ImageContent)[] = []
  for (const p of content) {
    if (p.type === 'text' && p.text) {
      parts.push({ type: 'text', text: p.text })
    } else if (p.type === 'image_url' && p.image_url) {
      // 从 data URL 解析 base64 data 与 mimeType；
      // HTTP URL 不能伪造成 base64 data（会静默丢失/损坏数据），改为占位文本提示
      const url = p.image_url.url
      const match = /^data:(image\/[a-zA-Z+.-]+);base64,(.*)$/.exec(url)
      if (match) {
        parts.push({ type: 'image', data: match[2], mimeType: match[1] })
      } else {
        parts.push({ type: 'text', text: `[图片链接: ${url}]（不支持直接以 URL 引用图片，请使用本地图片附件）` })
      }
    }
  }
  return parts.length > 0 ? parts : ''
}

/** pi Usage → 现有 LLMUsage
 * pi-ai 的 `usage.input` 已扣除 cacheRead/cacheWrite（非缓存输入），
 * 项目需要总输入（含缓存）用于上下文利用率统计与展示。
 */
function toLLMUsage(usage: PiUsage | undefined): LLMUsage | undefined {
  if (!usage) return undefined
  const totalInput = usage.input + usage.cacheRead
  return {
    promptTokens: totalInput,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...(usage.cacheRead ? { cachedTokens: usage.cacheRead } : {}),
  }
}

/** 从 AssistantMessage 提取 LLMResponse 字段 */
function assistantToResponse(msg: PiAssistantMessage, latencyMs: number): LLMResponse {
  let content = ''
  let reasoningContent: string | undefined
  const toolCalls: LLMToolCall[] = []

  for (const part of msg.content) {
    if (part.type === 'text') {
      content += part.text
    } else if (part.type === 'thinking') {
      reasoningContent = (reasoningContent || '') + part.thinking
    } else if (part.type === 'toolCall') {
      toolCalls.push({
        id: part.id,
        type: 'function',
        function: {
          name: part.name,
          arguments: JSON.stringify(part.arguments),
        },
      })
    }
  }

  return {
    content,
    reasoningContent: reasoningContent || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: msg.stopReason,
    usage: toLLMUsage(msg.usage),
    latencyMs,
  }
}

export class PiAIProvider implements ILLMProvider {
  readonly name = 'pi-ai'
  private config: LLMProviderConfig

  constructor(config: LLMProviderConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
    }
  }

  updateConfig(config: Partial<LLMProviderConfig>): void {
    Object.assign(this.config, config)
  }

  getConfig(): LLMProviderConfig {
    return { ...this.config }
  }

  async chat(messages: LLMMessage[], tools?: any[], options?: LLMCallOptions): Promise<LLMResponse> {
    const startTime = Date.now()
    const logSource = options?.logSource || 'agent'
    const { systemPrompt, piMessages } = toPiMessages(messages, this.config.providerType, this.config.model, this.config.apiFormat)
    const enableThinking = options?.enableThinking ?? this.config.defaultOptions?.enableThinking
    const piModel = buildPiModel({
      modelId: this.config.model,
      baseUrl: this.config.baseUrl!,
      providerType: this.config.providerType,
      apiFormat: this.config.apiFormat,
      enableThinking,
      imageInput: true,
    })

    const context: Context = {
      ...(systemPrompt ? { systemPrompt } : {}),
      messages: piMessages,
      ...(tools && tools.length > 0 ? { tools: this.toPiTools(tools) } : {}),
    }

    const streamOptions = this.buildStreamOptions(options, options?.signal, false)

    try {
      const eventStream = resolvePiStreamFn(this.config.apiFormat)(piModel, context, streamOptions)
      const finalMessage = await eventStream.result()

      // pi-ai 非流式聚合在上游失败时以 stopReason='error' 的空消息返回而非抛错，
      // 不显式抛出会让调用方把空 content 当成功结果（记忆提取等会静默产出空结果）
      if (finalMessage.stopReason === 'error') {
        throw new Error(finalMessage.errorMessage || '上游返回错误')
      }

      const latencyMs = Date.now() - startTime
      const response = assistantToResponse(finalMessage, latencyMs)

      LLMLoggerService.getInstance().logCall({
        type: 'chat',
        source: logSource,
        model: this.config.model,
        providerType: this.config.providerType,
        request: {
          messages: this.sanitizeMessagesForLog(messages),
          tools: tools?.length ? tools : undefined,
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
          stream: false,
        },
        response: {
          content: response.content,
          reasoningContent: response.reasoningContent,
          toolCalls: response.toolCalls,
          finishReason: response.finishReason,
          usage: response.usage,
          latencyMs,
        },
      })

      return response
    } catch (error: any) {
      LLMLoggerService.getInstance().logCall({
        type: 'chat',
        source: logSource,
        model: this.config.model,
        providerType: this.config.providerType,
        request: {
          messages: this.sanitizeMessagesForLog(messages),
          tools: tools?.length ? tools : undefined,
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
          stream: false,
        },
        error: error.message,
      })
      throw this.wrapError(error)
    }
  }

  async chatStream(
    messages: LLMMessage[],
    tools: any[],
    callbacks: LLMStreamCallbacks,
    signal?: AbortSignal,
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    const startTime = Date.now()
    const logSource = options?.logSource || 'agent'
    const { systemPrompt, piMessages } = toPiMessages(messages, this.config.providerType, this.config.model, this.config.apiFormat)
    const enableThinking = options?.enableThinking ?? this.config.defaultOptions?.enableThinking
    const piModel = buildPiModel({
      modelId: this.config.model,
      baseUrl: this.config.baseUrl!,
      providerType: this.config.providerType,
      apiFormat: this.config.apiFormat,
      enableThinking,
      imageInput: true,
    })

    const context: Context = {
      ...(systemPrompt ? { systemPrompt } : {}),
      messages: piMessages,
      ...(tools && tools.length > 0 ? { tools: this.toPiTools(tools) } : {}),
    }

    const streamOptions = this.buildStreamOptions(options, signal, true)

    // 累积 toolCall 增量，按 contentIndex 聚合
    const accumulated: Record<number, { id: string; name: string; arguments: string }> = {}
    let finalMessage: PiAssistantMessage | undefined

    try {
      const eventStream = resolvePiStreamFn(this.config.apiFormat)(piModel, context, streamOptions)

      for await (const event of eventStream) {
        if (signal?.aborted) break
        this.handleStreamEvent(event, callbacks, accumulated)
        if (event.type === 'done') {
          finalMessage = event.message
        }
      }

      // abort 时不抛错，返回空 response，让上层（base-agent.runStream）判断 signal.aborted 处理
      if (signal?.aborted) {
        return {
          content: '',
          finishReason: 'aborted',
          usage: undefined,
          latencyMs: Date.now() - startTime,
        }
      }

      if (!finalMessage) {
        throw new Error('LLM stream ended without final message')
      }

      const latencyMs = Date.now() - startTime
      const response = assistantToResponse(finalMessage, latencyMs)

      const toolCalls = Object.values(accumulated).map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }))
      if (toolCalls.length > 0) {
        callbacks.onToolCall(toolCalls)
        response.toolCalls = toolCalls
      }

      LLMLoggerService.getInstance().logCall({
        type: 'chatStream',
        source: logSource,
        model: this.config.model,
        providerType: this.config.providerType,
        request: {
          messages: this.sanitizeMessagesForLog(messages),
          tools: tools.length ? tools : undefined,
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
          stream: true,
        },
        response: {
          content: response.content,
          reasoningContent: response.reasoningContent,
          toolCalls: response.toolCalls,
          usage: response.usage,
          latencyMs,
        },
      })

      return response
    } catch (error: any) {
      LLMLoggerService.getInstance().logCall({
        type: 'chatStream',
        source: logSource,
        model: this.config.model,
        providerType: this.config.providerType,
        request: {
          messages: this.sanitizeMessagesForLog(messages),
          tools: tools.length ? tools : undefined,
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
          stream: true,
        },
        error: error.message,
      })
      throw this.wrapError(error)
    }
  }

  estimateTokens(messages: LLMMessage[]): number {
    let totalChars = 0
    for (const msg of messages) {
      totalChars += (typeof msg.content === 'string' ? msg.content.length : 0)
      totalChars += (msg.reasoning_content?.length ?? 0)
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          totalChars += (tc.function.name?.length ?? 0)
          totalChars += (tc.function.arguments?.length ?? 0)
        }
      }
    }
    return Math.ceil(totalChars / 3.5)
  }

  /** 统一构造 pi-ai stream options（采样/思考/附加头/超时等，单一入口见 pi-stream-options.ts） */
  private buildStreamOptions(options: LLMCallOptions | undefined, signal: AbortSignal | undefined, streaming: boolean): Record<string, any> {
    const defaults = this.config.defaultOptions || {}
    return buildPiStreamOptions({
      providerType: this.config.providerType,
      modelId: this.config.model,
      apiFormat: this.config.apiFormat,
      apiKey: this.resolveApiKey(),
      sessionId: options?.sessionId,
      signal,
      streaming,
      enableThinking: options?.enableThinking ?? defaults.enableThinking,
      temperature: options?.temperature ?? defaults.temperature,
      maxTokens: options?.maxTokens ?? defaults.maxTokens,
      topP: options?.topP ?? defaults.topP,
      frequencyPenalty: options?.frequencyPenalty ?? defaults.frequencyPenalty,
      presencePenalty: options?.presencePenalty ?? defaults.presencePenalty,
      thinkingBudget: options?.thinkingBudget ?? defaults.thinkingBudget,
      timeoutMs: options?.timeoutMs ?? defaults.timeoutMs,
      // 供应商级附加头优先于内置会话路由头
      extraHeaders: { ...(defaults.extraHeaders || {}), ...(options?.extraHeaders || {}) },
      extraBody: options?.extraBody ?? defaults.extraBody,
    })
  }

  private handleStreamEvent(
    event: AssistantMessageEvent,
    callbacks: LLMStreamCallbacks,
    accumulated: Record<number, { id: string; name: string; arguments: string }>,
  ): void {
    switch (event.type) {
      case 'text_delta':
        callbacks.onChunk(event.delta)
        break
      case 'thinking_delta':
        callbacks.onThought(event.delta)
        break
      case 'error': {
        // pi-ai 出错时 push error 事件，errorMessage 含具体原因（HTTP 错误/参数不支持等）
        // 必须抛错，否则 finalMessage 为空 content 的 message，用户看到无输出无报错
        const errMsg = (event.error as PiAssistantMessage)?.errorMessage
        throw new Error(errMsg ? `LLM 流式请求失败: ${errMsg}` : 'LLM 流式请求失败')
      }
      case 'toolcall_delta': {
        const idx = event.contentIndex
        if (!accumulated[idx]) {
          accumulated[idx] = { id: '', name: '', arguments: '' }
        }
        accumulated[idx].arguments += event.delta
        // 从 partial 提取 id/name（pi 在 toolcall_start 后逐步填充）
        const partial = event.partial
        const tc = partial.content.find((c): c is PiToolCall => c.type === 'toolCall' && (c as any).type === 'toolCall')
        if (tc) {
          const existing = accumulated[idx]
          if (tc.id) existing.id = tc.id
          if (tc.name) existing.name = tc.name
        }
        const delta: LLMToolCallDelta = {
          index: idx,
          id: accumulated[idx].id || undefined,
          name: accumulated[idx].name || undefined,
          arguments: accumulated[idx].arguments,
        }
        callbacks.onToolCallDelta?.(delta)
        break
      }
      case 'toolcall_end': {
        const idx = event.contentIndex
        const tc = event.toolCall
        accumulated[idx] = {
          id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        }
        const delta: LLMToolCallDelta = {
          index: idx,
          id: tc.id,
          name: tc.name,
          arguments: accumulated[idx].arguments,
        }
        callbacks.onToolCallDelta?.(delta)
        break
      }
      default:
        break
    }
  }

  private resolveApiKey(): string {
    // 本地服务（LM Studio 等）无需 API key；pi-ai 对空 key 直接抛错，用占位符跳过校验，服务端会忽略该请求头
    return this.config.apiKey || 'unused'
  }

  private toPiTools(tools: any[]): any[] {
    return tools.map(t => {
      const fn = t.function || t
      return {
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} },
      }
    })
  }

  private sanitizeMessagesForLog(messages: LLMMessage[]): any[] {
    return messages.map(m => {
      const msg: any = { role: m.role }
      if (typeof m.content === 'string') {
        msg.content = m.content
      } else if (Array.isArray(m.content)) {
        msg.content = m.content.map((part: LLMMessageContentPart) => {
          if (part.type === 'image_url') {
            return { type: 'image_url', image_url: { url: '[image]' } }
          }
          return part
        })
      }
      if (m.tool_calls) msg.tool_calls = m.tool_calls
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
      if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
      return msg
    })
  }

  private wrapError(error: any): Error {
    const status = error?.status || 0
    const retryable = status === 429 || status >= 500
    const err = new Error(`LLM call failed: ${error.message || error}`)
    ;(err as any).status = status || undefined
    ;(err as any).retryable = retryable
    return err
  }
}
