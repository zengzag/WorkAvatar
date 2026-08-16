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

/** 对比新旧模型列表，按模型内部 id 计算模型ID重命名映射（旧值 → 新值） */
export function computeModelRenames(oldModels: LLMModelConfig[], newModels: LLMModelConfig[]): Map<string, string> {
  const renames = new Map<string, string>()
  for (const next of newModels) {
    const prev = oldModels.find(m => m.id === next.id)
    if (prev && prev.model !== next.model) {
      renames.set(prev.model, next.model)
    }
  }
  return renames
}

/** 模型ID变更后同步更新 localStorage 中的引用（场景默认模型缓存、工作台各员工选择、创建向导选择） */
export function syncModelRenamesInStorage(providerId: string, renames: Map<string, string>): void {
  if (!providerId || renames.size === 0) return

  for (const scene of ['creation', 'workbench', 'knowledge', 'quick', 'embedding', 'memory']) {
    const raw = localStorage.getItem(`defaultModel:${scene}`)
    if (!raw) continue
    try {
      const cfg = JSON.parse(raw)
      if (cfg?.provider_id === providerId && renames.has(cfg.model_id)) {
        localStorage.setItem(`defaultModel:${scene}`, JSON.stringify({ ...cfg, model_id: renames.get(cfg.model_id) }))
      }
    } catch { /* 忽略非法缓存 */ }
  }

  const modelKeyPrefixes = ['employeeWorkbench:selectedModelId', 'creationWizard:selectedModelId']
  for (const modelPrefix of modelKeyPrefixes) {
    const providerPrefix = modelPrefix.replace('selectedModelId', 'selectedProviderId')
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(modelPrefix)) continue
      const suffix = key.slice(modelPrefix.length)
      if (localStorage.getItem(providerPrefix + suffix) !== providerId) continue
      const modelId = localStorage.getItem(key)
      if (modelId && renames.has(modelId)) {
        localStorage.setItem(key, renames.get(modelId)!)
      }
    }
  }
}
