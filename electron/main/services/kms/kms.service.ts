import type Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import KMSDatabaseService from './kms-database.service'
import KMSCrawlerService from './kms-crawler.service'
import KMSSearchEngineService, { type SearchResult, type SearchOptions } from './kms-search-engine.service'
import KMSIndexManagerService, { type IndexProgress, type AutoIndexConfig, type AutoIndexStatus } from './kms-index-manager.service'
import KMSIndexWorkerClientService from './kms-index-worker-client.service'
import KMSAutoIndexService from './kms-auto-index.service'
import KMSSearchHistoryService from './kms-search-history.service'
import KMSFileReaderService from './kms-file-reader.service'
import KMSKeywordStatsService from './kms-keyword-stats.service'
import KMSKnowledgeCardService from './kms-knowledge-card.service'
import KMSStopWordsService from './kms-stop-words.service'
import LLMClientService from '../llm-client.service'
import { generateId, calculateFileHash } from '../common-utils'
import { createLogger } from '../logger'
import {
  getKmsLLMConfig as resolveKmsLLMConfig,
  getKmsSummaryLLMConfig as resolveKmsSummaryLLMConfig,
  getKmsEmbeddingConfig as resolveKmsEmbeddingConfig,
  getKmsSettings as readKmsSettings,
  setKmsSettings as writeKmsSettings,
  type KmsLLMConfig,
  type KmsEmbeddingConfig,
  type KmsSettings,
} from './kms-config-helpers'
import {
  generateCollectionSummary as generateCollectionSummaryViaLLM,
  saveCollectionSummary,
} from './kms-collection-llm-helpers'

const logger = createLogger('KMS')

// embeddedFileIds 缓存：避免每次 getFileSummaries 都全量扫描向量库的 DISTINCT file_id
let _embeddedFileIdsCache: Set<string> | null = null
let _embeddedFileIdsCacheTime = 0
const EMBEDDED_FILE_IDS_CACHE_TTL = 60000

/**
 * KMS 顶层服务（外观模式）
 * 组合爬虫、搜索引擎、索引管理器三个子服务，提供统一的API
 */
