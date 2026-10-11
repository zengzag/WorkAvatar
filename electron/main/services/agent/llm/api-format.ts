import type { Model } from '@earendil-works/pi-ai'
import { stream as openaiCompletionsStream } from '@earendil-works/pi-ai/api/openai-completions'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { LLMApiFormat, ThinkingLevel } from '../../../../shared/types'
import { getProviderCompat } from './provider-compat'

export const DEFAULT_API_FORMAT: LLMApiFormat = 'chat-completions'

/** 归一化接口形式：未知值回退 chat-completions */
export function normalizeApiFormat(value?: string | null): LLMApiFormat {
  return value === 'anthropic-messages' || value === 'openai-responses' ? value : DEFAULT_API_FORMAT
}

/** 接口形式 → pi-ai api 标识 */
export function resolvePiApi(value?: string | null): 'openai-completions' | 'anthropic-messages' | 'openai-responses' {
  const format = normalizeApiFormat(value)
  if (format === 'anthropic-messages') return 'anthropic-messages'
  if (format === 'openai-responses') return 'openai-responses'
  return 'openai-completions'
}

/** 延迟加载的 pi-ai stream 实现：anthropic/responses 的 SDK 仅在首次调用时动态载入 */
const anthropicApi = anthropicMessagesApi()
const responsesApi = openAIResponsesApi()

type PiStreamFn = (model: any, context: any, options?: any) => any

/** 按接口形式选择 pi-ai stream 函数（chat-completions 复用既有静态导入） */
export function resolvePiStreamFn(value?: string | null): PiStreamFn {
  const format = normalizeApiFormat(value)
  if (format === 'anthropic-messages') return anthropicApi.stream as PiStreamFn
  if (format === 'openai-responses') return responsesApi.stream as PiStreamFn
  return openaiCompletionsStream as unknown as PiStreamFn
}

/**
 * 各接口形式的 baseUrl 语义：
 * - chat-completions / openai-responses：OpenAI SDK 约定 baseUrl 含 /v1，SDK 追加 /chat/completions 或 /responses
 * - anthropic-messages：Anthropic SDK 约定 baseUrl 不含 /v1（SDK 追加 /v1/messages）；
 *   为兼容按 OpenAI 习惯填写的 .../v1，剥离结尾的 /v1
 */
export function resolveApiBaseUrl(value: string | undefined, baseUrl: string): string {
  if (normalizeApiFormat(value) !== 'anthropic-messages') return baseUrl
  return baseUrl.replace(/\/v1\/?$/i, '') || baseUrl
}

export interface BuildPiModelInput {
  modelId: string
  baseUrl: string
  providerType?: string
  apiFormat?: string
  enableThinking?: ThinkingLevel
  /** pi-ai Model.input 是否声明支持图片 */
  imageInput: boolean
}

/**
 * 构造 pi-ai 合成 Model（按接口形式选择 api 与 compat）。
 * chat-completions 沿用 provider-compat.ts 的 compat 配置；
 * anthropic/responses 使用各自 compat 形态，且 reasoning 仅由显式思考开关驱动
 * （provider-compat 的 thinkingFormat / alwaysReasoning 属 chat-completions 专有）。
 */
export function buildPiModel(input: BuildPiModelInput): Model<any> {
  const format = normalizeApiFormat(input.apiFormat)
  const compat = getProviderCompat(input.providerType, input.modelId)
  const reasoning = format === 'chat-completions'
    ? (!!input.enableThinking || !!compat.thinkingFormat || !!compat.alwaysReasoning)
    : !!input.enableThinking

  const model: Record<string, any> = {
    id: input.modelId,
    name: input.modelId,
    api: resolvePiApi(format),
    provider: input.providerType || 'openai',
    baseUrl: resolveApiBaseUrl(format, input.baseUrl),
    reasoning,
    input: input.imageInput ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // 上下文预算由 memory-manager 按模型真实 context_window 管理，此处取偏大值避免二次截断
    contextWindow: 256 * 1024,
    maxTokens: 32 * 1024,
  }

  if (format === 'anthropic-messages') {
    model.compat = {}
  } else if (format === 'openai-responses') {
    model.compat = {
      supportsDeveloperRole: compat.supportsDeveloperRole,
      supportsStrictMode: compat.supportsStrictMode,
      ...(compat.sendSessionAffinityHeaders ? { sessionAffinityFormat: compat.sessionAffinityFormat || 'openai' } : {}),
    }
  } else {
    model.compat = {
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      maxTokensField: compat.maxTokensField,
      supportsReasoningEffort: compat.supportsReasoningEffort,
      supportsDeveloperRole: compat.supportsDeveloperRole,
      supportsStore: compat.supportsStore,
      supportsStrictMode: compat.supportsStrictMode,
      ...(compat.sendSessionAffinityHeaders ? {
        sendSessionAffinityHeaders: true,
        sessionAffinityFormat: compat.sessionAffinityFormat || 'openai',
      } : {}),
      ...(compat.thinkingFormat ? { thinkingFormat: compat.thinkingFormat } : {}),
      ...(compat.zaiToolStream ? { zaiToolStream: true } : {}),
      ...(compat.requiresReasoningContentOnAssistantMessages ? { requiresReasoningContentOnAssistantMessages: true } : {}),
    }
  }

  return model as Model<any>
}
