import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import PathService from './path.service'
import DatabaseService from './database.service'
import { createLogger } from './logger'

const logger = createLogger('AttachmentService')

/**
 * 对话图片附件存储：base64 data URL 落盘为文件（hash 去重），
 * 消息里只存 `wa-attachment://local/<sha256>.<ext>` 引用。
 * 文件实际位于 <dataDir>/attachments/<hash 前 2 位>/<sha256>.<ext>。
 *
 * ============================================================================
 * 【WA-COMPAT:legacy-base64-migration】旧版本兼容标记（整组逻辑可整体移除）
 * ----------------------------------------------------------------------------
 * 本服务包含一段向下兼容逻辑：迁移历史版本直接内嵌到 messages_json 的
 * base64 图片（data:image/...）为附件文件引用。涉及：
 *   1. LEGACY_MIGRATION_FLAG（settings KV 一次性完成标记）
 *   2. migrateExistingDataUrls()（逐行迁移）
 *   3. collectAttachmentRefs/replaceDataUrlsWithRefs 中对 "wa-attachment://" /
 *      "data:image/" 前缀的识别（collectAllRefs/migrate 的 LIKE 扫描）
 *   4. DATA_URL_PATTERN 兜底解析 data URL（渲染端新图已全部是引用）
 * 后续版本确认无存量 base64 数据残留（LEGACY_MIGRATION_FLAG 已全量下发）
 * 后，搜索标记 "WA-COMPAT:legacy-base64-migration" 即可定位并整体删除上述
 * 代码与该 settings 键。parseImageDataUrl 对 data URL 的常规支持不属于本
 * 兼容范围，勿一并删除。
 * ============================================================================
 */
export const ATTACHMENT_REF_PATTERN = /^wa-attachment:\/\/local\/([a-f0-9]{64})\.(png|jpg|jpeg|gif|bmp|webp|tiff|svg)$/

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
}

const DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/
const MAX_SAVE_BYTES = 12 * 1024 * 1024
/** 单文件最大 data URL 字符长度（迁移上限，超出跳过保留原文） */
const MAX_DATA_URL_CHARS = 18 * 1024 * 1024
const LRU_MAX_BYTES = 32 * 1024 * 1024
/** GC 保护：24 小时内新落盘的附件不清理（防止误删未发送的草稿附件、跨会话竞争） */
const PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000

export interface ResolvedAttachment {
  mimeType: string
  base64: string
}

/** 深度遍历消息结构，收集全部 wa-attachment:// 引用 */
export function collectAttachmentRefs(value: any, out: Set<string> = new Set()): Set<string> {
  const walk = (v: any): void => {
    if (typeof v === 'string') {
      if (v.startsWith('wa-attachment://')) out.add(v)
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item)
    } else if (v && typeof v === 'object') {
      for (const key of Object.keys(v)) walk(v[key])
    }
  }
  walk(value)
  return out
}

/** 深度遍历并把 data:image base64 字符串替换为附件引用；返回是否发生替换 */
export function replaceDataUrlsWithRefs(value: any): { value: any; changed: boolean } {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/') && value.length <= MAX_DATA_URL_CHARS && DATA_URL_PATTERN.test(value)) {
      const ref = AttachmentService.getInstance().saveDataUrl(value)
      if (ref) return { value: ref, changed: true }
    }
    return { value, changed: false }
  }
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map(item => {
      const r = replaceDataUrlsWithRefs(item)
      changed = changed || r.changed
      return r.value
    })
    return changed ? { value: next, changed } : { value, changed: false }
  }
  if (value && typeof value === 'object') {
    let changed = false
    const next: Record<string, any> = {}
    for (const key of Object.keys(value)) {
      const r = replaceDataUrlsWithRefs(value[key])
      next[key] = r.value
      changed = changed || r.changed
    }
    return changed ? { value: next, changed } : { value, changed: false }
  }
  return { value, changed: false }
}

class AttachmentService {
  private static instance: AttachmentService
  /** 【WA-COMPAT:legacy-base64-migration】旧版本存量 base64 迁移完成标记（settings KV，迁移成功后置位，后续版本稳定后连同本段兼容逻辑一并移除） */
  private static readonly LEGACY_MIGRATION_FLAG = 'attachment_legacy_base64_migrated'
  /** 本次会话内新落盘的引用：GC 不得删除（可能尚在输入框/草稿中未持久化） */
  private sessionSaved = new Set<string>()
  /** 引用 → 文件内容 LRU 缓存（LLM 每轮请求都要读历史图片） */
  private cache = new Map<string, Buffer>()
  private cacheBytes = 0
  private orphanPruneTimer: NodeJS.Timeout | null = null
  private prunning = false

  static getInstance(): AttachmentService {
    if (!AttachmentService.instance) {
      AttachmentService.instance = new AttachmentService()
    }
    return AttachmentService.instance
  }

  private getDir(): string {
    return PathService.getInstance().getAttachmentsDir()
  }

