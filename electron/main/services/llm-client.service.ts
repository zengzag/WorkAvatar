import DatabaseService from './database.service'
import { safeStorage } from 'electron'

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
  stream?: boolean
}

interface ProcessThinkChunkResult {
  thought?: string
  content?: string
}

let thinkTagState: 'normal' | 'thinking' = 'normal'
let thinkContentBuffer = ''

function resetThinkState(): void {
  thinkTagState = 'normal'
  thinkContentBuffer = ''
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

function processThinkChunk(rawChunk: string): ProcessThinkChunkResult {
  thinkContentBuffer += rawChunk
  let thought = ''
  let content = ''

  while (thinkContentBuffer.length > 0) {
    if (thinkTagState === 'normal') {
      const openIdx = thinkContentBuffer.toLowerCase().indexOf('<think>')
      if (openIdx === -1) {
        const partials = ['<', '<t', '<th', '<thi', '<thin']
        let hasPartial = false
        for (const p of partials) {
          if (thinkContentBuffer.endsWith(p)) { hasPartial = true; break }
        }
        if (!hasPartial) {
          content += thinkContentBuffer
          thinkContentBuffer = ''
        }
        break
      } else {
        content += thinkContentBuffer.substring(0, openIdx)
        thinkContentBuffer = thinkContentBuffer.substring(openIdx + 7)
        thinkTagState = 'thinking'
      }
    } else if (thinkTagState === 'thinking') {
      const closeIdx = thinkContentBuffer.toLowerCase().indexOf('</think>')
      if (closeIdx === -1) {
        const partials = ['<', '</', '</t', '</th', '</thi', '</thin', '</think']
        let hasPartial = false
        for (const p of partials) {
          if (thinkContentBuffer.endsWith(p)) { hasPartial = true; break }
        }
        if (!hasPartial) {
          thought += thinkContentBuffer
          thinkContentBuffer = ''
        }
        break
      } else {
        thought += thinkContentBuffer.substring(0, closeIdx)
        thinkContentBuffer = thinkContentBuffer.substring(closeIdx + 8)
        thinkTagState = 'normal'
      }
    }
  }

  return {
    thought: thought || undefined,
    content: content || undefined,
  }
}

function finalizeThinkState(): ProcessThinkChunkResult {
  let thought = ''
  let content = ''

  if (thinkContentBuffer.length > 0) {
    if (thinkTagState === 'thinking') {
      thought = thinkContentBuffer
        .replace(/<\/?(?:think|t|th|thi|thin)$/gi, '')
        .trim()
    } else {
      content = thinkContentBuffer
        .replace(/^<?\/?t(?:h(?:i(?:n(?:k)?)?)?)?$/gi, '')
        .trim()
    }
    thinkContentBuffer = ''
  }
  thinkTagState = 'normal'

  return {
    thought: thought || undefined,
    content: content || undefined,
  }
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
    }
  }

  getBaseURL(config: LLMProviderConfig): string {
    if (config.base_url) {
      return config.base_url.replace(/\/+$/, '')
    }
    switch (config.provider_type) {
      case 'openai':
      case 'openai-compatible':
        return 'https://api.openai.com/v1'
      case 'groq':
        return 'https://api.groq.com/openai/v1'
      case 'mistral':
        return 'https://api.mistral.ai/v1'
      default:
        return config.base_url || 'https://api.openai.com/v1'
    }
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

    const body: ChatCompletionRequest = {
      model: options?.model || config.model,
      messages,
      temperature: options?.temperature ?? config.temperature,
      max_tokens: options?.max_tokens ?? config.max_tokens,
      stream: false,
    }

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
    return stripThinkTags(fullContent)
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

    const body: ChatCompletionRequest = {
      model: options?.model || config.model,
      messages,
      temperature: options?.temperature ?? config.temperature,
      max_tokens: options?.max_tokens ?? config.max_tokens,
      stream: true,
    }

    try {
      resetThinkState()
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
              const result = processThinkChunk(content)
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

      const finalResult = finalizeThinkState()
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
  }) {
    const id = require('crypto').randomUUID()
    const now = Math.floor(Date.now() / 1000)
    const apiKeyValue = params.api_key

    if (params.is_default) {
      this.db.getDb().prepare('UPDATE llm_providers SET is_default = 0').run()
    }

    this.db.getDb().prepare(`
      INSERT INTO llm_providers (id, name, provider_type, base_url, model, embedding_model, temperature, max_tokens, timeout_ms, extra_headers_json, is_default, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      params.is_default ? 1 : 0,
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
