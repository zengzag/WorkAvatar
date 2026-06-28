import fs from 'fs'
import path from 'path'
import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSSearchEngineService from './kms-search-engine.service'
import { generateId, calculateFileHash } from '../common-utils'
import { createLogger } from '../logger'

const logger = createLogger('KMS-Crawler')

/** 支持的文件扩展名 */
const SUPPORTED_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xlsx', 'xls', 'csv', 'pptx',
  'txt', 'md', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'
])

/** 需要跳过的目录名 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  '__pycache__', '.DS_Store', 'Thumbs.db',
  '.vscode', '.idea', '.trae',
  'dist', 'build', 'out', 'target',
])

export interface CrawlResult {
  totalFiles: number
  newFiles: number
  modifiedFiles: number
  deletedFiles: number
  unchangedFiles: number
  /** 因稳定阈值跳过的文件数（文件最近被修改，尚未稳定） */
  skippedUnstableFiles: number
}

export interface CrawlOptions {
  /** 文件稳定阈值（秒）：修改时间距今不足该值的文件视为"尚未稳定"，跳过不索引，避免用户正在编辑时频繁更新 */
  stableThresholdSeconds?: number
}

export interface FileEntry {
  id: string
  dirId: string
  filePath: string
  fileName: string
  fileExt: string
  fileSize: number
  fileHash: string
  modifiedTime: number
  indexStatus: string
  dataTier: string
}

/**
 * KMS 目录爬虫服务
 * 负责扫描索引目录、检测文件变更、管理文件注册表
 */
class KMSCrawlerService {
  private db: Database.Database
  private static instance: KMSCrawlerService

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSCrawlerService {
    if (!KMSCrawlerService.instance) {
      KMSCrawlerService.instance = new KMSCrawlerService()
    }
    return KMSCrawlerService.instance
  }

  /**
   * 扫描指定索引目录，检测文件变更
   * @param stableThresholdSeconds 文件稳定阈值（秒）：修改时间距今不足该值的文件视为"尚未稳定"，跳过不索引
   */
  async crawlDirectory(dirId: string, signal?: AbortSignal, options?: CrawlOptions): Promise<CrawlResult> {
    const dirRow = this.db.prepare('SELECT * FROM kms_index_dirs WHERE id = ? AND enabled = 1').get(dirId) as any
    if (!dirRow) {
      throw new Error(`Index directory not found or disabled: ${dirId}`)
    }

    const dirPath = dirRow.dir_path
    const recursive = dirRow.recursive === 1
    const extensions = dirRow.file_extensions
      ? dirRow.file_extensions.split(',').map((e: string) => e.trim().toLowerCase()).filter(Boolean)
      : []

    if (!fs.existsSync(dirPath)) {
      throw new Error(`Directory does not exist: ${dirPath}`)
    }

    const stableThreshold = options?.stableThresholdSeconds ?? 0
    const now = Math.floor(Date.now() / 1000)

    // 收集磁盘上的文件
    const diskFiles = this.scanDiskFiles(dirPath, recursive, extensions, signal)

    // 获取数据库中该目录的已注册文件
    const dbFiles = this.db.prepare('SELECT * FROM kms_files WHERE dir_id = ?').all(dirId) as any[]
    const dbFileMap = new Map(dbFiles.map(f => [f.file_path, f]))

    const result: CrawlResult = {
      totalFiles: diskFiles.length,
      newFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      unchangedFiles: 0,
      skippedUnstableFiles: 0,
    }

    const diskPathSet = new Set(diskFiles.map(f => f.filePath))

    // 检测新增和修改的文件
    for (const diskFile of diskFiles) {
      if (signal?.aborted) break

      const dbFile = dbFileMap.get(diskFile.filePath)
      if (!dbFile) {
        // 新文件
        await this.registerFile(dirId, diskFile)
        result.newFiles++
      } else if (diskFile.modifiedTime > dbFile.modified_time || diskFile.fileSize !== dbFile.file_size) {
        // 可能修改的文件 - 先检查稳定阈值
        // 如果文件最近被修改（距今不足稳定阈值），跳过以避免用户正在编辑时频繁更新
        if (stableThreshold > 0 && (now - diskFile.modifiedTime) < stableThreshold) {
          result.skippedUnstableFiles++
          continue
        }

        // 需要计算hash确认是否真的修改
        const newHash = await calculateFileHash(diskFile.filePath)
        if (newHash !== dbFile.file_hash) {
          this.updateFileHash(dbFile.id, newHash, diskFile.modifiedTime, diskFile.fileSize)
          result.modifiedFiles++
        } else {
          result.unchangedFiles++
        }
      } else {
        result.unchangedFiles++
      }
    }

    // 检测已删除的文件
    for (const dbFile of dbFiles) {
      if (!diskPathSet.has(dbFile.file_path)) {
        this.unregisterFile(dbFile.id)
        result.deletedFiles++
      }
    }

    logger.info(`Crawled "${dirPath}": ${result.newFiles} new, ${result.modifiedFiles} modified, ${result.deletedFiles} deleted, ${result.unchangedFiles} unchanged, ${result.skippedUnstableFiles} skipped(unstable)`)
    return result
  }

