import type DatabaseService from '../database.service'
import { getDefaultProviderId } from '../common-utils'
import { createLogger } from '../logger'
import { type AgentLLMConfig, type QueryType } from './kms-search-agent-types'

const logger = createLogger('KMS-SearchAgent-Helpers')

/**
 * 获取默认 LLM 配置（providerId + modelId + enableThinking）
 * 优先级：KMS 专属设置 (kms_model) > 知识场景默认模型 (default_model_knowledge) > 任意可用提供商
 */
export function getDefaultLLMConfig(mainDb: DatabaseService): AgentLLMConfig | null {
  const db = mainDb.getDb()

  try {
    const kmsModelRow = db.prepare("SELECT value FROM settings WHERE key = 'kms_model'").get() as any
    if (kmsModelRow?.value) {
      const config = JSON.parse(kmsModelRow.value)
      if (config.provider_id) {
        return {
          providerId: config.provider_id,
          modelId: config.model_id || undefined,
          enableThinking: !!config.enable_thinking,
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to read kms_model setting, falling back to default', error)
  }

  try {
    const row = db.prepare(
      "SELECT value FROM settings WHERE key = 'default_model_knowledge'"
    ).get() as any
    if (row?.value) {
      const config = JSON.parse(row.value)
      if (config.provider_id) {
        return {
          providerId: config.provider_id,
          modelId: config.model_id || undefined,
          enableThinking: false,
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to read default_model_knowledge setting, falling back to first provider', error)
  }

  const fallbackProviderId = getDefaultProviderId(mainDb)
  if (fallbackProviderId) {
    return { providerId: fallbackProviderId, modelId: undefined, enableThinking: false }
  }
  return null
}

/** 根据 providerId 获取其默认 model_id */
export function getModelIdByProvider(mainDb: DatabaseService, providerId: string): string | undefined {
  const row = mainDb.getDb().prepare(
    'SELECT model, models_json FROM llm_providers WHERE id = ?'
  ).get(providerId) as any
  if (!row) return undefined
  if (row.models_json) {
    try {
      const models = JSON.parse(row.models_json)
      if (Array.isArray(models) && models.length > 0 && models[0].id) {
        return models[0].id
      }
    } catch (err: any) {
      logger.warn(`Failed to parse models_json for provider ${providerId}:`, err?.message || err)
    }
  }
  return row.model || undefined
}

/** 降级查询类型分类（基于关键词正则匹配，无需 LLM 调用） */
export function fallbackClassify(query: string): QueryType {
  const lower = query.toLowerCase()
  if (/在哪|哪里|位置|定位|找出|找到|查找|哪个文件/.test(lower)) return 'locate'
  if (/什么是|是什么|解释|定义|含义|意思/.test(lower)) return 'concept'
  if (/趋势|变化|发展|历程|时间线|演变/.test(lower)) return 'trend'
  if (/总结|分析|对比|汇总|概括|综述/.test(lower)) return 'analysis'
  return 'locate'
}

/**
 * 搜索完成后异步触发冷热数据评估（fire-and-forget）
 *
 * 通过 KMSService.evaluateAndPromote 委托到 KMSIndexManagerService：
 * - 去抖：5分钟内的多次搜索只触发一次评估（force=false）
 * - 晋升：高频命中的冷文件会被标记为热文件，并自动重新解析（file2md）+ 生成 LLM 摘要 + 向量嵌入
 * - 隔离：使用动态 require 规避与 KMSService 的循环依赖
 */
export function triggerEvaluateAndPromote(force: boolean): void {
  try {
    const KMSService = require('./kms.service').default
    KMSService.getInstance().evaluateAndPromote(force).catch((err: any) => {
      logger.debug('Post-search evaluateAndPromote failed:', err?.message || err)
    })
  } catch (error) {
    logger.debug('Failed to trigger evaluateAndPromote', error)
  }
}
