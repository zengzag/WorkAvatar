import type Database from 'better-sqlite3'
import type LLMClientService from '../llm-client.service'
import DatabaseService from '../database.service'
import { getDefaultProviderId } from '../common-utils'
import { createLogger } from '../logger'
import {
  type FileInventoryItem,
  type ScopeSummaryItem,
  type FileToRead,
  type AgentLLMConfig,
} from './kms-search-agent-types'
import type { SearchResult } from './kms-search-engine.service'

const logger = createLogger('KMS-SearchAgent-Helpers')

/**
 * 获取默认 LLM 配置（providerId + modelId + enableThinking）
 * 优先级：KMS 专属设置 (kms_model) > 知识场景默认模型 (default_model_knowledge) > 任意可用提供商
 */
export function getDefaultLLMConfig(mainDb: DatabaseService): AgentLLMConfig | null {
  const db = mainDb.getDb()

  // 1. 优先使用 KMS 专属模型设置
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

  // 2. 回退到知识场景默认模型
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

  // 3. 最后回退到任意可用提供商
  const fallbackProviderId = getDefaultProviderId(mainDb)
  if (fallbackProviderId) {
    return { providerId: fallbackProviderId, modelId: undefined, enableThinking: false }
  }
  return null
}

/**
 * 获取 KMS 专属 Embedding 配置
 * 优先级：KMS 专属设置 (kms_embedding_model) > 默认 Embedding 配置
 */
