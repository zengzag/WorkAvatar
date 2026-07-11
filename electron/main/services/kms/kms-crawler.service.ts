import fs from 'fs'
import path from 'path'
import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSSearchEngineService from './kms-search-engine.service'
import { generateId, calculateFileHash } from '../common-utils'
import { createLogger } from '../logger'

const logger = createLogger('KMS-Crawler')

const SUPPORTED_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xlsx', 'xls', 'csv', 'pptx',
  'txt', 'md', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'
])

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
    const t0 = Date.now()

    // ===== Phase 1: 快速检测（仅 readdirSync + statSync + Map 对比，无文件内容哈希） =====
    const diskFiles = this.scanDiskFiles(dirPath, recursive, extensions, signal)

    // 只取检测需要的 5 个字段，避免 SELECT * 加载 parse_error 等无用列
    const dbFiles = this.db.prepare(
      'SELECT id, file_path, file_hash, modified_time, file_size FROM kms_files WHERE dir_id = ?'
    ).all(dirId) as any[]
    const dbFileMap = new Map(dbFiles.map(f => [f.file_path, f]))
    const diskPathSet = new Set(diskFiles.map(f => f.filePath))

    const newCandidates: Array<{ filePath: string; fileName: string; fileSize: number; modifiedTime: number }> = []
    const modifiedCandidates: Array<{ diskFile: typeof diskFiles[0]; dbFile: any }> = []
    let deletedFiles = 0
    let unchangedFiles = 0
    let skippedUnstableFiles = 0

    for (const diskFile of diskFiles) {
      if (signal?.aborted) break
      const dbFile = dbFileMap.get(diskFile.filePath)
      if (!dbFile) {
        newCandidates.push(diskFile)
      } else if (diskFile.modifiedTime > dbFile.modified_time || diskFile.fileSize !== dbFile.file_size) {
        if (stableThreshold > 0 && (now - diskFile.modifiedTime) < stableThreshold) {
          skippedUnstableFiles++
          continue
        }
        modifiedCandidates.push({ diskFile, dbFile })
      } else {
        unchangedFiles++
      }
    }

    // 已删除文件：无需哈希，立即注销
    for (const dbFile of dbFiles) {
      if (!diskPathSet.has(dbFile.file_path)) {
        try {
          this.unregisterFile(dbFile.id)
          deletedFiles++
        } catch (err: any) {
          logger.warn(`Failed to unregister file "${dbFile.file_path}":`, err?.message || err)
        }
      }
    }

    const t1 = Date.now()
    logger.info(`Crawl phase1 "${dirPath}": detect=${t1 - t0}ms, total=${diskFiles.length}, newCandidates=${newCandidates.length}, modifiedCandidates=${modifiedCandidates.length}, deleted=${deletedFiles}, unchanged=${unchangedFiles}, skippedUnstable=${skippedUnstableFiles}`)

    // 没有 new/modified 候选时直接返回，跳过哈希阶段
    if (newCandidates.length === 0 && modifiedCandidates.length === 0) {
      logger.info(`Crawled "${dirPath}": 0 new, 0 modified, ${deletedFiles} deleted, ${unchangedFiles} unchanged, ${skippedUnstableFiles} skipped(unstable)`)
      return {
        totalFiles: diskFiles.length,
        newFiles: 0,
        modifiedFiles: 0,
        deletedFiles,
        unchangedFiles,
        skippedUnstableFiles,
      }
    }

    // ===== Phase 2: 并行哈希（并发 16，I/O 密集型场景下近线性加速） =====
    // 收集所有需要哈希的文件路径，统一并行计算
    const hashItems: Array<{ filePath: string }> = [
      ...newCandidates,
      ...modifiedCandidates.map(c => c.diskFile),
    ]
    const hashMap = await this.parallelCalculateFileHash(hashItems, 16, signal)

    // ===== Phase 3: 根据哈希结果写入数据库（同步 better-sqlite3，顺序执行即可） =====
    let newFiles = 0
    let modifiedFiles = 0

    for (const diskFile of newCandidates) {
      if (signal?.aborted) break
      const hash = hashMap.get(diskFile.filePath)
      if (!hash) continue // 哈希失败的文件跳过
      try {
        this.registerFileWithHash(dirId, diskFile, hash)
        newFiles++
      } catch (err: any) {
        logger.warn(`Failed to register file "${diskFile.filePath}":`, err?.message || err)
      }
    }

    for (const { diskFile, dbFile } of modifiedCandidates) {
      if (signal?.aborted) break
      const newHash = hashMap.get(diskFile.filePath)
      if (!newHash) continue
      try {
        if (newHash !== dbFile.file_hash) {
          this.updateFileHash(dbFile.id, newHash, diskFile.modifiedTime, diskFile.fileSize)
          modifiedFiles++
        } else {
          // 内容未变，仅 mtime/size 变化（如复制、touch），更新元数据即可，避免无谓重索引
          this.updateFileMeta(dbFile.id, diskFile.modifiedTime, diskFile.fileSize)
          unchangedFiles++
        }
      } catch (err: any) {
        logger.warn(`Failed to update file "${diskFile.filePath}":`, err?.message || err)
      }
    }

    const t2 = Date.now()
    logger.info(`Crawl phase2 "${dirPath}": hash+write=${t2 - t1}ms (${hashItems.length} files hashed in parallel)`)
    logger.info(`Crawled "${dirPath}": ${newFiles} new, ${modifiedFiles} modified, ${deletedFiles} deleted, ${unchangedFiles} unchanged, ${skippedUnstableFiles} skipped(unstable)`)

    return {
      totalFiles: diskFiles.length,
      newFiles,
      modifiedFiles,
      deletedFiles,
      unchangedFiles,
      skippedUnstableFiles,
    }
  }

  /**
   * 并发计算多个文件的哈希值（I/O 密集型，并发读取远快于串行）。
   *
   * 采用固定数量的 worker 协程从共享索引队列拉取任务，
   * 避免一次性创建 N 个 Promise 导致内存/fd 压力。
   *
   * @param files 需要哈希的文件列表（仅取 filePath）
   * @param concurrency 并发度（建议 8-16）
   * @param signal 取消信号
   * @returns Map<filePath, hash>
   */
  private async parallelCalculateFileHash(
    files: Array<{ filePath: string }>,
    concurrency: number,
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>()
    if (files.length === 0) return results

    let index = 0
    const actualConcurrency = Math.min(concurrency, files.length)

    const worker = async () => {
      while (index < files.length) {
        if (signal?.aborted) return
        const current = files[index++]
        if (!current) return
        try {
          const hash = await calculateFileHash(current.filePath)
          results.set(current.filePath, hash)
        } catch (err: any) {
          logger.warn(`Failed to hash "${current.filePath}":`, err?.message || err)
        }
      }
    }

    await Promise.all(Array.from({ length: actualConcurrency }, () => worker()))
    return results
  }

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

  updateFileStatus(fileId: string, status: string, error?: string): void {
    if (error) {
      this.db.prepare('UPDATE kms_files SET index_status = ?, parse_error = ?, updated_at = unixepoch() WHERE id = ?')
        .run(status, error, fileId)
    } else {
      this.db.prepare('UPDATE kms_files SET index_status = ?, parse_error = NULL, updated_at = unixepoch() WHERE id = ?')
        .run(status, fileId)
    }
  }

  updateFileDataTier(fileId: string, tier: 'cold' | 'hot'): void {
    this.db.prepare('UPDATE kms_files SET data_tier = ?, updated_at = unixepoch() WHERE id = ?')
      .run(tier, fileId)
  }

  logFileAccess(fileId: string, accessType: 'search_hit' | 'read' | 'summary_view'): void {
    const exists = this.db.prepare('SELECT 1 FROM kms_files WHERE id = ?').get(fileId)
    if (!exists) return

    const id = generateId()
    this.db.prepare(
      'INSERT INTO kms_access_log (id, file_id, access_type, accessed_at) VALUES (?, ?, ?, unixepoch())'
    ).run(id, fileId, accessType)
  }

  logFileAccessBatch(fileIds: string[], accessType: 'search_hit' | 'read' | 'summary_view'): void {
    if (fileIds.length === 0) return
    const uniqueIds = [...new Set(fileIds)]
    const placeholders = uniqueIds.map(() => '?').join(',')
    this.db.prepare(
      `INSERT INTO kms_access_log (id, file_id, access_type, accessed_at)
       SELECT lower(hex(randomblob(16))), id, ?, unixepoch()
       FROM kms_files WHERE id IN (${placeholders})`
    ).run(accessType, ...uniqueIds)
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
      } catch (err: any) {
        logger.warn(`Cannot read directory "${currentDir}", skipping:`, err?.message || err)
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
          // 跳过 Office/WPS 临时锁文件（如 ~$test.docx、.~test.docx）
          if (entry.name.startsWith('~$') || entry.name.startsWith('.~')) continue
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
          } catch (err: any) {
            logger.warn(`Cannot stat file "${fullPath}", skipping:`, err?.message || err)
          }
        }
      }
    }

    walk(dirPath)
    return results
  }

  /**
   * 注册新文件到数据库（使用预计算的哈希，避免重复读取文件内容）
   * - 如果 file_path 已存在（重叠目录场景，如添加了父目录又添加子目录），直接跳过，复用已有索引
   * - 如果相同 hash 的文件已存在（不同位置的同内容文件），复用索引数据，避免重复计算
   */
  private registerFileWithHash(dirId: string, diskFile: { filePath: string; fileName: string; fileSize: number; modifiedTime: number }, hash: string): void {
    const existingByPath = this.db.prepare('SELECT id, dir_id FROM kms_files WHERE file_path = ? LIMIT 1').get(diskFile.filePath) as any
    if (existingByPath) {
      // 文件已注册在其他目录下：若来自虚拟手动目录（合集文件），迁移到真实索引目录
      const manualDirPath = '__manual_files__'
      const manualDir = this.db.prepare("SELECT id FROM kms_index_dirs WHERE dir_path = ?").get(manualDirPath) as any
      if (manualDir && existingByPath.dir_id === manualDir.id) {
        this.db.prepare('UPDATE kms_files SET dir_id = ? WHERE id = ?').run(dirId, existingByPath.id)
        logger.info(`File "${diskFile.filePath}" migrated from manual source dir to real index dir ${dirId}`)
      } else {
        logger.info(`File "${diskFile.filePath}" already registered under dir ${existingByPath.dir_id}, skipping`)
      }
      return
    }

    const id = generateId()
    const ext = path.extname(diskFile.fileName).toLowerCase().slice(1)

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
   * 更新文件元数据（mtime/size 变化但内容哈希未变时调用，避免无谓重索引）
   */
  private updateFileMeta(fileId: string, modifiedTime: number, fileSize: number): void {
    this.db.prepare(`
      UPDATE kms_files SET modified_time = ?, file_size = ?, updated_at = unixepoch() WHERE id = ?
    `).run(modifiedTime, fileSize, fileId)
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
    // 先显式清理 FTS5 全文索引和向量库 embedding：
    // - kms_fts 是 FTS5 虚表，不支持外键级联删除
    // - kms_embeddings 位于独立的向量库，跨库外键不可用
    KMSSearchEngineService.getInstance().deleteIndexByFile(fileId)
    // 主库的段落/摘要/搜索索引/访问日志/合集关联由 ON DELETE CASCADE 级联清理
    this.db.prepare('DELETE FROM kms_files WHERE id = ?').run(fileId)
  }
}

export default KMSCrawlerService
