import type { ThinkingLevel } from '../../../../shared/types'
import { getProviderExtraRequestHeaders, resolveReasoningEffort } from './provider-compat'

/**
 * 统一构造 pi-ai openai-completions stream 的 options（单一入口）。
 * PiAIProvider 与 pi-agent-adapter 共用，集中处理：
 * - 思考强度（reasoningEffort，含 alwaysReasoning provider 的兜底）
 * - 会话亲和 / 供应商附加请求头（headers）
 * - 采样参数（top_p / frequency_penalty / presence_penalty → samplingParams）
 * - 思考预算（thinkingBudget → thinkingBudgets）
 * - 供应商附加请求体（extraBody → onPayload）
 * - 请求超时（timeoutMs）
 * 避免两条链路各自拼装导致行为漂移。
 */
export interface PiStreamOptionsInput {
  providerType?: string
  modelId?: string
  apiKey?: string
  sessionId?: string
  signal?: AbortSignal
  enableThinking?: ThinkingLevel
  temperature?: number
  maxTokens?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  thinkingBudget?: number
  timeoutMs?: number
  /**
   * 是否为流式调用。流式时忽略 timeoutMs：
   * pi-ai 会把 timeoutMs 直接交给 OpenAI SDK 的 timeout（整请求时限，非 idle），
   * 供应商 timeout_ms 默认 60000，套到长流式回复上会被中途中断；流式用 signal 控制即可。
   */
  streaming?: boolean
  /** 供应商级附加请求头（优先级高于内置会话路由头，可覆盖） */
  extraHeaders?: Record<string, string>
  /** 供应商级附加请求体字段（浅合并进请求体，同名键覆盖） */
  extraBody?: Record<string, any>
}

export function buildPiStreamOptions(input: PiStreamOptionsInput): Record<string, any> {
  const samplingParams: Record<string, unknown> = {}
  if (input.topP !== undefined) samplingParams.top_p = input.topP
  if (input.frequencyPenalty !== undefined) samplingParams.frequency_penalty = input.frequencyPenalty
  if (input.presencePenalty !== undefined) samplingParams.presence_penalty = input.presencePenalty

  const reasoningEffort = resolveReasoningEffort(input.providerType, input.modelId, input.enableThinking)
  const routingHeaders = getProviderExtraRequestHeaders(input.providerType, input.modelId, input.sessionId)
  // 供应商显式配置的附加头优先，便于用户覆盖内置会话路由头
  const headers: Record<string, string> = { ...(routingHeaders || {}), ...(input.extraHeaders || {}) }

  return {
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(Object.keys(samplingParams).length > 0 ? { samplingParams } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    // thinkingBudgets 是「按强度档位」的 map；项目侧 thinking_budget 是单一数值，统一套用到各档
    ...(input.thinkingBudget !== undefined
      ? {
          thinkingBudgets: {
            minimal: input.thinkingBudget,
            low: input.thinkingBudget,
            medium: input.thinkingBudget,
            high: input.thinkingBudget,
          },
        }
      : {}),
    // 流式调用不设 timeoutMs（见 PiStreamOptionsInput.streaming 注释），避免长回复被整请求时限截断
    ...(input.timeoutMs !== undefined && !input.streaming ? { timeoutMs: input.timeoutMs } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(input.extraBody ? { onPayload: (payload: any) => ({ ...payload, ...input.extraBody }) } : {}),
  }
}