export function getKmsEmbeddingConfig(
  llmClient: LLMClientService,
  mainDb: DatabaseService,
): { providerId: string; modelName: string } | null {
  const db = mainDb.getDb()
  // 1. 优先使用 KMS 专属 Embedding 模型设置
  try {
    const kmsEmbRow = db.prepare("SELECT value FROM settings WHERE key = 'kms_embedding_model'").get() as any
    if (kmsEmbRow?.value) {
      const config = JSON.parse(kmsEmbRow.value)
      if (config.provider_id) {
        const provider = llmClient.getProvider(config.provider_id) as any
        if (provider) {
          let modelName = ''
          if (config.model_id && provider.models_json) {
            try {
              const models = JSON.parse(provider.models_json)
              const model = models.find((m: any) => m.id === config.model_id)
              if (model) {
                modelName = model.model
              }
            } catch (err: any) {
              logger.warn('Failed to parse provider models_json for embedding model:', err?.message || err)
            }
          }
          if (!modelName) {
            modelName = provider.embedding_model || 'text-embedding-3-small'
          }
          return { providerId: config.provider_id, modelName }
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to read kms_embedding_model setting, falling back to default embedding config', error)
  }

  // 2. 回退到默认 Embedding 配置
  return llmClient.getDefaultEmbeddingConfig()
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

/**
 * 获取文件清单（文件名、路径、轻量摘要）—— 用于LLM判断哪些文件可能相关
 * 支持按目录或合集过滤，两者同时存在时取交集
 *
 * 优化策略：
 * - 文件总数 <= 50 时：全部发送给 LLM
 * - 文件总数 > 50 时：先用查询关键词对文件名/摘要做轻量匹配，取匹配的文件 + 部分代表性样本
 */
export function getFileInventory(
  db: Database.Database,
  dirIds?: string[],
  collectionIds?: string[],
  query?: string,
): FileInventoryItem[] {
  try {
    // 基础查询：获取所有已完成索引的文件
    let baseSql = `
      SELECT DISTINCT f.id as file_id, f.file_name, f.file_path, f.file_ext,
             COALESCE(s.light_summary, '') as light_summary,
             COALESCE(s.summary, '') as summary
      FROM kms_files f
      LEFT JOIN kms_file_summaries s ON s.file_id = f.id
      WHERE f.index_status = 'completed'
    `
    const baseParams: any[] = []
    if (dirIds && dirIds.length > 0) {
      const placeholders = dirIds.map(() => '?').join(',')
      baseSql += ` AND f.dir_id IN (${placeholders})`
      baseParams.push(...dirIds)
    }
    if (collectionIds && collectionIds.length > 0) {
      const placeholders = collectionIds.map(() => '?').join(',')
      baseSql += ` AND f.id IN (SELECT file_id FROM kms_file_collections WHERE collection_id IN (${placeholders}))`
      baseParams.push(...collectionIds)
    }

    // 先获取总文件数
    const countSql = `SELECT COUNT(*) as cnt FROM (${baseSql})`
    const total = (db.prepare(countSql).get(...baseParams) as any)?.cnt || 0

    // 文件数量较少时，全量返回
    if (total <= 50) {
      const rows = db.prepare(`${baseSql} ORDER BY f.file_name LIMIT 50`).all(...baseParams) as any[]
      return rows.map(rowToInventoryItem)
    }

    // 文件数量较多时：基于查询关键词预筛选
    const keywords = extractKeywords(query || '')
    const results: FileInventoryItem[] = []
    const seenIds = new Set<string>()

    // 1. 关键词匹配文件名/摘要的文件（优先）
    if (keywords.length > 0) {
      const matchSql = `${baseSql} AND (${keywords.map(() => `(f.file_name LIKE ? OR s.light_summary LIKE ? OR s.summary LIKE ?)`).join(' OR ')}) ORDER BY f.file_name LIMIT 30`
      const matchParams = [...baseParams]
      for (const kw of keywords) {
        const like = `%${kw}%`
        matchParams.push(like, like, like)
      }
      const rows = db.prepare(matchSql).all(...matchParams) as any[]
      for (const r of rows) {
        if (!seenIds.has(r.file_id)) {
          seenIds.add(r.file_id)
          results.push(rowToInventoryItem(r))
        }
      }
    }

    // 2. 补充代表性样本（按扩展名分组，每组取最新文件）
    if (results.length < 50) {
      const sampleSql = `${baseSql} ORDER BY f.file_ext, f.updated_at DESC LIMIT 50`
      const sampleRows = db.prepare(sampleSql).all(...baseParams) as any[]
      for (const r of sampleRows) {
        if (!seenIds.has(r.file_id) && results.length < 50) {
          seenIds.add(r.file_id)
          results.push(rowToInventoryItem(r))
        }
      }
    }

    return results
  } catch (err) {
    logger.warn('Failed to get file inventory:', err)
    return []
  }
}

function rowToInventoryItem(r: any): FileInventoryItem {
  return {
    fileId: r.file_id,
    fileName: r.file_name,
    filePath: r.file_path,
    fileExt: r.file_ext || '',
    lightSummary: r.summary || r.light_summary || '',
  }
}

/** 从查询中提取关键词（简单分词，用于文件名/摘要预匹配） */
export function extractKeywords(query: string): string[] {
  const stopWords = new Set(['如何', '怎么', '什么', '为什么', '的', '了', '吗', '呢', '在', '是', '有', '和', '与', '及', '等', '中', '上', '下', '不', '也', '都', '还', '就', '要', '会', '能', '可以', '这个', '那个', 'how', 'what', 'why', 'where', 'when', 'who', 'is', 'are', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or'])
  const tokens: string[] = []
  // 英文词
  const enWords = query.match(/[a-zA-Z0-9]+/g) || []
  tokens.push(...enWords.filter(w => !stopWords.has(w.toLowerCase()) && w.length > 1))
  // 中文连续片段：按2字和3字滑动窗口提取
  const cnSegments = query.match(/[\u4e00-\u9fff]+/g) || []
  for (const seg of cnSegments) {
    if (seg.length <= 4 && !stopWords.has(seg)) {
      tokens.push(seg)
    } else {
      for (let len = 2; len <= Math.min(4, seg.length); len++) {
        for (let i = 0; i <= seg.length - len; i++) {
          const sub = seg.substring(i, i + len)
          if (!stopWords.has(sub)) tokens.push(sub)
        }
      }
    }
  }
  return [...new Set(tokens)].slice(0, 5)
}

/**
 * 获取作用域摘要（目录摘要或合集摘要）
 * - 仅传 dirIds：返回目录摘要
 * - 仅传 collectionIds：返回合集摘要（包装为兼容结构）
 * - 同时传：返回目录摘要（合集摘要作为补充信息，由调用方决定是否使用）
 */
export function getScopeSummaries(
  db: Database.Database,
  dirIds?: string[],
  collectionIds?: string[],
): ScopeSummaryItem[] {
  // 优先返回目录摘要
  const dirSummaries = getDirSummaries(db, dirIds)
  if (dirSummaries.length > 0 || (dirIds && dirIds.length > 0)) {
    return dirSummaries
  }

  // 没有目录过滤时，若指定了合集，返回合集摘要
  if (collectionIds && collectionIds.length > 0) {
    try {
      const placeholders = collectionIds.map(() => '?').join(',')
      const rows = db.prepare(`
        SELECT cs.summary, cs.key_topics_json,
               (SELECT COUNT(*) FROM kms_file_collections fc WHERE fc.collection_id = cs.collection_id) as file_count,
               c.name as collection_name
        FROM kms_collection_summaries cs
        JOIN kms_collections c ON c.id = cs.collection_id
        WHERE cs.collection_id IN (${placeholders})
      `).all(...collectionIds) as any[]
      return rows.map(r => ({
        dirPath: `合集: ${r.collection_name}`,
        summary: r.summary || '',
        fileCount: r.file_count || 0,
      }))
    } catch {
      return []
    }
  }

  return []
}

/** 获取目录摘要 */
export function getDirSummaries(db: Database.Database, dirIds?: string[]): ScopeSummaryItem[] {
  try {
    let sql = 'SELECT dir_path, summary, file_count FROM kms_dir_summaries'
    const params: any[] = []
    if (dirIds && dirIds.length > 0) {
      const placeholders = dirIds.map(() => '?').join(',')
      sql += ` WHERE dir_id IN (${placeholders})`
      params.push(...dirIds)
    }
    const rows = db.prepare(sql).all(...params) as any[]
    return rows.map(r => ({
      dirPath: r.dir_path,
      summary: r.summary,
      fileCount: r.file_count,
    }))
  } catch {
    return []
  }
}

/**
 * 选择需要读取片段的文件
 * 综合考虑：搜索结果中的文件 + LLM规划的候选文件
 */
export function selectFilesToRead(
  db: Database.Database,
  searchResults: SearchResult[],
  candidateFileIds: string[],
  resultsInsufficient: boolean,
): FileToRead[] {
  const fileMap = new Map<string, string>() // fileId -> fileName

  // 如果搜索结果不足，读取搜索结果中的文件
  if (resultsInsufficient) {
    for (const r of searchResults.slice(0, 3)) {
      if (r.file_id && r.file_name) {
        fileMap.set(r.file_id, r.file_name)
      }
    }
  }

  // 批量查询 LLM 规划的候选文件，消除 N+1
  const candidateIds = candidateFileIds.filter(id => !fileMap.has(id)).slice(0, 3)
  if (candidateIds.length > 0) {
    const placeholders = candidateIds.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT id, file_name FROM kms_files WHERE id IN (${placeholders})`
    ).all(...candidateIds) as any[]
    for (const row of rows) {
      if (!fileMap.has(row.id)) {
        fileMap.set(row.id, row.file_name)
      }
    }
  }

  return Array.from(fileMap.entries()).map(([fileId, fileName]) => ({ fileId, fileName }))
}

/**
 * 读取文件分片
 * 优先从已存储的段落内容读取（热数据，零解析开销），
 * 冷数据没有段落记录时回退到重新解析（使用索引时保存的 parse_mode 决定 hot/cold）。
 */
export async function readFileChunk(
  db: Database.Database,
  fileId: string,
  startOffset: number,
  maxChars: number,
): Promise<string> {
  try {
    // 优先使用已存储的段落内容（热数据，零解析开销）
    const KMSFileReaderService = require('./kms-file-reader.service').default
    const fileReader = KMSFileReaderService.getInstance()
    let content = fileReader.getStoredFullContent(fileId)

    if (content === null) {
      // 冷数据：读取索引时保存的 parse_mode，决定使用 file2md 还是普通解析器
      const file = db.prepare('SELECT file_path FROM kms_files WHERE id = ?').get(fileId) as any
      if (!file) return ''
      const summary = db.prepare('SELECT parse_mode FROM kms_file_summaries WHERE file_id = ?').get(fileId) as any
      const parseMode = summary?.parse_mode || undefined

      const FileParserService = require('../file-parser.service').default
      const parseResult = await FileParserService.getInstance().parseFilePath(
        file.file_path,
        undefined,
        parseMode === 'file2md' ? 'hot' : 'cold',
      )
      content = parseResult.fullText || ''
    }

    return content.substring(startOffset, startOffset + maxChars)
  } catch (err) {
    logger.warn(`Failed to read chunk from file ${fileId}:`, err)
    return ''
  }
}

/** 计算检索结果去重 key */
export function getResultKey(result: SearchResult): string {
  if (result.paragraph_id) return `paragraph-${result.paragraph_id}`
  if (result.match_type === 'content_paragraph' && result.start_offset !== undefined) {
    return `content-${result.file_id}-${result.start_offset}`
  }
  return `${result.match_type}-${result.file_id}`
}

/**
 * 记录搜索命中（用于冷热数据评估）
 *
 * 仅记录排名靠前的有限条结果作为命中，避免 topK 过大时大量低相关结果被计入命中计数，
 * 导致文件被轻易晋升为热数据。结果已按相关性排序，取前 N 条即可。
 */
const SEARCH_HIT_RECORD_LIMIT = 10

export function logSearchHits(results: SearchResult[]): void {
  const topResults = results.slice(0, SEARCH_HIT_RECORD_LIMIT)
  const fileIds = [...new Set(topResults.map(r => r.file_id).filter(Boolean))]
  if (fileIds.length === 0) return
  try {
    const crawler = require('./kms-crawler.service').default.getInstance()
    crawler.logFileAccessBatch(fileIds, 'search_hit')
  } catch (error) {
    logger.debug('Failed to log search hits batch', error)
  }
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
