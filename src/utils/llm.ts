import type { LLMModelConfig } from '../types'

export const DOMESTIC_PROVIDERS = new Set(['deepseek', 'qwen', 'zhipu', 'volcengine', 'xiaomi', 'moonshot', 'yi'])
export const LOCAL_PROVIDERS = new Set(['lmstudio', 'openai-compatible'])

/** 支持 reasoning_effort 的 provider（可多级思考强度） */
const REASONING_EFFORT_PROVIDERS = new Set(['openai', 'deepseek', 'azure'])

/** 支持思考模式的 provider */
const THINKING_PROVIDERS = new Set(['deepseek', 'qwen', 'lmstudio', 'volcengine', 'zhipu', 'xiaomi'])

export function supportsReasoningEffort(providerType?: string): boolean {
  return !!providerType && REASONING_EFFORT_PROVIDERS.has(providerType)
}

export function supportsThinking(providerType?: string): boolean {
  return !!providerType && THINKING_PROVIDERS.has(providerType)
}

export function getProviderModels(provider: { models_json?: string }): LLMModelConfig[] {
  if (!provider?.models_json) return []
  try {
    return JSON.parse(provider.models_json).map((m: any) => ({
      ...m,
      category: m.category || 'chat',
    }))
  } catch {
    return []
  }
}
