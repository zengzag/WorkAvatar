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
  /** 文件稳定阈值（分钟）：修改时间距今不足该值的文件视为"尚未稳定"，跳过不索引，避免用户正在编辑时频繁更新 */
  stableThresholdMinutes?: number
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
 * 检查阶段收集的变化信息（纯数据，不含 DB 操作）
 */
interface DirChanges {
  dirId: string
  /** 已删除文件的 ID 列表 */
  deletedFileIds: string[]
  /** 新文件（含哈希结果） */
  newFiles: Array<{ diskFile: DiskFile; hash: string }>
  /** 修改文件（含哈希结果，contentChanged 表示内容确实变化） */
  modifiedFiles: Array<{ diskFile: DiskFile; dbFile: any; newHash: string; contentChanged: boolean }>
  /** 统计 */
  totalFiles: number
  unchangedFiles: number
  skippedUnstableFiles: number
}

type DiskFile = { filePath: string; fileName: string; fileSize: number; modifiedTime: number }

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
   * 检查阶段：扫描磁盘 + 比对 DB + 哈希候选文件。
   * 纯只读操作，不做任何 DB 修改。
   */
  private async detectChanges(dirId: string, signal?: AbortSignal, options?: CrawlOptions): Promise<DirChanges> {
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

    const stableThresholdMinutes = options?.stableThresholdMinutes ?? 0
    const stableThresholdSeconds = stableThresholdMinutes * 60
    const now = Math.floor(Date.now() / 1000)

    // Phase 1: 扫描磁盘 + 比对 DB（纯只读）
    const diskFiles = await this.scanDiskFiles(dirPath, recursive, extensions, signal)

    const dbFiles = this.db.prepare(
      'SELECT id, file_path, file_hash, modified_time, file_size FROM kms_files WHERE dir_id = ?'
    ).all(dirId) as any[]
    const dbFileMap = new Map(dbFiles.map(f => [f.file_path, f]))
    const diskPathSet = new Set(diskFiles.map(f => f.filePath))

    const newCandidates: DiskFile[] = []
    const modifiedCandidates: Array<{ diskFile: DiskFile; dbFile: any }> = []
    const deletedFileIds: string[] = []
    let unchangedFiles = 0
    let skippedUnstableFiles = 0

    for (const diskFile of diskFiles) {
      if (signal?.aborted) break
      const dbFile = dbFileMap.get(diskFile.filePath)
      if (!dbFile) {
        newCandidates.push(diskFile)
      } else if (diskFile.modifiedTime > dbFile.modified_time || diskFile.fileSize !== dbFile.file_size) {
        if (stableThresholdSeconds > 0 && (now - diskFile.modifiedTime) < stableThresholdSeconds) {
          skippedUnstableFiles++
          continue
        }
        modifiedCandidates.push({ diskFile, dbFile })
      } else {
        unchangedFiles++
      }
    }

    // 检测已删除文件（DB 有但磁盘没有）
    for (const dbFile of dbFiles) {
      if (!diskPathSet.has(dbFile.file_path)) {
        deletedFileIds.push(dbFile.id)
      }
    }

    logger.info(`Detect "${dirPath}": total=${diskFiles.length}, new=${newCandidates.length}, modified=${modifiedCandidates.length}, deleted=${deletedFileIds.length}, unchanged=${unchangedFiles}, skipped=${skippedUnstableFiles}`)

    // Phase 2: 并行哈希候选文件（纯只读 I/O）
    const hashItems = [
      ...newCandidates,
      ...modifiedCandidates.map(c => c.diskFile),
    ]
    if (hashItems.length > 0) {
      logger.info(`Detect "${dirPath}": hashing ${hashItems.length} files...`)
    }
    const hashMap = await this.parallelCalculateFileHash(hashItems, 16, signal)

    const newFiles = newCandidates
      .map(diskFile => ({ diskFile, hash: hashMap.get(diskFile.filePath)! }))
      .filter(item => item.hash)

    const modifiedFiles = modifiedCandidates
      .map(({ diskFile, dbFile }) => ({
        diskFile,
        dbFile,
        newHash: hashMap.get(diskFile.filePath)!,
        contentChanged: hashMap.get(diskFile.filePath) !== dbFile.file_hash,
      }))
      .filter(item => item.newHash)

    return {
      dirId,
      deletedFileIds,
      newFiles,
      modifiedFiles,
      totalFiles: diskFiles.length,
      unchangedFiles,
      skippedUnstableFiles,
    }
  }

  /**
   * 应用阶段：统一处理增删改的 DB 修改。
   * - 已删除文件：批量删除索引 + 记录
   * - 修改文件（内容已变）：批量删除旧索引 + 更新哈希
   * - 修改文件（内容未变）：仅更新元数据
   * - 新文件：注册到 DB
   */
  private async applyChanges(changes: DirChanges, signal?: AbortSignal): Promise<{ newFiles: number; modifiedFiles: number; deletedFiles: number }> {
    const { deletedFileIds, newFiles, modifiedFiles, dirId } = changes

    // 1) 批量删除已删除文件的索引和记录
    if (deletedFileIds.length > 0) {
      const t = Date.now()
      KMSSearchEngineService.getInstance().deleteIndexByFiles(deletedFileIds)
      const placeholders = deletedFileIds.map(() => '?').join(',')
      this.db.prepare(`DELETE FROM kms_files WHERE id IN (${placeholders})`).run(...deletedFileIds)
      logger.info(`Apply: deleted ${deletedFileIds.length} files in ${Date.now() - t}ms`)
    }

    // 2) 批量删除内容已变更文件的旧索引（后续重新索引时写入新数据）
    const contentChangedFileIds = modifiedFiles.filter(m => m.contentChanged).map(m => m.dbFile.id)
    if (contentChangedFileIds.length > 0) {
      const t = Date.now()
      KMSSearchEngineService.getInstance().deleteIndexByFiles(contentChangedFileIds)
      logger.info(`Apply: deleted old index for ${contentChangedFileIds.length} modified files in ${Date.now() - t}ms`)
    }

    // 3) 注册新文件
    let newCount = 0
    for (const { diskFile, hash } of newFiles) {
      if (signal?.aborted) break
      try {
        this.registerFileWithHash(dirId, diskFile, hash)
        newCount++
      } catch (err: any) {
        logger.warn(`Failed to register file "${diskFile.filePath}":`, err?.message || err)
      }
      if (newCount % 50 === 0) await new Promise(resolve => setImmediate(resolve))
    }

    // 4) 更新修改文件
    let modifiedCount = 0
    let unchangedMetaCount = 0
    for (const { diskFile, dbFile, newHash, contentChanged } of modifiedFiles) {
      if (signal?.aborted) break
      try {
        if (contentChanged) {
          this.updateFileHash(dbFile.id, newHash, diskFile.modifiedTime, diskFile.fileSize)
          modifiedCount++
        } else {
          this.updateFileMeta(dbFile.id, diskFile.modifiedTime, diskFile.fileSize)
          unchangedMetaCount++
        }
      } catch (err: any) {
        logger.warn(`Failed to update file "${diskFile.filePath}":`, err?.message || err)
      }
      if ((newCount + modifiedCount) % 50 === 0) await new Promise(resolve => setImmediate(resolve))
    }

    return { newFiles: newCount, modifiedFiles: modifiedCount, deletedFiles: deletedFileIds.length }
  }

  /**
   * 爬取单个目录（检查 + 应用，用于 rebuildDir 场景）
   */
  async crawlDirectory(dirId: string, signal?: AbortSignal, options?: CrawlOptions): Promise<CrawlResult> {
    const changes = await this.detectChanges(dirId, signal, options)
    if (signal?.aborted) {
      return {
        totalFiles: changes.totalFiles,
        newFiles: 0, modifiedFiles: 0, deletedFiles: 0,
        unchangedFiles: changes.unchangedFiles,
        skippedUnstableFiles: changes.skippedUnstableFiles,
      }
    }
    const applied = await this.applyChanges(changes, signal)
    return {
      totalFiles: changes.totalFiles,
      newFiles: applied.newFiles,
      modifiedFiles: applied.modifiedFiles,
      deletedFiles: applied.deletedFiles,
      unchangedFiles: changes.unchangedFiles,
      skippedUnstableFiles: changes.skippedUnstableFiles,
    }
  }

  /**
   * 爬取所有目录（先统一检查，再统一应用）
   *
   * 检查阶段对所有目录只做 scan + compare + hash（纯只读），
   * 收集完所有变化后统一执行批量删除/注册/更新，避免逐目录 DB 写入。
   */
  async crawlAllDirectories(
    signal?: AbortSignal,
    options?: CrawlOptions,
    onProgress?: (current: number, total: number, dirPath: string) => void,
  ): Promise<CrawlResult> {
    const t0 = Date.now()
    const dirs = this.db.prepare('SELECT * FROM kms_index_dirs WHERE enabled = 1').all() as any[]
    logger.info(`Crawl all: ${dirs.length} dirs`)

    // === 检查阶段：逐目录检测，收集所有变化 ===
    const allChanges: DirChanges[] = []
    for (let i = 0; i < dirs.length; i++) {
      if (signal?.aborted) break
      const dir = dirs[i]
      onProgress?.(i, dirs.length, dir.dir_path)
      try {
        const changes = await this.detectChanges(dir.id, signal, options)
        allChanges.push(changes)
      } catch (err) {
        logger.error(`Detect failed for "${dir.dir_path}":`, err)
      }
    }

    if (signal?.aborted) {
      logger.info(`Crawl all: aborted during detect, ${Date.now() - t0}ms`)
      return { totalFiles: 0, newFiles: 0, modifiedFiles: 0, deletedFiles: 0, unchangedFiles: 0, skippedUnstableFiles: 0 }
    }

    // === 应用阶段：统一处理所有目录的变化 ===
    const totalResult: CrawlResult = {
      totalFiles: 0, newFiles: 0, modifiedFiles: 0, deletedFiles: 0, unchangedFiles: 0, skippedUnstableFiles: 0,
    }

    for (const changes of allChanges) {
      if (signal?.aborted) break
      totalResult.totalFiles += changes.totalFiles
      totalResult.unchangedFiles += changes.unchangedFiles
      totalResult.skippedUnstableFiles += changes.skippedUnstableFiles

      if (changes.deletedFileIds.length > 0 || changes.newFiles.length > 0 || changes.modifiedFiles.length > 0) {
        const applied = await this.applyChanges(changes, signal)
        totalResult.newFiles += applied.newFiles
        totalResult.modifiedFiles += applied.modifiedFiles
        totalResult.deletedFiles += applied.deletedFiles
      }
    }

    logger.info(`Crawl all: done in ${(Date.now() - t0) / 1000}s, new=${totalResult.newFiles}, modified=${totalResult.modifiedFiles}, deleted=${totalResult.deletedFiles}`)
    return totalResult
  }

  /**
   * 并发计算多个文件的哈希值（I/O 密集型，并发读取远快于串行）。
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
   */
  getFileAccessStatsBatch(fileIds: string[], days: number = 30): Map<string, { hitCount: number; readCount: number; lastAccessed: number | null }> {
    const result = new Map<string, { hitCount: number; readCount: number; lastAccessed: number | null }>()
    if (fileIds.length === 0) return result
    const since = Math.floor(Date.now() / 1000) - days * 86400

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
    for (const id of fileIds) {
      if (!result.has(id)) {
        result.set(id, { hitCount: 0, readCount: 0, lastAccessed: null })
      }
    }
    return result
  }

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
   * 扫描磁盘文件（分批异步，让出事件循环以推送进度）
   *
   * Worker 模式下，旧的同步递归 walk 会阻塞整个 Worker 事件循环，
   * 改为分批处理：BATCH_SIZE 个目录后 await setImmediate。
   */
  private async scanDiskFiles(dirPath: string, recursive: boolean, extensions: string[], signal?: AbortSignal): Promise<DiskFile[]> {
    const results: DiskFile[] = []
    const dirQueue: string[] = [dirPath]
    let dirsScanned = 0
    const BATCH_SIZE = 50
    const LOG_INTERVAL = 100  // 每累计 100 个匹配文件输出一次日志

    while (dirQueue.length > 0) {
      if (signal?.aborted) break
      const currentDir = dirQueue.shift()!
      dirsScanned++

      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true })
      } catch {
        if (dirsScanned % BATCH_SIZE === 0) await new Promise(resolve => setImmediate(resolve))
        continue
      }

      for (const entry of entries) {
        if (signal?.aborted) break
        const fullPath = path.join(currentDir, entry.name)

        if (entry.isDirectory()) {
          if (recursive && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            dirQueue.push(fullPath)
          }
        } else if (entry.isFile()) {
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
            if (results.length % LOG_INTERVAL === 0) {
              logger.info(`Scan "${dirPath}": found ${results.length} files so far (last: ${entry.name})`)
            }
          } catch {
            // skip
          }
        }
      }

      if (dirsScanned % BATCH_SIZE === 0) {
        await new Promise(resolve => setImmediate(resolve))
      }
    }

    if (results.length > 0) {
      logger.info(`Scan "${dirPath}": total ${results.length} files in ${dirsScanned} dirs`)
    }

    return results
  }

  /**
   * 注册新文件到数据库（使用预计算的哈希，避免重复读取文件内容）
   * - 如果 file_path 已存在（重叠目录场景），直接跳过
   * - 如果相同 hash 的文件已存在（不同位置的同内容文件），复用索引数据
   */
  private registerFileWithHash(dirId: string, diskFile: DiskFile, hash: string): void {
    const existingByPath = this.db.prepare('SELECT id, dir_id FROM kms_files WHERE file_path = ? LIMIT 1').get(diskFile.filePath) as any
    if (existingByPath) {
      const manualDirPath = '__manual_files__'
      const manualDir = this.db.prepare("SELECT id FROM kms_index_dirs WHERE dir_path = ?").get(manualDirPath) as any
      if (manualDir && existingByPath.dir_id === manualDir.id) {
        this.db.prepare('UPDATE kms_files SET dir_id = ? WHERE id = ?').run(dirId, existingByPath.id)
      }
      return
    }

    const id = generateId()
    const ext = path.extname(diskFile.fileName).toLowerCase().slice(1)

    const existingFile = this.db.prepare('SELECT id FROM kms_files WHERE file_hash = ? LIMIT 1').get(hash) as any

    if (existingFile) {
      this.db.prepare(`
        INSERT INTO kms_files (id, dir_id, file_path, file_name, file_ext, file_size, file_hash, modified_time, index_status, data_tier)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'cold')
      `).run(id, dirId, diskFile.filePath, diskFile.fileName, ext, diskFile.fileSize, hash, diskFile.modifiedTime)

      KMSSearchEngineService.getInstance().cloneIndexData(existingFile.id, id)
    } else {
      this.db.prepare(`
        INSERT INTO kms_files (id, dir_id, file_path, file_name, file_ext, file_size, file_hash, modified_time, index_status, data_tier)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'cold')
      `).run(id, dirId, diskFile.filePath, diskFile.fileName, ext, diskFile.fileSize, hash, diskFile.modifiedTime)
    }
  }

  private updateFileMeta(fileId: string, modifiedTime: number, fileSize: number): void {
    this.db.prepare(`
      UPDATE kms_files SET modified_time = ?, file_size = ?, updated_at = unixepoch() WHERE id = ?
    `).run(modifiedTime, fileSize, fileId)
  }

  private updateFileHash(fileId: string, newHash: string, modifiedTime: number, fileSize: number): void {
    const existingFile = this.db.prepare('SELECT id FROM kms_files WHERE file_hash = ? AND id != ? LIMIT 1').get(newHash, fileId) as any

    if (existingFile) {
      const searchEngine = KMSSearchEngineService.getInstance()
      searchEngine.deleteIndexByFile(fileId)
      this.db.prepare(`
        UPDATE kms_files SET file_hash = ?, modified_time = ?, file_size = ?, index_status = 'completed', updated_at = unixepoch() WHERE id = ?
      `).run(newHash, modifiedTime, fileSize, fileId)
      searchEngine.cloneIndexData(existingFile.id, fileId)
    } else {
      this.db.prepare(`
        UPDATE kms_files SET file_hash = ?, modified_time = ?, file_size = ?, index_status = 'modified', updated_at = unixepoch() WHERE id = ?
      `).run(newHash, modifiedTime, fileSize, fileId)
    }
  }
}

export default KMSCrawlerService
