import type Database from 'better-sqlite3'
import LLMClientService from '../llm-client.service'
import { generateId } from '../common-utils'
import { callLLMForJSON } from './kms-llm-helpers'
import { createLogger } from '../logger'
import type { KmsLLMConfig } from './kms-config-helpers'

const logger = createLogger('KMS-Collection')

export interface CollectionFile {
  id: string
  file_name: string
  light_summary?: string
  summary?: string
}

export interface CollectionInfo {
  id: string
  name: string
  description: string
}

const MAX_INPUT_CHARS = 12000

/** 通过 LLM 生成合集整体摘要和关键主题词 */
export async function generateCollectionSummary(
  db: Database.Database,
  collectionId: string,
  llmConfig: KmsLLMConfig,
  signal?: AbortSignal,
): Promise<{ summary: string; keyTopics: string[] } | { error: string }> {
  const collection = db.prepare('SELECT id, name, description FROM kms_collections WHERE id = ?').get(collectionId) as any
  if (!collection) return { error: 'Collection not found' }
  if (signal?.aborted) return { error: 'ABORTED' }

  const files = db.prepare(`
    SELECT f.id, f.file_name,
           COALESCE(s.light_summary, '') as light_summary,
           COALESCE(s.summary, '') as summary
    FROM kms_files f
    INNER JOIN kms_file_collections fc ON fc.file_id = f.id
    LEFT JOIN kms_file_summaries s ON s.file_id = f.id
    WHERE fc.collection_id = ?
    ORDER BY f.file_name
  `).all(collectionId) as CollectionFile[]

  if (files.length === 0) return { error: 'NO_FILES' }

  const fileSummaries: string[] = []
  let totalChars = 0
  for (const f of files) {
    const lightSummary = f.light_summary || f.summary || ''
    const line = `【${f.file_name}】${lightSummary ? ' ' + lightSummary : ''}`
    if (totalChars + line.length > MAX_INPUT_CHARS) {
      fileSummaries.push(`...（其余 ${files.length - fileSummaries.length} 个文件省略）`)
      break
    }
    fileSummaries.push(line)
    totalChars += line.length
  }

  const prompt = `请基于以下合集内文件的摘要信息，生成该合集的整体摘要和关键主题词。

合集名称：${collection.name}
合集描述：${collection.description || '（无）'}
文件数量：${files.length}

文件摘要列表：
${fileSummaries.join('\n')}

要求：
1. summary：用 150-300 字概括这个合集的核心内容、覆盖范围与价值，不要罗列文件名。
2. keyTopics：提取 3-8 个关键主题词（短语），用于快速了解合集主题。

只返回 JSON：{"summary":"...","keyTopics":["..."]}`

  try {
    const llmClient = LLMClientService.getInstance()
    const parsed = await callLLMForJSON<{ summary: string; keyTopics: string[] }>(
      llmClient,
      llmConfig.providerId,
      llmConfig.modelId,
      [
        { role: 'system', content: '你是一个资料库合集分析助手。只输出 JSON，不要添加其他文本。' },
        { role: 'user', content: prompt },
      ],
      { summary: '', keyTopics: [] },
      { temperature: 0.7, maxTokens: 800, signal, logSource: 'kms_collection_summary', enable_thinking: llmConfig.enableThinking ? 'high' : false },
    )

    if (signal?.aborted) return { error: 'ABORTED' }

    const summary: string = (parsed.summary || '').trim()
    const keyTopics: string[] = Array.isArray(parsed.keyTopics)
      ? parsed.keyTopics.map((k: any) => String(k).trim()).filter(Boolean).slice(0, 8)
      : []

    if (!summary) return { error: 'LLM returned empty summary' }

    logger.info(`Collection summary generated for ${collectionId}: ${summary.length} chars, ${keyTopics.length} topics`)
    return { summary, keyTopics }
  } catch (err: any) {
    if (signal?.aborted || err?.name === 'AbortError') return { error: 'ABORTED' }
    logger.error('generateCollectionSummary failed:', err?.message || err)
    return { error: err?.message || 'LLM call failed' }
  }
}

/** 持久化合集摘要到数据库 */
export function saveCollectionSummary(
  db: Database.Database,
  collectionId: string,
  summary: string,
  keyTopics: string[] = [],
): void {
  const existing = db.prepare('SELECT id FROM kms_collection_summaries WHERE collection_id = ?').get(collectionId) as any
  if (existing) {
    db.prepare(`
      UPDATE kms_collection_summaries SET summary = ?, key_topics_json = ?, updated_at = unixepoch()
      WHERE collection_id = ?
    `).run(summary, JSON.stringify(keyTopics), collectionId)
  } else {
    db.prepare(`
      INSERT INTO kms_collection_summaries (id, collection_id, summary, key_topics_json, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
    `).run(
      generateId(),
      collectionId,
      summary,
      JSON.stringify(keyTopics),
    )
  }
}
