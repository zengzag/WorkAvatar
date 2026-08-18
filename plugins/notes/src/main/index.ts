/**
 * notes 内置插件主进程入口。
 * 由宿主 NotesService 迁移而来（保持全部功能）：
 * - vault 仍为宿主 dataDir/notes（用户自定义数据目录不变，笔记文件零搬迁）
 * - settings 从内核主库 settings 表一次性迁入插件分库（plugin_kv）
 * - IPC 经 ctx.ipc.handle 注册，广播经 ctx.ipc.broadcast 推送到主窗口 + tab 独立窗口
 */
import { app, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import type { PluginContext, PluginMigrationContext, PluginDatabase } from '../../../plugin-sdk/src'

// ====== 类型（从宿主 shared/channels/notes 迁入，插件不依赖宿主内部） ======

export type NoteNodeType = 'folder' | 'file'

export interface NoteNode {
  name: string
  relPath: string
  type: NoteNodeType
  mtime: number
  size: number
  children?: NoteNode[]
}

export interface NoteContent {
  relPath: string
  content: string
  mtime: number
  size: number
}

export interface NoteSearchSnippet {
  line: number
  text: string
}

export interface NoteSearchHit {
  relPath: string
  snippets: NoteSearchSnippet[]
}

export interface NotesSettings {
  editor_mode: 'edit' | 'split' | 'preview'
  last_opened: string | null
  open_tabs: string[]
  active_tab: string | null
  sidebar_collapsed: boolean
  outline_collapsed: boolean
  sidebar_width: number
  outline_width: number
  editor_max_width: number
  editor_font_size: number
  editor_line_height: number
  expanded_folders: string[]
  diary_enabled: boolean
  diary_root: string
}

export const DEFAULT_NOTES_SETTINGS: NotesSettings = {
  editor_mode: 'edit',
  last_opened: null,
  open_tabs: [],
  active_tab: null,
  sidebar_collapsed: false,
  outline_collapsed: false,
  sidebar_width: 260,
  outline_width: 260,
  editor_max_width: 820,
  editor_font_size: 15,
  editor_line_height: 1.7,
  expanded_folders: [],
  diary_enabled: false,
  diary_root: 'diary',
}

export interface NotesDataChangedPayload {
  scope: 'tree' | 'settings'
  ts: number
  self?: boolean
}

const SETTINGS_KEY = 'notes_settings'

// ====== 服务 ======

class NotesService {
  private vaultRoot: string
  private watcher: fs.FSWatcher | null = null
  private selfWritePaths = new Set<string>()
  private selfWriteTimer: NodeJS.Timeout | null = null
  private settingsCache: NotesSettings | null = null
  private debouncedBroadcastTimer: NodeJS.Timeout | null = null
  private treeCache: { tree: NoteNode[]; mtime: number } | null = null
  private kvDb: PluginDatabase | null = null

  constructor(private ctx: PluginContext) {
    const dataDir = ctx.services.host.getDataDir()
    this.vaultRoot = path.join(dataDir, 'notes')
    this.ensureDir(this.vaultRoot)
  }

  getVaultRoot(): string {
    return this.vaultRoot
  }

  /** settings 存插件分库 plugin_kv 表（与宿主 ctx.storage 同一 index.db）；先确保表存在 */
  private getKvDb(): PluginDatabase {
    if (!this.kvDb) {
      this.kvDb = this.ctx.storage.openSqlite('index')
      this.kvDb.exec('CREATE TABLE IF NOT EXISTS plugin_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    }
    return this.kvDb
  }

  // ====== watcher ======

  startWatcher(): void {
    if (this.watcher) return
    try {
      this.watcher = fs.watch(this.vaultRoot, { recursive: true }, (_eventType, filename) => {
        if (!filename) return
        this.scheduleBroadcast(filename)
      })
      this.watcher.on('error', (err) => {
        this.ctx.services.logger.warn('notes watcher error:', (err as Error)?.message || err)
      })
    } catch (err: any) {
      this.ctx.services.logger.warn('notes watcher start failed:', err?.message || err)
    }
  }

  stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }

  // ====== 路径安全 ======

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
      if (entry.name.startsWith('.')) continue
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
      const childAbs = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        const children = this.readDir(childAbs, childRel)
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

  renameItem(relPath: string, newName: string): { relPath: string } {
    const full = this.resolve(relPath)
    if (!fs.existsSync(full)) throw new Error('目标不存在')
    const isFile = fs.statSync(full).isFile()
    let finalName = this.sanitizeName(newName)
    if (!finalName) throw new Error('名称无效')
    if (isFile) {
      finalName = this.ensureMdExt(finalName)
    } else {
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

  getAbsolutePath(relPath: string): string {
    return this.resolve(relPath)
  }

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

  async deleteItem(relPath: string): Promise<{ success: boolean }> {
    const full = this.resolve(relPath)
    if (!fs.existsSync(full)) return { success: true }
    this.markSelfWrite(relPath)
    await this.moveToTrash(full)
    return { success: true }
  }

  private async moveToTrash(filePath: string): Promise<void> {
    try {
      await shell.trashItem(filePath)
    } catch {
      // 回收站不可用（如某些 Linux 环境）时回退到永久删除
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { recursive: true, force: true })
      }
    }
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

  // ====== 设置（插件分库 plugin_kv） ======

  getSettings(): NotesSettings {
    if (this.settingsCache) return this.settingsCache
    try {
      const row = this.getKvDb().prepare('SELECT value FROM plugin_kv WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined
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
      this.getKvDb().prepare(
        'INSERT INTO plugin_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(SETTINGS_KEY, JSON.stringify(next))
    } catch (err: any) {
      this.ctx.services.logger.warn('set notes settings failed:', err?.message || err)
    }
    return next
  }

  // ====== 日记 ======

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
    this.selfWriteTimer = setTimeout(() => {
      this.selfWritePaths.clear()
      this.selfWriteTimer = null
    }, 1500)
  }

  private scheduleBroadcast(filename: string): void {
    const relPath = this.toPosix(filename).replace(/^\//, '')
    const isSelf = this.selfWritePaths.has(relPath)
    this.invalidateTreeCache()
    if (this.debouncedBroadcastTimer) clearTimeout(this.debouncedBroadcastTimer)
    this.debouncedBroadcastTimer = setTimeout(() => {
      this.debouncedBroadcastTimer = null
      const payload: NotesDataChangedPayload = { scope: 'tree', ts: Date.now(), self: isSelf }
      this.ctx.ipc.broadcast('data-changed', payload)
    }, 200)
  }

  private invalidateTreeCache(): void {
    this.treeCache = null
  }
}

// ====== 迁移：把内核主库 notes_settings 迁入插件分库 ======

const _migrations = [
  {
    version: '1-migrate-settings',
    description: '迁移笔记设置从内核主库 settings 表到插件分库',
    async run(mig: PluginMigrationContext) {
      if (!mig.legacy) return
      try {
        const raw = mig.legacy.getSetting(SETTINGS_KEY) as string | undefined
        if (raw) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
          await mig.storage.set(SETTINGS_KEY, parsed)
          mig.logger.info('notes settings 已从内核主库迁移到插件分库')
        }
      } catch (err: any) {
        mig.logger.warn('notes settings 迁移失败（忽略，使用默认设置）:', err?.message || err)
      }
    },
  },
  {
    version: '2-migrate-settings-legacy',
    description: '补迁笔记设置（v1 因当时缺 legacyMigration 权限未执行；manifest 已补充权限）',
    async run(mig: PluginMigrationContext) {
      if (!mig.legacy) return
      try {
        const raw = mig.legacy.getSetting(SETTINGS_KEY) as string | undefined
        if (raw) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
          await mig.storage.set(SETTINGS_KEY, parsed)
          mig.logger.info('notes settings 已补迁到插件分库（展开状态/日记/编辑偏好恢复）')
        }
      } catch (err: any) {
        mig.logger.warn('notes settings 补迁失败（忽略，使用默认设置）:', err?.message || err)
      }
    },
  },
]

// ====== 激活 ======

let service: NotesService | null = null

export const migrations = _migrations

/** 由消息内容生成笔记标题：优先首个标题，其次首行非空文本，最后时间戳兜底 */
function buildNoteName(content: string): string {
  const headingMatch = content.match(/^#+\s+(.+)$/m)
  if (headingMatch) {
    const t = headingMatch[1].replace(/[*_`~\[\]]/g, '').trim().slice(0, 40)
    if (t) return t
  }
  const firstLine = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] || ''
  const cleaned = firstLine.replace(/^#+\s+/, '').replace(/[*_`~\[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (cleaned) return cleaned
  return `AI回复-${Date.now()}`
}

export function activate(ctx: PluginContext): void {
  service = new NotesService(ctx)
  registerIpc(ctx)
  // 通用插件能力：注册对话消息快捷操作 →"保存到笔记"（由宿主在任务对话中渲染按钮）
  ctx.contributions.registerMessageActions([{
    id: 'save-to-note',
    title: 'saveToNote',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 1.5h6L13 5v9.5h-9.5z"/><path d="M9.5 1.5V5H13"/><path d="M6 8.5h4M6 11h4"/></svg>',
    target: 'assistant',
    handler: async ({ content }) => {
      if (!service || !content) return { error: 'saveToNoteFailed' }
      try {
        const created = service.createNote('', buildNoteName(content))
        service.writeNote(created.relPath, content)
        return { success: 'saveToNoteSuccess' }
      } catch {
        return { error: 'saveToNoteFailed' }
      }
    },
  }])
  service.startWatcher()
  ctx.services.logger.info(`notes 插件激活完成，vault=${service.getVaultRoot()}`)
}

export function deactivate(): void {
  if (service) {
    service.stopWatcher()
    service = null
  }
}

function registerIpc(ctx: PluginContext): void {
  if (!service) return
  const s = service

  ctx.ipc.handle('list-tree', () => s.listTree())

  ctx.ipc.handle('read', (relPath: string) => {
    if (!relPath) return { error: 'relPath 必填' }
    return s.readNote(relPath)
  })

  ctx.ipc.handle('write', (params: { relPath: string; content: string }) => {
    if (!params?.relPath || typeof params.content !== 'string') {
      return { error: 'relPath 和 content 必填' }
    }
    return s.writeNote(params.relPath, params.content)
  })

  ctx.ipc.handle('create-note', (params: { parentRelPath: string; name: string }) => {
    if (!params?.name) return { error: 'name 必填' }
    return s.createNote(params.parentRelPath || '', params.name)
  })

  ctx.ipc.handle('create-folder', (params: { parentRelPath: string; name: string }) => {
    if (!params?.name) return { error: 'name 必填' }
    return s.createFolder(params.parentRelPath || '', params.name)
  })

  ctx.ipc.handle('rename', (params: { relPath: string; newName: string }) => {
    if (!params?.relPath || !params.newName) return { error: 'relPath 和 newName 必填' }
    return s.renameItem(params.relPath, params.newName)
  })

  ctx.ipc.handle('move', (params: { srcRelPath: string; destParentRelPath: string }) => {
    if (!params?.srcRelPath) return { error: 'srcRelPath 必填' }
    return s.moveItem(params.srcRelPath, params.destParentRelPath || '')
  })

  ctx.ipc.handle('copy', async (params: { srcRelPath: string; destParentRelPath: string }) => {
    if (!params?.srcRelPath) return { error: 'srcRelPath 必填' }
    return await s.copyItem(params.srcRelPath, params.destParentRelPath || '')
  })

  ctx.ipc.handle('delete', async (relPath: string) => {
    if (!relPath) return { error: 'relPath 必填' }
    return await s.deleteItem(relPath)
  })

  ctx.ipc.handle('search', async (params: { query: string; maxResults?: number }) => {
    if (!params?.query) return []
    return await s.search(params.query, params.maxResults)
  })

  ctx.ipc.handle('get-settings', () => s.getSettings())

  ctx.ipc.handle('set-settings', (params: Partial<NotesSettings>) => {
    return s.setSettings(params || {})
  })

  ctx.ipc.handle('get-abs-path', (relPath: string) => {
    if (!relPath) return { error: 'relPath 必填' }
    try {
      return { absPath: s.getAbsolutePath(relPath) }
    } catch (err: any) {
      return { error: err?.message || '获取路径失败' }
    }
  })

  ctx.ipc.handle('open-in-explorer', (relPath: string) => {
    if (!relPath) return { error: 'relPath 必填' }
    try {
      s.openInExplorer(relPath)
      return { success: true }
    } catch (err: any) {
      return { error: err?.message || '打开失败' }
    }
  })

  ctx.ipc.handle('open-vault', () => {
    try {
      shell.openPath(s.getVaultRoot())
      return { success: true }
    } catch (err: any) {
      return { error: err?.message || '打开失败' }
    }
  })

  ctx.ipc.handle('import-external', async (params: { srcAbsPath: string; destParentRelPath: string }) => {
    if (!params?.srcAbsPath) return { error: 'srcAbsPath 必填' }
    try {
      return await s.importExternal(params.srcAbsPath, params.destParentRelPath || '')
    } catch (err: any) {
      return { error: err?.message || '导入失败' }
    }
  })

  ctx.ipc.handle('save-image', (params: { buffer: ArrayBuffer; fileName: string }) => {
    if (!params?.buffer) return { error: 'buffer 必填' }
    try {
      const buffer = Buffer.from(params.buffer as ArrayBuffer)
      const relPath = s.saveImage(buffer, params.fileName || 'image.png')
      return { relPath }
    } catch (err: any) {
      return { error: err?.message || '保存图片失败' }
    }
  })

  ctx.ipc.handle('open-diary', () => {
    try {
      return s.openOrCreateDiary()
    } catch (err: any) {
      return { error: err?.message || '打开日记失败' }
    }
  })

  ctx.ipc.handle('read-external', (absPath: string) => {
    if (!absPath) return { error: 'absPath 必填' }
    try {
      return s.readExternalFile(absPath)
    } catch (err: any) {
      return { error: err?.message || '打开文件失败' }
    }
  })

  ctx.ipc.handle('write-external', (params: { absPath: string; content: string }) => {
    if (!params?.absPath || typeof params.content !== 'string') {
      return { error: 'absPath 和 content 必填' }
    }
    try {
      return s.writeExternalFile(params.absPath, params.content)
    } catch (err: any) {
      return { error: err?.message || '保存失败' }
    }
  })
}