  /**
   * 扫描所有启用的索引目录
   */
  async crawlAllDirectories(signal?: AbortSignal, options?: CrawlOptions): Promise<CrawlResult> {
    const dirs = this.db.prepare('SELECT * FROM kms_index_dirs WHERE enabled = 1').all() as any[]
    const totalResult: CrawlResult = {
      totalFiles: 0,
      newFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      unchangedFiles: 0,
      skippedUnstableFiles: 0,
    }

    for (const dir of dirs) {
      if (signal?.aborted) break
      try {
        const result = await this.crawlDirectory(dir.id, signal, options)
        totalResult.totalFiles += result.totalFiles
        totalResult.newFiles += result.newFiles
        totalResult.modifiedFiles += result.modifiedFiles
        totalResult.deletedFiles += result.deletedFiles
        totalResult.unchangedFiles += result.unchangedFiles
        totalResult.skippedUnstableFiles += result.skippedUnstableFiles
      } catch (err) {
        logger.error(`Failed to crawl directory "${dir.dir_path}":`, err)
      }
    }

    return totalResult
  }

  /**
   * 获取需要索引的文件列表（status=pending 或 modified）
   */
  getPendingFiles(): FileEntry[] {
    const rows = this.db.prepare(`
      SELECT f.*, d.dir_path
      FROM kms_files f
      JOIN kms_index_dirs d ON f.dir_id = d.id
      WHERE f.index_status IN ('pending', 'modified')
      ORDER BY f.updated_at ASC
    `).all() as any[]

    return rows.map(r => ({
      id: r.id,
      dirId: r.dir_id,
      filePath: r.file_path,
      fileName: r.file_name,
      fileExt: r.file_ext,
      fileSize: r.file_size,
      fileHash: r.file_hash,
      modifiedTime: r.modified_time,
      indexStatus: r.index_status,
      dataTier: r.data_tier,
    }))
  }

  /**
   * 获取指定目录下的所有文件
   */
  getFilesByDir(dirId: string): FileEntry[] {
    const rows = this.db.prepare('SELECT * FROM kms_files WHERE dir_id = ?').all(dirId) as any[]
    return rows.map(r => ({
      id: r.id,
      dirId: r.dir_id,
      filePath: r.file_path,
      fileName: r.file_name,
      fileExt: r.file_ext,
      fileSize: r.file_size,
      fileHash: r.file_hash,
      modifiedTime: r.modified_time,
      indexStatus: r.index_status,
      dataTier: r.data_tier,
    }))
  }

  /**
   * 更新文件索引状态
   */
  updateFileStatus(fileId: string, status: string, error?: string): void {
    if (error) {
      this.db.prepare('UPDATE kms_files SET index_status = ?, parse_error = ?, updated_at = unixepoch() WHERE id = ?')
        .run(status, error, fileId)
    } else {
      this.db.prepare('UPDATE kms_files SET index_status = ?, parse_error = NULL, updated_at = unixepoch() WHERE id = ?')
        .run(status, fileId)
    }
  }

  /**
   * 更新文件数据层级（冷/热）
   */
  updateFileDataTier(fileId: string, tier: 'cold' | 'hot'): void {
    this.db.prepare('UPDATE kms_files SET data_tier = ?, updated_at = unixepoch() WHERE id = ?')
      .run(tier, fileId)
  }

