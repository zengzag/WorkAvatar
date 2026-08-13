import type { LLMModelConfig } from '../types'

export const DOMESTIC_PROVIDERS = new Set(['deepseek', 'qwen', 'zhipu', 'volcengine', 'xiaomi', 'moonshot', 'yi'])
export const LOCAL_PROVIDERS = new Set(['lmstudio', 'openai-compatible'])

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
