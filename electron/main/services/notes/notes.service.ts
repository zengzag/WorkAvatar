import fs from 'fs'
import path from 'path'
import { BrowserWindow, shell } from 'electron'
import PathService from '../path.service'
import { createLogger } from '../logger'
import { moveToTrash } from '../common-utils'
import {
  DEFAULT_NOTES_SETTINGS,
  NOTES_CHANNELS,
  type NoteNodeType,
  type NoteNode,
  type NoteContent,
  type NoteSearchHit,
  type NoteSearchSnippet,
  type NotesSettings,
} from '../../../shared/channels/notes'

const logger = createLogger('Notes')

// 类型从 shared 复用，避免重复定义
export type {
  NoteNodeType,
  NoteNode,
  NoteContent,
  NoteSearchHit,
  NoteSearchSnippet,
  NotesSettings,
}

const SETTINGS_KEY = 'notes_settings'

// ====== 服务 ======

class NotesService {
  private static instance: NotesService
  private vaultRoot: string
  private watcher: fs.FSWatcher | null = null
  /** 自身写操作触发的变更事件忽略窗口，避免刷新打断编辑器光标 */
  private selfWritePaths = new Set<string>()
  private selfWriteTimer: NodeJS.Timeout | null = null
  private settingsCache: NotesSettings | null = null
  private debouncedBroadcastTimer: NodeJS.Timeout | null = null
  private treeCache: { tree: NoteNode[]; mtime: number } | null = null

  private constructor() {
    const dataDir = PathService.getInstance().getDataDir()
    this.vaultRoot = path.join(dataDir, 'notes')
    this.ensureDir(this.vaultRoot)
  }

  static getInstance(): NotesService {
    if (!NotesService.instance) {
      NotesService.instance = new NotesService()
    }
    return NotesService.instance
  }

  getVaultRoot(): string {
    return this.vaultRoot
  }

  private invalidateTreeCache(): void {
    this.treeCache = null
  }

  /** 启动文件监听（应用启动时调用一次） */
  startWatcher(): void {
    if (this.watcher) return
    try {
      // Windows / macOS 支持 recursive；Linux 不支持，回退监听单目录（子目录变更需重建）
      this.watcher = fs.watch(this.vaultRoot, { recursive: true }, (_eventType, filename) => {
        if (!filename) return
        this.scheduleBroadcast(filename)
      })
      this.watcher.on('error', (err) => {
        logger.warn('notes watcher error:', (err as Error)?.message || err)
      })
    } catch (err: any) {
      logger.warn('notes watcher start failed:', err?.message || err)
    }
  }

  stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }

  // ====== 路径安全 ======

  /** 把 relPath 解析为 vault 内绝对路径，越界抛错 */
  private resolve(relPath: string): string {
    if (!relPath || typeof relPath !== 'string') {
      throw new Error('路径不能为空')
    }
    const normalized = path.normalize(relPath)
    if (path.isAbsolute(normalized)) {
      throw new Error('不允许绝对路径')
    }
    const full = path.resolve(this.vaultRoot, normalized)
    const rootWithSep = this.vaultRoot + path.sep
    if (full !== this.vaultRoot && !full.startsWith(rootWithSep)) {
      throw new Error('路径越界')
    }
    return full
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  private toPosix(p: string): string {
    return p.replace(/\\/g, '/')
  }

  // ====== 树读取 ======

  listTree(): NoteNode[] {
    try {
      const stat = fs.statSync(this.vaultRoot)
      if (this.treeCache && this.treeCache.mtime === stat.mtimeMs) {
        return this.treeCache.tree
      }
      const tree = this.readDir(this.vaultRoot, '')
      this.treeCache = { tree, mtime: stat.mtimeMs }
      return tree
    } catch {
      return this.readDir(this.vaultRoot, '')
    }
  }

  private readDir(absDir: string, relDir: string): NoteNode[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: NoteNode[] = []
    for (const entry of entries) {
      // 跳过隐藏文件 / 文件夹（. 开头）
      if (entry.name.startsWith('.')) continue
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
      const childAbs = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        const children = this.readDir(childAbs, childRel)
        // 空文件夹也保留，便于展示
        let stat: fs.Stats | null = null
        try { stat = fs.statSync(childAbs) } catch { /* ignore */ }
        nodes.push({
          name: entry.name,
          relPath: this.toPosix(childRel),
          type: 'folder',
          mtime: stat?.mtimeMs ?? 0,
          size: 0,
          children,
        })
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        let stat: fs.Stats | null = null
        try { stat = fs.statSync(childAbs) } catch { /* ignore */ }
        nodes.push({
          name: entry.name,
          relPath: this.toPosix(childRel),
          type: 'file',
          mtime: stat?.mtimeMs ?? 0,
          size: stat?.size ?? 0,
        })
      }
    }
    // 文件夹优先，各自按名称升序
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return nodes
  }

  // ====== 读写 ======

  readNote(relPath: string): NoteContent {
    const full = this.resolve(relPath)
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      throw new Error('笔记不存在')
    }
    if (!stat.isFile()) {
      throw new Error('笔记不存在')
    }
    const content = fs.readFileSync(full, 'utf-8')
    return {
      relPath: this.toPosix(relPath),
      content,
      mtime: stat.mtimeMs,
      size: stat.size,
    }
  }

  /** 写入笔记（创建或覆盖）。relPath 可指向已存在文件或新文件 */
  writeNote(relPath: string, content: string): NoteContent {
    const full = this.resolve(relPath)
    const parent = path.dirname(full)
    this.ensureDir(parent)
    this.markSelfWrite(relPath)
    fs.writeFileSync(full, content, 'utf-8')
    const stat = fs.statSync(full)
    return {
      relPath: this.toPosix(relPath),
      content,
      mtime: stat.mtimeMs,
      size: stat.size,
    }
  }

  /** 在指定父文件夹下创建空笔记，返回 relPath。重名自动加序号 */
  createNote(parentRelPath: string, name: string): NoteNode {
    const parentAbs = parentRelPath ? this.resolve(parentRelPath) : this.vaultRoot
    if (!fs.existsSync(parentAbs) || !fs.statSync(parentAbs).isDirectory()) {
      throw new Error('父文件夹不存在')
    }
    const baseName = this.sanitizeName(name) || '无标题笔记'
    const fileName = this.ensureMdExt(baseName)
    const finalName = this.uniqueName(parentAbs, fileName)
    const full = path.join(parentAbs, finalName)
    const relPath = parentRelPath
      ? this.toPosix(`${parentRelPath}/${finalName}`)
      : this.toPosix(finalName)
    this.markSelfWrite(relPath)
    fs.writeFileSync(full, '', 'utf-8')
    const stat = fs.statSync(full)
    return {
      name: finalName,
      relPath,
      type: 'file',
      mtime: stat.mtimeMs,
      size: 0,
    }
  }

  /** 在指定父文件夹下创建文件夹 */
  createFolder(parentRelPath: string, name: string): NoteNode {
    const parentAbs = parentRelPath ? this.resolve(parentRelPath) : this.vaultRoot
    if (!fs.existsSync(parentAbs) || !fs.statSync(parentAbs).isDirectory()) {
      throw new Error('父文件夹不存在')
    }
    const baseName = this.sanitizeName(name) || '新建文件夹'
    const finalName = this.uniqueName(parentAbs, baseName, true)
    const full = path.join(parentAbs, finalName)
    this.markSelfWrite(parentRelPath ? `${parentRelPath}/${finalName}` : finalName)
    fs.mkdirSync(full)
    const stat = fs.statSync(full)
    const relPath = parentRelPath
      ? this.toPosix(`${parentRelPath}/${finalName}`)
      : this.toPosix(finalName)
    return {
      name: finalName,
      relPath,
      type: 'folder',
      mtime: stat.mtimeMs,
      size: 0,
      children: [],
    }
  }

  /** 重命名文件 / 文件夹。返回新的 relPath */
  renameItem(relPath: string, newName: string): { relPath: string } {
    const full = this.resolve(relPath)
    if (!fs.existsSync(full)) throw new Error('目标不存在')
    const isFile = fs.statSync(full).isFile()
    let finalName = this.sanitizeName(newName)
    if (!finalName) throw new Error('名称无效')
    if (isFile) {
      finalName = this.ensureMdExt(finalName)
    } else {
      // 文件夹不允许带扩展名歧义，保留原样（去除末尾点）
      finalName = finalName.replace(/[.]+$/, '')
      if (!finalName) throw new Error('名称无效')
    }
    if (finalName === path.basename(full)) {
      return { relPath: this.toPosix(relPath) }
    }
    const parent = path.dirname(full)
    const dest = path.join(parent, finalName)
    if (fs.existsSync(dest)) throw new Error('已存在同名项')
    this.markSelfWrite(relPath)
    fs.renameSync(full, dest)
    const parentRel = path.dirname(relPath)
    const newRel = parentRel === '.' ? finalName : `${this.toPosix(parentRel)}/${finalName}`
    this.markSelfWrite(newRel)
    return { relPath: this.toPosix(newRel) }
  }

  /** 移动文件 / 文件夹到目标父文件夹 */
  moveItem(srcRelPath: string, destParentRelPath: string): { relPath: string } {
    const srcFull = this.resolve(srcRelPath)
    if (!fs.existsSync(srcFull)) throw new Error('源不存在')
    const destParentAbs = destParentRelPath ? this.resolve(destParentRelPath) : this.vaultRoot
    if (!fs.existsSync(destParentAbs) || !fs.statSync(destParentAbs).isDirectory()) {
      throw new Error('目标文件夹不存在')
    }
    const baseName = path.basename(srcFull)
    const destFull = path.join(destParentAbs, baseName)
    if (srcFull === destFull) {
      return { relPath: this.toPosix(srcRelPath) }
    }
    if (fs.existsSync(destFull)) throw new Error('目标已存在同名项')
    // 防止把文件夹移入自身
    if (fs.statSync(srcFull).isDirectory() && destFull.startsWith(srcFull + path.sep)) {
      throw new Error('不能移入自身子目录')
    }
    this.markSelfWrite(srcRelPath)
    fs.renameSync(srcFull, destFull)
    const newRel = destParentRelPath
      ? this.toPosix(`${destParentRelPath}/${baseName}`)
      : this.toPosix(baseName)
    this.markSelfWrite(newRel)
    return { relPath: newRel }
  }

  /** 复制文件 / 文件夹到目标父文件夹（重名自动加序号）。返回新的 relPath */
  async copyItem(srcRelPath: string, destParentRelPath: string): Promise<{ relPath: string }> {
    const srcFull = this.resolve(srcRelPath)
    if (!fs.existsSync(srcFull)) throw new Error('源不存在')
    const destParentAbs = destParentRelPath ? this.resolve(destParentRelPath) : this.vaultRoot
    if (!fs.existsSync(destParentAbs) || !fs.statSync(destParentAbs).isDirectory()) {
      throw new Error('目标文件夹不存在')
    }
    const baseName = path.basename(srcFull)
    const isFolder = fs.statSync(srcFull).isDirectory()
    const stem = isFolder ? baseName : baseName.replace(/\.md$/i, '')
    const finalName = this.uniqueName(destParentAbs, stem, isFolder)
    const destFull = path.join(destParentAbs, finalName)
    // 防止把文件夹复制到自身子目录
    if (isFolder && destFull.startsWith(srcFull + path.sep)) {
      throw new Error('不能复制到自身子目录')
    }
    await this.copyRecursiveAsync(srcFull, destFull)
    const newRel = destParentRelPath
      ? this.toPosix(`${destParentRelPath}/${finalName}`)
      : this.toPosix(finalName)
    this.markSelfWrite(newRel)
    return { relPath: newRel }
  }

  private async copyRecursiveAsync(src: string, dest: string): Promise<void> {
    const stat = await fs.promises.stat(src)
    if (stat.isDirectory()) {
      await fs.promises.mkdir(dest, { recursive: true })
      const entries = await fs.promises.readdir(src, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        await this.copyRecursiveAsync(path.join(src, entry.name), path.join(dest, entry.name))
      }
    } else {
      await fs.promises.copyFile(src, dest)
    }
  }

  /** 从 vault 外部导入文件 / 文件夹（重名自动加序号） */
  async importExternal(srcAbsPath: string, destParentRelPath: string): Promise<{ relPath: string }> {
    if (!srcAbsPath || !fs.existsSync(srcAbsPath)) throw new Error('源文件不存在')
    const destParentAbs = destParentRelPath ? this.resolve(destParentRelPath) : this.vaultRoot
    if (!fs.existsSync(destParentAbs) || !fs.statSync(destParentAbs).isDirectory()) {
      throw new Error('目标文件夹不存在')
    }
    const baseName = path.basename(srcAbsPath)
    const isFolder = fs.statSync(srcAbsPath).isDirectory()
    const finalName = this.uniqueName(destParentAbs, baseName, isFolder)
    const destFull = path.join(destParentAbs, finalName)
    if (isFolder && destFull.startsWith(srcAbsPath + path.sep)) {
      throw new Error('不能复制到自身子目录')
    }
    await this.copyRecursiveAsync(srcAbsPath, destFull)
    const newRel = destParentRelPath
      ? this.toPosix(`${destParentRelPath}/${finalName}`)
      : this.toPosix(finalName)
    this.markSelfWrite(newRel)
    return { relPath: newRel }
  }

  /** 获取笔记 / 文件夹的绝对路径（用于复制路径、资源管理器打开等） */
  getAbsolutePath(relPath: string): string {
    return this.resolve(relPath)
  }

  /** 在系统资源管理器中打开：文件高亮定位，文件夹直接打开 */
  openInExplorer(relPath: string): void {
    const full = this.resolve(relPath)
    if (!fs.existsSync(full)) throw new Error('目标不存在')
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      shell.openPath(full)
    } else {
      shell.showItemInFolder(full)
    }
  }

  /** 读取 vault 外部 .md 文件（按绝对路径，用于临时打开） */
  readExternalFile(absPath: string): NoteContent {
    if (!absPath || typeof absPath !== 'string') throw new Error('路径不能为空')
    const resolved = path.resolve(absPath)
    if (!resolved.toLowerCase().endsWith('.md')) throw new Error('仅支持 .md 文件')
    let stat: fs.Stats
    try {
      stat = fs.statSync(resolved)
    } catch {
      throw new Error('文件不存在')
    }
    if (!stat.isFile()) throw new Error('不是文件')
    const content = fs.readFileSync(resolved, 'utf-8')
    return {
      relPath: resolved,
      content,
      mtime: stat.mtimeMs,
      size: stat.size,
    }
  }

  /** 写入 vault 外部 .md 文件（按绝对路径，用于临时编辑保存） */
  writeExternalFile(absPath: string, content: string): NoteContent {
    if (!absPath || typeof absPath !== 'string') throw new Error('路径不能为空')
    const resolved = path.resolve(absPath)
    if (!resolved.toLowerCase().endsWith('.md')) throw new Error('仅支持 .md 文件')
    fs.writeFileSync(resolved, content, 'utf-8')
    const stat = fs.statSync(resolved)
    return {
      relPath: resolved,
      content,
      mtime: stat.mtimeMs,
      size: stat.size,
    }
  }

  /** 删除文件 / 文件夹（移至操作系统回收站，可找回） */
  async deleteItem(relPath: string): Promise<{ success: boolean }> {
    const full = this.resolve(relPath)
    if (!fs.existsSync(full)) return { success: true }
    this.markSelfWrite(relPath)
    await moveToTrash(full)
    return { success: true }
  }

  // ====== 搜索 ======

  async search(query: string, maxResults = 100): Promise<NoteSearchHit[]> {
    const q = (query || '').trim()
    if (!q) return []
    const lowerQ = q.toLowerCase()
    const hits: NoteSearchHit[] = []
    const files: string[] = []
    this.collectMdFiles(this.vaultRoot, '', files)
    for (const file of files) {
      if (hits.length >= maxResults) break
      let content: string
      try {
        content = await fs.promises.readFile(path.join(this.vaultRoot, file), 'utf-8')
      } catch {
        continue
      }
      const lines = content.split(/\r?\n/)
      const snippets: NoteSearchSnippet[] = []
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerQ)) {
          snippets.push({ line: i, text: this.truncateLine(lines[i], q) })
          if (snippets.length >= 3) break
        }
      }
      // 文件名命中也算一条
      const nameHit = file.toLowerCase().includes(lowerQ) && snippets.length === 0
      if (snippets.length > 0 || nameHit) {
        hits.push({ relPath: this.toPosix(file), snippets })
      }
    }
    return hits
  }

  private collectMdFiles(absDir: string, relDir: string, out: string[]): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
      const childAbs = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        this.collectMdFiles(childAbs, childRel, out)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(childRel)
      }
    }
  }

  private truncateLine(line: string, query: string): string {
    const max = 200
    const trimmed = line.replace(/\s+/g, ' ').trim()
    if (trimmed.length <= max) return trimmed
    const idx = trimmed.toLowerCase().indexOf(query.toLowerCase())
    if (idx < 0) return trimmed.slice(0, max) + '…'
    const start = Math.max(0, idx - 40)
    const end = Math.min(trimmed.length, idx + query.length + 80)
    return (start > 0 ? '…' : '') + trimmed.slice(start, end) + (end < trimmed.length ? '…' : '')
  }

  /** 保存粘贴/上传的图片到 vault 的 attachments 目录，返回 markdown 相对路径 */
  saveImage(buffer: Buffer, fileName: string): string {
    const attachmentsDir = path.join(this.vaultRoot, 'attachments')
    if (!fs.existsSync(attachmentsDir)) {
      fs.mkdirSync(attachmentsDir, { recursive: true })
    }
    const ext = path.extname(fileName) || '.png'
    const baseName = path.basename(fileName, ext).replace(/[^\w\u4e00-\u9fa5-]/g, '_')
    const timestamp = Date.now()
    const uniqueName = `${baseName}_${timestamp}${ext}`
    const absPath = path.join(attachmentsDir, uniqueName)
    fs.writeFileSync(absPath, buffer)
    this.markSelfWrite(`attachments/${uniqueName}`)
    return `attachments/${uniqueName}`
  }

  // ====== 设置 ======

  getSettings(): NotesSettings {
    if (this.settingsCache) return this.settingsCache
    try {
      const db = this.getSettingsDb()
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as any
      if (row?.value) {
        const parsed = JSON.parse(row.value)
        this.settingsCache = { ...DEFAULT_NOTES_SETTINGS, ...parsed }
      } else {
        this.settingsCache = { ...DEFAULT_NOTES_SETTINGS }
      }
    } catch {
      this.settingsCache = { ...DEFAULT_NOTES_SETTINGS }
    }
    return this.settingsCache!
  }

  setSettings(patch: Partial<NotesSettings>): NotesSettings {
    const current = this.getSettings()
    const next: NotesSettings = { ...current, ...patch }
    this.settingsCache = next
    try {
      const db = this.getSettingsDb()
      db.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      ).run(SETTINGS_KEY, JSON.stringify(next))
    } catch (err: any) {
      logger.warn('set notes settings failed:', err?.message || err)
    }
    return next
  }

  // ====== 日记 ======

  /** 打开今日日记：在 diary_root 下创建/打开以 YYYY.MM.DD.md 命名的文件 */
  openOrCreateDiary(): { relPath: string; created: boolean } {
    const settings = this.getSettings()
    if (!settings.diary_enabled) throw new Error('日记功能未启用')
    const rootRel = (settings.diary_root || '').trim() || 'diary'
    const rootFull = this.resolve(rootRel)
    if (fs.existsSync(rootFull) && !fs.statSync(rootFull).isDirectory()) {
      throw new Error('日记根目录已被文件占用')
    }
    this.ensureDir(rootFull)
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    const fileName = `${y}.${m}.${d}.md`
    const fileFull = path.join(rootFull, fileName)
    const relPath = this.toPosix(path.relative(this.vaultRoot, fileFull))
    let created = false
    if (!fs.existsSync(fileFull)) {
      this.markSelfWrite(relPath)
      fs.writeFileSync(fileFull, '', 'utf-8')
      created = true
    }
    return { relPath, created }
  }

  // ====== 名称处理 ======

  private sanitizeName(name: string): string {
    return (name || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/^\.+/, '')
      .trim()
  }

  private ensureMdExt(name: string): string {
    if (name.toLowerCase().endsWith('.md')) return name
    return `${name}.md`
  }

  private uniqueName(parentAbs: string, name: string, isFolder = false): string {
    const candidate = isFolder ? name : this.ensureMdExt(name)
    if (!fs.existsSync(path.join(parentAbs, candidate))) return candidate
    const ext = isFolder ? '' : '.md'
    const stem = isFolder ? name : name.replace(/\.md$/i, '')
    for (let i = 2; i < 1000; i++) {
      const tryName = `${stem} ${i}${ext}`
      if (!fs.existsSync(path.join(parentAbs, tryName))) return tryName
    }
    return `${candidate}.${Date.now()}`
  }

  // ====== 自写忽略 + 广播 ======

  private markSelfWrite(relPath: string): void {
    this.selfWritePaths.add(this.toPosix(relPath))
    if (this.selfWriteTimer) clearTimeout(this.selfWriteTimer)
    // 1.5s 内的连续自写合并，之后清空
    this.selfWriteTimer = setTimeout(() => {
      this.selfWritePaths.clear()
      this.selfWriteTimer = null
    }, 1500)
  }

  private scheduleBroadcast(filename: string): void {
    const relPath = this.toPosix(filename).replace(/^\//, '')
    // 自身写触发的变更：仅静默刷新树，不强制重载当前编辑器内容
    const isSelf = this.selfWritePaths.has(relPath)
    this.invalidateTreeCache()
    if (this.debouncedBroadcastTimer) clearTimeout(this.debouncedBroadcastTimer)
    this.debouncedBroadcastTimer = setTimeout(() => {
      this.debouncedBroadcastTimer = null
      this.broadcast({ scope: 'tree', ts: Date.now(), self: isSelf })
    }, 200)
  }

  private broadcast(payload: { scope: 'tree' | 'settings'; ts: number; self?: boolean }): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send(NOTES_CHANNELS.NOTES_DATA_CHANGED, payload)
        } catch { /* ignore */ }
      }
    }
  }

  private settingsDb: any = null
  private getSettingsDb(): any {
    if (this.settingsDb) return this.settingsDb
    // 复用主库连接
    this.settingsDb = require('../database.service').default.getInstance().getDb()
    return this.settingsDb
  }
}

export default NotesService