class KMSService {
  private db: Database.Database
  private static instance: KMSService
  private progressListeners: Set<(progress: IndexProgress) => void> = new Set()
  /**
   * 进度推送节流：批量索引上千文件时，逐文件/逐段落产生大量进度事件，
   * 直接转发会导致 IPC 消息洪泛 → 主线程事件循环饱和 + 渲染进程 React 频繁重渲染 → UI 卡死。
   *
   * 策略：trailing-edge 节流，间隔 PROGRESS_THROTTLE_MS 内只保留最新一条进度，到点刷新；
   * done/error 等终止阶段立即下发，保证 UI 及时感知完成/取消。
   */
  private static readonly PROGRESS_THROTTLE_MS = 300
  private lastProgressNotifyAt: number = 0
  private pendingProgress: IndexProgress | null = null
  private progressFlushTimer: NodeJS.Timeout | null = null

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
    // 将自动索引进度转发到进度通知通道，供前端感知
    KMSIndexManagerService.getInstance().setAutoIndexProgressCallback((progress) => {
      this.notifyProgress(progress)
    })
    // Worker 客户端的进度回调也转发到统一进度通道
    KMSIndexWorkerClientService.getInstance().setProgressCallback((progress) => {
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

    // 兼容 Windows 大小写不敏感：先按原路径查，再用归一化路径查
    const existing = this.db.prepare(
      'SELECT * FROM kms_index_dirs WHERE dir_path = ? OR LOWER(dir_path) = LOWER(?)'
    ).get(dirPath, dirPath) as any

    if (existing) {
      // 已存在相同目录，更新可修改字段并返回
      this.db.prepare(`
        UPDATE kms_index_dirs
        SET display_name = ?, recursive = ?, file_extensions = ?, updated_at = unixepoch()
        WHERE id = ?
      `).run(
        displayName || existing.display_name,
        recursive !== undefined ? (recursive ? 1 : 0) : existing.recursive,
        fileExtensions?.join(',') || existing.file_extensions,
        existing.id
      )
      return this.getIndexDir(existing.id)
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

  /**
   * 删除索引目录（轻量操作，不阻塞 UI）。
   *
   * 分类处理该目录下的文件：
   * - 仍属于至少一个合集的文件：迁移到虚拟手动目录（保留索引与文件记录）
   * - 不属于任何合集的文件：仅删除 kms_files 记录，不清理 FTS5 / 向量库
   *
   * 搜索已 JOIN kms_files，删除文件记录后搜索结果自动排除。
   * 残留的 FTS5 / embedding 孤儿记录可通过「设置 > 数据库清理」回收空间。
   *
   * 旧实现逐文件清理 FTS5 + 向量库导致 1000+ 文件目录卡死主线程。
   */
  deleteIndexDir(id: string): { migrated: number; removed: number } {
    const searchEngine = KMSSearchEngineService.getInstance()

    // 1. 收集该目录下所有文件 ID
    const files = this.db.prepare('SELECT id FROM kms_files WHERE dir_id = ?').all(id) as any[]
    if (files.length === 0) {
      this.db.prepare('DELETE FROM kms_index_dirs WHERE id = ?').run(id)
      searchEngine.invalidateCache()
      return { migrated: 0, removed: 0 }
    }
    const allFileIds = files.map(f => f.id)

    // 2. 仅查询本目录内属于合集的文件（避免全表扫描）
    const inCollectionSet = new Set<string>()
    for (let i = 0; i < allFileIds.length; i += 500) {
      const batch = allFileIds.slice(i, i + 500)
      const placeholders = batch.map(() => '?').join(',')
      const rows = this.db.prepare(
        `SELECT DISTINCT file_id FROM kms_file_collections WHERE file_id IN (${placeholders})`
      ).all(...batch) as any[]
      for (const r of rows) inCollectionSet.add(r.file_id)
    }

    const toMigrate = allFileIds.filter(fid => inCollectionSet.has(fid))
    const toRemove = allFileIds.filter(fid => !inCollectionSet.has(fid))

    // 3. 全部操作在单一事务中完成（轻量 UPDATE / DELETE，不碰 FTS5 / 向量库）
    const tx = this.db.transaction(() => {
      // 迁移合集文件到虚拟手动目录
      if (toMigrate.length > 0 && this.manualSourceDirId) {
        for (let i = 0; i < toMigrate.length; i += 500) {
          const batch = toMigrate.slice(i, i + 500)
          const placeholders = batch.map(() => '?').join(',')
          this.db.prepare(
            `UPDATE kms_files SET dir_id = ? WHERE id IN (${placeholders})`
          ).run(this.manualSourceDirId, ...batch)
        }
      }

      // 删除非合集文件记录（FTS5 / embedding 孤儿留给数据库清理）
      for (let i = 0; i < toRemove.length; i += 500) {
        const batch = toRemove.slice(i, i + 500)
        const placeholders = batch.map(() => '?').join(',')
        this.db.prepare(`DELETE FROM kms_search_index WHERE file_id IN (${placeholders})`).run(...batch)
        this.db.prepare(`DELETE FROM kms_paragraphs WHERE file_id IN (${placeholders})`).run(...batch)
        this.db.prepare(`DELETE FROM kms_files WHERE id IN (${placeholders})`).run(...batch)
      }

      // 删除目录记录
      this.db.prepare('DELETE FROM kms_index_dirs WHERE id = ?').run(id)
    })
    tx()

    searchEngine.invalidateCache()

    logger.info(
      `删除索引目录 ${id}：迁移 ${toMigrate.length} 个文件到手动目录，移除 ${toRemove.length} 个文件记录（FTS5/向量库孤儿待清理）`
    )

    return { migrated: toMigrate.length, removed: toRemove.length }
  }

  getIndexDir(id: string): any {
    return this.db.prepare('SELECT * FROM kms_index_dirs WHERE id = ?').get(id)
  }

  listIndexDirs(): any[] {
    return this.db.prepare(
      `SELECT d.*,
        (SELECT COUNT(*) FROM kms_files f WHERE f.dir_id = d.id) as file_count
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
    // 1. 收集该合集下的所有文件 ID（删除合集后级联会清除 kms_file_collections，需提前收集）
    const collectionFiles = this.db.prepare(
      'SELECT file_id FROM kms_file_collections WHERE collection_id = ?'
    ).all(id) as any[]

    // 2. 删除合集（级联删除 kms_file_collections、kms_collection_summaries）
    this.db.prepare('DELETE FROM kms_collections WHERE id = ?').run(id)

    // 3. 清理游离文件：不再属于任何合集、且位于虚拟手动目录的文件
    this.cleanupOrphanFiles(collectionFiles.map(f => f.file_id))

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

    // 跳过 Office/WPS 临时锁文件（如 ~$test.docx、.~test.docx）
    if (fileName.startsWith('~$') || fileName.startsWith('.~')) {
      throw new Error(`不支持添加 Office/WPS 临时文件: ${fileName}`)
    }

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
    // 通过 Worker 客户端路由，让索引在 Worker 线程执行避免阻塞 UI
    if (changed) {
      this.incrementalIndex().catch((err: any) => {
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
   * 从合集中移除文件
   * 若该文件不再属于任何合集且仅存在于虚拟手动目录，则彻底清理
   */
  removeFileFromCollection(collectionId: string, fileId: string): void {
    this.db.prepare(
      'DELETE FROM kms_file_collections WHERE file_id = ? AND collection_id = ?'
    ).run(fileId, collectionId)
    this.db.prepare('UPDATE kms_collections SET updated_at = unixepoch() WHERE id = ?').run(collectionId)

    // 清理游离文件：该文件不再属于任何合集、且位于虚拟手动目录时删除
    this.cleanupOrphanFiles([fileId])

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
             COALESCE(s.main_topics_json, '[]') as main_topics_json,
             CASE WHEN f.data_tier = 'hot' AND COALESCE(s.summary, '') != '' THEN 1 ELSE 0 END as deep_processed
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

    // 深度处理完成数：data_tier='hot' 且有 LLM 摘要
    const deepProcessedCount = (this.db.prepare(`
      SELECT COUNT(*) as count FROM kms_file_collections fc
      JOIN kms_files f ON fc.file_id = f.id
      LEFT JOIN kms_file_summaries s ON s.file_id = f.id
      WHERE fc.collection_id = ? AND f.data_tier = 'hot' AND COALESCE(s.summary, '') != ''
    `).get(collectionId) as any)?.count || 0

    const hasSummary = !!this.db.prepare(
      'SELECT 1 FROM kms_collection_summaries WHERE collection_id = ?'
    ).get(collectionId)

    return {
      fileCount,
      indexedCount,
      hotCount,
      pendingCount,
      deepProcessedCount,
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

  /**
   * 按自然语言 query 搜索合集摘要（LIKE 模糊匹配 summary + key_topics_json）
   * 用于 kms_search 工具内部附加搜索合集摘要内容，无需向量索引
   * 返回合集元数据 + 摘要 + 主题
   */
  searchCollectionSummaries(query: string, topK: number = 3): Array<{
    collectionId: string
    collectionName: string
    description: string
    summary: string
    keyTopics: string[]
    fileCount: number
  }> {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []

    // 关键词拆分（与搜索引擎一致：空格 + 中英文边界）
    const words = normalized.split(/\s+/).filter(s => s.length > 0)
    if (words.length === 0) return []

    // 一次性 JOIN 查询：合集摘要 + 合集元数据 + 文件计数
    const rows = this.db.prepare(`
      SELECT cs.collection_id, cs.summary, cs.key_topics_json,
             c.name, c.description,
             (SELECT COUNT(*) FROM kms_file_collections fc WHERE fc.collection_id = c.id) AS file_count
      FROM kms_collection_summaries cs
      JOIN kms_collections c ON cs.collection_id = c.id
    `).all() as any[]

    if (rows.length === 0) return []

    const scored = rows.map(row => {
      const summary = (row.summary || '').toLowerCase()
      const topics = (() => { try { const arr = JSON.parse(row.key_topics_json || '[]'); return Array.isArray(arr) ? arr : [] } catch { return [] } })()
      const topicsText = topics.join(' ').toLowerCase()
      const name = (row.name || '').toLowerCase()
      const desc = (row.description || '').toLowerCase()

      const haystack = `${name} ${desc} ${summary} ${topicsText}`
      let score = 0
      let matchCount = 0
      for (const word of words) {
        if (haystack.includes(word)) {
          score += word.length * 2
          matchCount++
        }
      }
      const matchRatio = matchCount / words.length
      return { row, score: score * (0.5 + matchRatio * 0.5), topics }
    }).filter(s => s.score > 0)

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK).map(s => ({
      collectionId: s.row.collection_id,
      collectionName: s.row.name,
      description: s.row.description || '',
      summary: s.row.summary || '',
      keyTopics: s.topics,
      fileCount: s.row.file_count || 0,
    }))
  }

  setCollectionSummary(collectionId: string, summary: string, keyTopics: string[] = []): void {
    saveCollectionSummary(this.db, collectionId, summary, keyTopics)
  }

  deleteCollectionSummary(collectionId: string): void {
    this.db.prepare('DELETE FROM kms_collection_summaries WHERE collection_id = ?').run(collectionId)
  }

  /**
   * 清理游离文件：不再属于任何合集、且仅存在于虚拟手动目录的文件
   *
   * 背景：合集中的文件若不在任何索引目录下，其 dir_id 指向虚拟目录 __manual_files__。
   * 删除合集或从合集中移除文件时，如果该文件不再属于任何合集，则它已无实际归属，
   * 应从 kms_files、FTS5、embedding 等表中彻底清理，避免"幽灵文件"出现在搜索结果中。
   *
   * @param candidateFileIds 候选文件 ID 列表（通常是刚被解除合集关联的文件）
   */
  private cleanupOrphanFiles(candidateFileIds: string[]): void {
    if (candidateFileIds.length === 0 || !this.manualSourceDirId) return

    const searchEngine = KMSSearchEngineService.getInstance()

    for (const fileId of candidateFileIds) {
      // 检查文件是否仍在虚拟手动目录中（如果 dir_id 指向真实索引目录，则不算游离文件）
      const file = this.db.prepare(
        'SELECT dir_id FROM kms_files WHERE id = ?'
      ).get(fileId) as any
      if (!file || file.dir_id !== this.manualSourceDirId) continue

      // 检查该文件是否仍属于至少一个合集
      const stillInCollection = this.db.prepare(
        'SELECT 1 FROM kms_file_collections WHERE file_id = ? LIMIT 1'
      ).get(fileId)
      if (stillInCollection) continue

      // 游离文件：显式清理 FTS5、向量库，然后删除文件记录
      searchEngine.deleteIndexByFile(fileId)
      this.db.prepare('DELETE FROM kms_files WHERE id = ?').run(fileId)
      logger.info(`已清理游离文件: ${fileId}`)
    }
  }

  async generateCollectionSummary(collectionId: string, signal?: AbortSignal): Promise<{ summary: string; keyTopics: string[] } | { error: string }> {
    const llmConfig = this.getKmsSummaryLLMConfig()
    if (!llmConfig) {
      return { error: 'NO_LLM_PROVIDER' }
    }

    const result = await generateCollectionSummaryViaLLM(this.db, collectionId, llmConfig, signal)
    if ('summary' in result && result.summary) {
      this.setCollectionSummary(collectionId, result.summary, result.keyTopics)
    }
    return result
  }

  getKmsLLMConfigPublic(): KmsLLMConfig | null {
    return this.getKmsLLMConfig()
  }

  getKmsSummaryLLMConfigPublic(): KmsLLMConfig | null {
    return this.getKmsSummaryLLMConfig()
  }

  getKmsEmbeddingConfigPublic(): KmsEmbeddingConfig | null {
    return this.getKmsEmbeddingConfig()
  }

  private getKmsLLMConfig(): KmsLLMConfig | null {
    return resolveKmsLLMConfig()
  }

  getKmsSummaryLLMConfig(): KmsLLMConfig | null {
    return resolveKmsSummaryLLMConfig()
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
      SELECT f.id as file_id, f.file_name, f.file_path, f.file_name as text, 'file_name' as match_type, f.modified_time as modified_time
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
      // 前端传入毫秒，modified_time 存储为 unix 秒
      params.push(Math.floor(options.timeRangeStart / 1000))
    }

    if (options?.timeRangeEnd !== undefined) {
      sql += ' AND f.modified_time <= ?'
      // 前端传入毫秒，modified_time 存储为 unix 秒
      params.push(Math.floor(options.timeRangeEnd / 1000))
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
    // 前端传入的 timeRangeStart/End 为毫秒，kms_files.modified_time 存储为 unix 秒，
    // 此处统一转换为秒，与 searchFiles 保持一致
    const normalizedOptions = options
      ? {
          ...options,
          timeRangeStart: options.timeRangeStart !== undefined ? Math.floor(options.timeRangeStart / 1000) : undefined,
          timeRangeEnd: options.timeRangeEnd !== undefined ? Math.floor(options.timeRangeEnd / 1000) : undefined,
        }
      : options
    const results = searchEngine.search(query, queryEmbedding, normalizedOptions)
    logger.info(`search engine returned ${results.length} results in ${Date.now() - searchStart}ms`)

    // 批量记录搜索命中（仅取排名靠前的有限条，避免 resultLimit 过大时大量低相关结果被计入命中计数）
    const hitFileIds = [...new Set(results.slice(0, 10).map(r => r.file_id).filter(Boolean))]
    if (hitFileIds.length > 0) {
      const crawler = KMSCrawlerService.getInstance()
      crawler.logFileAccessBatch(hitFileIds, 'search_hit')
    }

    // 记录关键词搜索频次（用于热点词检测与知识卡片自动沉淀）
    KMSKeywordStatsService.getInstance().incrementKeywordStat(query, hitFileIds)

    // 搜索后异步触发冷热数据评估（去抖，5分钟内不重复）
    // 高频命中的冷文件会自动晋升为热文件，并触发 file2md 重新解析 + LLM 摘要生成
    // 同时评估知识卡片：热点词达到阈值时自动沉淀卡片，过期卡片自动刷新
    this.evaluateAndPromote(false).catch((err: any) => {
      logger.warn('Post-search evaluateAndPromote failed:', err?.message || err)
    })
    KMSKnowledgeCardService.getInstance().evaluateCards(false).catch((err: any) => {
      logger.warn('Post-search evaluateCards failed:', err?.message || err)
    })

    logger.info(`search "${query}" total: ${results.length} results, ${Date.now() - startTime}ms`)
    return results
  }

  /**
   * 评估冷热数据层级，并对晋升的冷文件自动执行热数据处理
   *
   * 委托至 KMSIndexManagerService.evaluateAndPromote，供搜索流程（普通搜索 & AI 智能检索）
   * 在记录命中后统一触发冷热晋升评估。
   *
   * @param force 是否强制评估（忽略去抖间隔）。索引流程结束后传 true；
   *              搜索触发的评估传 false，受 MIN_EVALUATION_INTERVAL_MS 去抖控制
   */
  async evaluateAndPromote(force: boolean = false): Promise<void> {
    await KMSIndexManagerService.getInstance().evaluateAndPromote(force)
    // 索引流程结束后（force=true）同步评估知识卡片：刷新过期卡片 + 归档旧卡片
    if (force) {
      KMSKnowledgeCardService.getInstance().evaluateCards(true).catch((err: any) => {
        logger.warn('Post-index evaluateCards failed:', err?.message || err)
      })
    }
  }

  private getKmsEmbeddingConfig(): KmsEmbeddingConfig | null {
    return resolveKmsEmbeddingConfig()
  }

  async getFileContent(fileId: string, options?: { paragraphId?: string; startOffset?: number; endOffset?: number; startLine?: number; maxChars?: number }): Promise<string> {
    return KMSFileReaderService.getInstance().getFileContent(fileId, options)
  }

  getFileSummary(fileId: string): any {
    return KMSFileReaderService.getInstance().getFileSummary(fileId)
  }

  async getFileFullContent(fileId: string): Promise<{ content: string; fileName: string; filePath: string; truncated: boolean }> {
    return KMSFileReaderService.getInstance().getFileFullContent(fileId)
  }

  async buildFullIndex(providerId?: string, withEmbedding: boolean = true, resetHotData: boolean = false): Promise<void> {
    if (!providerId) {
      const llmConfig = this.getKmsLLMConfig()
      providerId = llmConfig?.providerId
    }
    const workerClient = KMSIndexWorkerClientService.getInstance()
    await workerClient.runTask(
      'buildFull',
      [providerId, withEmbedding, resetHotData],
      async () => {
        const indexManager = KMSIndexManagerService.getInstance()
        await indexManager.buildFullIndex(providerId, (progress) => {
          this.notifyProgress(progress)
        }, withEmbedding, resetHotData)
      },
    )
  }

  async incrementalIndex(providerId?: string, withEmbedding: boolean = true): Promise<void> {
    if (!providerId) {
      const llmConfig = this.getKmsLLMConfig()
      providerId = llmConfig?.providerId
    }
    const workerClient = KMSIndexWorkerClientService.getInstance()
    await workerClient.runTask(
      'incremental',
      [providerId, withEmbedding],
      async () => {
        const indexManager = KMSIndexManagerService.getInstance()
        await indexManager.incrementalIndex(providerId, (progress) => {
          this.notifyProgress(progress)
        }, withEmbedding)
      },
    )
  }

  async rebuildDirIndex(dirId: string, providerId?: string, withEmbedding: boolean = true, resetHotData: boolean = false): Promise<void> {
    if (!providerId) {
      const llmConfig = this.getKmsLLMConfig()
      providerId = llmConfig?.providerId
    }
    const workerClient = KMSIndexWorkerClientService.getInstance()
    await workerClient.runTask(
      'rebuildDir',
      [dirId, providerId, withEmbedding, resetHotData],
      async () => {
        const indexManager = KMSIndexManagerService.getInstance()
        await indexManager.rebuildDirIndex(dirId, providerId, (progress) => {
          this.notifyProgress(progress)
        }, withEmbedding, resetHotData)
      },
    )
  }

  async processCollectionDeep(collectionId: string, incremental: boolean = true): Promise<{ fileProcessed: number; summaryGenerated: boolean; embeddingGenerated: boolean; error?: string }> {
    const workerClient = KMSIndexWorkerClientService.getInstance()
    return await workerClient.runTask(
      'processCollectionDeep',
      [collectionId, incremental],
      async () => {
        const indexManager = KMSIndexManagerService.getInstance()
        return await indexManager.processCollectionDeep(collectionId, (progress) => {
          this.notifyProgress(progress)
        }, incremental)
      },
    )
  }

  async processSingleFileDeep(fileId: string, collectionId?: string): Promise<{ success: boolean; error?: string }> {
    const workerClient = KMSIndexWorkerClientService.getInstance()
    return await workerClient.runTask(
      'processSingleFileDeep',
      [fileId, collectionId],
      async () => {
        const indexManager = KMSIndexManagerService.getInstance()
        return await indexManager.processSingleFileDeep(fileId, collectionId, (progress) => {
          this.notifyProgress(progress)
        })
      },
    )
  }

  cancelSingleFileDeepProcess(): void {
    KMSIndexWorkerClientService.getInstance().cancelCollectionDeepProcess()
    KMSIndexManagerService.getInstance().cancelCollectionDeepProcess()
  }

  cancelCollectionDeepProcess(): void {
    // 优先取消 Worker 中的任务；同时取消主线程降级路径（如果有）
    KMSIndexWorkerClientService.getInstance().cancelCollectionDeepProcess()
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
      // 异步触发增量索引（通过 Worker 路由，避免阻塞 UI）
      this.incrementalIndex().catch((err: any) => {
        logger.error('Auto incrementalIndex after file rebuild failed:', err?.message || err)
      })
      return { success: true }
    } catch (err: any) {
      logger.error('rebuildFileIndex failed:', err?.message || err)
      return { success: false, error: err?.message || 'UNKNOWN' }
    }
  }

  cancelIndexing(): void {
    // 优先取消 Worker 中的任务；同时取消主线程降级路径（如果有）
    KMSIndexWorkerClientService.getInstance().cancelIndexing()
    KMSIndexManagerService.getInstance().cancelIndexing()
    // 同步取消自动索引检查（"立即检查" 触发的索引任务有独立的 AbortController）
    KMSAutoIndexService.getInstance().cancelCurrentRun()
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

  getDatabaseStats(): any {
    return KMSDatabaseService.getInstance().getDatabaseStats()
  }

  cleanupDatabase(): any {
    const result = KMSDatabaseService.getInstance().cleanupDatabase()
    // 清理后缓存可能失效，主动刷新
    KMSSearchEngineService.getInstance().invalidateCache()
    return result
  }

  getKmsSettings(): KmsSettings {
    return readKmsSettings()
  }

  setKmsSettings(params: any): void {
    writeKmsSettings(params)
    if (params.autoIndex !== undefined) {
      const config: AutoIndexConfig = {
        enabled: !!params.autoIndex.enabled,
        intervalMinutes: Math.max(1, Math.min(1440, params.autoIndex.intervalMinutes ?? 1)),
        stableThresholdMinutes: Math.max(0, Math.min(1440, params.autoIndex.stableThresholdMinutes ?? 5)),
      }
      KMSIndexManagerService.getInstance().startAutoIndex(config)
    }
  }

  initAutoIndex(): void {
    const settings = this.getKmsSettings()
    const config: AutoIndexConfig = settings.autoIndex || { enabled: false, intervalMinutes: 1, stableThresholdMinutes: 5 }
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

  getFileSummaries(params?: { dirId?: string; collectionId?: string; dataTier?: string; indexStatus?: string; keyword?: string; page?: number; pageSize?: number }): { items: any[]; total: number } {
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
    if (params?.indexStatus) {
      whereClause += ' AND f.index_status = ?'
      sqlParams.push(params.indexStatus)
    }
    if (params?.keyword) {
      whereClause += ' AND (f.file_name LIKE ? OR s.light_summary LIKE ? OR s.summary LIKE ?)'
      const kw = `%${params.keyword}%`
      sqlParams.push(kw, kw, kw)
    }

    const total = (this.db.prepare(
      `SELECT COUNT(*) as count FROM kms_files f LEFT JOIN kms_file_summaries s ON s.file_id = f.id ${whereClause}`
    ).get(...sqlParams) as any)?.count || 0

    // kms_embeddings 已迁移到独立的向量库，跨库无法 JOIN/EXISTS。
    // 先从向量库加载所有有 embedding 的 file_id 集合，再在应用层标记 has_embedding。
    // 使用 60 秒 TTL 缓存避免每次翻页都全量扫描向量库。
    const vectorDb = KMSDatabaseService.getInstance().getVectorDb()
    let embeddedFileIds: Set<string>
    if (_embeddedFileIdsCache && Date.now() - _embeddedFileIdsCacheTime < EMBEDDED_FILE_IDS_CACHE_TTL) {
      embeddedFileIds = _embeddedFileIdsCache
    } else {
      embeddedFileIds = new Set()
      try {
        const rows = vectorDb.prepare('SELECT DISTINCT file_id FROM kms_embeddings').all() as any[]
        embeddedFileIds = new Set(rows.map(r => r.file_id))
        _embeddedFileIdsCache = embeddedFileIds
        _embeddedFileIdsCacheTime = Date.now()
      } catch (err: any) {
        logger.warn('加载向量库 file_id 集合失败:', err?.message || err)
      }
    }

    const items = this.db.prepare(`
      SELECT f.id, f.file_name, f.file_path, f.file_ext, f.file_size, f.data_tier,
             f.index_status, f.modified_time, f.updated_at,
             COALESCE(s.summary, '') as summary,
             COALESCE(s.light_summary, '') as light_summary,
             COALESCE(s.preview_text, '') as preview_text,
             COALESCE(s.keywords_json, '[]') as keywords_json,
             COALESCE(s.main_topics_json, '[]') as main_topics_json,
             d.display_name as dir_name,
             d.dir_path as dir_path
      FROM kms_files f
      LEFT JOIN kms_file_summaries s ON s.file_id = f.id
      LEFT JOIN kms_index_dirs d ON d.id = f.dir_id
      ${whereClause}
      ORDER BY f.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...sqlParams, pageSize, offset) as any[]

    for (const item of items) {
      item.has_embedding = embeddedFileIds.has(item.id) ? 1 : 0
    }

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

  // ==================== 知识卡片 ====================

  getKeywordStats(params?: { limit?: number; minCount?: number; recentDays?: number }): any[] {
    return KMSKeywordStatsService.getInstance().getKeywordStats(params)
  }

  getKnowledgeCards(params?: {
    status?: 'active' | 'stale' | 'archived' | 'disabled'
    keyword?: string
    pinnedOnly?: boolean
    limit?: number
    offset?: number
  }): { cards: any[]; total: number } {
    return KMSKnowledgeCardService.getInstance().listCards(params)
  }

  getKnowledgeCard(id: string): any | null {
    return KMSKnowledgeCardService.getInstance().getCard(id)
  }

  async generateKnowledgeCard(keyword: string, displayKeyword?: string, options?: { onProgress?: (step: any) => void }): Promise<{ success: boolean; card?: any; error?: string }> {
    return KMSKnowledgeCardService.getInstance().generateCard(keyword, displayKeyword, options)
  }

  async refreshKnowledgeCard(id: string, signal?: AbortSignal, options?: { onProgress?: (step: any) => void }): Promise<{ success: boolean; card?: any; error?: string }> {
    return KMSKnowledgeCardService.getInstance().refreshCard(id, signal, options)
  }

  updateKnowledgeCard(params: { id: string; summary?: string; keyPoints?: any[]; pinned?: boolean }): { success: boolean; error?: string } {
    return KMSKnowledgeCardService.getInstance().updateCard(params)
  }

  deleteKnowledgeCard(id: string): void {
    KMSKnowledgeCardService.getInstance().deleteCard(id)
  }

  disableKnowledgeCard(id: string): void {
    KMSKnowledgeCardService.getInstance().disableCard(id)
  }

  enableKnowledgeCard(id: string): void {
    KMSKnowledgeCardService.getInstance().enableCard(id)
  }

  pinKnowledgeCard(id: string, pinned: boolean): void {
    KMSKnowledgeCardService.getInstance().pinCard(id, pinned)
  }

  async searchKnowledgeCards(query: string, topK?: number): Promise<any[]> {
    return KMSKnowledgeCardService.getInstance().searchCards(query, topK || 3)
  }

  // ==================== 停用词管理 ====================

  getStopWords(params?: { source?: 'manual' | 'auto_idf'; limit?: number; offset?: number }): { words: any[]; total: number } {
    return KMSStopWordsService.getInstance().listStopWords(params)
  }

  addStopWord(word: string): { success: boolean; error?: string } {
    return KMSStopWordsService.getInstance().addStopWord(word, 'manual')
  }

  deleteStopWord(id: string): void {
    KMSStopWordsService.getInstance().deleteStopWord(id)
  }

  clearAutoStopWords(): number {
    return KMSStopWordsService.getInstance().clearAutoStopWords()
  }

  onProgress(listener: (progress: IndexProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  /**
   * 推送一条错误进度到前端。
   * 用于 fire-and-forget IPC（ipcMain.on）在操作失败时通知 UI，
   * 避免 release 下错误被静默吞掉导致界面永久卡在"索引中"。
   */
  notifyIndexError(message: string, extras?: Partial<IndexProgress>): void {
    this.notifyProgress({
      phase: 'error',
      current: 0,
      total: 0,
      message,
      ...extras,
    })
  }

  private notifyProgress(progress: IndexProgress): void {
    const isTerminal = progress.phase === 'done' || progress.phase === 'error'

    if (isTerminal) {
      // 终止阶段：取消待刷定时器，立即下发，保证 UI 及时感知完成/取消/错误
      if (this.progressFlushTimer) {
        clearTimeout(this.progressFlushTimer)
        this.progressFlushTimer = null
      }
      this.pendingProgress = null
      this.lastProgressNotifyAt = Date.now()
      this.dispatchProgress(progress)
      return
    }

    const now = Date.now()
    if (now - this.lastProgressNotifyAt >= KMSService.PROGRESS_THROTTLE_MS) {
      // 已过节流窗口：立即下发
      if (this.progressFlushTimer) {
        clearTimeout(this.progressFlushTimer)
        this.progressFlushTimer = null
      }
      this.pendingProgress = null
      this.lastProgressNotifyAt = now
      this.dispatchProgress(progress)
    } else {
      // 节流窗口内：缓存最新进度，安排定时刷新（只保留一个 timer）
      this.pendingProgress = progress
      if (!this.progressFlushTimer) {
        const delay = KMSService.PROGRESS_THROTTLE_MS - (now - this.lastProgressNotifyAt)
        this.progressFlushTimer = setTimeout(() => {
          this.progressFlushTimer = null
          if (this.pendingProgress) {
            const pending = this.pendingProgress
            this.pendingProgress = null
            this.lastProgressNotifyAt = Date.now()
            this.dispatchProgress(pending)
          }
        }, Math.max(50, delay))
      }
    }
  }

  private dispatchProgress(progress: IndexProgress): void {
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