  private filePathFor(hash: string, ext: string): string {
    // ext 入参可能是 '.png' 或 'png' 两种形态，统一去掉前导点
    const normalized = ext.replace(/^\./, '')
    return path.join(this.getDir(), hash.slice(0, 2), `${hash}.${normalized}`)
  }

  /** 解析引用对应的磁盘文件路径；非法引用返回 null */
  getFilePathFromRef(ref: string): string | null {
    const match = ATTACHMENT_REF_PATTERN.exec(ref)
    if (!match) return null
    return this.filePathFor(match[1], match[2])
  }

  /** base64 data URL 落盘，返回引用；非法数据/写盘失败返回 null（调用方回退原 data URL） */
  saveDataUrl(dataUrl: string): string | null {
    try {
      if (typeof dataUrl !== 'string') return null
      const match = DATA_URL_PATTERN.exec(dataUrl)
      if (!match) return null
      const buffer = Buffer.from(match[2], 'base64')
      if (buffer.length === 0 || buffer.length > MAX_SAVE_BYTES) return null
      const ext = EXT_BY_MIME[match[1].toLowerCase()]
      if (!ext) return null
      const hash = crypto.createHash('sha256').update(buffer).digest('hex')
      const filePath = this.filePathFor(hash, ext)
      if (!fs.existsSync(filePath)) {
        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(filePath, buffer)
      }
      const ref = `wa-attachment://local/${hash}.${ext}`
      this.sessionSaved.add(ref)
      return ref
    } catch (err: any) {
      logger.warn('saveDataUrl failed:', err?.message || err)
      return null
    }
  }

  /** 读取引用对应的图片；文件丢失/读失败返回 null（不抛异常） */
  resolve(ref: string): ResolvedAttachment | null {
    try {
      const match = ATTACHMENT_REF_PATTERN.exec(ref)
      if (!match) return null
      const hash = match[1]
      const ext = match[2]
      const filePath = this.filePathFor(hash, ext)
      let buffer = this.cache.get(ref)
      if (buffer) {
        // LRU 触碰
        this.cache.delete(ref)
        this.cache.set(ref, buffer)
      } else {
        if (!fs.existsSync(filePath)) return null
        buffer = fs.readFileSync(filePath)
        this.cache.set(ref, buffer)
        this.cacheBytes += buffer.length
        while (this.cacheBytes > LRU_MAX_BYTES && this.cache.size > 1) {
          const oldest = this.cache.keys().next().value as string
          const oldestBuf = this.cache.get(oldest)
          this.cache.delete(oldest)
          this.cacheBytes -= oldestBuf?.length || 0
        }
      }
      return { mimeType: MIME_BY_EXT[ext] || 'application/octet-stream', base64: buffer.toString('base64') }
    } catch (err: any) {
      logger.warn('resolve attachment failed:', ref, err?.message || err)
      return null
    }
  }

  /** 查询若干会话消息中引用的附件（必须在会话删除前调用候选收集） */
  collectRefsForConversations(convIds: string[]): string[] {
    try {
      const db = DatabaseService.getInstance().getDb()
      const stmt = db.prepare('SELECT messages_json FROM conversations WHERE id = ?')
      const refs = new Set<string>()
      for (const id of convIds) {
        const row = stmt.get(id) as any
        if (row?.messages_json) {
          try { collectAttachmentRefs(JSON.parse(row.messages_json), refs) } catch { /* skip */ }
        }
      }
      return [...refs]
    } catch (err: any) {
      logger.warn('collectRefsForConversations failed:', err?.message || err)
      return []
    }
  }

