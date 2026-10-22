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

/** 解析模型上下文窗口（token）：优先 context_window，其次 max_tokens×4，最后 256k 兜底 */
export function resolveContextWindowTokens(modelConfig: LLMModelConfig | null | undefined): number {
  if (!modelConfig) return 256 * 1024
  return modelConfig.context_window ?? (modelConfig.max_tokens ? modelConfig.max_tokens * 4 : 256 * 1024)
}

/**
 * 工具结果裁剪水位（token）：按模型真实上下文窗口比例计算，避免固定 80k 在长上下文模型上过早截断。
 * 高水位触发整块裁剪，低水位决定保留量；两者的差值提供滞后区间，避免边界逐请求前移。
 */
export function resolveToolResultTrimThresholds(contextWindowTokens: number): { high: number; low: number } {
  return {
    high: Math.max(8000, Math.floor(contextWindowTokens * 0.75)),
    low: Math.max(2000, Math.floor(contextWindowTokens * 0.3)),
  }
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

/**
 * 解析 JSON 对象字符串（extra_headers_json / extra_body_json 等）。
 * 非法 JSON 或非对象（数组/标量）返回 undefined，供 pi-ai 的 headers / onPayload 使用。
 */
export function parseJsonRecord(json?: string | null): Record<string, any> | undefined {
  if (!json) return undefined
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>
    }
    logger.warn('parseJsonRecord: value is not a JSON object, ignored')
    return undefined
  } catch (err: any) {
    logger.warn('Failed to parse JSON record:', err?.message || err)
    return undefined
  }
}
