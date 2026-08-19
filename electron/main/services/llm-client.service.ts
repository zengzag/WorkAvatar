import DatabaseService from './database.service'
import { generateId } from './common-utils'
import { createLogger } from './logger'
import {
  type LLMProviderConfig,
  PROVIDER_DEFAULTS,
} from './llm-client-types'
import { buildHeaders } from './llm-request-builder'
import { SecureKeyStorage } from './secure-key-storage'

const logger = createLogger('LLMClient')

const ALLOWED_PROVIDER_COLUMNS = [
  'name', 'provider_type', 'base_url', 'model',
  'embedding_model', 'temperature', 'max_tokens',
  'timeout_ms', 'extra_headers_json', 'extra_body_json',
  'is_default', 'models_json',
]

class LLMClientService {
  private db: DatabaseService
  private keyStorage: SecureKeyStorage
  private static instance: LLMClientService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.keyStorage = new SecureKeyStorage(this.db.getDb())
  }

  static getInstance(): LLMClientService {
    if (!LLMClientService.instance) {
      LLMClientService.instance = new LLMClientService()
    }
    return LLMClientService.instance
  }

  async getProviderConfig(providerId: string): Promise<LLMProviderConfig | null> {
    const row = this.db.getDb().prepare(
      'SELECT * FROM llm_providers WHERE id = ?'
    ).get(providerId) as any
    if (!row) return null

    const apiKey = await this.keyStorage.getApiKey(providerId)

    return {
      id: row.id,
      name: row.name,
      provider_type: row.provider_type,
      base_url: row.base_url,
      model: row.model,
      embedding_model: row.embedding_model || 'text-embedding-3-small',
      api_key: apiKey || undefined,
      temperature: row.temperature ?? 0.7,
      max_tokens: row.max_tokens ?? 4096,
      timeout_ms: row.timeout_ms ?? 60000,
      extra_headers_json: row.extra_headers_json,
      extra_body_json: row.extra_body_json,
      models_json: row.models_json,
    }
  }

  getBaseURL(config: LLMProviderConfig): string {
    if (config.base_url) {
      return config.base_url.replace(/\/+$/, '')
    }
    const defaults = PROVIDER_DEFAULTS[config.provider_type]
    if (defaults?.baseURL) {
      return defaults.baseURL
    }
    return 'https://api.openai.com/v1'
  }

  getProviderDefaults(providerType: string) {
    return PROVIDER_DEFAULTS[providerType] || null
  }

  async testConnection(providerId: string): Promise<{ success: boolean; error?: string; latency?: number }> {
    const config = await this.getProviderConfig(providerId)
    if (!config) {
      return { success: false, error: 'Provider not found' }
    }

    const startTime = Date.now()
    const baseURL = this.getBaseURL(config)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    try {
      const headers = buildHeaders(config)
      const response = await fetch(`${baseURL}/models`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })

      clearTimeout(timeout)
      const latency = Date.now() - startTime

      if (response.ok) {
        return { success: true, latency }
      } else if (response.status === 401 || response.status === 403) {
        return { success: false, error: 'API Key 无效或权限不足', latency }
      } else {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}`, latency }
      }
    } catch (err: any) {
      clearTimeout(timeout)
      return {
        success: false,
        error: err.name === 'AbortError' ? '连接超时' : (err.message || 'Unknown error'),
        latency: Date.now() - startTime,
      }
    }
  }

  getProviderList() {
    return this.db.getDb().prepare(
      'SELECT * FROM llm_providers ORDER BY is_default DESC, created_at DESC'
    ).all()
  }

  getProvider(id: string) {
    return this.db.getDb().prepare(
      'SELECT * FROM llm_providers WHERE id = ?'
    ).get(id)
  }

  async createProvider(params: {
    name: string
    provider_type: string
    base_url?: string
    model: string
    embedding_model?: string
    api_key?: string
    temperature?: number
    max_tokens?: number
    timeout_ms?: number
    is_default?: boolean
    extra_headers_json?: string
    extra_body_json?: string
    models_json?: string
  }) {
    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    const apiKeyValue = params.api_key

    if (params.is_default) {
      this.db.getDb().prepare('UPDATE llm_providers SET is_default = 0').run()
    }

    this.db.getDb().prepare(`
      INSERT INTO llm_providers (id, name, provider_type, base_url, model, embedding_model, temperature, max_tokens, timeout_ms, extra_headers_json, extra_body_json, is_default, models_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.name,
      params.provider_type,
      params.base_url || null,
      params.model,
      params.embedding_model || 'text-embedding-3-small',
      params.temperature ?? 0.7,
      params.max_tokens ?? 4096,
      params.timeout_ms ?? 60000,
      params.extra_headers_json || null,
      params.extra_body_json || null,
      params.is_default ? 1 : 0,
      params.models_json || '[]',
      now,
    )

    if (apiKeyValue) {
      await this.keyStorage.saveApiKey(id, apiKeyValue)
    }

    this.notifyProviderChanged()
    return this.getProvider(id)
  }

  async updateProvider(id: string, params: Record<string, any>) {
    const provider = this.getProvider(id) as any
    if (!provider) return null

    if (params.models_json !== undefined) {
      this.syncModelReferences(id, provider.models_json, params.models_json)
    }

    if (params.api_key !== undefined) {
      if (params.api_key) {
        await this.keyStorage.saveApiKey(id, params.api_key)
      }
      delete params.api_key
    }

    if (params.is_default) {
      this.db.getDb().prepare('UPDATE llm_providers SET is_default = 0').run()
    }

    const updates: string[] = []
    const values: any[] = []

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && ALLOWED_PROVIDER_COLUMNS.includes(key)) {
        updates.push(`${key} = ?`)
        if (key === 'is_default') {
          values.push(value ? 1 : 0)
        } else if (value === null) {
          values.push(null)
        } else if (typeof value === 'boolean') {
          values.push(value ? 1 : 0)
        } else {
          values.push(value)
        }
      }
    }

    if (updates.length > 0) {
      values.push(id)
      this.db.getDb().prepare(`
        UPDATE llm_providers SET ${updates.join(', ')} WHERE id = ?
      `).run(...values)
    }

    this.notifyProviderChanged()
    return this.getProvider(id)
  }

  /** 模型ID变更后级联更新所有引用处（settings 表场景默认模型/KMS/语音、自动化任务） */
  private syncModelReferences(providerId: string, oldModelsJson: string | undefined, newModelsJson: string | undefined): void {
    try {
      const oldModels: any[] = oldModelsJson ? JSON.parse(oldModelsJson) : []
      const newModels: any[] = newModelsJson ? JSON.parse(newModelsJson) : []

      const renames = new Map<string, string>()
      for (const next of newModels) {
        if (!next?.id || !next?.model) continue
        const prev = oldModels.find(m => m?.id === next.id)
        if (prev?.model && prev.model !== next.model) {
          renames.set(prev.model, next.model)
        }
      }
      if (renames.size === 0) return

      const db = this.db.getDb()

      // settings 表中 {provider_id, model_id} 结构的配置
      const settingKeys = [
        'default_model_creation', 'default_model_workbench', 'default_model_knowledge',
        'default_model_quick', 'default_model_embedding', 'default_model_memory',
        'kms_model', 'kms_embedding_model', 'kms_summary_model',
      ]
      const updateSetting = (key: string, value: any) => {
        db.prepare('UPDATE settings SET value = ?, updated_at = unixepoch() WHERE key = ?')
          .run(JSON.stringify(value), key)
      }
      for (const key of settingKeys) {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
        if (!row?.value) continue
        try {
          const config = JSON.parse(row.value)
          if (config?.provider_id === providerId && typeof config.model_id === 'string' && renames.has(config.model_id)) {
            config.model_id = renames.get(config.model_id)
            updateSetting(key, config)
          }
        } catch { /* 忽略非法 JSON */ }
      }

      // 语音纪要模型（嵌套在 voice_settings.minutesModel）
      const voiceRow = db.prepare("SELECT value FROM settings WHERE key = 'voice_settings'").get() as any
      if (voiceRow?.value) {
        try {
          const voiceSettings = JSON.parse(voiceRow.value)
          const mm = voiceSettings?.minutesModel
          if (mm?.provider_id === providerId && typeof mm.model_id === 'string' && renames.has(mm.model_id)) {
            mm.model_id = renames.get(mm.model_id)
            updateSetting('voice_settings', voiceSettings)
          }
        } catch { /* 忽略非法 JSON */ }
      }

      // 自动化任务与执行历史（已插件化，经内核事件通知 automation 插件更新其分库）
      try {
        const { default: PluginHostService } = require('./plugin/plugin-host.service')
        PluginHostService.getInstance().notifyKernelEvent('model:renamed', { providerId, renames: Object.fromEntries(renames) })
      } catch { /* ignore */ }

      logger.info(`Synced model renames for provider ${providerId}:`, Object.fromEntries(renames))
    } catch (err: any) {
      logger.warn('Failed to sync model references:', err?.message || err)
    }
  }

  async deleteProvider(id: string): Promise<boolean> {
    await this.keyStorage.deleteApiKey(id)
    const result = this.db.getDb().prepare('DELETE FROM llm_providers WHERE id = ?').run(id)
    if (result.changes > 0) this.notifyProviderChanged()
    return result.changes > 0
  }

  /** 供应商/模型增删改后通知订阅插件刷新模型下拉选项 */
  private notifyProviderChanged(): void {
    try {
      const { default: PluginHostService } = require('./plugin/plugin-host.service')
      PluginHostService.getInstance().notifyKernelEvent('provider:changed', { ts: Date.now() })
    } catch { /* ignore */ }
  }

  private async callEmbeddingAPI(config: any, input: string | string[], timeoutMs?: number, modelName?: string): Promise<any> {
    const baseURL = this.getBaseURL(config)
    const headers = buildHeaders(config)
    const embeddingModel = modelName || config.embedding_model || 'text-embedding-3-small'
    const body = {
      model: embeddingModel,
      input,
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs || config.timeout_ms || 60000)

    try {
      const response = await fetch(`${baseURL}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Embedding API error (${response.status}): ${errorText}`)
      }

      return await response.json()
    } catch (err: any) {
      clearTimeout(timeout)
      if (err.name === 'AbortError') {
        throw new Error('Embedding API request timed out')
      }
      logger.error(`embedding API failed (model=${modelName}):`, err?.message || err)
      throw err
    }
  }

  async createEmbedding(providerId: string, text: string, modelName?: string): Promise<Float32Array> {
    const config = await this.getProviderConfig(providerId)
    if (!config) {
      throw new Error('LLM Provider not found')
    }

    const data = await this.callEmbeddingAPI(config, text, undefined, modelName)
    const embeddingData = data.data?.[0]?.embedding
    if (!embeddingData || !Array.isArray(embeddingData)) {
      throw new Error('Invalid embedding response format')
    }

    return new Float32Array(embeddingData)
  }

  async createEmbeddings(providerId: string, texts: string[], modelName?: string): Promise<Float32Array[]> {
    const config = await this.getProviderConfig(providerId)
    if (!config) {
      throw new Error('LLM Provider not found')
    }

    const batchSize = 20
    const allEmbeddings: Float32Array[] = []

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)

      const data = await this.callEmbeddingAPI(config, batch, config.timeout_ms || 120000, modelName)
      const embeddings = data.data as Array<{ embedding: number[]; index: number }>
      if (!embeddings || !Array.isArray(embeddings)) {
        throw new Error('Invalid embedding response format')
      }

      embeddings.sort((a, b) => a.index - b.index)
      for (const emb of embeddings) {
        allEmbeddings.push(new Float32Array(emb.embedding))
      }
    }

    return allEmbeddings
  }

  getDefaultEmbeddingConfig(): { providerId: string; modelName: string } | null {
    const row = this.db.getDb().prepare(
      "SELECT value FROM settings WHERE key = 'default_model_embedding'"
    ).get() as any
    if (!row?.value) return null

    try {
      const config = JSON.parse(row.value)
      if (!config.provider_id) return null

      const provider = this.getProvider(config.provider_id) as any
      if (!provider) return null

      let modelName = ''
      if (config.model_id && provider.models_json) {
        const models = JSON.parse(provider.models_json)
        const model = models.find((m: any) => m.id === config.model_id || m.model === config.model_id)
        if (model) {
          modelName = model.model
        }
      }

      if (!modelName) {
        modelName = provider.embedding_model || 'text-embedding-3-small'
      }

      return { providerId: config.provider_id, modelName }
    } catch {
      return null
    }
  }
}

export default LLMClientService
