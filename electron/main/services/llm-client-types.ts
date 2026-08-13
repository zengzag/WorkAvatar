import { isMainThread } from 'worker_threads'
import type { LLMModelConfig } from '../../shared/types'

/** LLM 提供商配置（数据库行映射） */
export interface LLMProviderConfig {
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

export interface ChatMessage {
  role: string
  content: string
}

export interface ChatCompletionRequest {
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

export interface ProcessThinkChunkResult {
  thought?: string
  content?: string
}

/** 各 provider 类型的默认 baseURL 和模型 */
export const PROVIDER_DEFAULTS: Record<string, { baseURL: string; defaultModel: string; defaultEmbeddingModel: string }> = {
  openai: { baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  'openai-compatible': { baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  lmstudio: { baseURL: 'http://localhost:1234/v1', defaultModel: '', defaultEmbeddingModel: '' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', defaultEmbeddingModel: 'text-embedding-3-small' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', defaultEmbeddingModel: 'text-embedding-v3' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash', defaultEmbeddingModel: 'embedding-3' },
  volcengine: { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-1-5-pro-32k', defaultEmbeddingModel: 'text-embedding-v3' },
  xiaomi: { baseURL: 'https://api.xiaomimimo.com/v1', defaultModel: 'mimo-v2.5-pro', defaultEmbeddingModel: 'text-embedding-3-small' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k', defaultEmbeddingModel: 'text-embedding-3-small' },
  yi: { baseURL: 'https://api.lingyiwanwu.com/v1', defaultModel: 'yi-lightning', defaultEmbeddingModel: 'text-embedding-3-small' },
  groq: { baseURL: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', defaultEmbeddingModel: 'text-embedding-3-small' },
  mistral: { baseURL: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', defaultEmbeddingModel: 'mistral-embed' },
  azure: { baseURL: '', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  vertex: { baseURL: '', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  bedrock: { baseURL: '', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  xai: { baseURL: 'https://api.x.ai/v1', defaultModel: 'grok-3-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
}

/** chat/chatStream 方法选项 */
export interface ChatOptions {
  temperature?: number
  max_tokens?: number
  model?: string
  enable_thinking?: boolean
  signal?: AbortSignal
  logSource?: string
}

export type { LLMModelConfig }

/**
 * 延迟加载 electron.safeStorage（worker_threads 中不可用）
 * 在 worker 模式下返回 null，调用方需处理 null 情况
 */
export function getSafeStorage(): any | null {
  if (!isMainThread) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron').safeStorage
  } catch {
    return null
  }
}