  /**
   * 记录文件访问
   */
  logFileAccess(fileId: string, accessType: 'search_hit' | 'read' | 'summary_view'): void {
    // 先检查文件是否存在，避免外键约束失败
    const exists = this.db.prepare('SELECT 1 FROM kms_files WHERE id = ?').get(fileId)
    if (!exists) return

    const id = generateId()
    this.db.prepare(
      'INSERT INTO kms_access_log (id, file_id, access_type, accessed_at) VALUES (?, ?, ?, unixepoch())'
    ).run(id, fileId, accessType)
  }

  /**
   * 获取文件访问统计
   */
  getFileAccessStats(fileId: string, days: number = 30): { hitCount: number; readCount: number; lastAccessed: number | null } {
    const since = Math.floor(Date.now() / 1000) - days * 86400

    const hitRow = this.db.prepare(
      "SELECT COUNT(*) as count FROM kms_access_log WHERE file_id = ? AND access_type = 'search_hit' AND accessed_at >= ?"
    ).get(fileId, since) as any

    const readRow = this.db.prepare(
      "SELECT COUNT(*) as count FROM kms_access_log WHERE file_id = ? AND access_type = 'read' AND accessed_at >= ?"
    ).get(fileId, since) as any

    const lastRow = this.db.prepare(
      'SELECT MAX(accessed_at) as last FROM kms_access_log WHERE file_id = ?'
    ).get(fileId) as any

    return {
      hitCount: hitRow?.count || 0,
      readCount: readRow?.count || 0,
      lastAccessed: lastRow?.last || null,
    }
  }

