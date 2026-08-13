import { agentLoop, agentLoopContinue } from '@earendil-works/pi-agent-core'
import { stream as openaiCompletionsStream } from '@earendil-works/pi-ai/api/openai-completions'
import {
  type Model,
  type Message as PiMessage,
  type UserMessage,
  type AssistantMessage as PiAssistantMessage,
  type ToolResultMessage,
  type TextContent,
  type ThinkingContent,
  type ImageContent,
  type ToolCall as PiToolCall,
  type Usage as PiUsage,
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
import type { GeneratedFileInfo } from '../../../../shared/types'

const logger = createLogger('PiAgentAdapter')

/** 构造 pi-ai 合成 Model<"openai-completions">，复用 PiAIProvider 的 thinkingFormat 映射逻辑 */
function createPiModel(config: AgentConfig): Model<'openai-completions'> {
  const providerType = config.providerType
  let thinkingFormat: 'deepseek' | 'qwen' | undefined
  switch (providerType) {
    case 'deepseek':
    case 'volcengine':
    case 'zhipu':
      thinkingFormat = 'deepseek'
      break
    case 'qwen':
      thinkingFormat = 'qwen'
      break
  }

  // LMStudio 等本地服务不支持 store 等 OpenAI 特有参数
  const isLocalProvider = providerType === 'lmstudio'
  // 国产 provider（deepseek/qwen/volcengine/zhipu）均不支持 developer role
  const supportsDeveloperRole = !thinkingFormat && !isLocalProvider
  // volcengine/zhipu 只接受 thinking 参数，不支持 reasoning_effort（deepseek 两者都支持）
  const reasoningEffortSupported = providerType === 'deepseek'
  // 关键：对有 thinkingFormat 的 provider，reasoning 必须始终为 true
  // pi-ai 的 thinkingFormat 分支只在 model.reasoning=true 时执行
  // 若为 false，分支不执行 → 不发 thinking 参数 → 豆包等用默认行为（开思考），开关失效
  // 开关由 reasoningEffort 控制：有值→enabled，无值→disabled
  const reasoning = !!config.enableThinking || !!thinkingFormat

  return {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: providerType || 'openai',
    baseUrl: config.baseUrl || 'https://api.openai.com/v1',
    reasoning,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: {
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      maxTokensField: 'max_tokens',
      supportsReasoningEffort: reasoningEffortSupported,
      supportsDeveloperRole,
      ...(thinkingFormat ? { thinkingFormat } : {}),
      ...(isLocalProvider ? { supportsStore: false } : {}),
    },
  }
}

/** 从 data URL 解析 base64 数据与 mimeType；非 data URL 原样返回（让 provider 自行处理 HTTP 图） */
function parseImageDataUrl(url: string): { data: string; mimeType: string } | { url: string } {
  const match = /^data:(image\/[a-zA-Z+.-]+);base64,(.*)$/.exec(url)
  if (match) {
    return { data: match[2], mimeType: match[1] }
  }
  return { url }
}

/** 构造 streamFn，内部委托给 pi-ai openai-completions stream */
function createStreamFn(config: AgentConfig): StreamFn {
  const piModel = createPiModel(config)
  const apiKey = config.apiKey
  return (_model, context, options) => {
    return openaiCompletionsStream(piModel, context, {
      apiKey,
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      // pi-ai stream 函数通过 reasoningEffort 决定 deepseek/qwen thinkingFormat 的开关
      // pi-agent-core 传的 options.reasoning 是 ThinkingLevel 类型，直接复用
      ...(options?.reasoning ? { reasoningEffort: options.reasoning } : {}),
    } as any)
  }
}

/** 现有 Message[] → pi Message[] + systemPrompt */
function toPiMessages(messages: Message[]): { systemPrompt?: string; piMessages: PiMessage[] } {
  let systemPrompt: string | undefined
  const piMessages: PiMessage[] = []
  const ts = Date.now()

  for (const m of messages) {
    if (m.role === 'system') {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${m.content}`
        : m.content
      continue
    }

    if (m.role === 'user') {
      const content: string | (TextContent | ImageContent)[] = m.images && m.images.length > 0
        ? [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.images.map(url => {
              const parsed = parseImageDataUrl(url)
              if ('data' in parsed) {
                return { type: 'image' as const, data: parsed.data, mimeType: parsed.mimeType }
              }
              // HTTP URL：pi-ai 仅支持 base64 data，HTTP 图需下载后转 base64
              // 此处保留 url 形式，provider 不识别时会忽略
              return { type: 'image' as const, data: parsed.url, mimeType: 'image/png' }
            }),
          ]
        : m.content
      const userMsg: UserMessage = { role: 'user', content, timestamp: ts }
      piMessages.push(userMsg)
      continue
    }

    if (m.role === 'assistant') {
      const contentParts: (TextContent | ThinkingContent | PiToolCall)[] = []
      if (m.content) contentParts.push({ type: 'text', text: m.content })
      if (m.reasoning_content) {
        contentParts.push({ type: 'thinking', thinking: m.reasoning_content })
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
        api: 'openai-completions',
        provider: 'openai',
        model: '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: ts,
      })
      continue
    }

    if (m.role === 'tool') {
      const text = m.content || ''
      piMessages.push({
        role: 'toolResult',
        toolCallId: m.toolCallId || '',
        toolName: '',
        content: text ? [{ type: 'text', text }] : [],
        isError: false,
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
 * 注意：ToolDispatcher.dispatch 不接受 signal 参数，这里通过 dispatch 前检查 abort 与超时中间件兜底。
 */
function toAgentTool(
  tool: ToolDefinition,
  dispatcher: ToolDispatcher,
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

      const toolContext = onUpdate
        ? { onProgress: (progress: any) => onUpdate({ content: [{ type: 'text', text: '' }], details: { progress } }) }
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
      return {
        content: [{ type: 'text', text }],
        details: {
          output: result.output,
          error: result.error,
          rawOutput: result.rawOutput,
          generatedFiles: result.generatedFiles,
          success: result.success,
          latencyMs: result.latencyMs ?? (Date.now() - startMs),
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
 * 保留最近 KEEP_RECENT 条 tool result 完整，更早的截断为摘要。
 */
function trimPiToolResults(messages: AgentMessage[]): AgentMessage[] {
  const MAX_ESTIMATED_TOKENS = 80000
  const KEEP_RECENT = 6
  const SUMMARY_PREFIX = '[已截断] '

  let totalChars = 0
  for (const msg of messages) {
    const pm = msg as PiMessage
    if (pm.role === 'toolResult') {
      for (const c of pm.content) {
        if (c.type === 'text') totalChars += c.text.length
      }
    } else if (pm.role === 'assistant') {
      for (const c of pm.content) {
        if (c.type === 'text') totalChars += c.text.length
        else if (c.type === 'thinking') totalChars += c.thinking.length
      }
    } else if (pm.role === 'user') {
      if (typeof pm.content === 'string') totalChars += pm.content.length
    }
  }

  if (totalChars / 3.5 < MAX_ESTIMATED_TOKENS) return messages

  const toolResultIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if ((messages[i] as PiMessage).role === 'toolResult') toolResultIndices.push(i)
  }

  const keepCount = Math.min(KEEP_RECENT, toolResultIndices.length)
  const toTrim = toolResultIndices.slice(0, toolResultIndices.length - keepCount)
  const result = [...messages]

  for (const idx of toTrim) {
    const msg = result[idx] as ToolResultMessage
    const newContent: (TextContent | ImageContent)[] = []
    for (const c of msg.content) {
      if (c.type === 'text' && c.text.length > 500 && !c.text.startsWith(SUMMARY_PREFIX)) {
        newContent.push({
          type: 'text',
          text: SUMMARY_PREFIX + c.text.slice(0, 300) + `\n…(原 ${c.text.length} 字符，已截断以节省上下文)`,
        })
      } else {
        newContent.push(c)
      }
    }
    result[idx] = { ...msg, content: newContent }
  }

  return result
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
}

/**
 * 用 pi-agent-core 的 agentLoop 执行智能体循环。
 * 内部完成：Message 转换、AgentTool 包装、事件转换、上下文截断、token 统计。
 * 保留现有 AgentRunStreamCallbacks + AgentEventEmitter 契约，前端零改动。
 */
export async function runPiAgentLoop(params: RunPiAgentLoopParams): Promise<{ tokenUsage: TokenUsage }> {
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
  } = params

  const { systemPrompt, piMessages } = toPiMessages(messages)

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
  const agentTools: AgentTool[] = []
  for (const def of toolDefinitions) {
    const name = def.function.name
    const tool = toolRegistry.getTool(name)
    if (tool) {
      agentTools.push(toAgentTool(tool, toolDispatcher))
    }
  }

  const piAgentContext: PiAgentContext = {
    systemPrompt: systemPrompt || '',
    messages: contextMessages as AgentMessage[],
    tools: agentTools,
  }

  let turnCount = 0
  let totalTokenUsage: TokenUsage = {}
  // 缓存 toolCallId → args：pi-agent-core 的 tool_execution_end 不含 args，需从 start 时缓存
  const toolArgsCache = new Map<string, any>()
  // 缓存 toolCallId → startTime：用于计算 latencyMs
  const toolStartTime = new Map<string, number>()

  const loopConfig: AgentLoopConfig = {
    model: createPiModel(config),
    convertToLlm: (msgs: AgentMessage[]) => msgs as PiMessage[],
    transformContext: async (msgs: AgentMessage[]) => trimPiToolResults(msgs),
    shouldStopAfterTurn: () => {
      turnCount++
      return turnCount >= maxIterations
    },
    toolExecution: 'sequential',
    // pi-agent-core 通过 config.reasoning 传给 streamFn 的 options.reasoning
    // createStreamFn 将其映射为 pi-ai 的 reasoningEffort，驱动 deepseek/qwen thinkingFormat 开关
    ...(config.enableThinking ? { reasoning: 'high' as const } : {}),
  }

  const streamFn = createStreamFn(config)

  // 启动 agentLoop，获取事件流
  const eventStream = prompts.length > 0
    ? agentLoop(prompts, piAgentContext, loopConfig, signal, streamFn)
    : agentLoopContinue(piAgentContext, loopConfig, signal, streamFn)

  // 订阅事件并转换
  // 注意：run:start/run:end 由 base-agent 统一 emit，这里不重复
  for await (const event of eventStream) {
    if (signal?.aborted) break
    handleAgentEvent(event, callbacks, eventEmitter, agentContext, onToolCallExecuted, onPromptTokens, toolArgsCache, toolStartTime, (usage) => {
      totalTokenUsage = {
        promptTokens: (totalTokenUsage.promptTokens || 0) + (usage.promptTokens || 0),
        completionTokens: (totalTokenUsage.completionTokens || 0) + (usage.completionTokens || 0),
        totalTokens: (totalTokenUsage.totalTokens || 0) + (usage.totalTokens || 0),
        ...(totalTokenUsage.cachedTokens || usage.cachedTokens
          ? { cachedTokens: (totalTokenUsage.cachedTokens || 0) + (usage.cachedTokens || 0) }
          : {}),
      }
    })
  }

  return { tokenUsage: totalTokenUsage }
}

function handleAgentEvent(
  event: AgentEvent,
  callbacks: AgentRunStreamCallbacks,
  eventEmitter: AgentEventEmitter,
  agentContext: AgentContext,
  onToolCallExecuted: RunPiAgentLoopParams['onToolCallExecuted'] | undefined,
  onPromptTokens: ((tokens: number) => void) | undefined,
  toolArgsCache: Map<string, any>,
  toolStartTime: Map<string, number>,
  onUsage: (usage: TokenUsage) => void,
): void {
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
        onUsage(usage)
        if (usage.promptTokens) onPromptTokens?.(usage.promptTokens)
      }
      break
    }

    case 'message_update': {
      const asstEvent = event.assistantMessageEvent
      switch (asstEvent.type) {
        case 'text_delta':
          callbacks.onChunk?.(asstEvent.delta)
          break
        case 'thinking_delta':
          callbacks.onThought?.(asstEvent.delta)
          break
        case 'toolcall_delta': {
          const partial = asstEvent.partial
          const tc = partial.content.find((c): c is PiToolCall => c.type === 'toolCall')
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
      callbacks.onToolCall?.({ id: event.toolCallId, name: event.toolName, args: event.args })
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
        latencyMs: details?.latencyMs ?? (startMs ? Date.now() - startMs : undefined),
      }
      // 清理 startTime 缓存（args 在 onToolCallExecuted 后清理）
      toolStartTime.delete(event.toolCallId)

      eventEmitter.emit('tool:call:end', { tool: event.toolName, success })
      callbacks.onToolResult?.({
        name: event.toolName,
        // 前端展示用 result：工具调用成功时展示 output，失败（异常）时展示 error
        result: success ? result.output : result.error,
        rawResult: result.rawOutput,
        generatedFiles: result.generatedFiles,
        // success 字段表示"工具调用是否成功"（基于 isError），非业务层成功
        success,
      })

      if (onToolCallExecuted) {
        try {
          // tool_execution_end 不含 args，从 tool_execution_start 缓存中取
          const args = toolArgsCache.get(event.toolCallId) ?? {}
          onToolCallExecuted(event.toolName, args, result)
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
