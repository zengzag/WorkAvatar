import DatabaseService from './database.service'
import { safeStorage } from 'electron'
import type { LLMModelConfig } from '../../shared/types'

interface LLMProviderConfig {
  id: string
  name: string
  provider_type: string
  base_url?: string
  model: string
  embedding_model?: string
  api_key?: string
  temperature: number
  max_tokens: number
  timeout_ms: number
  extra_headers_json?: string
  extra_body_json?: string
  models_json?: string
}

interface ChatMessage {
  role: string
  content: string
}

interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  stream?: boolean
  [key: string]: any
}

interface ProcessThinkChunkResult {
  thought?: string
  content?: string
}

const PROVIDER_DEFAULTS: Record<string, { baseURL: string; defaultModel: string; defaultEmbeddingModel: string }> = {
  openai: { baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  'openai-compatible': { baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  lmstudio: { baseURL: 'http://localhost:1234/v1', defaultModel: '', defaultEmbeddingModel: '' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', defaultEmbeddingModel: 'text-embedding-3-small' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', defaultEmbeddingModel: 'text-embedding-v3' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash', defaultEmbeddingModel: 'embedding-3' },
  volcengine: { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-1-5-pro-32k', defaultEmbeddingModel: 'text-embedding-v3' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k', defaultEmbeddingModel: 'text-embedding-3-small' },
  yi: { baseURL: 'https://api.lingyiwanwu.com/v1', defaultModel: 'yi-lightning', defaultEmbeddingModel: 'text-embedding-3-small' },
  groq: { baseURL: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', defaultEmbeddingModel: 'text-embedding-3-small' },
  mistral: { baseURL: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', defaultEmbeddingModel: 'mistral-embed' },
  azure: { baseURL: '', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  vertex: { baseURL: '', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  bedrock: { baseURL: '', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  xai: { baseURL: 'https://api.x.ai/v1', defaultModel: 'grok-3-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
}

function createThinkProcessor() {
  let state: 'normal' | 'thinking' = 'normal'
  let buffer = ''

  function reset(): void {
    state = 'normal'
    buffer = ''
  }

  function processChunk(rawChunk: string): ProcessThinkChunkResult {
    buffer += rawChunk
    let thought = ''
    let content = ''

    while (buffer.length > 0) {
      if (state === 'normal') {
        const openIdx = buffer.toLowerCase().indexOf('<think')
        if (openIdx === -1) {
          const partials = ['<', '<t', '<th', '<thi', '<thin']
          let hasPartial = false
          for (const p of partials) {
            if (buffer.endsWith(p)) { hasPartial = true; break }
          }
          if (!hasPartial) {
            content += buffer
            buffer = ''
          }
          break
        } else {
          content += buffer.substring(0, openIdx)
          const afterOpen = buffer.substring(openIdx)
          const closeBracketIdx = afterOpen.indexOf('>')
          if (closeBracketIdx === -1) {
            buffer = ''
            state = 'thinking'
            break
          }
          buffer = afterOpen.substring(closeBracketIdx + 1)
          state = 'thinking'
        }
      } else if (state === 'thinking') {
        const closeIdx = buffer.toLowerCase().indexOf('</think')
        if (closeIdx === -1) {
          const partials = ['<', '</', '</t', '</th', '</thi', '</thin', '</think']
          let hasPartial = false
          for (const p of partials) {
            if (buffer.endsWith(p)) { hasPartial = true; break }
          }
          if (!hasPartial) {
            thought += buffer
            buffer = ''
          }
          break
        } else {
          thought += buffer.substring(0, closeIdx)
          const afterClose = buffer.substring(closeIdx)
          const closeBracketIdx = afterClose.indexOf('>')
          if (closeBracketIdx === -1) {
            buffer = ''
            state = 'normal'
            break
          }
          buffer = afterClose.substring(closeBracketIdx + 1)
          state = 'normal'
        }
      }
    }

    return {
      thought: thought || undefined,
      content: content || undefined,
    }
  }

  function finalize(): ProcessThinkChunkResult {
    let thought = ''
    let content = ''

    if (buffer.length > 0) {
      if (state === 'thinking') {
        thought = buffer
          .replace(/<\/?(?:think|t|th|thi|thin)$/gi, '')
          .trim()
      } else {
        content = buffer
          .replace(/^<?\/?t(?:h(?:i(?:n(?:k)?)?)?)?$/gi, '')
          .trim()
      }
      buffer = ''
    }
    state = 'normal'

    return {
      thought: thought || undefined,
      content: content || undefined,
    }
  }

  return { reset, processChunk, finalize }
}

function getModelConfig(provider: LLMProviderConfig, modelName: string): LLMModelConfig | null {
  if (!provider.models_json) return null
  try {
    const models: LLMModelConfig[] = JSON.parse(provider.models_json)
    return models.find(m => m.model === modelName) || null
  } catch {
    return null
  }
}

function buildRequestBody(
  config: LLMProviderConfig,
  modelName: string,
  messages: ChatMessage[],
  stream: boolean,
  overrides?: { temperature?: number; max_tokens?: number }
): ChatCompletionRequest {
  const modelConfig = getModelConfig(config, modelName)
  const body: ChatCompletionRequest = {
    model: modelName,
    messages,
    temperature: overrides?.temperature ?? modelConfig?.temperature ?? config.temperature,
    max_tokens: overrides?.max_tokens ?? modelConfig?.max_tokens ?? config.max_tokens,
    stream,
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

  if (modelConfig?.enable_thinking) {
    if (config.provider_type === 'deepseek') {
      // DeepSeek reasoner models use reasoning_content natively
      // For deepseek-chat with thinking, no extra param needed - it uses <think/> tags
    } else if (config.provider_type === 'qwen') {
      body.enable_thinking = true
      if (modelConfig.thinking_budget) {
        body.thinking_budget = modelConfig.thinking_budget
      }
    } else if (config.provider_type === 'zhipu') {
      // Zhipu GLM models with thinking
    }
  }

  if (config.extra_body_json) {
    try {
      const extra = JSON.parse(config.extra_body_json)
      Object.assign(body, extra)
    } catch {}
  }

  return body
}

class SecureKeyStorage {
  private db: any

  constructor(db: any) {
    this.db = db
  }

  private encryptKey(plainText: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      const buffer = safeStorage.encryptString(plainText)
      return buffer.toString('base64')
    }
    return plainText
  }

  private decryptKey(encryptedText: string): string | null {
    if (!encryptedText) return null
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buffer = Buffer.from(encryptedText, 'base64')
        return safeStorage.decryptString(buffer)
      }
      return encryptedText
    } catch {
      return null
    }
  }

  async saveApiKey(providerId: string, apiKey: string): Promise<void> {
    const encrypted = this.encryptKey(apiKey)
    this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(`llm_api_key_${providerId}`, encrypted)
  }

  async getApiKey(providerId: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(`llm_api_key_${providerId}`) as any
    if (!row?.value) return null
    return this.decryptKey(row.value)
  }

  async deleteApiKey(providerId: string): Promise<void> {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(`llm_api_key_${providerId}`)
  }
}

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
      temperature: row.temperature ?? 0.3,
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
        } catch {}
      }

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

  async chat(
    providerId: string,
    messages: ChatMessage[],
    options?: { temperature?: number; max_tokens?: number; model?: string }
  ): Promise<string> {
    const config = await this.getProviderConfig(providerId)
    if (!config) {
      throw new Error('LLM Provider not found')
    }

    const baseURL = this.getBaseURL(config)
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
      } catch {}
    }

    const modelName = options?.model || config.model
    const body = buildRequestBody(config, modelName, messages, false, options)

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`LLM API error (${response.status}): ${errorText}`)
    }

    const data = await response.json()
    const fullContent = data.choices?.[0]?.message?.content || ''
    return fullContent.replace(/<think[\s\S]*?<\/think>/gi, '').trim()
  }

  async chatStream(
    providerId: string,
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    onDone: () => void,
    onError: (error: Error) => void,
    options?: { temperature?: number; max_tokens?: number; model?: string },
    signal?: AbortSignal,
    onThought?: (thoughtChunk: string) => void
  ): Promise<void> {
    const config = await this.getProviderConfig(providerId)
    if (!config) {
      onError(new Error('LLM Provider not found'))
      return
    }

    const baseURL = this.getBaseURL(config)
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
      } catch {}
    }

    const modelName = options?.model || config.model
    const body = buildRequestBody(config, modelName, messages, true, options)

    try {
      const thinkProcessor = createThinkProcessor()
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`LLM API error (${response.status}): ${errorText}`)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('No response body')
      }

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const data = trimmed.slice(6)
          if (data === '[DONE]') {
            onDone()
            return
          }

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta

            if (delta?.reasoning_content && onThought) {
              onThought(delta.reasoning_content)
            }

            const content = delta?.content
            if (content) {
              const result = thinkProcessor.processChunk(content)
              if (result.thought && onThought) {
                onThought(result.thought)
              }
              if (result.content) {
                onChunk(result.content)
              }
            }
          } catch {
          }
        }
      }

      const finalResult = thinkProcessor.finalize()
      if (finalResult.thought && onThought) {
        onThought(finalResult.thought)
      }
      if (finalResult.content) {
        onChunk(finalResult.content)
      }

      onDone()
    } catch (err: any) {
      onError(err)
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
    const id = require('crypto').randomUUID()
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
      params.temperature ?? 0.3,
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

    return this.getProvider(id)
  }

  async updateProvider(id: string, params: Record<string, any>) {
    const provider = this.getProvider(id) as any
    if (!provider) return null

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
      if (value !== undefined) {
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

    return this.getProvider(id)
  }

  async deleteProvider(id: string): Promise<boolean> {
    await this.keyStorage.deleteApiKey(id)
    const result = this.db.getDb().prepare('DELETE FROM llm_providers WHERE id = ?').run(id)
    return result.changes > 0
  }
}

export default LLMClientService
export { PROVIDER_DEFAULTS }
