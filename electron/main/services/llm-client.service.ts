import DatabaseService from './database.service'
import { safeStorage } from 'electron'
import type { LLMModelConfig } from '../../shared/types'
import { generateId } from './common-utils'
import LLMLoggerService from './llm-logger.service'

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

function getModelConfig(provider: LLMProviderConfig, modelIdentifier: string): LLMModelConfig | null {
  if (!provider.models_json) return null
  try {
    const models: LLMModelConfig[] = JSON.parse(provider.models_json)
    return models.find(m => m.id === modelIdentifier) || models.find(m => m.model === modelIdentifier) || null
  } catch {
    return null
  }
}

function buildRequestBody(
  config: LLMProviderConfig,
  modelName: string,
  messages: ChatMessage[],
  stream: boolean,
  overrides?: { temperature?: number; max_tokens?: number; enable_thinking?: boolean }
): ChatCompletionRequest {
  const modelConfig = getModelConfig(config, modelName)
  const enableThinking = overrides?.enable_thinking ?? modelConfig?.enable_thinking ?? false
  const body: ChatCompletionRequest = {
    model: modelName,
    messages,
    temperature: overrides?.temperature ?? modelConfig?.temperature ?? config.temperature,
    max_tokens: overrides?.max_tokens ?? modelConfig?.max_tokens ?? config.max_tokens,
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

  if (enableThinking) {
    if (config.provider_type === 'deepseek') {
      body.thinking = { type: 'enabled' }
      body.reasoning_effort = 'high'
    } else if (config.provider_type === 'qwen') {
      body.enable_thinking = true
      if (modelConfig?.thinking_budget) {
        body.thinking_budget = modelConfig.thinking_budget
      }
    } else if (config.provider_type === 'volcengine') {
      body.thinking = { type: 'enabled' }
    } else if (config.provider_type === 'zhipu') {
      body.thinking = { type: 'enabled' }
    }
  } else {
    if (config.provider_type === 'deepseek') {
      body.thinking = { type: 'disabled' }
    } else if (config.provider_type === 'volcengine') {
      body.thinking = { type: 'disabled' }
    } else if (config.provider_type === 'zhipu') {
      body.thinking = { type: 'disabled' }
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

  private resolveModelName(config: LLMProviderConfig, modelIdentifier: string): string {
    if (config.models_json) {
      try {
        const models: LLMModelConfig[] = JSON.parse(config.models_json)
        const matched = models.find(m => m.id === modelIdentifier)
        if (matched) return matched.model
      } catch {}
    }
    return modelIdentifier
  }

  async chat(
    providerId: string,
    messages: ChatMessage[],
    options?: { temperature?: number; max_tokens?: number; model?: string; enable_thinking?: boolean; signal?: AbortSignal; logSource?: string }
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

    const modelName = this.resolveModelName(config, options?.model || config.model)
    const body = buildRequestBody(config, modelName, messages, false, options)
    const logSource = options?.logSource || 'unknown'
    const startTime = Date.now()

    try {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        LLMLoggerService.getInstance().logCall({
          type: 'chat',
          source: logSource,
          model: modelName,
          providerType: config.provider_type,
          request: {
            messages,
            temperature: body.temperature,
            max_tokens: body.max_tokens,
            stream: false,
          },
          error: `${response.status} - ${errorText}`,
        })
        throw new Error(`LLM API error (${response.status}): ${errorText}`)
      }

      const data = await response.json()
      const fullContent = data.choices?.[0]?.message?.content || ''
      const result = fullContent.replace(/<think[\s\S]*?<\/think>/gi, '').trim()
      const latencyMs = Date.now() - startTime

      LLMLoggerService.getInstance().logCall({
        type: 'chat',
        source: logSource,
        model: modelName,
        providerType: config.provider_type,
        request: {
          messages,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          stream: false,
        },
        response: {
          content: result,
          usage: data.usage,
          latencyMs,
        },
      })

      return result
    } catch (error: any) {
      if (!error.message?.includes('LLM API error')) {
        LLMLoggerService.getInstance().logCall({
          type: 'chat',
          source: logSource,
          model: modelName,
          providerType: config.provider_type,
          request: {
            messages,
            temperature: body.temperature,
            max_tokens: body.max_tokens,
            stream: false,
          },
          error: error.message,
        })
      }
      throw error
    }
  }

  async chatStream(
    providerId: string,
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    onDone: () => void,
    onError: (error: Error) => void,
    options?: { temperature?: number; max_tokens?: number; model?: string; enable_thinking?: boolean; logSource?: string },
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

    const modelName = this.resolveModelName(config, options?.model || config.model)
    const body = buildRequestBody(config, modelName, messages, true, options)
    const logSource = options?.logSource || 'unknown'
    const startTime = Date.now()

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
        LLMLoggerService.getInstance().logCall({
          type: 'chatStream',
          source: logSource,
          model: modelName,
          providerType: config.provider_type,
          request: {
            messages,
            temperature: body.temperature,
            max_tokens: body.max_tokens,
            stream: true,
          },
          error: `${response.status} - ${errorText}`,
        })
        throw new Error(`LLM API error (${response.status}): ${errorText}`)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('No response body')
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let fullContent = ''
      let fullThought = ''

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
            const latencyMs = Date.now() - startTime
            LLMLoggerService.getInstance().logCall({
              type: 'chatStream',
              source: logSource,
              model: modelName,
              providerType: config.provider_type,
              request: {
                messages,
                temperature: body.temperature,
                max_tokens: body.max_tokens,
                stream: true,
              },
              response: {
                content: fullContent,
                reasoningContent: fullThought || undefined,
                latencyMs,
              },
            })
            onDone()
            return
          }

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta

            if (delta?.reasoning_content && onThought) {
              fullThought += delta.reasoning_content
              onThought(delta.reasoning_content)
            }

            const content = delta?.content
            if (content) {
              const result = thinkProcessor.processChunk(content)
              if (result.thought && onThought) {
                fullThought += result.thought
                onThought(result.thought)
              }
              if (result.content) {
                fullContent += result.content
                onChunk(result.content)
              }
            }
          } catch {
          }
        }
      }

      const finalResult = thinkProcessor.finalize()
      if (finalResult.thought && onThought) {
        fullThought += finalResult.thought
        onThought(finalResult.thought)
      }
      if (finalResult.content) {
        fullContent += finalResult.content
        onChunk(finalResult.content)
      }

      const latencyMs = Date.now() - startTime
      LLMLoggerService.getInstance().logCall({
        type: 'chatStream',
        source: logSource,
        model: modelName,
        providerType: config.provider_type,
        request: {
          messages,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          stream: true,
        },
        response: {
          content: fullContent,
          reasoningContent: fullThought || undefined,
          latencyMs,
        },
      })

      onDone()
    } catch (err: any) {
      LLMLoggerService.getInstance().logCall({
        type: 'chatStream',
        source: logSource,
        model: modelName,
        providerType: config.provider_type,
        request: {
          messages,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          stream: true,
        },
        error: err.message,
      })
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

  private async callEmbeddingAPI(config: any, input: string | string[], timeoutMs?: number, modelName?: string): Promise<any> {
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
        const model = models.find((m: any) => m.id === config.model_id)
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
export { PROVIDER_DEFAULTS }
