import type Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import KMSDatabaseService from './kms-database.service'
import KMSCrawlerService from './kms-crawler.service'
import KMSSearchEngineService, { type SearchResult, type SearchOptions } from './kms-search-engine.service'
import KMSIndexManagerService, { type IndexProgress, type AutoIndexConfig, type AutoIndexStatus } from './kms-index-manager.service'
import KMSSearchAgentService, { type AgentSearchResult, type AgentSearchOptions } from './kms-search-agent.service'
import KMSSearchHistoryService from './kms-search-history.service'
import KMSFileReaderService from './kms-file-reader.service'
import LLMClientService from '../llm-client.service'
import DatabaseService from '../database.service'
import { generateId, calculateFileHash } from '../common-utils'
import { createLogger } from '../logger'
import { callLLMForJSON } from './kms-llm-helpers'

const logger = createLogger('KMS')

/**
 * KMS 顶层服务（外观模式）
 * 组合爬虫、搜索引擎、索引管理器三个子服务，提供统一的API
 */
class KMSService {
  private db: Database.Database
  private static instance: KMSService
  private progressListeners: Set<(progress: IndexProgress) => void> = new Set()

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
    // 将自动索引进度转发到进度通知通道，供前端感知
    KMSIndexManagerService.getInstance().setAutoIndexProgressCallback((progress) => {
      this.notifyProgress(progress)
    })
    // 确保"手动文件源"虚拟目录存在（用于合集文件注册）
    this.ensureManualSourceDir()
  }

  /**
   * 手动文件源虚拟目录的路径标记
   * 合集中不在任何索引目录下的文件，dir_id 指向此虚拟目录（enabled=0，不参与扫描）
   */
  private static readonly MANUAL_SOURCE_PATH = '__manual_files__'
  private manualSourceDirId: string | null = null

  /**
   * 确保手动文件源虚拟目录存在
   * 合集文件如果不在任何索引目录中，会注册到此目录下
   */
  private ensureManualSourceDir(): void {
    const existing = this.db.prepare(
      "SELECT id FROM kms_index_dirs WHERE dir_path = ?"
    ).get(KMSService.MANUAL_SOURCE_PATH) as any

    if (existing) {
      this.manualSourceDirId = existing.id
      return
    }

    const id = generateId()
    this.db.prepare(`
      INSERT INTO kms_index_dirs (id, dir_path, display_name, enabled, recursive, file_extensions)
      VALUES (?, ?, ?, 0, 0, '')
    `).run(id, KMSService.MANUAL_SOURCE_PATH, '手动添加的文件')
    this.manualSourceDirId = id
    logger.info('手动文件源虚拟目录已创建')
  }

  static getInstance(): KMSService {
    if (!KMSService.instance) {
      KMSService.instance = new KMSService()
    }
    return KMSService.instance
  }

  addIndexDir(dirPath: string, displayName?: string, recursive: boolean = true, fileExtensions?: string[]): any {
    if (!fs.existsSync(dirPath)) {
      throw new Error(`目录不存在: ${dirPath}`)
    }

    const id = generateId()
    this.db.prepare(`
      INSERT INTO kms_index_dirs (id, dir_path, display_name, recursive, file_extensions)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, dirPath, displayName || dirPath.split(/[\\/]/).pop() || dirPath, recursive ? 1 : 0, fileExtensions?.join(',') || '')

    return this.getIndexDir(id)
  }

  updateIndexDir(id: string, updates: { displayName?: string; enabled?: boolean; recursive?: boolean; fileExtensions?: string[] }): any {
    const sets: string[] = []
    const params: any[] = []

    if (updates.displayName !== undefined) {
      sets.push('display_name = ?')
      params.push(updates.displayName)
    }
    if (updates.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(updates.enabled ? 1 : 0)
    }
    if (updates.recursive !== undefined) {
      sets.push('recursive = ?')
      params.push(updates.recursive ? 1 : 0)
    }
    if (updates.fileExtensions !== undefined) {
      sets.push('file_extensions = ?')
      params.push(updates.fileExtensions.join(','))
    }

    if (sets.length === 0) return this.getIndexDir(id)

    sets.push('updated_at = unixepoch()')
    params.push(id)

    this.db.prepare(`UPDATE kms_index_dirs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return this.getIndexDir(id)
  }

  deleteIndexDir(id: string): void {
    this.db.prepare('DELETE FROM kms_index_dirs WHERE id = ?').run(id)
    KMSSearchEngineService.getInstance().invalidateCache()
  }

  getIndexDir(id: string): any {
    return this.db.prepare('SELECT * FROM kms_index_dirs WHERE id = ?').get(id)
  }

  listIndexDirs(): any[] {
    return this.db.prepare(
      `SELECT d.*,
        (SELECT COUNT(*) FROM kms_files f
         WHERE f.dir_id = d.id
         OR f.file_path LIKE (rtrim(d.dir_path, '/\\') || '/%')
         OR f.file_path LIKE (rtrim(d.dir_path, '/\\') || '\\%')
        ) as file_count
       FROM kms_index_dirs d
       WHERE d.dir_path != ?
       ORDER BY d.created_at ASC`
    ).all(KMSService.MANUAL_SOURCE_PATH)
  }

  createCollection(name: string, description: string = ''): any {
    const id = generateId()
    this.db.prepare(`
      INSERT INTO kms_collections (id, name, description)
      VALUES (?, ?, ?)
    `).run(id, name, description)
    return this.getCollection(id)
  }

  updateCollection(id: string, updates: { name?: string; description?: string }): any {
    const sets: string[] = []
    const params: any[] = []
    if (updates.name !== undefined) {
      sets.push('name = ?')
      params.push(updates.name)
    }
    if (updates.description !== undefined) {
      sets.push('description = ?')
      params.push(updates.description)
    }
    if (sets.length === 0) return this.getCollection(id)
    sets.push('updated_at = unixepoch()')
    params.push(id)
    this.db.prepare(`UPDATE kms_collections SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return this.getCollection(id)
  }

  deleteCollection(id: string): void {
    this.db.prepare('DELETE FROM kms_collections WHERE id = ?').run(id)
    KMSSearchEngineService.getInstance().invalidateCache()
  }

  getCollection(id: string): any {
    const collection = this.db.prepare('SELECT * FROM kms_collections WHERE id = ?').get(id) as any
    if (!collection) return null
    const fileCount = (this.db.prepare(
      'SELECT COUNT(*) as count FROM kms_file_collections WHERE collection_id = ?'
    ).get(id) as any)?.count || 0
    return { ...collection, file_count: fileCount }
  }

  listCollections(): any[] {
    const collections = this.db.prepare(`
      SELECT c.*,
             (SELECT COUNT(*) FROM kms_file_collections fc WHERE fc.collection_id = c.id) as file_count
      FROM kms_collections c
      ORDER BY c.updated_at DESC
    `).all() as any[]
    return collections
  }

  async addFileToCollection(collectionId: string, filePath: string): Promise<{ fileId: string; reused: boolean; duplicated: boolean; changed: boolean }> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`)
    }

    const fileName = path.basename(filePath)
    const ext = path.extname(fileName).toLowerCase().slice(1)
    const stat = fs.statSync(filePath)
    const fileSize = stat.size
    const modifiedTime = Math.floor(stat.mtimeMs / 1000)

    // 1. 按 file_path 查找现有记录
    const existingByPath = this.db.prepare(
      'SELECT id, file_hash, modified_time, index_status FROM kms_files WHERE file_path = ?'
    ).get(filePath) as any

    let fileId: string
    let reused = false
    let duplicated = false
    let changed = false

    if (existingByPath) {
      fileId = existingByPath.id
      reused = true

      // 检测文件是否被修改：mtime 变化时重新计算哈希比对
      if (existingByPath.modified_time !== modifiedTime) {
        const newHash = await calculateFileHash(filePath)
        if (existingByPath.file_hash !== newHash) {
          // 文件内容变化，重置为 pending 触发增量索引
          this.db.prepare(
            'UPDATE kms_files SET file_hash = ?, file_size = ?, modified_time = ?, index_status = ? WHERE id = ?'
          ).run(newHash, fileSize, modifiedTime, 'pending', fileId)
          changed = true
        } else {
          // 仅时间戳变化但内容未变，更新时间戳即可
          this.db.prepare(
            'UPDATE kms_files SET modified_time = ? WHERE id = ?'
          ).run(modifiedTime, fileId)
        }
      }
    } else {
      // 2. 文件未注册，计算哈希
      const hash = await calculateFileHash(filePath)

      // 3. 按 hash 查找是否有相同内容的文件
      const existingByHash = this.db.prepare(
        'SELECT id FROM kms_files WHERE file_hash = ? LIMIT 1'
      ).get(hash) as any

      fileId = generateId()
      changed = true // 新文件需要索引

      if (existingByHash) {
        this.db.prepare(`
          INSERT INTO kms_files (id, dir_id, file_path, file_name, file_ext, file_size, file_hash, modified_time, index_status, data_tier)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'cold')
        `).run(fileId, this.manualSourceDirId, filePath, fileName, ext, fileSize, hash, modifiedTime)
        KMSSearchEngineService.getInstance().cloneIndexData(existingByHash.id, fileId)
        duplicated = true
        changed = false
      } else {
        // 4. 全新文件，注册到虚拟目录，待索引
        this.db.prepare(`
          INSERT INTO kms_files (id, dir_id, file_path, file_name, file_ext, file_size, file_hash, modified_time, index_status, data_tier)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'cold')
        `).run(fileId, this.manualSourceDirId, filePath, fileName, ext, fileSize, hash, modifiedTime)
      }
    }

    // 5. 关联到合集（INSERT OR IGNORE 避免重复关联）
    this.db.prepare(`
      INSERT OR IGNORE INTO kms_file_collections (file_id, collection_id)
      VALUES (?, ?)
    `).run(fileId, collectionId)

    // 6. 更新合集更新时间
    this.db.prepare('UPDATE kms_collections SET updated_at = unixepoch() WHERE id = ?').run(collectionId)

    KMSSearchEngineService.getInstance().invalidateCache()

    // 7. 若有新增/变更的 pending 文件，异步触发增量索引（fire-and-forget）
    if (changed) {
      KMSIndexManagerService.getInstance().incrementalIndex().catch((err: any) => {
        logger.error('Auto incrementalIndex after addFileToCollection failed:', err?.message || err)
      })
    }

    return { fileId, reused, duplicated, changed }
  }

  async addFilesToCollection(collectionId: string, filePaths: string[]): Promise<{ added: number; reused: number; duplicated: number; changed: number; failed: { path: string; error: string }[] }> {
    let added = 0
    let reused = 0
    let duplicated = 0
    let changed = 0
    const failed: { path: string; error: string }[] = []

    for (const filePath of filePaths) {
      try {
        const result = await this.addFileToCollection(collectionId, filePath)
        added++
        if (result.reused) reused++
        if (result.duplicated) duplicated++
        if (result.changed) changed++
      } catch (err: any) {
        failed.push({ path: filePath, error: err?.message || String(err) })
      }
    }

    return { added, reused, duplicated, changed, failed }
  }

  /**
   * 从合集中移除文件（仅解除关联，不删除文件本身）
   */
  removeFileFromCollection(collectionId: string, fileId: string): void {
    this.db.prepare(
      'DELETE FROM kms_file_collections WHERE file_id = ? AND collection_id = ?'
    ).run(fileId, collectionId)
    this.db.prepare('UPDATE kms_collections SET updated_at = unixepoch() WHERE id = ?').run(collectionId)
    KMSSearchEngineService.getInstance().invalidateCache()
  }

  /**
   * 获取合集内的文件列表（含文件详细信息）
   */
  listFilesInCollection(collectionId: string): any[] {
    return this.db.prepare(`
      SELECT f.id, f.file_name, f.file_path, f.file_ext, f.file_size, f.data_tier,
             f.index_status, f.modified_time, f.updated_at,
             fc.added_at,
             COALESCE(s.summary, '') as summary,
             COALESCE(s.light_summary, '') as light_summary,
             COALESCE(s.keywords_json, '[]') as keywords_json,
             COALESCE(s.main_topics_json, '[]') as main_topics_json
      FROM kms_file_collections fc
      JOIN kms_files f ON fc.file_id = f.id
      LEFT JOIN kms_file_summaries s ON s.file_id = f.id
      WHERE fc.collection_id = ?
      ORDER BY fc.added_at DESC
    `).all(collectionId) as any[]
  }

  /**
   * 获取合集统计信息
   */
  getCollectionStats(collectionId: string): any {
    const fileCount = (this.db.prepare(
      'SELECT COUNT(*) as count FROM kms_file_collections WHERE collection_id = ?'
    ).get(collectionId) as any)?.count || 0

    const indexedCount = (this.db.prepare(`
      SELECT COUNT(*) as count FROM kms_file_collections fc
      JOIN kms_files f ON fc.file_id = f.id
      WHERE fc.collection_id = ? AND f.index_status = 'completed'
    `).get(collectionId) as any)?.count || 0

    const hotCount = (this.db.prepare(`
      SELECT COUNT(*) as count FROM kms_file_collections fc
      JOIN kms_files f ON fc.file_id = f.id
      WHERE fc.collection_id = ? AND f.data_tier = 'hot'
    `).get(collectionId) as any)?.count || 0

    const pendingCount = (this.db.prepare(`
      SELECT COUNT(*) as count FROM kms_file_collections fc
      JOIN kms_files f ON fc.file_id = f.id
      WHERE fc.collection_id = ? AND f.index_status = 'pending'
    `).get(collectionId) as any)?.count || 0

    const hasSummary = !!this.db.prepare(
      'SELECT 1 FROM kms_collection_summaries WHERE collection_id = ?'
    ).get(collectionId)

    return {
      fileCount,
      indexedCount,
      hotCount,
      pendingCount,
      hasSummary,
    }
  }

  getCollectionSummary(collectionId: string): any {
    return this.db.prepare(
      'SELECT * FROM kms_collection_summaries WHERE collection_id = ?'
    ).get(collectionId) as any
  }

  getCollectionSummariesByIds(collectionIds: string[]): Map<string, any> {
    const result = new Map<string, any>()
    if (collectionIds.length === 0) return result
    const placeholders = collectionIds.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT * FROM kms_collection_summaries WHERE collection_id IN (${placeholders})`
    ).all(...collectionIds) as any[]
    for (const row of rows) {
      result.set(row.collection_id, row)
    }
    return result
  }

  setCollectionSummary(collectionId: string, summary: string, keyTopics: string[] = []): void {
    const existing = this.db.prepare(
      'SELECT id FROM kms_collection_summaries WHERE collection_id = ?'
    ).get(collectionId) as any

    if (existing) {
      this.db.prepare(`
        UPDATE kms_collection_summaries
        SET summary = ?, key_topics_json = ?, updated_at = unixepoch()
        WHERE collection_id = ?
      `).run(summary, JSON.stringify(keyTopics), collectionId)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kms_collection_summaries (id, collection_id, summary, key_topics_json)
        VALUES (?, ?, ?, ?)
      `).run(id, collectionId, summary, JSON.stringify(keyTopics))
    }
  }

  deleteCollectionSummary(collectionId: string): void {
    this.db.prepare('DELETE FROM kms_collection_summaries WHERE collection_id = ?').run(collectionId)
  }

  async generateCollectionSummary(collectionId: string, signal?: AbortSignal): Promise<{ summary: string; keyTopics: string[] } | { error: string }> {
    const collection = this.db.prepare('SELECT id, name, description FROM kms_collections WHERE id = ?').get(collectionId) as any
    if (!collection) {
      return { error: 'Collection not found' }
    }

    if (signal?.aborted) {
      return { error: 'ABORTED' }
    }

    const files = this.listFilesInCollection(collectionId)
    if (files.length === 0) {
      return { error: 'NO_FILES' }
    }

    // 获取摘要模型 LLM 配置（KMS 摘要模型 → KMS AI搜索模型 → 知识场景默认 → 任意可用）
    const llmConfig = this.getKmsSummaryLLMConfig()
    if (!llmConfig) {
      return { error: 'NO_LLM_PROVIDER' }
    }

    // 拼接文件信息+轻量摘要作为 LLM 输入（控制总长度避免超 token）
    const fileSummaries: string[] = []
    let totalChars = 0
    const MAX_INPUT_CHARS = 12000
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
        { temperature: 0.3, maxTokens: 800, signal, logSource: 'kms_collection_summary', enable_thinking: llmConfig.enableThinking },
      )

      // 取消检查
      if (signal?.aborted) {
        return { error: 'ABORTED' }
      }

      const summary: string = (parsed.summary || '').trim()
      const keyTopics: string[] = Array.isArray(parsed.keyTopics)
        ? parsed.keyTopics.map((k: any) => String(k).trim()).filter(Boolean).slice(0, 8)
        : []

      if (!summary) {
        return { error: 'LLM returned empty summary' }
      }

      this.setCollectionSummary(collectionId, summary, keyTopics)
      logger.info(`Collection summary generated for ${collectionId}: ${summary.length} chars, ${keyTopics.length} topics`)

      return { summary, keyTopics }
    } catch (err: any) {
      if (signal?.aborted || err?.name === 'AbortError') {
        return { error: 'ABORTED' }
      }
      logger.error('generateCollectionSummary failed:', err?.message || err)
      return { error: err?.message || 'LLM call failed' }
    }
  }

  getKmsLLMConfigPublic(): { providerId: string; modelId: string | undefined; enableThinking: boolean } | null {
    return this.getKmsLLMConfig()
  }

  /**
   * 获取摘要模型配置（用于文件摘要、目录摘要、合集摘要、合集深度处理等）
   * 优先级：KMS 摘要模型 (kms_summary_model) > KMS AI搜索模型 (kms_model) > 知识场景默认模型 > 任意可用提供商
   */
  getKmsSummaryLLMConfigPublic(): { providerId: string; modelId: string | undefined; enableThinking: boolean } | null {
    return this.getKmsSummaryLLMConfig()
  }

  getKmsEmbeddingConfigPublic(): { providerId: string; modelName: string } | null {
    return this.getKmsEmbeddingConfig()
  }

  private getKmsLLMConfig(): { providerId: string; modelId: string | undefined; enableThinking: boolean } | null {
    const llmClient = LLMClientService.getInstance()
    const mainDb = DatabaseService.getInstance().getDb()

    try {
      const kmsModelRow = mainDb.prepare("SELECT value FROM settings WHERE key = 'kms_model'").get() as any
      if (kmsModelRow?.value) {
        const config = JSON.parse(kmsModelRow.value)
        if (config.provider_id && llmClient.getProvider(config.provider_id)) {
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
      const row = mainDb.prepare("SELECT value FROM settings WHERE key = 'default_model_knowledge'").get() as any
      if (row?.value) {
        const config = JSON.parse(row.value)
        if (config.provider_id && llmClient.getProvider(config.provider_id)) {
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

    const providers = llmClient.getProviderList?.() as any[] || []
    const first = providers[0]
    return first ? { providerId: first.id, modelId: undefined, enableThinking: false } : null
  }

  getKmsSummaryLLMConfig(): { providerId: string; modelId: string | undefined; enableThinking: boolean } | null {
    const llmClient = LLMClientService.getInstance()
    const mainDb = DatabaseService.getInstance().getDb()

    try {
      const summaryRow = mainDb.prepare("SELECT value FROM settings WHERE key = 'kms_summary_model'").get() as any
      if (summaryRow?.value) {
        const config = JSON.parse(summaryRow.value)
        if (config.provider_id && llmClient.getProvider(config.provider_id)) {
          return {
            providerId: config.provider_id,
            modelId: config.model_id || undefined,
            enableThinking: !!config.enable_thinking,
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to read kms_summary_model setting, falling back to kms_model', error)
    }

    return this.getKmsLLMConfig()
  }

  scanDirFiles(dirPath: string, extensions?: string[]): { files: string[]; skipped: number } {
    return KMSFileReaderService.getInstance().scanDirFiles(dirPath, extensions)
  }

  getFileParagraphs(fileId: string): any[] {
    return KMSFileReaderService.getInstance().getFileParagraphs(fileId)
  }

  getParagraphContent(paragraphId: string): { id: string; title: string; title_path: string; level: number; paragraph_index: number; content: string; summary: string | null; keywords_json: string | null; file_id: string } | null {
    return KMSFileReaderService.getInstance().getParagraphContent(paragraphId)
  }

  getFileToc(fileId: string): any[] {
    return KMSFileReaderService.getInstance().getFileToc(fileId)
  }

  getParagraphsByIds(paragraphIds: string[]): any[] {
    return KMSFileReaderService.getInstance().getParagraphsByIds(paragraphIds)
  }

  /**
   * 按文件名搜索文件（不匹配文件内容）
   * 支持与现有搜索相同的过滤条件（dirIds, collectionIds, fileExtensions, timeRangeStart, timeRangeEnd）
   */
  searchFiles(query: string, options?: SearchOptions): SearchResult[] {
    const startTime = Date.now()
    let sql = `
      SELECT f.id as file_id, f.file_name, f.file_path, f.file_name as text, 'file_name' as match_type
      FROM kms_files f
      LEFT JOIN kms_index_dirs d ON d.id = f.dir_id
      WHERE f.file_name LIKE ?
    `
    const params: any[] = [`%${query}%`]

    if (options?.dirIds && options.dirIds.length > 0) {
      const placeholders = options.dirIds.map(() => '?').join(',')
      sql += ` AND f.dir_id IN (${placeholders})`
      params.push(...options.dirIds)
    }

    if (options?.fileExtensions && options.fileExtensions.length > 0) {
      const placeholders = options.fileExtensions.map(() => '?').join(',')
      sql += ` AND f.file_ext IN (${placeholders})`
      params.push(...options.fileExtensions)
    }

    if (options?.timeRangeStart !== undefined) {
      sql += ' AND f.modified_time >= ?'
      params.push(options.timeRangeStart)
    }

    if (options?.timeRangeEnd !== undefined) {
      sql += ' AND f.modified_time <= ?'
      params.push(options.timeRangeEnd)
    }

    if (options?.collectionIds && options.collectionIds.length > 0) {
      const placeholders = options.collectionIds.map(() => '?').join(',')
      sql += ` AND f.id IN (SELECT file_id FROM kms_file_collections WHERE collection_id IN (${placeholders}))`
      params.push(...options.collectionIds)
    }

    // 默认限制返回数量，避免大量结果导致前端渲染卡顿
    const limit = options?.topK ?? 200
    sql += ' LIMIT ?'
    params.push(limit)

    const results = this.db.prepare(sql).all(...params) as SearchResult[]
    logger.info(`searchFiles "${query}": ${results.length} results, ${Date.now() - startTime}ms`)
    return results
  }

  async search(query: string, options?: SearchOptions & { useSemantic?: boolean }): Promise<SearchResult[]> {
    const startTime = Date.now()
    const searchEngine = KMSSearchEngineService.getInstance()
    let queryEmbedding: Float32Array | undefined

    if (options?.useSemantic) {
      try {
        const embStart = Date.now()
        const embConfig = this.getKmsEmbeddingConfig()
        if (embConfig) {
          queryEmbedding = await LLMClientService.getInstance().createEmbedding(
            embConfig.providerId,
            query,
            embConfig.modelName
          )
        }
        logger.info(`search embedding generated in ${Date.now() - embStart}ms`)
      } catch (err) {
        logger.warn('Failed to generate query embedding, falling back to keyword search:', err)
      }
    }

    const searchStart = Date.now()
    const results = searchEngine.search(query, queryEmbedding, options)
    logger.info(`search engine returned ${results.length} results in ${Date.now() - searchStart}ms`)

    const hitFileIds = new Set(results.map(r => r.file_id))
    const crawler = KMSCrawlerService.getInstance()
    for (const fileId of hitFileIds) {
      crawler.logFileAccess(fileId, 'search_hit')
    }

    logger.info(`search "${query}" total: ${results.length} results, ${Date.now() - startTime}ms`)
    return results
  }

  private getKmsEmbeddingConfig(): { providerId: string; modelName: string } | null {
    const llmClient = LLMClientService.getInstance()
    const mainDb = DatabaseService.getInstance().getDb()

    try {
      const kmsEmbRow = mainDb.prepare("SELECT value FROM settings WHERE key = 'kms_embedding_model'").get() as any
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
              } catch {}
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

    return llmClient.getDefaultEmbeddingConfig()
  }

  async getFileContent(fileId: string, options?: { paragraphId?: string; startOffset?: number; endOffset?: number; startLine?: number; maxChars?: number }): Promise<string> {
    return KMSFileReaderService.getInstance().getFileContent(fileId, options)
  }

  getFileSummary(fileId: string): any {
    return KMSFileReaderService.getInstance().getFileSummary(fileId)
  }

  async agentSearch(query: string, options?: AgentSearchOptions): Promise<AgentSearchResult> {
    return KMSSearchAgentService.getInstance().search(query, options)
  }

  async getFileFullContent(fileId: string): Promise<{ content: string; fileName: string; filePath: string; truncated: boolean }> {
    return KMSFileReaderService.getInstance().getFileFullContent(fileId)
  }

  async buildFullIndex(providerId?: string, withEmbedding: boolean = true): Promise<void> {
    const indexManager = KMSIndexManagerService.getInstance()
    if (!providerId) {
      const llmConfig = this.getKmsLLMConfig()
      providerId = llmConfig?.providerId
    }
    await indexManager.buildFullIndex(providerId, (progress) => {
      this.notifyProgress(progress)
    }, withEmbedding)
  }

  async incrementalIndex(providerId?: string, withEmbedding: boolean = true): Promise<void> {
    const indexManager = KMSIndexManagerService.getInstance()
    if (!providerId) {
      const llmConfig = this.getKmsLLMConfig()
      providerId = llmConfig?.providerId
    }
    await indexManager.incrementalIndex(providerId, (progress) => {
      this.notifyProgress(progress)
    }, withEmbedding)
  }

  async rebuildDirIndex(dirId: string, providerId?: string, withEmbedding: boolean = true): Promise<void> {
    const indexManager = KMSIndexManagerService.getInstance()
    if (!providerId) {
      const llmConfig = this.getKmsLLMConfig()
      providerId = llmConfig?.providerId
    }
    await indexManager.rebuildDirIndex(dirId, providerId, (progress) => {
      this.notifyProgress(progress)
    }, withEmbedding)
  }

  async processCollectionDeep(collectionId: string): Promise<{ fileProcessed: number; summaryGenerated: boolean; embeddingGenerated: boolean; error?: string }> {
    const indexManager = KMSIndexManagerService.getInstance()
    return await indexManager.processCollectionDeep(collectionId, (progress) => {
      this.notifyProgress(progress)
    })
  }

  cancelCollectionDeepProcess(): void {
    KMSIndexManagerService.getInstance().cancelCollectionDeepProcess()
  }

  async generateDirSummaryManual(dirId: string): Promise<{ success: boolean; error?: string }> {
    return KMSIndexManagerService.getInstance().generateDirSummaryManual(dirId)
  }

  async generateFileSummaryManual(fileId: string): Promise<{ success: boolean; error?: string }> {
    return KMSIndexManagerService.getInstance().generateFileSummaryManual(fileId)
  }

  async rebuildFileIndex(fileId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const searchEngine = KMSSearchEngineService.getInstance()
      const crawler = KMSCrawlerService.getInstance()
      searchEngine.deleteIndexByFile(fileId)
      crawler.updateFileStatus(fileId, 'pending')
      // 异步触发增量索引
      KMSIndexManagerService.getInstance().incrementalIndex().catch((err: any) => {
        logger.error('Auto incrementalIndex after file rebuild failed:', err?.message || err)
      })
      return { success: true }
    } catch (err: any) {
      logger.error('rebuildFileIndex failed:', err?.message || err)
      return { success: false, error: err?.message || 'UNKNOWN' }
    }
  }

  cancelIndexing(): void {
    KMSIndexManagerService.getInstance().cancelIndexing()
  }

  getStats(): any {
    const crawler = KMSCrawlerService.getInstance()
    const searchEngine = KMSSearchEngineService.getInstance()

    const fileStats = crawler.getFileStats()
    const indexStats = searchEngine.getIndexStats()
    const dirCount = (this.db.prepare('SELECT COUNT(*) as count FROM kms_index_dirs WHERE dir_path != ?').get(KMSService.MANUAL_SOURCE_PATH) as any)?.count || 0
    const enabledDirCount = (this.db.prepare('SELECT COUNT(*) as count FROM kms_index_dirs WHERE enabled = 1 AND dir_path != ?').get(KMSService.MANUAL_SOURCE_PATH) as any)?.count || 0
    const collectionCount = (this.db.prepare('SELECT COUNT(*) as count FROM kms_collections').get() as any)?.count || 0

    return {
      dirs: { total: dirCount, enabled: enabledDirCount },
      collections: { total: collectionCount },
      files: fileStats,
      index: indexStats,
    }
  }

  getKmsSettings(): any {
    const mainDb = DatabaseService.getInstance().getDb()
    const result: any = {
      model: null,
      embeddingModel: null,
      summaryModel: null,
      searchParams: { maxRounds: 3, topK: 10, resultLimit: 100 },
      autoIndex: { enabled: false, intervalMinutes: 10, stableThresholdSeconds: 300 },
    }

    try {
      const modelRow = mainDb.prepare("SELECT value FROM settings WHERE key = 'kms_model'").get() as any
      if (modelRow?.value) {
        result.model = JSON.parse(modelRow.value)
      }
    } catch {}

    try {
      const embRow = mainDb.prepare("SELECT value FROM settings WHERE key = 'kms_embedding_model'").get() as any
      if (embRow?.value) {
        result.embeddingModel = JSON.parse(embRow.value)
      }
    } catch {}

    try {
      const summaryRow = mainDb.prepare("SELECT value FROM settings WHERE key = 'kms_summary_model'").get() as any
      if (summaryRow?.value) {
        result.summaryModel = JSON.parse(summaryRow.value)
      }
    } catch {}

    try {
      const paramsRow = mainDb.prepare("SELECT value FROM settings WHERE key = 'kms_search_params'").get() as any
      if (paramsRow?.value) {
        result.searchParams = { ...result.searchParams, ...JSON.parse(paramsRow.value) }
      }
    } catch {}

    try {
      const autoIndexRow = mainDb.prepare("SELECT value FROM settings WHERE key = 'kms_auto_index'").get() as any
      if (autoIndexRow?.value) {
        result.autoIndex = { ...result.autoIndex, ...JSON.parse(autoIndexRow.value) }
      }
    } catch {}

    return result
  }

  setKmsSettings(params: any): void {
    const mainDb = DatabaseService.getInstance().getDb()
    const setSetting = (key: string, value: any) => {
      const jsonStr = JSON.stringify(value)
      mainDb.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      ).run(key, jsonStr)
    }

    if (params.model !== undefined) {
      if (params.model) {
        setSetting('kms_model', params.model)
      } else {
        mainDb.prepare("DELETE FROM settings WHERE key = 'kms_model'").run()
      }
    }
    if (params.embeddingModel !== undefined) {
      if (params.embeddingModel) {
        setSetting('kms_embedding_model', params.embeddingModel)
      } else {
        mainDb.prepare("DELETE FROM settings WHERE key = 'kms_embedding_model'").run()
      }
    }
    if (params.summaryModel !== undefined) {
      if (params.summaryModel) {
        setSetting('kms_summary_model', params.summaryModel)
      } else {
        mainDb.prepare("DELETE FROM settings WHERE key = 'kms_summary_model'").run()
      }
    }
    if (params.searchParams !== undefined) {
      setSetting('kms_search_params', params.searchParams)
    }
    if (params.autoIndex !== undefined) {
      setSetting('kms_auto_index', params.autoIndex)
      const config: AutoIndexConfig = {
        enabled: !!params.autoIndex.enabled,
        intervalMinutes: Math.max(1, Math.min(1440, params.autoIndex.intervalMinutes ?? 10)),
        stableThresholdSeconds: Math.max(0, Math.min(86400, params.autoIndex.stableThresholdSeconds ?? 300)),
      }
      KMSIndexManagerService.getInstance().startAutoIndex(config)
    }
  }

  initAutoIndex(): void {
    const settings = this.getKmsSettings()
    const config: AutoIndexConfig = settings.autoIndex || { enabled: false, intervalMinutes: 10, stableThresholdSeconds: 300 }
    KMSIndexManagerService.getInstance().startAutoIndex(config)
  }

  getAutoIndexStatus(): AutoIndexStatus {
    return KMSIndexManagerService.getInstance().getAutoIndexStatus()
  }

  async runAutoIndexCheckNow(): Promise<void> {
    await KMSIndexManagerService.getInstance().runAutoIndexCheck()
  }

  getDirSummaries(): any[] {
    return this.db.prepare(`
      SELECT ds.dir_id, ds.dir_path, ds.summary, ds.file_count, ds.keywords_json, ds.updated_at,
             d.display_name, d.enabled
      FROM kms_dir_summaries ds
      LEFT JOIN kms_index_dirs d ON d.id = ds.dir_id
      ORDER BY ds.updated_at DESC
    `).all() as any[]
  }

  getFileSummaries(params?: { dirId?: string; collectionId?: string; dataTier?: string; keyword?: string; page?: number; pageSize?: number }): { items: any[]; total: number } {
    const page = params?.page || 1
    const pageSize = params?.pageSize || 20
    const offset = (page - 1) * pageSize

    // 不再过滤 __manual_files__ 虚拟目录：手动添加到合集的文件也应在知识视图中可见
    let whereClause = 'WHERE 1=1'
    const sqlParams: any[] = []

    if (params?.dirId) {
      whereClause += ' AND f.dir_id = ?'
      sqlParams.push(params.dirId)
    }
    if (params?.collectionId) {
      whereClause += ' AND f.id IN (SELECT file_id FROM kms_file_collections WHERE collection_id = ?)'
      sqlParams.push(params.collectionId)
    }
    if (params?.dataTier) {
      whereClause += ' AND f.data_tier = ?'
      sqlParams.push(params.dataTier)
    }
    if (params?.keyword) {
      whereClause += ' AND (f.file_name LIKE ? OR s.light_summary LIKE ? OR s.summary LIKE ?)'
      const kw = `%${params.keyword}%`
      sqlParams.push(kw, kw, kw)
    }

    const total = (this.db.prepare(
      `SELECT COUNT(*) as count FROM kms_files f LEFT JOIN kms_file_summaries s ON s.file_id = f.id ${whereClause}`
    ).get(...sqlParams) as any)?.count || 0

    const items = this.db.prepare(`
      SELECT f.id, f.file_name, f.file_path, f.file_ext, f.file_size, f.data_tier,
             f.index_status, f.modified_time, f.updated_at,
             COALESCE(s.summary, '') as summary,
             COALESCE(s.light_summary, '') as light_summary,
             COALESCE(s.preview_text, '') as preview_text,
             COALESCE(s.keywords_json, '[]') as keywords_json,
             COALESCE(s.main_topics_json, '[]') as main_topics_json,
             d.display_name as dir_name,
             d.dir_path as dir_path,
             CASE WHEN EXISTS (
               SELECT 1 FROM kms_embeddings e WHERE e.file_id = f.id LIMIT 1
             ) THEN 1 ELSE 0 END as has_embedding
      FROM kms_files f
      LEFT JOIN kms_file_summaries s ON s.file_id = f.id
      LEFT JOIN kms_index_dirs d ON d.id = f.dir_id
      ${whereClause}
      ORDER BY f.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...sqlParams, pageSize, offset) as any[]

    return { items, total }
  }

  /**
   * 记录搜索历史（相同 query 去重：更新已有记录而非重复插入）
   */
  recordSearchHistory(params: {
    query: string
    searchMode: string
    resultCount: number
    filters?: any
  }): void {
    KMSSearchHistoryService.getInstance().recordSearchHistory(params)
  }

  /**
   * 获取搜索历史列表
   */
  getSearchHistory(params?: { limit?: number; searchMode?: string }): any[] {
    return KMSSearchHistoryService.getInstance().getSearchHistory(params)
  }

  /**
   * 清空搜索历史
   */
  clearSearchHistory(searchMode?: string): void {
    KMSSearchHistoryService.getInstance().clearSearchHistory(searchMode)
  }

  /**
   * 删除单条搜索历史
   */
  deleteSearchHistory(id: string): void {
    KMSSearchHistoryService.getInstance().deleteSearchHistory(id)
  }

  onProgress(listener: (progress: IndexProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  private notifyProgress(progress: IndexProgress): void {
    for (const listener of this.progressListeners) {
      try {
        listener(progress)
      } catch (error) {
        logger.warn('KMS progress listener threw an error', error)
      }
    }
  }
}

export default KMSService
