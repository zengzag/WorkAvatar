import { agentLoop, agentLoopContinue } from '@earendil-works/pi-agent-core'
import {
  type Context,
  type Tool,
  type Message as PiMessage,
  type UserMessage,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEventStream,
  type ToolResultMessage,
  type TextContent,
  type ThinkingContent,
  type ImageContent,
  type ToolCall as PiToolCall,
  type Usage as PiUsage,
  createInitialSystemMessage,
  toToolDeclaration,
  getCurrentSystemPrompt,
  getCurrentTools,
} from '@earendil-works/pi-ai'
import type {
  AgentTool,
  AgentMessage,
  AgentEvent,
  AgentLoopConfig,
  AgentContext as PiAgentContext,
  StreamFn,
} from '@earendil-works/pi-agent-core'
import type { ToolDefinition, OpenAIToolDefinition, ToolCallResult } from '../tools/types'
import { TextLoopDetector, type LoopHit } from './loop-detector'
import { ToolDispatcher } from '../tools/tool-dispatcher'
import { ToolRegistry } from '../tools/tool-registry'
import { AgentEventEmitter } from './agent-events'
import { AgentContext } from './agent-context'
import type {
  AgentConfig,
  AgentRunStreamCallbacks,
  Message,
  TokenUsage,
} from './types'
import { createLogger } from '../../logger'
import { buildPiModel, normalizeApiFormat, resolvePiApi, resolvePiStreamFn } from '../llm/api-format'
import { buildPiStreamOptions } from '../llm/pi-stream-options'
import AttachmentService, { ATTACHMENT_REF_PATTERN, describeImageForLog } from '../../attachment.service'
import LLMLoggerService from '../../llm-logger.service'
import type { GeneratedFileInfo } from '../../../../shared/types'

const logger = createLogger('PiAgentAdapter')

/** 构造 pi-ai 合成 Model（按接口形式选择 api 与 compat），compat 配置由 provider-compat.ts 统一管理 */
function createPiModel(config: AgentConfig): any {
  return buildPiModel({
    modelId: config.model,
    baseUrl: config.baseUrl || 'https://api.openai.com/v1',
    providerType: config.providerType,
    apiFormat: config.apiFormat,
    enableThinking: config.enableThinking,
    // 视觉能力：用于 pi-ai 序列化校验与上下文注入判断（不支持图片时不注入工具返回的图片）
    imageInput: config.supportsImageInput === true,
  })
}

/** 图片引用解析结果：
 * - data URL → { data, mimeType }
 * - wa-attachment:// 引用 → 读盘转 base64；文件丢失 → { missing: true }（对话继续，附丢失提示）
 * - 其他（HTTP）→ { url } 原样返回（让 provider 自行处理）
 */
function parseImageDataUrl(url: string): { data: string; mimeType: string } | { url: string } | { missing: true } {
  const match = /^data:(image\/[a-zA-Z+.-]+);base64,(.*)$/.exec(url)
  if (match) {
    return { data: match[2], mimeType: match[1] }
  }
  if (ATTACHMENT_REF_PATTERN.test(url)) {
    const resolved = AttachmentService.getInstance().resolve(url)
    if (resolved) {
      return { data: resolved.base64, mimeType: resolved.mimeType }
    }
    return { missing: true }
  }
  return { url }
}

/** 日志用：ImageContent 对象 → 来源引用（附件引用 / data URL），避免日志写出 base64 内容 */
const imageSourceByPart = new WeakMap<ImageContent, string>()

function createImagePart(parsed: { data: string; mimeType: string }, source: string): ImageContent {
  const part: ImageContent = { type: 'image', data: parsed.data, mimeType: parsed.mimeType }
  imageSourceByPart.set(part, source)
  return part
}

/** 构造 streamFn，内部委托给 pi-ai stream（按接口形式分派）。
 *  包装 eventStream 以窃听事件，在流结束后写入 LLM 日志（与 PiAIProvider 格式一致），
 *  否则 agent 主流程绕过 PiAIProvider 会导致 .log/llm 缺失原始交互记录。
 */
function createStreamFn(config: AgentConfig): StreamFn {
  const piModel = createPiModel(config)
  const piStream = resolvePiStreamFn(config.apiFormat)
  const apiKey = config.apiKey
  return (_model, context, options) => {
    const startTime = Date.now()
    // 立即快照 context.messages：pi-agent-core 在流式过程中会往 context.messages
    // push partialMessage / 替换为 finalMessage（agent-loop.js streamAssistantResponse），
    // 而 convertToLlm 返回同一数组引用，若不快照，日志 request.messages 会混入当次 LLM 回答
    const contextSnapshot: Context = {
      messages: [...context.messages],
    }
    // 采样 / 传输设置：AgentConfig.stream（模型/供应商配置派生）优先，其次尊重 pi-agent-core 透传的 options
    const stream = config.stream || {}
    // 循环检测中断控制器：与外部 signal 级联（外部中止 → 一并中止），
    // 检测触发时仅中止本次 LLM 调用，不影响外层 agent 循环的中断语义
    const loopAbort = new AbortController()
    let detachExternalAbort: (() => void) | undefined
    const externalSignal = options?.signal
    if (externalSignal) {
      if (externalSignal.aborted) {
        loopAbort.abort()
      } else {
        const onAbort = () => loopAbort.abort()
        externalSignal.addEventListener('abort', onAbort, { once: true })
        // 配对移除：流结束后调用，避免外部 signal 与每次 LLM 请求间的监听器堆积
        detachExternalAbort = () => externalSignal.removeEventListener('abort', onAbort)
      }
    }
    const innerStream = piStream(piModel, context, buildPiStreamOptions({
      providerType: config.providerType,
      modelId: config.model,
      apiFormat: config.apiFormat,
      apiKey,
      sessionId: options?.sessionId ?? config.sessionId,
      signal: loopAbort.signal,
      streaming: true,
      enableThinking: config.enableThinking,
      ...stream,
      temperature: stream.temperature ?? options?.temperature,
      maxTokens: stream.maxTokens ?? options?.maxTokens,
    }) as any)
    return wrapStreamWithLogging(innerStream, {
      model: config.model,
      providerType: config.providerType,
      apiFormat: config.apiFormat,
      context: contextSnapshot,
      options,
      startTime,
    }, loopAbort, detachExternalAbort)
  }
}

