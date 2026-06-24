import type Database from 'better-sqlite3'
import fs from 'fs'
import KMSDatabaseService from './kms-database.service'
import KMSCrawlerService from './kms-crawler.service'
import KMSSearchEngineService, { type SearchResult, type SearchOptions } from './kms-search-engine.service'
import KMSIndexManagerService, { type IndexProgress } from './kms-index-manager.service'
import KMSSearchAgentService, { type AgentSearchResult, type AgentSearchOptions } from './kms-search-agent.service'
import LLMClientService from '../llm-client.service'
import DatabaseService from '../database.service'
import FileParserService from '../file-parser.service'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'

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
  }

  static getInstance(): KMSService {
    if (!KMSService.instance) {
      KMSService.instance = new KMSService()
    }
    return KMSService.instance
  }

  // ==================== 索引目录管理 ====================

  /**
   * 添加索引目录
   */
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

  /**
   * 更新索引目录
   */
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

  /**
   * 删除索引目录
   */
  deleteIndexDir(id: string): void {
    // 级联删除会自动清理关联文件、段落、摘要、索引和嵌入
    this.db.prepare('DELETE FROM kms_index_dirs WHERE id = ?').run(id)
    KMSSearchEngineService.getInstance().invalidateCache()
  }

  /**
   * 获取索引目录
   */
  getIndexDir(id: string): any {
    return this.db.prepare('SELECT * FROM kms_index_dirs WHERE id = ?').get(id)
  }

  /**
   * 获取所有索引目录
   */
  listIndexDirs(): any[] {
    return this.db.prepare('SELECT * FROM kms_index_dirs ORDER BY created_at ASC').all()
  }

  // ==================== 搜索 ====================

  /**
   * 搜索
   */
  async search(query: string, options?: SearchOptions & { useSemantic?: boolean }): Promise<SearchResult[]> {
    const searchEngine = KMSSearchEngineService.getInstance()
    let queryEmbedding: Float32Array | undefined

    if (options?.useSemantic) {
      try {
        const embConfig = this.getKmsEmbeddingConfig()
        if (embConfig) {
          queryEmbedding = await LLMClientService.getInstance().createEmbedding(
            embConfig.providerId,
            query,
            embConfig.modelName
          )
        }
      } catch (err) {
        logger.warn('Failed to generate query embedding, falling back to keyword search:', err)
      }
    }

    const results = searchEngine.search(query, queryEmbedding, options)

    // 记录搜索命中
    const hitFileIds = new Set(results.map(r => r.file_id))
    const crawler = KMSCrawlerService.getInstance()
    for (const fileId of hitFileIds) {
      crawler.logFileAccess(fileId, 'search_hit')
    }

    return results
  }

  /**
   * 获取 KMS Embedding 配置（优先 KMS 专属设置，回退到默认设置）
   */
  private getKmsEmbeddingConfig(): { providerId: string; modelName: string } | null {
    const llmClient = LLMClientService.getInstance()
    const mainDb = DatabaseService.getInstance().getDb()

    // 1. 优先使用 KMS 专属 Embedding 模型设置
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
    } catch {}

    // 2. 回退到默认 Embedding 配置
    return llmClient.getDefaultEmbeddingConfig()
  }

  /**
   * 获取文件内容（按段落/偏移/行号定位）
   */
  async getFileContent(fileId: string, options?: { paragraphId?: string; startOffset?: number; endOffset?: number; startLine?: number; maxChars?: number }): Promise<string> {
    const file = this.db.prepare('SELECT * FROM kms_files WHERE id = ?').get(fileId) as any
    if (!file) throw new Error('File not found')

    // 文件存在后再记录访问日志（避免外键约束失败）
    const crawler = KMSCrawlerService.getInstance()
    crawler.logFileAccess(fileId, 'read')

    // 如果指定了段落ID，从段落表获取
    if (options?.paragraphId) {
      const paragraph = this.db.prepare('SELECT content FROM kms_paragraphs WHERE id = ? AND file_id = ?').get(options.paragraphId, fileId) as any
      if (paragraph) return paragraph.content
    }

    // 否则重新解析文件获取原文
    const maxChars = options?.maxChars || 5000
    try {
      const parseResult = await FileParserService.getInstance().parseFilePath(file.file_path)
      let content = parseResult.fullText

      if (options?.startOffset !== undefined && options?.endOffset !== undefined) {
        content = content.substring(options.startOffset, options.endOffset)
      } else if (options?.startLine !== undefined) {
        const lines = content.split('\n')
        content = lines.slice(options.startLine - 1, options.startLine + 50).join('\n')
      }

      return content.substring(0, maxChars)
    } catch (err) {
      logger.error(`Failed to read file content for ${file.file_path}:`, err)
      throw err
    }
  }

  /**
   * 获取文件摘要
   */
  getFileSummary(fileId: string): any {
    const summary = this.db.prepare('SELECT * FROM kms_file_summaries WHERE file_id = ?').get(fileId)
    if (!summary) return null

    // 摘要存在后再记录访问日志（避免外键约束失败）
    const crawler = KMSCrawlerService.getInstance()
    crawler.logFileAccess(fileId, 'summary_view')

    return summary
  }

  /**
   * AI 智能检索（通过检索子智能体）
   * 自主规划检索路径、多轮补充查找、筛选提纯内容，输出核心结论+精准溯源
   */
  async agentSearch(query: string, options?: AgentSearchOptions): Promise<AgentSearchResult> {
    return KMSSearchAgentService.getInstance().search(query, options)
  }

  /**
   * 获取文件完整文本内容（用于预览）
   */
  async getFileFullContent(fileId: string): Promise<{ content: string; fileName: string; filePath: string }> {
    const file = this.db.prepare('SELECT * FROM kms_files WHERE id = ?').get(fileId) as any
    if (!file) throw new Error('File not found')

    const crawler = KMSCrawlerService.getInstance()
    crawler.logFileAccess(fileId, 'read')

    try {
      const parseResult = await FileParserService.getInstance().parseFilePath(file.file_path)
      return {
        content: parseResult.fullText,
        fileName: file.file_name,
        filePath: file.file_path,
      }
    } catch (err) {
      logger.error(`Failed to read file content for ${file.file_path}:`, err)
      throw err
    }
  }

  // ==================== 索引管理 ====================

  /**
   * 构建全量索引
   */
  async buildFullIndex(providerId?: string): Promise<void> {
    const indexManager = KMSIndexManagerService.getInstance()
    await indexManager.buildFullIndex(providerId, (progress) => {
      this.notifyProgress(progress)
    })
  }

  /**
   * 增量索引
   */
  async incrementalIndex(providerId?: string): Promise<void> {
    const indexManager = KMSIndexManagerService.getInstance()
    await indexManager.incrementalIndex(providerId, (progress) => {
      this.notifyProgress(progress)
    })
  }

  /**
   * 重建指定目录索引
   */
  async rebuildDirIndex(dirId: string, providerId?: string): Promise<void> {
    const indexManager = KMSIndexManagerService.getInstance()
    await indexManager.rebuildDirIndex(dirId, providerId, (progress) => {
      this.notifyProgress(progress)
    })
  }

  /**
   * 取消索引任务
   */
  cancelIndexing(): void {
    KMSIndexManagerService.getInstance().cancelIndexing()
  }

  // ==================== 统计 ====================

  /**
   * 获取整体统计信息
   */
  getStats(): any {
    const crawler = KMSCrawlerService.getInstance()
    const searchEngine = KMSSearchEngineService.getInstance()

    const fileStats = crawler.getFileStats()
    const indexStats = searchEngine.getIndexStats()
    const dirCount = (this.db.prepare('SELECT COUNT(*) as count FROM kms_index_dirs').get() as any)?.count || 0
    const enabledDirCount = (this.db.prepare('SELECT COUNT(*) as count FROM kms_index_dirs WHERE enabled = 1').get() as any)?.count || 0

    return {
      dirs: { total: dirCount, enabled: enabledDirCount },
      files: fileStats,
      index: indexStats,
    }
  }

  // ==================== KMS 设置 ====================

  /**
   * 获取 KMS 设置（模型配置、检索参数）
   */
  getKmsSettings(): any {
    const mainDb = DatabaseService.getInstance().getDb()
    const result: any = { model: null, embeddingModel: null, searchParams: { maxRounds: 3, topK: 10 } }

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
      const paramsRow = mainDb.prepare("SELECT value FROM settings WHERE key = 'kms_search_params'").get() as any
      if (paramsRow?.value) {
        result.searchParams = { ...result.searchParams, ...JSON.parse(paramsRow.value) }
      }
    } catch {}

    return result
  }

  /**
   * 保存 KMS 设置
   */
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
    if (params.searchParams !== undefined) {
      setSetting('kms_search_params', params.searchParams)
    }
  }

  // ==================== 知识沉淀（摘要查看） ====================

  /**
   * 获取所有目录摘要
   */
  getDirSummaries(): any[] {
    return this.db.prepare(`
      SELECT ds.dir_id, ds.dir_path, ds.summary, ds.file_count, ds.keywords_json, ds.updated_at,
             d.display_name, d.enabled
      FROM kms_dir_summaries ds
      LEFT JOIN kms_index_dirs d ON d.id = ds.dir_id
      ORDER BY ds.updated_at DESC
    `).all() as any[]
  }

  /**
   * 获取文件摘要列表（含冷热状态、轻量摘要、LLM摘要）
   */
  getFileSummaries(params?: { dirId?: string; dataTier?: string; keyword?: string; page?: number; pageSize?: number }): { items: any[]; total: number } {
    const page = params?.page || 1
    const pageSize = params?.pageSize || 20
    const offset = (page - 1) * pageSize

    let whereClause = 'WHERE 1=1'
    const sqlParams: any[] = []

    if (params?.dirId) {
      whereClause += ' AND f.dir_id = ?'
      sqlParams.push(params.dirId)
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
             d.display_name as dir_name
      FROM kms_files f
      LEFT JOIN kms_file_summaries s ON s.file_id = f.id
      LEFT JOIN kms_index_dirs d ON d.id = f.dir_id
      ${whereClause}
      ORDER BY f.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...sqlParams, pageSize, offset) as any[]

    return { items, total }
  }

  // ==================== 进度通知 ====================

  onProgress(listener: (progress: IndexProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  private notifyProgress(progress: IndexProgress): void {
    for (const listener of this.progressListeners) {
      try {
        listener(progress)
      } catch {}
    }
  }
}

export default KMSService
