import type { LLMProvider, LLMModelConfig } from '../types'

export function getProviderModels(provider: LLMProvider | { models_json?: string }): LLMModelConfig[] {
  if (!provider?.models_json) return []
  try {
    return JSON.parse(provider.models_json)
  } catch {
    return []
  }
}

export function getProviderModelOptions(provider: LLMProvider | { models_json?: string }): Array<{ value: string; label: string }> {
  return getProviderModels(provider).map((m) => ({ value: m.model, label: m.name }))
}
