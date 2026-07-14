import DatabaseService from './database.service'
import { generateId } from './common-utils'
import LLMLoggerService from './llm-logger.service'
import { createLogger } from './logger'
import {
  type LLMProviderConfig,
  type ChatMessage,
  type ChatOptions,
  PROVIDER_DEFAULTS,
} from './llm-client-types'
import { createThinkProcessor } from './llm-think-processor'
import { buildRequestBody, resolveModelName, buildHeaders } from './llm-request-builder'
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

  async chat(
    providerId: string,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<string> {
    const config = await this.getProviderConfig(providerId)
    if (!config) {
      throw new Error('LLM Provider not found')
    }

    const baseURL = this.getBaseURL(config)
    const headers = buildHeaders(config)
    const modelName = resolveModelName(config, options?.model || config.model)
    const body = buildRequestBody(config, modelName, messages, false, options)
    const logSource = options?.logSource || 'unknown'
    const startTime = Date.now()

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.timeout_ms || 60000)
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort()
      } else {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true })
      }
    }

    const requestLog = {
      messages,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      stream: false as const,
    }

    try {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!response.ok) {
        const errorText = await response.text()
        LLMLoggerService.getInstance().logCall({
          type: 'chat',
          source: logSource,
          model: modelName,
          providerType: config.provider_type,
          request: requestLog,
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
        request: requestLog,
        response: {
          content: result,
          usage: data.usage,
          latencyMs,
        },
      })

      return result
    } catch (error: any) {
      clearTimeout(timeout)
      if (error.name === 'AbortError' && !options?.signal?.aborted) {
        error.message = 'LLM API request timed out'
      }
      logger.error(`chat failed (provider=${providerId}, model=${modelName}):`, error?.message || error)
      if (!error.message?.includes('LLM API error')) {
        LLMLoggerService.getInstance().logCall({
          type: 'chat',
          source: logSource,
          model: modelName,
          providerType: config.provider_type,
          request: requestLog,
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
    options?: Omit<ChatOptions, 'signal'>,
    signal?: AbortSignal,
    onThought?: (thoughtChunk: string) => void,
  ): Promise<void> {
    const config = await this.getProviderConfig(providerId)
    if (!config) {
      onError(new Error('LLM Provider not found'))
      return
    }

    const baseURL = this.getBaseURL(config)
    const headers = buildHeaders(config)
    const modelName = resolveModelName(config, options?.model || config.model)
    const body = buildRequestBody(config, modelName, messages, true, options)
    const logSource = options?.logSource || 'unknown'
    const startTime = Date.now()

    const controller = new AbortController()
    // 流式调用使用双重超时：
    // 1. 总超时：config.timeout_ms（默认 60s），覆盖从请求开始到流结束的全过程
    // 2. 空闲超时：30s 无数据则中止，防止服务端发完 header 后卡住流不结束
    const totalTimeoutMs = config.timeout_ms || 60000
    const STREAM_IDLE_TIMEOUT_MS = 30_000
    let idleTimer: NodeJS.Timeout | null = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS)
    const totalTimer = setTimeout(() => controller.abort(), totalTimeoutMs)
    if (signal) {
      if (signal.aborted) {
        controller.abort()
      } else {
        signal.addEventListener('abort', () => controller.abort(), { once: true })
      }
    }

    const requestLog = {
      messages,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      stream: true as const,
    }

    try {
      const thinkProcessor = createThinkProcessor()
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      // header 已收到，清除空闲超时（流循环内会重新设置）
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }

      if (!response.ok) {
        const errorText = await response.text()
        LLMLoggerService.getInstance().logCall({
          type: 'chatStream',
          source: logSource,
          model: modelName,
          providerType: config.provider_type,
          request: requestLog,
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

      const logSuccess = () => {
        LLMLoggerService.getInstance().logCall({
          type: 'chatStream',
          source: logSource,
          model: modelName,
          providerType: config.provider_type,
          request: requestLog,
          response: {
            content: fullContent,
            reasoningContent: fullThought || undefined,
            latencyMs: Date.now() - startTime,
          },
        })
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        // 每收到数据重置空闲超时，防止服务端中途卡住
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS)

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const data = trimmed.slice(6)
          if (data === '[DONE]') {
            logSuccess()
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
          } catch (e) {
            logger.debug('Failed to parse stream chunk', e)
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

      // 流正常结束，清除所有定时器
      if (idleTimer) clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      logSuccess()
      onDone()
    } catch (err: any) {
      if (idleTimer) clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      if (err.name === 'AbortError' && !signal?.aborted) {
        err.message = 'LLM API request timed out'
      }
      logger.error(`chatStream failed (provider=${providerId}, model=${modelName}):`, err?.message || err)
      if (!err.message?.includes('LLM API error')) {
        LLMLoggerService.getInstance().logCall({
          type: 'chatStream',
          source: logSource,
          model: modelName,
          providerType: config.provider_type,
          request: requestLog,
          error: err.message,
        })
      }
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

    return this.getProvider(id)
  }

  async deleteProvider(id: string): Promise<boolean> {
    await this.keyStorage.deleteApiKey(id)
    const result = this.db.getDb().prepare('DELETE FROM llm_providers WHERE id = ?').run(id)
    return result.changes > 0
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
