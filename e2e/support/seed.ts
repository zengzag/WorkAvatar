import type { Page } from 'playwright'

export interface SeedProviderOptions {
  baseUrl: string
  modelId?: string
  name?: string
}

export interface SeedEmployeeOptions {
  name: string
  description?: string
  rules?: string
}

export interface SeedOptions {
  onboarded?: boolean
  locale?: 'zh-CN' | 'en-US'
  theme?: 'light' | 'dark' | 'system'
  provider?: SeedProviderOptions | null
  /** 额外的非默认供应商/模型（用于「切换模型重新生成」等场景） */
  extraProvider?: SeedProviderOptions | null
  employee?: SeedEmployeeOptions | null
}

/**
 * 通过应用自身的渲染端 API 完成测试前置数据准备。
 *
 * 这里刻意不使用直接写数据库的方式：种子数据走与真实用户相同的 IPC 通道，
 * 数据库结构变化时测试不会静默失效。
 */
export async function seedApplication(page: Page, options: SeedOptions): Promise<void> {
  await page.evaluate(async (opts) => {
    const api = (window as any).electronAPI
    if (!api) throw new Error('electronAPI 未注入，应用未成功启动')

    await api.settings.set({ key: 'onboarding_completed', value: opts.onboarded === false ? 'false' : 'true' })
    if (opts.locale) await api.settings.set({ key: 'appearance_locale', value: opts.locale })
    if (opts.theme) await api.settings.set({ key: 'appearance_theme', value: opts.theme })

    if (opts.provider) {
      const modelId = opts.provider.modelId || 'e2e-model'
      const modelEntryId = `model_${modelId}`
      const provider = await api.llm.createProvider({
        name: opts.provider.name || 'E2E Mock Provider',
        provider_type: 'openai-compatible',
        base_url: opts.provider.baseUrl,
        api_format: 'chat-completions',
        model: modelId,
        api_key: 'e2e-key',
        is_default: true,
        models_json: JSON.stringify([{
          id: modelEntryId,
          name: modelId,
          model: modelId,
          category: 'chat',
          temperature: 0.2,
          max_tokens: 4096,
          context_window: 128000,
          supports_image_input: 'on',
        }]),
      })
      if (provider?.id) {
        const binding = JSON.stringify({ provider_id: provider.id, model_id: modelEntryId })
        for (const scene of ['workbench', 'creation', 'knowledge', 'quick', 'memory']) {
          await api.settings.set({ key: `default_model_${scene}`, value: binding })
        }
      }
    }

    if (opts.extraProvider) {
      const modelId = opts.extraProvider.modelId || 'e2e-alt-model'
      await api.llm.createProvider({
        name: opts.extraProvider.name || 'E2E Alt Provider',
        provider_type: 'openai-compatible',
        base_url: opts.extraProvider.baseUrl,
        api_format: 'chat-completions',
        model: modelId,
        api_key: 'e2e-key',
        is_default: false,
        models_json: JSON.stringify([{
          id: `model_${modelId}`,
          name: modelId,
          model: modelId,
          category: 'chat',
          temperature: 0.2,
          max_tokens: 4096,
          context_window: 128000,
          supports_image_input: 'on',
        }]),
      })
    }

    if (opts.employee) {
      await api.employee.create({
        name: opts.employee.name,
        description: opts.employee.description || `E2E 测试员工：${opts.employee.name}`,
        rules: opts.employee.rules || `你是 ${opts.employee.name}，一名用于端到端测试的数字员工。`,
        profile_json: '',
      })
    }
  }, options)
}

/**
 * 写入种子数据后重载页面，让语言、主题与初始路由按新配置生效。
 * 应用启动本身就依赖这些持久化设置，重载是最接近真实用户重启的行为。
 */
export async function reloadSeededApplication(page: Page, targetHash = '#/tasks'): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.evaluate((hash) => { window.location.hash = hash }, targetHash)
}
