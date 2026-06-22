import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSCrawlerService from './kms-crawler.service'
import KMSSearchEngineService, { type SearchResult, type SearchOptions } from './kms-search-engine.service'
import KMSIndexManagerService, { type IndexProgress } from './kms-index-manager.service'
import LLMClientService from '../llm-client.service'
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
    if (!require('fs').existsSync(dirPath)) {
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
        const defaultConfig = LLMClientService.getInstance().getDefaultEmbeddingConfig()
        if (defaultConfig) {
          queryEmbedding = await LLMClientService.getInstance().createEmbedding(
            defaultConfig.providerId,
            query,
            defaultConfig.modelName
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
   * 获取文件内容（按段落/偏移/行号定位）
   */
  async getFileContent(fileId: string, options?: { paragraphId?: string; startOffset?: number; endOffset?: number; startLine?: number; maxChars?: number }): Promise<string> {
    const crawler = KMSCrawlerService.getInstance()
    crawler.logFileAccess(fileId, 'read')

    const file = this.db.prepare('SELECT * FROM kms_files WHERE id = ?').get(fileId) as any
    if (!file) throw new Error('File not found')

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
    const crawler = KMSCrawlerService.getInstance()
    crawler.logFileAccess(fileId, 'summary_view')

    return this.db.prepare('SELECT * FROM kms_file_summaries WHERE file_id = ?').get(fileId)
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