  /** 删除候选引用中已无任何对话引用的附件文件（保留本会话新落盘，防止误删草稿） */
  pruneRefs(candidates: string[]): void {
    try {
      const referenced = this.collectAllRefs()
      let removed = 0
      for (const ref of candidates) {
        if (referenced.has(ref) || this.sessionSaved.has(ref)) continue
        const filePath = this.getFilePathFromRef(ref)
        if (filePath && fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); removed++ } catch { /* ignore */ }
        }
        this.cache.delete(ref)
      }
      if (removed > 0) logger.info(`对话删除后清理附件 ${removed} 个`)
    } catch (err: any) {
      logger.warn('pruneRefs failed:', err?.message || err)
    }
  }

  /** 收集数据库中全部对话引用的附件引用集合 */
  private collectAllRefs(): Set<string> {
    const refs = new Set<string>()
    try {
      const db = DatabaseService.getInstance().getDb()
      const rows = db.prepare('SELECT messages_json FROM conversations WHERE messages_json LIKE \'%wa-attachment://%\'').all() as any[]
      for (const row of rows) {
        try { collectAttachmentRefs(JSON.parse(row.messages_json), refs) } catch { /* skip */ }
      }
    } catch (err: any) {
      logger.warn('collectAllRefs failed:', err?.message || err)
    }
    return refs
  }

  /** 启动 GC：删除磁盘上无引用且超过 24h 的孤儿附件 */
  gcOrphans(): void {
    if (this.prunning) return
    this.prunning = true
    try {
      const referenced = this.collectAllRefs()
      const dir = this.getDir()
      const cutoff = Date.now() - PRUNE_MIN_AGE_MS
      let removed = 0
      for (const shard of fs.readdirSync(dir)) {
        const shardPath = path.join(dir, shard)
        let stats
        try { stats = fs.statSync(shardPath) } catch { continue }
        if (!stats.isDirectory()) continue
        for (const name of fs.readdirSync(shardPath)) {
          if (!ATTACHMENT_REF_PATTERN.test(`wa-attachment://local/${name}`)) continue
          const filePath = path.join(shardPath, name)
          let stat
          try { stat = fs.statSync(filePath) } catch { continue }
          if (!stat.isFile()) continue
          if (stat.mtimeMs > cutoff) continue
          const ref = `wa-attachment://local/${name}`
          if (referenced.has(ref) || this.sessionSaved.has(ref)) continue
          try { fs.unlinkSync(filePath); removed++ } catch { /* ignore */ }
        }
      }
      if (removed > 0) logger.info(`附件 GC：清理无引用文件 ${removed} 个`)
    } catch (err: any) {
      logger.warn('gcOrphans failed:', err?.message || err)
    } finally {
      this.prunning = false
    }
  }

  /** 会话批量删除后延迟触发孤儿清理（防抖） */
  scheduleOrphanPrune(): void {
    if (this.orphanPruneTimer) clearTimeout(this.orphanPruneTimer)
    this.orphanPruneTimer = setTimeout(() => {
      this.orphanPruneTimer = null
      this.gcOrphans()
    }, 5000)
  }

  /** 启动维护：先把存量 base64 数据迁移为附件引用，再执行孤儿 GC（异步不阻塞启动）
   *  【WA-COMPAT:legacy-base64-migration】迁移按 LEGACY_MIGRATION_FLAG 一次性执行，完成标记后跳过 */
  startupMaintenance(): void {
    setTimeout(() => {
      try {
        if (!this.isLegacyMigrationDone()) {
          this.migrateExistingDataUrls()
        }
      } catch (err: any) {
        logger.warn('migrateExistingDataUrls failed:', err?.message || err)
      }
      try {
        this.gcOrphans()
      } catch (err: any) {
        logger.warn('startup gc failed:', err?.message || err)
      }
    }, 3000)
  }

  /** 【WA-COMPAT:legacy-base64-migration】迁移是否已在既往启动中完成（settings KV 标记） */
  private isLegacyMigrationDone(): boolean {
    try {
      const db = DatabaseService.getInstance().getDb()
      const row = db.prepare('SELECT value FROM settings WHERE key = ?')
        .get(AttachmentService.LEGACY_MIGRATION_FLAG) as { value: string } | undefined
      return row?.value === '1'
    } catch (err: any) {
      logger.warn('isLegacyMigrationDone failed:', err?.message || err)
      return false
    }
  }

  /** 【WA-COMPAT:legacy-base64-migration】置位迁移完成标记（settings KV） */
  private markLegacyMigrationDone(): void {
    try {
      const db = DatabaseService.getInstance().getDb()
      db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(AttachmentService.LEGACY_MIGRATION_FLAG, '1')
    } catch (err: any) {
      logger.warn('markLegacyMigrationDone failed:', err?.message || err)
    }
  }

  /** 存量迁移：messages_json 内的 data:image base64 抽出落盘并替换为引用（逐行更新，失败跳过）
   *  【WA-COMPAT:legacy-base64-migration】旧版本兼容，稳定后整体移除（含 LEGACY_MIGRATION_FLAG KV 键） */
  migrateExistingDataUrls(): void {
    const db = DatabaseService.getInstance().getDb()
    const rows = db.prepare(
      'SELECT id, messages_json FROM conversations WHERE messages_json LIKE \'%data:image/%\''
    ).all() as Array<{ id: string; messages_json: string }>
    if (rows.length === 0) {
      // 无存量数据即可置位完成标记，后续启动不再做 LIKE 扫描
      this.markLegacyMigrationDone()
      return
    }
    // 本轮有失败行（解析异常）时不置位，下次启动重试
    let failed = 0

    let migrated = 0
    const update = db.prepare('UPDATE conversations SET messages_json = ? WHERE id = ?')
    for (const row of rows) {
      try {
        const messages = JSON.parse(row.messages_json)
        const replaced = replaceDataUrlsWithRefs(messages)
        if (replaced.changed) {
          const tx = db.transaction(() => {
            update.run(JSON.stringify(replaced.value), row.id)
          })
          tx()
          migrated++
        }
      } catch (err: any) {
        failed++
        logger.warn(`迁移对话 ${row.id} 失败，跳过:`, err?.message || err)
      }
    }
    if (migrated > 0) logger.info(`存量图片迁移完成：${migrated} 条对话的 base64 数据已转为附件引用`)
    if (failed === 0) this.markLegacyMigrationDone()
  }
}

export default AttachmentService
