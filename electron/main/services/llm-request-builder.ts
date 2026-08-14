import type { LLMModelConfig, ThinkingLevel } from '../../shared/types'
import type {
  LLMProviderConfig,
  ChatMessage,
  ChatCompletionRequest,
} from './llm-client-types'
import { createLogger } from './logger'
import { getProviderCompat } from './agent/llm/provider-compat'

const logger = createLogger('LLM-ReqBuilder')

/** 从 provider 的 models_json 中查找匹配的模型配置 */
export function getModelConfig(provider: LLMProviderConfig, modelIdentifier: string): LLMModelConfig | null {
  if (!provider.models_json) return null
  try {
    const models: LLMModelConfig[] = JSON.parse(provider.models_json)
    return models.find(m => m.id === modelIdentifier) || models.find(m => m.model === modelIdentifier) || null
  } catch (err: any) {
    logger.warn(`Failed to parse models_json (provider=${provider.id}):`, err?.message || err)
    return null
  }
}

/**
 * 构建 chat/completions 请求体
 *
 * 合并优先级：overrides > modelConfig > providerConfig
 * 根据 provider_type 和 enable_thinking 设置思考相关参数
 */
export function buildRequestBody(
  config: LLMProviderConfig,
  modelName: string,
  messages: ChatMessage[],
  stream: boolean,
  overrides?: { temperature?: number; max_tokens?: number; enable_thinking?: ThinkingLevel },
): ChatCompletionRequest {
  const modelConfig = getModelConfig(config, modelName)
  const enableThinking = overrides?.enable_thinking ?? modelConfig?.enable_thinking ?? false
  const compat = getProviderCompat(config.provider_type)
  const maxTokensValue = overrides?.max_tokens ?? modelConfig?.max_tokens ?? config.max_tokens
  const body: ChatCompletionRequest = {
    model: modelName,
    messages,
    temperature: overrides?.temperature ?? modelConfig?.temperature ?? config.temperature,
    [compat.maxTokensField]: maxTokensValue,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  }

  if (modelConfig?.top_p != null) {
    body.top_p = modelConfig.top_p
  }
  if (modelConfig?.frequency_penalty != null) {
    body.frequency_penalty = modelConfig.frequency_penalty
  }
  if (modelConfig?.presence_penalty != null) {
    body.presence_penalty = modelConfig.presence_penalty
  }

  applyThinkingConfig(body, config.provider_type, enableThinking, modelConfig?.thinking_budget)

  if (config.extra_body_json) {
    try {
      const extra = JSON.parse(config.extra_body_json)
      Object.assign(body, extra)
    } catch (err: any) {
      logger.warn(`Failed to parse extra_body_json (provider=${config.id}):`, err?.message || err)
    }
  }

  return body
}

/** 根据 provider_type 设置思考相关参数 */
function applyThinkingConfig(
  body: ChatCompletionRequest,
  providerType: string,
  enableThinking: ThinkingLevel,
  thinkingBudget?: number,
): void {
  const supportsThinking = ['deepseek', 'qwen', 'lmstudio', 'volcengine', 'zhipu', 'xiaomi'].includes(providerType)
  if (!supportsThinking) return

  const thinkingType = enableThinking ? 'enabled' : 'disabled'

  if (providerType === 'deepseek') {
    body.thinking = { type: thinkingType }
    if (enableThinking) body.reasoning_effort = enableThinking
  } else if (providerType === 'qwen' || providerType === 'lmstudio') {
    body.enable_thinking = !!enableThinking
    if (enableThinking && thinkingBudget != null) {
      body.thinking_budget = thinkingBudget
    }
  } else if (providerType === 'volcengine' || providerType === 'zhipu') {
    body.thinking = { type: thinkingType }
  } else if (providerType === 'xiaomi') {
    body.thinking = { type: thinkingType }
  }
}

/** 解析模型标识符为实际 API 模型名（从 models_json 查找） */
export function resolveModelName(config: LLMProviderConfig, modelIdentifier: string): string {
  if (config.models_json) {
    try {
      const models: LLMModelConfig[] = JSON.parse(config.models_json)
      const matched = models.find(m => m.id === modelIdentifier)
      if (matched) return matched.model
    } catch (err: any) {
      logger.warn(`Failed to parse models_json for model resolution (provider=${config.id}):`, err?.message || err)
    }
  }
  return modelIdentifier
}

/** 构建请求头（Authorization + extra_headers） */
export function buildHeaders(config: LLMProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (config.api_key) {
    headers['Authorization'] = `Bearer ${config.api_key}`
  }
  if (config.extra_headers_json) {
    try {
      const extra = JSON.parse(config.extra_headers_json)
      Object.assign(headers, extra)
    } catch (err: any) {
      logger.warn(`Failed to parse extra_headers_json (provider=${config.id}):`, err?.message || err)
    }
  }
  return headers
}
