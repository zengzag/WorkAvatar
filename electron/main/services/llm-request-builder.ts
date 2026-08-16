import type { LLMModelConfig } from '../../shared/types'
import type { LLMProviderConfig } from './llm-client-types'
import { createLogger } from './logger'

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
