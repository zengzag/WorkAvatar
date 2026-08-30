import fs from 'fs'
import path from 'path'
import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'

const logger = createLogger('KMS-SearchDirWatcher')

/** 与扫描侧一致的跳过目录 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  '__pycache__', '.DS_Store', 'Thumbs.db',
  '.vscode', '.idea', '.trae',
  'dist', 'build', 'out', 'target',
])

/** 事件合并窗口：编辑器保存会连续触发多个事件，批量处理避免抖动 */
const DEBOUNCE_MS = 500

interface WatchEntry {
  dirId: string
  rootPath: string
  recursive: boolean
  extSet: Set<string>
  watcher: fs.FSWatcher
  closed: boolean
  timer: NodeJS.Timeout | null
  pending: Set<string>
}

/**
 * 文件搜索目录监听服务
 *
 * 文件搜索目录只存轻量元数据（无索引管线），用 fs.watch 递归监听（Windows 上
 * 基于 ReadDirectoryChangesW，内核级推送，成本与目录规模基本无关）实现文件
 * 变化的实时增量同步，替代定时全量重扫。
 *
 * 监听只做单行 upsert/delete，磁盘 I/O 仅为 stat 单个文件；
 * 应用关闭期间的变化由启动时的全量重扫兜底。
 */
class KMSSearchDirWatcherService {
  private static instance: KMSSearchDirWatcherService
  private db: Database.Database
  private entries = new Map<string, WatchEntry>()
  /** 目录配置变更/异常恢复时触发的全量重扫回调（由 KMSService 注册） */
  private rescanCallback: ((dirId: string) => Promise<void> | void) | null = null

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSSearchDirWatcherService {
    if (!KMSSearchDirWatcherService.instance) {
      KMSSearchDirWatcherService.instance = new KMSSearchDirWatcherService()
    }
    return KMSSearchDirWatcherService.instance
  }

  setRescanCallback(fn: (dirId: string) => Promise<void> | void): void {
    this.rescanCallback = fn
  }

  /** 启动指定搜索目录的监听（须在启用状态下调用） */
  watchDir(dirRow: { id: string; dir_path: string; recursive: number; file_extensions: string }): void {
    this.unwatchDir(dirRow.id)
    if (!fs.existsSync(dirRow.dir_path)) return

    const entry: WatchEntry = {
      dirId: dirRow.id,
      rootPath: dirRow.dir_path,
      recursive: dirRow.recursive === 1,
      extSet: new Set(
        (dirRow.file_extensions || '')
          .split(',')
          .map(e => e.trim().toLowerCase().replace(/^\./, ''))
          .filter(Boolean)
      ),
      watcher: null as any,
      closed: false,
      timer: null,
      pending: new Set(),
    }

    try {
      // recursive watch：Windows/macOS 原生支持；recursive=false 时仅收到根目录直接子项事件
      entry.watcher = fs.watch(dirRow.dir_path, { recursive: entry.recursive }, (_event, filename) => {
        if (entry.closed) return
        if (!filename || typeof filename !== 'string') {
          // 无法定位具体文件（如根目录被替换）：退化为全量重扫
          this.scheduleFullRescan(entry)
          return
        }
        entry.pending.add(path.join(entry.rootPath, filename))
        this.scheduleFlush(entry)
      })
    } catch (err: any) {
      logger.warn(`启动监听失败 (${dirRow.dir_path}): ${err?.message || err}`)
      return
    }

    entry.watcher.on('error', (err: any) => {
      logger.warn(`监听异常，停止并重扫 (${dirRow.dir_path}): ${err?.message || err}`)
      this.unwatchDir(entry.dirId)
      this.scheduleFullRescan(entry)
    })

    this.entries.set(dirRow.id, entry)
    logger.info(`已监听文件搜索目录: ${dirRow.dir_path} (recursive=${entry.recursive})`)
  }

  unwatchDir(dirId: string): void {
    const entry = this.entries.get(dirId)
    if (!entry) return
    entry.closed = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.pending.clear()
    try { entry.watcher.close() } catch { /* 已关闭 */ }
    this.entries.delete(dirId)
  }

  private scheduleFlush(entry: WatchEntry): void {
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (entry.closed) return
      this.flush(entry)
    }, DEBOUNCE_MS)
  }

  private scheduleFullRescan(entry: WatchEntry): void {
    if (!this.rescanCallback) return
    // 重扫回调内会重建监听（KMSService.refreshSearchDir -> rewatch），这里只需去抖触发
    const dirId = entry.dirId
    setTimeout(() => {
      Promise.resolve(this.rescanCallback?.(dirId)).catch(() => {})
    }, DEBOUNCE_MS)
  }

  /** 批量处理监听事件：文件存在则 upsert，消失则删除 */
  private flush(entry: WatchEntry): void {
    const paths = [...entry.pending]
    entry.pending.clear()

    const upsert = this.db.prepare(`
      INSERT INTO kms_search_dir_files (id, dir_id, file_path, file_name, file_ext, file_size, modified_time)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        file_name = excluded.file_name,
        file_ext = excluded.file_ext,
        file_size = excluded.file_size,
        modified_time = excluded.modified_time,
        updated_at = unixepoch()
    `)
    const remove = this.db.prepare('DELETE FROM kms_search_dir_files WHERE file_path = ?')

    let upserted = 0
    let removed = 0
    for (const p of paths) {
      if (!this.shouldTrack(entry, p)) continue
      let stat: fs.Stats | null = null
      try {
        stat = fs.statSync(p)
      } catch {
        stat = null
      }
      if (stat && stat.isFile()) {
        const fileName = path.basename(p)
        upsert.run(
          generateId(), entry.dirId, p, fileName,
          path.extname(fileName).toLowerCase().slice(1),
          stat.size, Math.floor(stat.mtimeMs / 1000)
        )
        upserted++
      } else if (!stat) {
        remove.run(p)
        removed++
      }
      // 目录事件（stat 为 directory）忽略：递归监听下其中的文件会单独上报
    }
    if (upserted + removed > 0) {
      logger.info(`监听同步 (${entry.rootPath}): +${upserted} / -${removed}`)
    }
  }

  /** 路径是否属于该目录应跟踪的范围（跳过目录/隐藏目录/扩展名过滤/递归深度） */
  private shouldTrack(entry: WatchEntry, filePath: string): boolean {
    const rel = path.relative(entry.rootPath, filePath)
    if (!rel || rel.startsWith('..')) return false
    const parts = rel.split(path.sep)
    // 非递归目录只跟踪根目录直接子文件
    if (!entry.recursive && parts.length > 1) return false
    // 任一层级命中跳过目录/隐藏目录则忽略（最后一段是文件名本身）
    for (let i = 0; i < parts.length - 1; i++) {
      if (SKIP_DIRS.has(parts[i]) || parts[i].startsWith('.')) return false
    }
    const fileName = parts[parts.length - 1]
    if (fileName.startsWith('~$') || fileName.startsWith('.~')) return false
    if (entry.extSet.size > 0) {
      const ext = path.extname(fileName).toLowerCase().slice(1)
      if (!entry.extSet.has(ext)) return false
    }
    return true
  }
}

export default KMSSearchDirWatcherService