/** pi Context.messages → LLM 日志格式（OpenAI 风格，与 PiAIProvider.sanitizeMessagesForLog 一致） */
function piContextToLogMessages(context: Context): any[] {
  const messages: any[] = []
  // pi-ai 1.x 把系统提示词与工具声明折叠进首条 system 消息，还原出提示词便于日志阅读
  const systemPrompt = getCurrentSystemPrompt(context.messages)
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  for (const m of context.messages) {
    if (m.role === 'system') {
      continue
    }
    if (m.role === 'user') {
      const content = typeof m.content === 'string'
        ? m.content
        : m.content.map(c => c.type === 'image'
          ? { type: 'image_url', image_url: { url: describeImageForLog(imageSourceByPart.get(c)) } }
          : c)
      messages.push({ role: 'user', content })
    } else if (m.role === 'assistant') {
      let text = ''
      let reasoning: string | undefined
      const toolCalls: any[] = []
      for (const c of m.content) {
        if (c.type === 'text') text += c.text
        else if (c.type === 'thinking') reasoning = (reasoning || '') + c.thinking
        else if (c.type === 'toolCall') {
          toolCalls.push({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })
        }
      }
      const msg: any = { role: 'assistant', content: text }
      if (reasoning) msg.reasoning_content = reasoning
      if (toolCalls.length > 0) msg.tool_calls = toolCalls
      messages.push(msg)
    } else if (m.role === 'toolResult') {
      const text = m.content.map(c => c.type === 'text' ? c.text : '').join('')
      messages.push({ role: 'tool', content: text, tool_call_id: m.toolCallId })
    }
  }
  return messages
}

function piToolsToLogTools(tools?: Tool[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

/** pi Usage → LLM 日志 usage 格式（与 PiAIProvider.toLLMUsage 一致：总输入含缓存） */
function piUsageToLogUsage(usage: PiUsage | undefined): any | undefined {
  if (!usage) return undefined
  const totalInput = usage.input + usage.cacheRead
  return {
    promptTokens: totalInput,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...(usage.cacheRead ? { cachedTokens: usage.cacheRead } : {}),
  }
}

/**
 * 包装 AssistantMessageEventStream，窃听事件累积响应信息，
 * 在流结束（done/error/消费者退出）后写入 LLM 日志。
 * 同时对流式输出做循环检测（正文/思考/工具参数各自独立），
 * 检测命中后中止底层请求并停止转发，result() 返回合成的错误消息，
 * 走 pi-agent-core turn_end stopReason=error → handleAgentEvent 抛错的既有链路。
 * 保留 [Symbol.asyncIterator] 与 result() 契约，对 pi-agent-core 透明。
 */
function wrapStreamWithLogging(
  innerStream: AssistantMessageEventStream,
  logMeta: {
    model: string
    providerType?: string
    apiFormat?: string
    context: Context
    options?: any
    startTime: number
  },
  loopAbort?: AbortController,
  /** 流结束后清理回调：配对移除外部 signal 上的 abort 监听 */
  onStreamEnd?: () => void,
): AssistantMessageEventStream {
  let content = ''
  let reasoningContent = ''
  const toolCalls: any[] = []
  let usage: PiUsage | undefined
  let errorMessage: string | undefined
  let logged = false
  // 循环检测：正文 / 思考 / 每个工具参数流独立检测（跨流重复属合法引用，不算循环）
  const textDetector = new TextLoopDetector()
  const thinkingDetector = new TextLoopDetector()
  const toolArgDetectors = new Map<number, TextLoopDetector>()
  let loopError: string | undefined

  const formatLoopError = (stream: string, hit: LoopHit): string => {
    const unit = hit.unit.replace(/\s+/g, ' ').slice(0, 60)
    return `检测到循环输出（${stream}）：内容 "${unit}"（周期 ${hit.period} 字符）持续重复，已自动中断`
  }

  /** 循环中断时合成的错误 AssistantMessage（含已产出的部分内容，与 pi-ai 错误事件行为一致） */
  const buildLoopErrorResult = (): PiAssistantMessage => {
    const contentParts: (TextContent | ThinkingContent)[] = []
    if (content) contentParts.push({ type: 'text', text: content })
    if (reasoningContent) contentParts.push({ type: 'thinking', thinking: reasoningContent })
    return {
      role: 'assistant',
      content: contentParts,
      api: resolvePiApi(logMeta.apiFormat),
      provider: logMeta.providerType || 'openai',
      model: logMeta.model,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'error',
      errorMessage: loopError,
      timestamp: Date.now(),
    }
  }

  const writeLog = () => {
    if (logged) return
    logged = true
    const latencyMs = Date.now() - logMeta.startTime
    const request = {
      messages: piContextToLogMessages(logMeta.context),
      tools: piToolsToLogTools(getCurrentTools(logMeta.context.messages)),
      temperature: logMeta.options?.temperature,
      max_tokens: logMeta.options?.maxTokens,
      stream: true as const,
    }
    const error = loopError || errorMessage
    if (error) {
      LLMLoggerService.getInstance().logCall({
        type: 'chatStream',
        source: 'agent',
        model: logMeta.model,
        providerType: logMeta.providerType,
        request,
        error,
      })
    } else {
      LLMLoggerService.getInstance().logCall({
        type: 'chatStream',
        source: 'agent',
        model: logMeta.model,
        providerType: logMeta.providerType,
        request,
        response: {
          content,
          reasoningContent: reasoningContent || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: piUsageToLogUsage(usage),
          latencyMs,
        },
      })
    }
  }

  const wrapped = {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of innerStream) {
          if (!loopError) {
            switch (event.type) {
              case 'text_delta': {
                content += event.delta
                const hit = textDetector.push(event.delta)
                if (hit) loopError = formatLoopError('正文', hit)
                break
              }
              case 'thinking_delta': {
                reasoningContent += event.delta
                const hit = thinkingDetector.push(event.delta)
                if (hit) loopError = formatLoopError('思考', hit)
                break
              }
              case 'toolcall_delta': {
                let det = toolArgDetectors.get(event.contentIndex)
                if (!det) {
                  det = new TextLoopDetector()
                  toolArgDetectors.set(event.contentIndex, det)
                }
                const hit = det.push(event.delta)
                if (hit) loopError = formatLoopError('工具参数', hit)
                break
              }
              case 'toolcall_end':
                toolCalls.push({
                  id: event.toolCall.id,
                  type: 'function',
                  function: {
                    name: event.toolCall.name,
                    arguments: JSON.stringify(event.toolCall.arguments),
                  },
                })
                break
              case 'done': {
                // done 携带 finalMessage，从中提取完整 content/usage，比 delta 累积更准确
                const msg = event.message
                usage = msg.usage
                let text = ''
                let reasoning = ''
                const tcs: any[] = []
                for (const c of msg.content) {
                  if (c.type === 'text') text += c.text
                  else if (c.type === 'thinking') reasoning += c.thinking
                  else if (c.type === 'toolCall') {
                    tcs.push({
                      id: c.id,
                      type: 'function',
                      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                    })
                  }
                }
                content = text
                reasoningContent = reasoning
                if (tcs.length > 0) {
                  toolCalls.length = 0
                  toolCalls.push(...tcs)
                }
                break
              }
              case 'error':
                errorMessage = (event.error as PiAssistantMessage)?.errorMessage || 'LLM 流式请求失败'
                break
            }
            if (loopError) {
              // 命中循环：中止底层请求并停止转发；result() 返回合成错误消息
              logger.warn(`Agent stream loop detected, aborting: ${loopError} (model=${logMeta.model}, latencyMs=${Date.now() - logMeta.startTime})`)
              loopAbort?.abort()
              break
            }
          }
          yield event
        }
      } finally {
        writeLog()
        onStreamEnd?.()
      }
    },
    result() {
      if (loopError) return Promise.resolve(buildLoopErrorResult())
      return innerStream.result()
    },
  }
  return wrapped as unknown as AssistantMessageEventStream
}