  /**
   * 批量获取文件访问统计（单次聚合查询，避免 N+1）
   * @param fileIds 文件ID列表
   * @param days 统计窗口天数
   * @returns Map<fileId, stats>
   */
  getFileAccessStatsBatch(fileIds: string[], days: number = 30): Map<string, { hitCount: number; readCount: number; lastAccessed: number | null }> {
    const result = new Map<string, { hitCount: number; readCount: number; lastAccessed: number | null }>()
    if (fileIds.length === 0) return result
    const since = Math.floor(Date.now() / 1000) - days * 86400

    // 单次聚合查询：用 CASE WHEN 在一次扫描中统计两类访问量 + MAX 最后访问时间
    const placeholders = fileIds.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT file_id,
             SUM(CASE WHEN access_type = 'search_hit' AND accessed_at >= ? THEN 1 ELSE 0 END) AS hit_count,
             SUM(CASE WHEN access_type = 'read'        AND accessed_at >= ? THEN 1 ELSE 0 END) AS read_count,
             MAX(accessed_at) AS last_accessed
      FROM kms_access_log
      WHERE file_id IN (${placeholders})
      GROUP BY file_id
    `).all(since, since, ...fileIds) as any[]

    for (const row of rows) {
      result.set(row.file_id, {
        hitCount: row.hit_count || 0,
        readCount: row.read_count || 0,
        lastAccessed: row.last_accessed || null,
      })
    }
    // 未在访问日志中出现的文件补默认值
    for (const id of fileIds) {
      if (!result.has(id)) {
        result.set(id, { hitCount: 0, readCount: 0, lastAccessed: null })
      }
    }
    return result
  }

  /**
   * 获取所有文件统计
   */
  getFileStats(): { total: number; byStatus: Record<string, number>; byTier: Record<string, number>; byExt: Record<string, number> } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM kms_files').get() as any)?.count || 0

    const statusRows = this.db.prepare('SELECT index_status, COUNT(*) as count FROM kms_files GROUP BY index_status').all() as any[]
    const byStatus: Record<string, number> = {}
    for (const row of statusRows) byStatus[row.index_status] = row.count

    const tierRows = this.db.prepare('SELECT data_tier, COUNT(*) as count FROM kms_files GROUP BY data_tier').all() as any[]
    const byTier: Record<string, number> = {}
    for (const row of tierRows) byTier[row.data_tier] = row.count

    const extRows = this.db.prepare('SELECT file_ext, COUNT(*) as count FROM kms_files GROUP BY file_ext ORDER BY count DESC LIMIT 20').all() as any[]
    const byExt: Record<string, number> = {}
    for (const row of extRows) byExt[row.file_ext] = row.count

    return { total, byStatus, byTier, byExt }
  }

  /**
   * 扫描磁盘文件
   */
  private scanDiskFiles(dirPath: string, recursive: boolean, extensions: string[], signal?: AbortSignal): Array<{ filePath: string; fileName: string; fileSize: number; modifiedTime: number }> {
    const results: Array<{ filePath: string; fileName: string; fileSize: number; modifiedTime: number }> = []

    const walk = (currentDir: string) => {
      if (signal?.aborted) return

      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (signal?.aborted) return

        const fullPath = path.join(currentDir, entry.name)

        if (entry.isDirectory()) {
          if (recursive && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walk(fullPath)
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase().slice(1)
          if (!SUPPORTED_EXTENSIONS.has(ext)) continue
          if (extensions.length > 0 && !extensions.includes(ext)) continue

          try {
            const stat = fs.statSync(fullPath)
            results.push({
              filePath: fullPath,
              fileName: entry.name,
              fileSize: stat.size,
              modifiedTime: Math.floor(stat.mtimeMs / 1000),
            })
          } catch {
            // 跳过无法访问的文件
          }
        }
      }
    }

    walk(dirPath)
    return results
  }

  /**
   * 注册新文件到数据库
   * 如果相同MD5的文件已存在（不同目录），直接复用索引数据，避免重复计算
   */
  private async registerFile(dirId: string, diskFile: { filePath: string; fileName: string; fileSize: number; modifiedTime: number }): Promise<void> {
    const id = generateId()
    const ext = path.extname(diskFile.fileName).toLowerCase().slice(1)
    const hash = await calculateFileHash(diskFile.filePath)

    // 检查是否已有相同hash的文件（不同位置的同内容文件）
    const existingFile = this.db.prepare('SELECT id FROM kms_files WHERE file_hash = ? LIMIT 1').get(hash) as any

    if (existingFile) {
      // 相同内容文件已存在，直接标记为completed并复制索引
      this.db.prepare(`
        INSERT INTO kms_files (id, dir_id, file_path, file_name, file_ext, file_size, file_hash, modified_time, index_status, data_tier)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'cold')
      `).run(id, dirId, diskFile.filePath, diskFile.fileName, ext, diskFile.fileSize, hash, diskFile.modifiedTime)

      // 复制索引数据
      KMSSearchEngineService.getInstance().cloneIndexData(existingFile.id, id)
      logger.info(`Deduplicated file "${diskFile.fileName}" (hash: ${hash.substring(0, 8)}...) from existing file ${existingFile.id}`)
    } else {
      // 新文件，正常注册
      this.db.prepare(`
        INSERT INTO kms_files (id, dir_id, file_path, file_name, file_ext, file_size, file_hash, modified_time, index_status, data_tier)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'cold')
      `).run(id, dirId, diskFile.filePath, diskFile.fileName, ext, diskFile.fileSize, hash, diskFile.modifiedTime)
    }
  }

  /**
   * 更新文件hash（文件内容已变更）
   * 检查新hash是否与其他文件重复，若重复则复用索引
   */
  private updateFileHash(fileId: string, newHash: string, modifiedTime: number, fileSize: number): void {
    // 检查是否有其他文件已有相同hash
    const existingFile = this.db.prepare('SELECT id FROM kms_files WHERE file_hash = ? AND id != ? LIMIT 1').get(newHash, fileId) as any

    if (existingFile) {
      // 新hash与其他文件重复，复用索引
      const searchEngine = KMSSearchEngineService.getInstance()
      searchEngine.deleteIndexByFile(fileId)
      this.db.prepare(`
        UPDATE kms_files SET file_hash = ?, modified_time = ?, file_size = ?, index_status = 'completed', updated_at = unixepoch() WHERE id = ?
      `).run(newHash, modifiedTime, fileSize, fileId)
      searchEngine.cloneIndexData(existingFile.id, fileId)
      logger.info(`Deduplicated modified file ${fileId} (hash: ${newHash.substring(0, 8)}...) from existing file ${existingFile.id}`)
    } else {
      this.db.prepare(`
        UPDATE kms_files SET file_hash = ?, modified_time = ?, file_size = ?, index_status = 'modified', updated_at = unixepoch() WHERE id = ?
      `).run(newHash, modifiedTime, fileSize, fileId)
    }
  }

  /**
   * 注销已删除的文件
   */
  private unregisterFile(fileId: string): void {
    // 级联删除会自动清理关联的段落、摘要、索引和嵌入
    this.db.prepare('DELETE FROM kms_files WHERE id = ?').run(fileId)
  }
}

export default KMSCrawlerService
