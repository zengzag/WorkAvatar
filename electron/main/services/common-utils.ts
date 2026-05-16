import * as crypto from 'crypto'
import * as fs from 'fs'

export function generateId(): string {
  return crypto.randomBytes(4).toString('hex')
}

export async function calculateFileHash(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

export function safeCalculate(expression: string): number {
  const sanitized = expression
    .replace(/[^0-9+\-*/().\s%^]/g, '')
    .replace(/\^/g, '**')
    .replace(/%/g, '/100')

  if (!sanitized || sanitized.length === 0) {
    throw new Error('Invalid expression')
  }

  const result = Function(`"use strict"; return (${sanitized})`)()
  if (typeof result !== 'number' || !isFinite(result)) {
    throw new Error('Calculation error')
  }
  return result
}

export function formatDate(date: Date, format: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return format
    .replace('YYYY', String(date.getFullYear()))
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()))
    .replace('ss', pad(date.getSeconds()))
}

export function getDefaultProviderId(db: { getDb(): any }): string | null {
  const row = db.getDb().prepare('SELECT id FROM llm_providers WHERE is_default = 1 LIMIT 1').get()
  return row ? row.id : null
}

export const PROVIDER_DEFAULTS: Record<string, { baseURL: string; defaultModel: string; defaultEmbeddingModel: string }> = {
  openai: { baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  'openai-compatible': { baseURL: '', defaultModel: '', defaultEmbeddingModel: 'text-embedding-3-small' },
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

export function getBaseURL(config: { base_url?: string; provider_type?: string }): string {
  if (config.base_url) {
    return config.base_url.replace(/\/+$/, '')
  }
  const defaults = PROVIDER_DEFAULTS[config.provider_type || '']
  return defaults?.baseURL || config.base_url || 'https://api.openai.com/v1'
}
