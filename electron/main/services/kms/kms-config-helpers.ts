import LLMClientService from '../llm-client.service'
import DatabaseService from '../database.service'
import { createLogger } from '../logger'

const logger = createLogger('KMS-Config')

export interface KmsLLMConfig {
  providerId: string
  modelId: string | undefined
  enableThinking: boolean
}

export interface KmsEmbeddingConfig {
  providerId: string
  modelName: string
}

export interface KmsSettings {
  model: any
  embeddingModel: any
  summaryModel: any
  searchParams: { maxRounds: number; topK: number; resultLimit: number; autoReparseHotData: boolean }
  autoIndex: { enabled: boolean; intervalMinutes: number; stableThresholdSeconds: number }
}

const DEFAULT_SEARCH_PARAMS = { maxRounds: 3, topK: 10, resultLimit: 100, autoReparseHotData: true }
const DEFAULT_AUTO_INDEX = { enabled: false, intervalMinutes: 10, stableThresholdSeconds: 300 }

/** 读取主库 settings 表中的 JSON 配置 */
function readSettingJson(key: string): any | null {
  const mainDb = DatabaseService.getInstance().getDb()
  try {
    const row = mainDb.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row?.value ? JSON.parse(row.value) : null
  } catch {
    return null
  }
}

/** 获取 KMS AI 搜索模型配置
 * 优先级：KMS AI搜索模型 (kms_model) > 知识场景默认模型 > 任意可用提供商
 */
export function getKmsLLMConfig(): KmsLLMConfig | null {
  const llmClient = LLMClientService.getInstance()

  const kmsModel = readSettingJson('kms_model')
  if (kmsModel?.provider_id && llmClient.getProvider(kmsModel.provider_id)) {
    return {
      providerId: kmsModel.provider_id,
      modelId: kmsModel.model_id || undefined,
      enableThinking: !!kmsModel.enable_thinking,
    }
  }

  const defaultModel = readSettingJson('default_model_knowledge')
  if (defaultModel?.provider_id && llmClient.getProvider(defaultModel.provider_id)) {
    return {
      providerId: defaultModel.provider_id,
      modelId: defaultModel.model_id || undefined,
      enableThinking: false,
    }
  }

  const providers = llmClient.getProviderList?.() as any[] || []
  const first = providers[0]
  return first ? { providerId: first.id, modelId: undefined, enableThinking: false } : null
}

/** 获取摘要模型配置
 * 优先级：KMS 摘要模型 (kms_summary_model) > KMS AI搜索模型 (kms_model) > 知识场景默认模型 > 任意可用提供商
 */
export function getKmsSummaryLLMConfig(): KmsLLMConfig | null {
  const llmClient = LLMClientService.getInstance()

  const summaryModel = readSettingJson('kms_summary_model')
  if (summaryModel?.provider_id && llmClient.getProvider(summaryModel.provider_id)) {
    return {
      providerId: summaryModel.provider_id,
      modelId: summaryModel.model_id || undefined,
      enableThinking: !!summaryModel.enable_thinking,
    }
  }

  return getKmsLLMConfig()
}

/** 获取向量嵌入模型配置 */
export function getKmsEmbeddingConfig(): KmsEmbeddingConfig | null {
  const llmClient = LLMClientService.getInstance()

  const kmsEmb = readSettingJson('kms_embedding_model')
  if (kmsEmb?.provider_id) {
    const provider = llmClient.getProvider(kmsEmb.provider_id) as any
    if (provider) {
      let modelName = ''
      if (kmsEmb.model_id && provider.models_json) {
        try {
          const models = JSON.parse(provider.models_json)
          const model = models.find((m: any) => m.id === kmsEmb.model_id)
          if (model) {
            modelName = model.model
          }
        } catch (err: any) {
          logger.warn('Failed to parse provider models_json for embedding config:', err?.message || err)
        }
      }
      if (!modelName) {
        modelName = provider.embedding_model || 'text-embedding-3-small'
      }
      return { providerId: kmsEmb.provider_id, modelName }
    }
  }

  return llmClient.getDefaultEmbeddingConfig()
}

/** 读取全部 KMS 设置 */
export function getKmsSettings(): KmsSettings {
  return {
    model: readSettingJson('kms_model'),
    embeddingModel: readSettingJson('kms_embedding_model'),
    summaryModel: readSettingJson('kms_summary_model'),
    searchParams: { ...DEFAULT_SEARCH_PARAMS, ...(readSettingJson('kms_search_params') || {}) },
    autoIndex: { ...DEFAULT_AUTO_INDEX, ...(readSettingJson('kms_auto_index') || {}) },
  }
}

/** 写入单条 setting（存在则更新，传 null 则删除） */
function writeSetting(key: string, value: any): void {
  const mainDb = DatabaseService.getInstance().getDb()
  if (value) {
    mainDb.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, JSON.stringify(value))
  } else {
    mainDb.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }
}

/** 持久化 KMS 设置（不含 autoIndex 的运行时生效，调用方需单独处理） */
export function setKmsSettings(params: any): void {
  if (params.model !== undefined) writeSetting('kms_model', params.model)
  if (params.embeddingModel !== undefined) writeSetting('kms_embedding_model', params.embeddingModel)
  if (params.summaryModel !== undefined) writeSetting('kms_summary_model', params.summaryModel)
  if (params.searchParams !== undefined) writeSetting('kms_search_params', params.searchParams)
  if (params.autoIndex !== undefined) writeSetting('kms_auto_index', params.autoIndex)
}