/** 现有 Message[] → pi Message[] + systemPrompt */
function toPiMessages(
  messages: Message[],
  providerType?: string,
  modelId?: string,
  apiFormat?: string,
): { systemPrompt?: string; piMessages: PiMessage[] } {
  let systemPrompt: string | undefined
  const piMessages: PiMessage[] = []
  const ts = Date.now()
  const provider = providerType || 'openai'
  const piApi = resolvePiApi(apiFormat)
  // 仅 chat-completions 回放 reasoning_content（以 reasoning_content 作为占位签名）；
  // anthropic/responses 的历史思考需真实签名/加密内容，缺失时回放会报错，故丢弃
  const replayReasoning = normalizeApiFormat(apiFormat) === 'chat-completions'

  for (const m of messages) {
    if (m.role === 'system') {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${m.content}`
        : m.content
      continue
    }

    if (m.role === 'user') {
      // HTTP 图片 URL 无法作为 base64 data 直接发送（伪造 data 字段是损坏数据，会静默丢失）。
      // toPiMessages 为同步函数无法下载转码，改为丢弃并在文本中显式告知模型，
      // 避免模型误以为图片已发送。
      const httpImageUrls: string[] = []
      const imageParts: ImageContent[] = []
      let missingImageCount = 0
      for (const url of m.images || []) {
        const parsed = parseImageDataUrl(url)
        if ('data' in parsed) {
          imageParts.push(createImagePart(parsed, url))
        } else if ('missing' in parsed) {
          missingImageCount++
        } else {
          httpImageUrls.push(parsed.url)
        }
      }
      const skipNote = httpImageUrls.length > 0
        ? `\n\n[Note: ${httpImageUrls.length} image(s) were referenced by HTTP links and could not be attached; only inline data URL images are supported. Links: ${httpImageUrls.join(', ')}]`
        : ''
      const missingNote = missingImageCount > 0
        ? `\n\n[Note: ${missingImageCount} image attachment(s) are missing and were not attached; understanding of the related content may be affected.]`
        : ''
      const userNote = skipNote + missingNote
      const content: string | (TextContent | ImageContent)[] = imageParts.length > 0
        ? [
            ...(((m.content || '') || userNote) ? [{ type: 'text' as const, text: (m.content || '') + userNote }] : []),
            ...imageParts,
          ]
        : (m.content || '') + userNote
      const userMsg: UserMessage = { role: 'user', content, timestamp: ts }
      piMessages.push(userMsg)
      continue
    }

    if (m.role === 'assistant') {
      const contentParts: (TextContent | ThinkingContent | PiToolCall)[] = []
      if (m.content) contentParts.push({ type: 'text', text: m.content })
      if (m.reasoning_content && replayReasoning) {
        contentParts.push({ type: 'thinking', thinking: m.reasoning_content, thinkingSignature: 'reasoning_content' })
      }
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          let args: Record<string, any> = {}
          try { args = JSON.parse(tc.function.arguments) } catch { /* 保留空对象 */ }
          contentParts.push({
            type: 'toolCall',
            id: tc.id,
            name: tc.function.name,
            arguments: args,
          })
        }
      }
      piMessages.push({
        role: 'assistant',
        content: contentParts,
        api: piApi,
        provider,
        model: modelId || '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: ts,
      })
      continue
    }

    if (m.role === 'tool') {
      const text = m.content || ''
      // 工具结果图片回放：与实时链路一致放入 toolResult content，
      // 最终由 convertToLlm 在请求前改写为 user 消息注入
      const imageParts: (TextContent | ImageContent)[] = []
      let missingImageCount = 0
      for (const url of m.images || []) {
        const parsed = parseImageDataUrl(url)
        if ('data' in parsed) {
          imageParts.push(createImagePart(parsed, url))
        } else if ('missing' in parsed) {
          missingImageCount++
        }
      }
      if (missingImageCount > 0) {
        imageParts.push({ type: 'text', text: `[注意] ${missingImageCount} 张图片附件文件已丢失，无法提供图片内容` })
      }
      piMessages.push({
        role: 'toolResult',
        toolCallId: m.toolCallId || '',
        toolName: '',
        content: text ? [{ type: 'text', text }, ...imageParts] : imageParts,
        isError: m.isError === true,
        timestamp: ts,
      })
    }
  }

  return { systemPrompt, piMessages }
}

/** pi Usage → 现有 TokenUsage
 * pi-ai 的 `usage.input` 已扣除 cacheRead/cacheWrite（非缓存输入），
 * 项目需要总输入（含缓存，缓存也占用上下文窗口）用于上下文利用率统计与展示。
 */
function toTokenUsage(usage: PiUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  const totalInput = usage.input + usage.cacheRead
  return {
    promptTokens: totalInput,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...(usage.cacheRead ? { cachedTokens: usage.cacheRead } : {}),
  }
}

/**
 * 包装 ToolDispatcher + 中间件为 pi AgentTool。
 * execute 内部委托给现有 ToolDispatcher.dispatch，保留中间件链（retry/timeout/logging/result_size）。
 * execute 的 signal 通过 ToolHandlerContext 透传给 dispatch 与 handler，
 * dispatcher 执行前预检 abort，timeout 中间件在等待期感知中止立即收敛为失败。
 */
function toAgentTool(
  tool: ToolDefinition,
  dispatcher: ToolDispatcher,
  imageSupport: boolean,
): AgentTool {
  return {
    name: tool.name,
    description: tool.description,
    label: tool.title,
    parameters: tool.parameters as any,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      // dispatch 前若已 abort，直接返回错误，避免触发不可中断的工具
      if (signal?.aborted) {
        return {
          content: [{ type: 'text', text: '操作已取消' }],
          details: { success: false, error: '操作已取消' },
          isError: true,
        }
      }

      const toolContext = imageSupport || onUpdate || signal
        ? {
            ...(onUpdate ? { onProgress: (progress: any) => onUpdate({ content: [{ type: 'text', text: '' }], details: { progress } }) } : {}),
            ...(imageSupport ? { imageSupport: true } : {}),
            ...(signal ? { signal } : {}),
          }
        : undefined

      const startMs = Date.now()
      let result: ToolCallResult
      let caught = false
      try {
        result = await dispatcher.dispatch(tool.name, params as Record<string, any>, toolContext)
      } catch (err: any) {
        caught = true
        result = {
          success: false,
          error: `工具 "${tool.name}" 执行异常: ${err?.message || String(err)}`,
          toolName: tool.name,
          latencyMs: Date.now() - startMs,
        }
      }

      const text = formatToolMessageContent(result)
      // 图片以 ImageContent 形式放入 toolResult 消息（pi 层存储），
      // 由 convertToLlm 在每次 LLM 请求前改写为紧随 tool result 的 user 消息注入
      const imageParts: (TextContent | ImageContent)[] = []
      let missingToolImages = 0
      for (const url of result.images || []) {
        const parsed = parseImageDataUrl(url)
        if ('data' in parsed) {
          imageParts.push(createImagePart(parsed, url))
        } else if ('missing' in parsed) {
          missingToolImages++
        }
      }
      if (missingToolImages > 0) {
        imageParts.push({ type: 'text', text: `[注意] ${missingToolImages} 张图片附件文件已丢失，无法提供图片内容` })
      }
      return {
        content: [{ type: 'text', text }, ...imageParts],
        details: {
          output: result.output,
          error: result.error,
          rawOutput: result.rawOutput,
          generatedFiles: result.generatedFiles,
          images: result.images,
          success: result.success,
          latencyMs: result.latencyMs ?? (Date.now() - startMs),
          // 实际发送给 LLM 的工具结果原文：前端重建 history 时优先用它，
          // 保证与上一轮真实 transcript 字节一致（失败工具/对象输出等场景展示值与原文不同）
          llmContent: text,
        },
        // isError 只在工具调用本身失败（抛异常/abort）时为 true；
        // 业务失败（如 shell_exec exit_code≠0，result.success=false 但工具正常返回了结果）时 isError=false，
        // LLM 从 output 内容（含 exit_code/stderr）自行判断命令是否失败并修正
        isError: caught,
      }
    },
  }
}

/**
 * 前端仅凭展示值（output / error）能重建出的工具结果文本。
 * 与 expandFrontendMessages 的重建规则保持一致（空值占位 + 对象按 2 空格缩进序列化），
 * 用于判断是否需要把 LLM 原文额外下发给前端。
 */
function expectedToolMessageContent(displayValue: any): string {
  if (displayValue === undefined || displayValue === null || displayValue === '') return '工具执行完成，无返回值'
  if (typeof displayValue === 'string') return displayValue
  try {
    return JSON.stringify(displayValue, null, 2)
  } catch {
    return String(displayValue)
  }
}

/**
 * 格式化工具结果为 LLM tool message 内容（从 base-agent 提取，保持行为一致）
 */
function formatToolMessageContent(result: ToolCallResult): string {
  if (result.success) {
    return result.output !== undefined && result.output !== null && result.output !== ''
      ? typeof result.output === 'string'
        ? result.output
        : (() => { try { return JSON.stringify(result.output, null, 2) } catch { return String(result.output) } })()
      : '(工具执行成功，无输出)'
  }

  const parts: string[] = []
  parts.push(`[错误] ${result.error || '(无错误信息)'}`)
  if (result.output !== undefined && result.output !== null && result.output !== '') {
    const outputStr = typeof result.output === 'string'
      ? result.output
      : (() => { try { return JSON.stringify(result.output, null, 2) } catch { return String(result.output) } })()
    if (outputStr.trim()) parts.push(outputStr)
  }
  return parts.join('\n\n')
}

/**
 * 截断较早的 tool result 内容，防止上下文溢出（pi Message 版本）。
 *
 * 关键约束：截断必须「大块 + 滞后 + 切点只前进」，不能按「保留最近 N 条」逐请求移动边界。
 * 后者每次请求都会改动一条历史消息，导致该消息之后的全部 token 前缀失效（KV cache 击穿）。
 *
 * 策略：总估算超过高水位时，从最新往前保留到低水位，其余一次性压成摘要；
 * 切点在单次 run 内冻结（ToolResultTrimState），后续请求即使仍高于高水位也复用同一批截断，
 * 只有有效大小再次超过高水位时才整块向前推进。high-low 的差值提供滞后区间。
 */
const TOOL_RESULT_TRIM_HIGH_WATER_TOKENS = 80000
const TOOL_RESULT_TRIM_LOW_WATER_TOKENS = 30000
const TOOL_RESULT_SUMMARY_PREFIX = '[Truncated] '

/** 工具结果裁剪切点：cut = 已截断的 toolResult 数量（按出现顺序）。
 *  由 BaseAgent 持有并跨 run 复用，避免每个新 user turn 首次请求重新放大截断范围。 */
export interface ToolResultTrimState {
  cut: number
}

function estimateCharsForTrim(msg: PiMessage): number {
  if (msg.role === 'toolResult' || msg.role === 'assistant') {
    let chars = 0
    for (const c of msg.content) {
      if (c.type === 'text') chars += c.text.length
      else if (c.type === 'thinking') chars += c.thinking.length
    }
    return chars
  }
  if (msg.role === 'user' && typeof msg.content === 'string') return msg.content.length
  return 0
}

function estimateTrimTokens(messages: AgentMessage[]): number {
  let chars = 0
  for (const msg of messages) chars += estimateCharsForTrim(msg as PiMessage)
  return chars / 3.5
}

function collectToolResultIndices(messages: AgentMessage[]): number[] {
  const indices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if ((messages[i] as PiMessage).role === 'toolResult') indices.push(i)
  }
  return indices
}

/** 将前 cut 个工具结果压成摘要；已截断/短文本/图片按既有规则处理 */
function applyToolResultTrim(messages: AgentMessage[], cut: number): AgentMessage[] {
  if (cut <= 0) return messages
  const toolResultIndices = collectToolResultIndices(messages)
  if (toolResultIndices.length === 0) return messages
  // 至少保留最新一条：历史被压缩/删除后旧 cut 可能过大，不能把当前工具输出也截掉
  const limit = Math.min(cut, Math.max(0, toolResultIndices.length - 1))
  const result = [...messages]
  for (let k = 0; k < limit; k++) {
    const idx = toolResultIndices[k]
    const msg = result[idx] as ToolResultMessage
    const newContent: (TextContent | ImageContent)[] = []
    for (const c of msg.content) {
      // 已截断的旧图片块直接丢弃，避免被截断历史持续占用视觉上下文
      if (c.type === 'image') continue
      if (c.type === 'text' && c.text.length > 500 && !c.text.startsWith(TOOL_RESULT_SUMMARY_PREFIX)) {
        newContent.push({
          type: 'text',
          text: TOOL_RESULT_SUMMARY_PREFIX + c.text.slice(0, 300) + `\n…(original ${c.text.length} chars, truncated to save context)`,
        })
      } else {
        newContent.push(c)
      }
    }
    result[idx] = { ...msg, content: newContent }
  }
  return result
}

/** 从最新往前累计到低水位，返回需要截断的工具结果数量；至少保留最新一条，避免把当前工具输出也截掉 */
function computeTrimCut(messages: AgentMessage[], toolResultIndices: number[], lowTokens: number): number {
  let keptChars = 0
  let cut = 0
  for (let i = toolResultIndices.length - 1; i >= 0; i--) {
    keptChars += estimateCharsForTrim(messages[toolResultIndices[i]] as PiMessage)
    if (keptChars / 3.5 > lowTokens) {
      cut = i + 1
      break
    }
    cut = i
  }
  return Math.min(cut, Math.max(0, toolResultIndices.length - 1))
}

function trimPiToolResults(
  messages: AgentMessage[],
  state: ToolResultTrimState,
  highTokens: number,
  lowTokens: number,
): AgentMessage[] {
  const toolResultIndices = collectToolResultIndices(messages)
  if (toolResultIndices.length === 0) return messages

  // 历史被重写/压缩导致工具结果数量变少：旧切点已无意义，重新判断
  if (state.cut >= toolResultIndices.length) state.cut = 0

  const current = applyToolResultTrim(messages, state.cut)
  if (estimateTrimTokens(current) < highTokens) {
    return state.cut > 0 ? current : messages
  }

  const nextCut = computeTrimCut(current, toolResultIndices, lowTokens)
  if (nextCut > state.cut) state.cut = nextCut
  return state.cut > 0 ? applyToolResultTrim(messages, state.cut) : messages
}

/**
 * AgentMessage[] → LLM 可见的 PiMessage[]（每次 LLM 请求前的临时转换，不回写上下文）。
 * OpenAI 兼容协议的 tool 消息不允许携带图片内容：
 * 先把 toolResult 中的 ImageContent 抽出，包裹进紧随整个 tool result 批次之后的
 * synthetic user 消息注入，模型即可在同轮看到图片。
 * 单次请求最多注入 MAX_INJECTED_IMAGES 张，更早的图片块直接丢弃以控制上下文。
 */
const MAX_INJECTED_IMAGES = 4

/** 模型不支持图片输入时的降级提示（附在被抽掉图片的 toolResult 文本之后） */
const IMAGE_UNSUPPORTED_NOTE = '\n\n[Note] This model does not support image input, so the image was not sent with the request. To read text inside the image, use the ocr_image tool.'
const IMAGE_UNSUPPORTED_MARKER = 'This model does not support image input'

function convertMessagesForLlm(messages: AgentMessage[], imageSupport: boolean): PiMessage[] {
  const out: PiMessage[] = []
  let pendingImages: ImageContent[] = []
  const flushImages = () => {
    if (pendingImages.length === 0) return
    // 超出上限时保留最新的图片，较早的丢弃
    const injected = pendingImages.length > MAX_INJECTED_IMAGES
      ? pendingImages.slice(-MAX_INJECTED_IMAGES)
      : pendingImages
    pendingImages = []
    out.push({
      role: 'user',
      timestamp: Date.now(),
      content: [
        { type: 'text', text: '[Attached images] The tool returned the following image(s). Continue the analysis using their content:' },
        ...injected,
      ],
    })
  }

  for (const m of messages) {
    const pm = m as PiMessage
    if (pm.role === 'toolResult') {
      const rest: TextContent[] = []
      for (const c of pm.content) {
        if (c.type === 'image') {
          // 支持视觉：暂存待注入；不支持：丢弃并补降级提示
          if (imageSupport) pendingImages.push(c)
        } else {
          rest.push(c as TextContent)
        }
      }
      if (!imageSupport && pm.content.some(c => c.type === 'image')
        && !pm.content.some(c => c.type === 'text' && c.text.includes(IMAGE_UNSUPPORTED_MARKER))) {
        rest.push({ type: 'text', text: IMAGE_UNSUPPORTED_NOTE })
      }
      if (rest.length === 0) rest.push({ type: 'text', text: '(no text output)' })
      out.push({ ...pm, content: rest })
      continue
    }
    flushImages()
    out.push(pm as PiMessage)
  }
  flushImages()
  return out
}

export interface RunPiAgentLoopParams {
  config: AgentConfig
  messages: Message[]
  toolDefinitions: OpenAIToolDefinition[]
  toolDispatcher: ToolDispatcher
  toolRegistry: ToolRegistry
  callbacks: AgentRunStreamCallbacks
  signal?: AbortSignal
  maxIterations: number
  eventEmitter: AgentEventEmitter
  agentContext: AgentContext
  onToolCallExecuted?: (toolName: string, args: any, result: ToolCallResult) => Promise<void>
  onPromptTokens?: (tokens: number) => void
  /** 会话 ID，传递给 pi-agent-core → streamFn → pi-ai 以启用 prompt cache */
  sessionId?: string
  /**
   * 每轮模型请求前查询节流提醒（turn 从 1 开始，按模型请求序号计）。
   * 返回的文本作为合成 user 消息追加在当次请求尾部（append-only，不回写上下文），
   * 因此不改变已发生对话的前缀缓存。
   */
  getLoopReminder?: (turn: number, maxIterations: number) => string | undefined
  /**
   * 易变任务上下文（记忆/知识库范围）：仅在本次 run 的首次请求追加在末尾，
   * 不写入 pi 上下文。后续工具轮次不重复注入，避免每次请求都多出一段未缓存 token；
   * 工作区/任务时间已由稳定头承载，仍全程可见。
   */
  requestTail?: string
  /** 工具结果裁剪高水位（token）：由模型上下文窗口派生；未传入时使用内置默认值 */
  trimHighWaterTokens?: number
  /** 工具结果裁剪低水位（token）：由模型上下文窗口派生；未传入时使用内置默认值 */
  trimLowWaterTokens?: number
  /** 跨 run 复用的裁剪切点（由 BaseAgent 持有，避免每个新 user turn 重置切点） */
  trimState?: ToolResultTrimState
}

/**
 * 用 pi-agent-core 的 agentLoop 执行智能体循环。
 * 内部完成：Message 转换、AgentTool 包装、事件转换、上下文截断、token 统计。
 * 保留现有 AgentRunStreamCallbacks + AgentEventEmitter 契约，前端零改动。
 */
export interface RunPiAgentLoopResult {
  tokenUsage?: TokenUsage
  aborted?: boolean
  /** 中断原因描述，便于排查 aborted 是用户主动停止还是底层异常 */
  abortReason?: string
}

export async function runPiAgentLoop(params: RunPiAgentLoopParams): Promise<RunPiAgentLoopResult> {
  const {
    config,
    messages,
    toolDefinitions,
    toolDispatcher,
    toolRegistry,
    callbacks,
    signal,
    maxIterations,
    eventEmitter,
    agentContext,
    onToolCallExecuted,
    onPromptTokens,
    sessionId,
    getLoopReminder,
    requestTail,
    trimHighWaterTokens,
    trimLowWaterTokens,
    trimState: sharedTrimState,
  } = params

  const { systemPrompt, piMessages } = toPiMessages(messages, config.providerType, config.model, config.apiFormat)

  // 拆分：history → context.messages，最后一条 user → prompts
  const lastUserIdx = (() => {
    for (let i = piMessages.length - 1; i >= 0; i--) {
      if ((piMessages[i] as PiMessage).role === 'user') return i
    }
    return -1
  })()

  let contextMessages: PiMessage[]
  let prompts: AgentMessage[]
  if (lastUserIdx >= 0) {
    contextMessages = piMessages.slice(0, lastUserIdx)
    prompts = [piMessages[lastUserIdx]]
  } else {
    contextMessages = piMessages
    prompts = []
  }

  // 包装工具为 AgentTool
  const imageSupport = config.supportsImageInput === true
  const agentTools: AgentTool[] = []
  for (const def of toolDefinitions) {
    const name = def.function.name
    const tool = toolRegistry.getTool(name)
    if (tool) {
      agentTools.push(toAgentTool(tool, toolDispatcher, imageSupport))
    }
  }

  // pi-ai 1.x 的 AgentContext 不再承载 systemPrompt/tools：提示词与工具声明折叠为
  // transcript 首条 system 消息（tools 仍用于工具执行）
  const systemMessage = createInitialSystemMessage(systemPrompt, agentTools.map(toToolDeclaration))
  const piAgentContext: PiAgentContext = {
    messages: [
      ...(systemMessage ? [systemMessage] : []),
      ...contextMessages,
    ] as AgentMessage[],
    tools: agentTools,
  }

  let turnCount = 0
  // 裁剪切点优先复用 BaseAgent 持有的跨 run 状态；未提供时仅本次 run 内有效
  const trimState: ToolResultTrimState = sharedTrimState ?? { cut: 0 }
  const trimHigh = trimHighWaterTokens ?? config.trimHighWaterTokens ?? TOOL_RESULT_TRIM_HIGH_WATER_TOKENS
  const trimLow = trimLowWaterTokens ?? config.trimLowWaterTokens ?? TOOL_RESULT_TRIM_LOW_WATER_TOKENS
  // 模型请求序号（流式恢复重试会在同一 turn 内再次转换，序号只增不减）
  let requestNumber = 0
  let totalTokenUsage: TokenUsage = {}
  // 本次 LLM 请求的流式计时（首/末 delta），用于计算输出速度
  const streamTiming: StreamTiming = {}
  // 缓存 toolCallId → args：pi-agent-core 的 tool_execution_end 不含 args，需从 start 时缓存
  const toolArgsCache = new Map<string, any>()
  // 缓存 toolCallId → startTime：用于计算 latencyMs
  const toolStartTime = new Map<string, number>()

  const loopConfig: AgentLoopConfig = {
    model: createPiModel(config),
    convertToLlm: (msgs: AgentMessage[]) => {
      requestNumber += 1
      // 每次请求前重置流式计时（流式恢复重试会在同一 turn 内再次进入）
      streamTiming.firstDeltaAt = undefined
      streamTiming.lastDeltaAt = undefined
      const converted = convertMessagesForLlm(msgs, config.supportsImageInput === true)
      // 易变任务上下文：只在本次 run 的首次请求注入（工作区/任务时间已在稳定头）。
      // ask_user 返回代表新的用户输入，需要再次注入记忆/知识库范围；普通工具轮次不重复。
      const lastMsg = msgs[msgs.length - 1] as PiMessage | undefined
      const afterUserInteraction = lastMsg?.role === 'toolResult' && (lastMsg as any).toolName === 'ask_user'
      if (requestTail && (requestNumber === 1 || afterUserInteraction)) {
        converted.push({
          role: 'user',
          timestamp: Date.now(),
          content: requestTail,
        } as PiMessage)
      }
      // 节流提醒：append-only，放在最后（每请求变化，不影响任务上下文的复用）
      if (getLoopReminder) {
        const reminder = getLoopReminder(requestNumber, maxIterations)
        if (reminder) {
          converted.push({
            role: 'user',
            timestamp: Date.now(),
            content: reminder,
          } as PiMessage)
        }
      }
      return converted
    },
    transformContext: async (msgs: AgentMessage[]) => trimPiToolResults(msgs, trimState, trimHigh, trimLow),
    // pi-ai 1.x 以 finishTurn 取代 shouldStopAfterTurn：undefined 表示正常调度，end 表示结束本次 run
    finishTurn: () => {
      turnCount++
      return turnCount >= maxIterations ? { action: 'end' as const } : undefined
    },
    toolExecution: 'sequential',
    // pi-agent-core 通过 config.reasoning 传给 streamFn 的 options.reasoning
    // createStreamFn 将其映射为 pi-ai 的 reasoningEffort，驱动 deepseek/qwen thinkingFormat 开关
    ...(config.enableThinking ? { reasoning: config.enableThinking } : {}),
    // sessionId 传递给 streamFn → pi-ai，启用 prompt cache（openai/deepseek/xiaomi 等支持）
    ...(sessionId ? { sessionId } : {}),
  }

  const streamFn = createStreamFn(config)

  // 启动 agentLoop，获取事件流
  const eventStream = prompts.length > 0
    ? agentLoop(prompts, piAgentContext, loopConfig, signal, streamFn)
    : agentLoopContinue(piAgentContext, loopConfig, signal, streamFn)

  // 订阅事件并转换
  // 注意：run:start/run:end 由 base-agent 统一 emit，这里不重复
  // 中止时（signal.aborted 或底层 fetch 抛 AbortError）不抛出，保留已累计的 tokenUsage 返回，
  // 让 base-agent 走 aborted 分支并把 tokenUsage/contextStats 透传给前端
  let aborted = false
  let abortReason: string | undefined
  try {
    for await (const event of eventStream) {
      if (signal?.aborted) {
        aborted = true
        abortReason = '用户主动停止（signal 已中止）'
        break
      }
      await handleAgentEvent(event, callbacks, eventEmitter, agentContext, onToolCallExecuted, onPromptTokens, toolArgsCache, toolStartTime, (usage, generationMs) => {
        const prevGenerationMs = totalTokenUsage.generationMs
        totalTokenUsage = {
          promptTokens: (totalTokenUsage.promptTokens || 0) + (usage.promptTokens || 0),
          completionTokens: (totalTokenUsage.completionTokens || 0) + (usage.completionTokens || 0),
          totalTokens: (totalTokenUsage.totalTokens || 0) + (usage.totalTokens || 0),
          ...(totalTokenUsage.cachedTokens || usage.cachedTokens
            ? { cachedTokens: (totalTokenUsage.cachedTokens || 0) + (usage.cachedTokens || 0) }
            : {}),
          ...(prevGenerationMs !== undefined || generationMs !== undefined
            ? { generationMs: (prevGenerationMs || 0) + (generationMs || 0) }
            : {}),
        }
      }, streamTiming)
    }
  } catch (err: any) {
    // signal.aborted 视为正常中止，保留 tokenUsage 返回；其他异常继续上抛
    if (signal?.aborted) {
      aborted = true
      // 区分用户主动停止 vs 底层异常（如网络中断）：若底层抛的是非 AbortError 错误，
      // 说明 signal 虽被中止但底层同时发生了异常，记录具体错误便于排查
      const isAbortError = err?.name === 'AbortError' || /abort/i.test(err?.message || '')
      abortReason = isAbortError
        ? '用户主动停止（signal 已中止，底层请求被中止）'
        : `signal 已中止，但底层抛出异常: ${err?.message || String(err)}`
    } else {
      throw err
    }
  }

  if (aborted) {
    logger.warn(`Agent loop aborted: ${abortReason}`)
  }

  // 若未累计到任何 token（abort 过早或 LLM 未返回 usage），返回 undefined 让前端回退到字符数
  const hasUsage = totalTokenUsage.promptTokens !== undefined
    || totalTokenUsage.completionTokens !== undefined
    || totalTokenUsage.totalTokens !== undefined
    || totalTokenUsage.cachedTokens !== undefined
  return { tokenUsage: hasUsage ? totalTokenUsage : undefined, aborted, abortReason }
}

/**
 * 从 partial content 中按 contentIndex 定位工具调用块。
 * contentIndex 指示参数增量所属的工具调用块（text/thinking 也占 content 下标）。
 * 不能用 find 取「第一个 toolCall」：同一 assistant 消息含多个工具调用时，
 * 后续工具的参数增量会被错误归到第一张卡片，前端流式参数展示错位。
 * 越界/类型不符时回退 find（对异常事件保持旧行为的兜底）。
 */
export function findToolCallByContentIndex(
  content: any[],
  contentIndex: number | undefined,
): PiToolCall | undefined {
  const indexed = contentIndex === undefined ? undefined : content[contentIndex]
  if (indexed && indexed.type === 'toolCall') return indexed as PiToolCall
  return content.find((c): c is PiToolCall => c.type === 'toolCall')
}

/** 单次 LLM 请求的流式计时：首个 delta → 末个 delta */
interface StreamTiming {
  firstDeltaAt?: number
  lastDeltaAt?: number
}

function markStreamDelta(timing: StreamTiming): void {
  const now = Date.now()
  if (timing.firstDeltaAt === undefined) timing.firstDeltaAt = now
  timing.lastDeltaAt = now
}

async function handleAgentEvent(
  event: AgentEvent,
  callbacks: AgentRunStreamCallbacks,
  eventEmitter: AgentEventEmitter,
  agentContext: AgentContext,
  onToolCallExecuted: RunPiAgentLoopParams['onToolCallExecuted'] | undefined,
  onPromptTokens: ((tokens: number) => void) | undefined,
  toolArgsCache: Map<string, any>,
  toolStartTime: Map<string, number>,
  onUsage: (usage: TokenUsage, generationMs?: number) => void,
  timing: StreamTiming,
): Promise<void> {
  switch (event.type) {
    case 'agent_start':
      // 不在此处 emit run:start，base-agent.runStream 已统一 emit，避免重复
      break

    case 'agent_end':
      // 不在此处 emit run:end，base-agent.runStream 已统一 emit，避免重复
      break

    case 'turn_start':
      // 恢复 running 状态：上一轮 tool_execution_end 后 state 可能停留在 tool_calling
      agentContext.setState('running')
      agentContext.incrementIteration()
      eventEmitter.emit('iteration:start', { iteration: agentContext.getIterationCount() })
      callbacks.onIterationStart?.(agentContext.getIterationCount())
      break

    case 'turn_end': {
      const iter = agentContext.getIterationCount()
      eventEmitter.emit('iteration:end', { iteration: iter })
      callbacks.onIterationEnd?.(iter)
      const asstMsg = event.message as PiAssistantMessage
      // 错误可见性：pi-ai 出错时 stopReason="error"，errorMessage 含具体原因
      // 不抛错会让用户看到空输出且无报错
      if (asstMsg.stopReason === 'error' && asstMsg.errorMessage) {
        throw new Error(`LLM 请求失败: ${asstMsg.errorMessage}`)
      }
      const usage = toTokenUsage(asstMsg.usage)
      if (usage) {
        // 首 token → 末 token 的耗时（无多段 delta 时无意义，返回 undefined），用于输出速度统计
        const start = timing.firstDeltaAt
        const end = timing.lastDeltaAt
        const generationMs = start !== undefined && end !== undefined && end > start ? end - start : undefined
        onUsage(usage, generationMs)
        if (usage.promptTokens) onPromptTokens?.(usage.promptTokens)
      }
      break
    }

    case 'message_update': {
      const asstEvent = event.assistantMessageEvent
      switch (asstEvent.type) {
        case 'text_delta':
          markStreamDelta(timing)
          callbacks.onChunk?.(asstEvent.delta)
          break
        case 'thinking_delta':
          markStreamDelta(timing)
          callbacks.onThought?.(asstEvent.delta)
          break
        case 'toolcall_delta': {
          markStreamDelta(timing)
          const partial = asstEvent.partial
          const tc = findToolCallByContentIndex(partial.content, asstEvent.contentIndex)
          callbacks.onToolCallDelta?.({
            index: asstEvent.contentIndex,
            id: tc?.id,
            name: tc?.name,
            arguments: asstEvent.delta,
          })
          break
        }
        default:
          break
      }
      break
    }

    case 'tool_execution_start': {
      agentContext.setState('tool_calling')
      // 缓存 args 与 startTime，供 tool_execution_end 使用
      // pi-agent-core 的 tool_execution_end 不含 args，需在此处缓存
      toolArgsCache.set(event.toolCallId, event.args)
      toolStartTime.set(event.toolCallId, Date.now())
      eventEmitter.emit('tool:call:start', { tool: event.toolName, args: event.args })
      // iteration：本次工具调用所属的模型请求轮次，前端据此还原 assistant 消息边界
      callbacks.onToolCall?.({
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        iteration: agentContext.getIterationCount(),
      })
      break
    }

    case 'tool_execution_update': {
      const details = (event.partialResult as any)?.details
      callbacks.onToolProgress?.({
        toolCallId: event.toolCallId,
        name: event.toolName,
        progress: details?.progress ?? event.partialResult,
      })
      break
    }

    case 'tool_execution_end': {
      const details = (event.result as any)?.details
      // success（传给前端的"工具调用是否成功"）只基于 isError（是否抛异常/abort）
      // 业务层成功（details.success，如 shell_exec exit_code=0）不影响前端"调用失败"判断，
      // LLM 从 output 内容（含 exit_code/stderr）自行判断命令是否失败
      const success = !event.isError
      const startMs = toolStartTime.get(event.toolCallId)
      const result: ToolCallResult = {
        success: details?.success ?? !event.isError,
        output: details?.output,
        error: details?.error,
        toolName: event.toolName,
        rawOutput: details?.rawOutput,
        generatedFiles: details?.generatedFiles as GeneratedFileInfo[] | undefined,
        images: details?.images as string[] | undefined,
        latencyMs: details?.latencyMs ?? (startMs ? Date.now() - startMs : undefined),
      }
      // 清理 startTime 缓存（args 在 onToolCallExecuted 后清理）
      toolStartTime.delete(event.toolCallId)

      eventEmitter.emit('tool:call:end', { tool: event.toolName, success })
      // 展示值（前端 UI 用 output / error）；若 LLM 实际看到的文本与「仅凭展示值重建」不同，
      // 额外下发 resultRaw，前端重建 history 时原样使用，避免跨轮前缀字节漂移
      const displayValue = success ? result.output : result.error
      const llmContent = details?.llmContent
      const resultRaw = typeof llmContent === 'string' && llmContent !== expectedToolMessageContent(displayValue)
        ? llmContent
        : undefined
      callbacks.onToolResult?.({
        name: event.toolName,
        // 前端展示用 result：工具调用成功时展示 output，失败（异常）时展示 error
        result: displayValue,
        rawResult: result.rawOutput,
        resultRaw,
        generatedFiles: result.generatedFiles,
        images: result.images,
        // success 字段表示"工具调用是否成功"（基于 isError），非业务层成功
        success,
        // 协议级失败标记：Anthropic tool_result.is_error 需要跨轮回放，否则历史字节不一致
        isError: event.isError === true,
      })

      if (onToolCallExecuted) {
        try {
          // tool_execution_end 不含 args，从 tool_execution_start 缓存中取
          const args = toolArgsCache.get(event.toolCallId) ?? {}
          await onToolCallExecuted(event.toolName, args, result)
        } catch (err: any) {
          logger.error(`onToolCallExecuted hook error for "${event.toolName}": ${err?.message || err}`)
        } finally {
          toolArgsCache.delete(event.toolCallId)
        }
      } else {
        toolArgsCache.delete(event.toolCallId)
      }
      break
    }

    default:
      break
  }
}
