import { app, BrowserWindow, globalShortcut, shell } from 'electron'
import { createRequire } from 'module'
import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'
import { createLogger } from '../logger'
import DatabaseService from '../database.service'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import type {
  PluginEventPayload,
  PluginInfo,
  PluginNavItemInfo,
  PluginRendererInfo,
} from '../../../shared/channels/plugin'
import type {
  PluginContext,
  PluginDatabase,
  PluginManifest,
  PluginMigration,
  PluginServices,
} from '../../../../plugins/plugin-sdk/src'

const logger = createLogger('PluginHost')

/** 宿主插件协议版本（manifest.engine 与此比对，破坏性变更升 major） */
export const PLUGIN_PROTOCOL_VERSION = '0.1.0'

/** manifest.id 保留字：与内核导航/宿主通用桥冲突 */
const RESERVED_IDS = ['settings', 'tasks', 'employees', 'list', 'invoke', 'event']

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/

/** 极简 semver：解析 x.y.z 与 >=a.b.c / ^x.y.z / * 组合范围，满足插件 engine 校验需求 */
function parseVersion(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function engineSatisfies(engine: string, host: string): boolean {
  const range = engine.trim()
  if (range === '*' || range === '') return true
  const hostV = parseVersion(host)
  if (!hostV) return false
  for (const part of range.split(/\s+/)) {
    const m = /^(>=|<=|>|<|\^)?(\d+\.\d+\.\d+|\*)$/.exec(part)
    if (!m) return false
    const [, op, ver] = m
    if (ver === '*') continue
    const target = parseVersion(ver)!
    const cmp = hostV[0] !== target[0] ? hostV[0] - target[0]
      : hostV[1] !== target[1] ? hostV[1] - target[1]
      : hostV[2] - target[2]
    let ok: boolean
    switch (op || '>=') {
      case '>=': ok = cmp >= 0; break
      case '<=': ok = cmp <= 0; break
      case '>': ok = cmp > 0; break
      case '<': ok = cmp < 0; break
      case '^': ok = hostV[0] === target[0] && cmp >= 0; break
      default: ok = cmp >= 0
    }
    if (!ok) return false
  }
  return true
}

interface PluginRecord {
  manifest: PluginManifest
  source: 'builtin' | 'user'
  rootDir: string
  enabled: boolean
  engineOk: boolean
  /** active: activate 成功；error: 激活抛错；invalid: manifest/engine 校验失败 */
  status: 'active' | 'disabled' | 'invalid' | 'error'
  statusMessage?: string
  /** activate 成功后的主进程模块（含 deactivate） */
  module?: { deactivate?: () => void | Promise<void> }
}

interface CollectedContributions {
  agentTools: unknown[]
  mcpTools: unknown[]
  fileAssociations: Map<string, string> // 扩展名(小写含点) → pluginId
}

const SETTINGS_KEY = 'plugins.config'

/**
 * 插件宿主：
 * - 双目录扫描（resources/plugins 内置 + userData/plugins 用户），同一套加载器
 * - manifest 校验 → 启停过滤 → migrations → activate(ctx)，单插件异常隔离
 * - 通用 IPC 桥（plugin-host:invoke 按前缀路由到插件 handler）
 * - 贡献点收集（agent 工具 / MCP 工具 / 文件关联 / 全局快捷键）
 * - plugin:// 协议文件服务（见 registerPluginProtocol）
 */
class PluginHostService {
  private static instance: PluginHostService
  private records = new Map<string, PluginRecord>()
  /** plugin:<id>:<channel> → handler */
  private handlers = new Map<string, (payload: unknown) => Promise<unknown> | unknown>()
  private contributions = new Map<string, CollectedContributions>()
  /** 本宿主注册的全局快捷键（退出时统一注销） */
  private registeredShortcuts = new Set<string>()
  /** 插件渲染端窗口集合（主窗口 + tab 独立窗口），broadcast 时遍历 */
  private targets = new Set<BrowserWindow>()
  private dataDir = ''
  private initialized = false

  private constructor() {}

  static getInstance(): PluginHostService {
    if (!PluginHostService.instance) {
      PluginHostService.instance = new PluginHostService()
    }
    return PluginHostService.instance
  }

  // ====== 目录 ======

  private getBuiltinDir(): string {
    // 打包模式：plugins 随 extraResources 复制到 resources/plugins（app.asar 之外）
    // 未打包（dev / electron .）：主进程位于 <root>/dist-electron/main，插件在 <root>/plugins
    // 按存在性择优，避免仅依赖 app.isPackaged（electron . 在部分环境下判定异常）
    const candidates = [
      path.join(process.resourcesPath, 'plugins'),
      path.join(__dirname, '..', '..', 'plugins'),
    ]
    return candidates.find(p => fs.existsSync(p)) ?? candidates[app.isPackaged ? 0 : 1]
  }

  private getUserDir(): string {
    const { default: PathService } = require('../path.service')
    return path.join(PathService.getInstance().getDataDir(), 'plugins')
  }

  private getPluginDataDir(id: string): string {
    return path.join(this.dataDir, id)
  }

  // ====== 启停配置（内核 settings KV） ======

  private readDisabledList(): Set<string> {
    try {
      const row = DatabaseService.getInstance().getDb()
        .prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined
      if (!row?.value) return new Set()
      const parsed = JSON.parse(row.value)
      return new Set(Array.isArray(parsed?.disabled) ? parsed.disabled : [])
    } catch {
      return new Set()
    }
  }

  private writeDisabledList(disabled: Set<string>): void {
    DatabaseService.getInstance().getDb()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SETTINGS_KEY, JSON.stringify({ disabled: Array.from(disabled) }))
  }

  // ====== 扫描与激活 ======

  /** 应用启动时调用：扫描 → 校验 → 迁移 → 激活。必须在内核 agent 服务初始化之前完成 */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    const { default: PathService } = require('../path.service')
    const dataDir = PathService.getInstance().getDataDir()
    this.dataDir = path.join(dataDir, 'plugin-data')
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.mkdirSync(this.getUserDir(), { recursive: true })

    // 一次性迁移：旧 userData/plugin-data → 新 dataDir/plugin-data
    const oldDataDir = path.join(app.getPath('userData'), 'plugin-data')
    if (fs.existsSync(oldDataDir) && oldDataDir !== this.dataDir) {
      try {
        for (const id of fs.readdirSync(oldDataDir)) {
          const src = path.join(oldDataDir, id)
          if (!fs.statSync(src).isDirectory()) continue
          const dst = path.join(this.dataDir, id)
          if (!fs.existsSync(dst)) {
            fs.mkdirSync(dst, { recursive: true })
            for (const f of fs.readdirSync(src)) {
              try { fs.copyFileSync(path.join(src, f), path.join(dst, f)) } catch { /* ignore */ }
            }
          }
        }
        logger.info(`插件数据已从旧目录迁移: ${oldDataDir} → ${this.dataDir}`)
      } catch (err: any) {
        logger.warn('插件数据迁移失败（忽略，新位置会重建）:', err?.message || err)
      }
    }

    // 一次性迁移：旧 userData/plugins（用户插件）→ 新 dataDir/plugins
    const oldUserPlugins = path.join(app.getPath('userData'), 'plugins')
    const newUserPlugins = this.getUserDir()
    if (fs.existsSync(oldUserPlugins) && oldUserPlugins !== newUserPlugins) {
      try {
        for (const name of fs.readdirSync(oldUserPlugins)) {
          const src = path.join(oldUserPlugins, name)
          const dst = path.join(newUserPlugins, name)
          if (!fs.existsSync(dst)) fs.cpSync(src, dst, { recursive: true })
        }
        logger.info(`用户插件已从旧目录迁移: ${oldUserPlugins} → ${newUserPlugins}`)
      } catch (err: any) {
        logger.warn('用户插件迁移失败（忽略）:', err?.message || err)
      }
    }

    const disabled = this.readDisabledList()
    const builtinDir = this.getBuiltinDir()
    const userDir = this.getUserDir()
    logger.info(`插件扫描: isPackaged=${app.isPackaged} appPath=${app.getAppPath()} resourcesPath=${process.resourcesPath}`)
    logger.info(`插件扫描: builtin=${builtinDir} (存在=${fs.existsSync(builtinDir)}) | user=${userDir} (存在=${fs.existsSync(userDir)})`)
    for (const [source, dir] of [['builtin', builtinDir], ['user', userDir]] as const) {
      let entries: string[] = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => e.isDirectory() && e.name !== 'plugin-sdk')
          .map(e => e.name)
      } catch { /* 目录不存在则跳过 */ }
      for (const name of entries) {
        this.scanPlugin(path.join(dir, name), source, disabled)
      }
    }
    logger.info(`插件扫描完成: 共 ${this.records.size} 个插件，${Array.from(this.records.values()).filter(r => r.status === 'invalid').length} 个无效`)
    for (const [id, r] of this.records) {
      if (r.status === 'invalid') logger.warn(`插件无效 ${id}: ${r.statusMessage ?? ''}`)
    }

    for (const record of this.records.values()) {
      if (!record.enabled) continue
      if (record.status === 'invalid') continue
      this.activateRecord(record)
    }
  }

  private scanPlugin(rootDir: string, source: 'builtin' | 'user', disabled: Set<string>): void {
    const fail = (message: string) => {
      this.records.set(rootDir, {
        manifest: { id: path.basename(rootDir), name: path.basename(rootDir), version: '0.0.0', engine: '*', main: '' },
        source, rootDir, enabled: false, engineOk: false, status: 'invalid', statusMessage: message,
      })
    }
    const manifestPath = path.join(rootDir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) return fail('缺少 manifest.json')
    let manifest: PluginManifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (err: any) {
      return fail(`manifest.json 解析失败: ${err?.message || err}`)
    }
    if (!ID_RE.test(manifest.id ?? '')) return fail(`id 非法: ${manifest.id}`)
    if (RESERVED_IDS.includes(manifest.id)) return fail(`id 为保留字: ${manifest.id}`)
    if (!manifest.main) return fail('缺少 main 入口')
    const entryPath = path.join(rootDir, manifest.main)
    if (!fs.existsSync(entryPath)) return fail(`主进程入口不存在: ${manifest.main}`)
    const engineOk = engineSatisfies(manifest.engine ?? '*', PLUGIN_PROTOCOL_VERSION)
    if (!engineOk) return fail(`engine 不兼容: 需要 ${manifest.engine}，宿主协议 ${PLUGIN_PROTOCOL_VERSION}`)
    if (this.records.has(manifest.id)) {
      logger.warn(`插件 id 冲突，忽略后发现的: ${manifest.id} (${rootDir})`)
      return
    }
    const enabled = !disabled.has(manifest.id)
    this.records.set(manifest.id, {
      manifest, source, rootDir, enabled, engineOk,
      status: enabled ? 'error' : 'disabled',
      statusMessage: enabled ? '尚未激活' : undefined,
    })
  }

  private activateRecord(record: PluginRecord): void {
    const { manifest, rootDir } = record
    try {
      const req = createRequire(__filename)
      const mod = req(path.join(rootDir, manifest.main)) as {
        migrations?: PluginMigration[]
        activate: (ctx: PluginContext) => void | Promise<void>
        deactivate?: () => void | Promise<void>
      }
      if (typeof mod.activate !== 'function') throw new Error('主进程入口缺少 activate 导出')

      const ctx = this.buildContext(record)
      this.runMigrations(record, mod.migrations ?? [], ctx)
      mod.activate(ctx)
      record.module = { deactivate: mod.deactivate }
      record.status = 'active'
      record.statusMessage = undefined
      logger.info(`插件已激活: ${manifest.id} v${manifest.version} (${record.source})`)
    } catch (err: any) {
      record.status = 'error'
      record.statusMessage = err?.message || String(err)
      logger.error(`插件激活失败: ${manifest.id}:`, record.statusMessage)
    }
  }

  private runMigrations(record: PluginRecord, migrations: PluginMigration[], ctx: PluginContext): void {
    if (!migrations.length) return
    const db = this.openPluginDatabase(record.manifest.id)
    db.exec('CREATE TABLE IF NOT EXISTS plugin_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
    const applied = new Set(
      (db.prepare('SELECT version FROM plugin_migrations').all() as { version: string }[]).map(r => r.version)
    )
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue
      logger.info(`执行插件迁移 ${record.manifest.id}@${migration.version}`)
      const run = db.transaction(() => {
        migration.run({
          storage: ctx.storage,
          legacy: this.hasPermission(record, 'legacyMigration') ? this.buildLegacyReader() : null,
          logger: ctx.services.logger,
        })
        db.prepare('INSERT INTO plugin_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString())
      })
      run() // 事务失败即抛错 → activateRecord 捕获 → 插件标记 error
    }
  }

  // ====== ctx 组装 ======

  private hasPermission(record: PluginRecord, permission: string): boolean {
    return (record.manifest.permissions ?? []).includes(permission as never)
  }

  private openPluginDatabase(id: string, name = 'index'): Database.Database {
    const dir = this.getPluginDataDir(id)
    fs.mkdirSync(dir, { recursive: true })
    const db = new Database(path.join(dir, `${name}.db`))
    db.pragma('journal_mode = WAL')
    return db
  }

  /** 插件 KV 专用连接（index.db，按插件缓存复用） */
  private kvDbs = new Map<string, Database.Database>()

  private getKvDb(id: string): Database.Database {
    let db = this.kvDbs.get(id)
    if (!db) {
      db = this.openPluginDatabase(id)
      db.exec('CREATE TABLE IF NOT EXISTS plugin_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      this.kvDbs.set(id, db)
    }
    return db
  }

  private buildContext(record: PluginRecord): PluginContext {
    const { manifest } = record
    const pluginLogger = createLogger(`Plugin:${manifest.id}`)
    const services: PluginServices = {
      logger: pluginLogger,
      host: {
        getDataDir: () => {
          const { default: PathService } = require('../path.service')
          return PathService.getInstance().getDataDir()
        },
      },
    }

    if (this.hasPermission(record, 'notifications')) {
      const { default: NotificationService } = require('../notification.service')
      services.notification = {
        notify: (payload) => NotificationService.getInstance().notify({
          title: payload.title,
          body: payload.body,
          source: `plugin:${manifest.id}`,
          silent: payload.silent,
        }),
      }
    }

    const contributions: CollectedContributions = {
      agentTools: [], mcpTools: [], fileAssociations: new Map(),
    }
    this.contributions.set(manifest.id, contributions)

    const record_ = record
    return {
      manifest,
      hostVersion: app.getVersion(),
      paths: {
        root: record_.rootDir,
        data: this.getPluginDataDir(manifest.id),
        resources: path.join(record_.rootDir, 'resources'),
      },
      ipc: {
        handle: (channel, handler) => {
          if (!channel || channel.includes(':')) throw new Error(`非法通道名: ${channel}`)
          const scope = manifest.ipc ?? []
          if (!scope.includes('*') && !scope.includes(channel)) {
            throw new Error(`通道 "${channel}" 未在 manifest.ipc 声明`)
          }
          this.handlers.set(`plugin:${manifest.id}:${channel}`, handler)
        },
        broadcast: (event, payload) => {
          this.broadcast(manifest.id, event, payload)
        },
      },
      storage: {
        rootDir: record_.rootDir,
        resourcesDir: path.join(record_.rootDir, 'resources'),
        dataDir: this.getPluginDataDir(manifest.id),
        openSqlite: (name?: string) => this.openPluginDatabase(manifest.id, name || 'index') as unknown as PluginDatabase,
        get: async <T,>(key: string, defaultValue?: T) => {
          const row = this.getKvDb(manifest.id).prepare('SELECT value FROM plugin_kv WHERE key = ?').get(key) as { value: string } | undefined
          if (!row) return defaultValue
          try { return JSON.parse(row.value) as T } catch { return defaultValue }
        },
        set: async (key: string, value: unknown) => {
          this.getKvDb(manifest.id)
            .prepare('INSERT INTO plugin_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, JSON.stringify(value))
        },
        delete: async (key: string) => {
          this.getKvDb(manifest.id).prepare('DELETE FROM plugin_kv WHERE key = ?').run(key)
        },
        keys: async () => {
          return (this.getKvDb(manifest.id).prepare('SELECT key FROM plugin_kv').all() as { key: string }[]).map(r => r.key)
        },
      },
      services,
      contributions: {
        registerAgentTools: (tools) => {
          for (const tool of tools) {
            const dup = this.findToolOwner(tool.id)
            if (dup) throw new Error(`工具 id "${tool.id}" 已被插件 ${dup} 注册`)
          }
          contributions.agentTools.push(...tools)
        },
        registerMcpTools: (tools) => { contributions.mcpTools.push(...tools) },
        registerFileAssociations: (assocs) => {
          for (const a of assocs) contributions.fileAssociations.set(a.extension.toLowerCase(), manifest.id)
        },
        registerGlobalShortcuts: (shortcuts) => {
          if (!this.hasPermission(record_, 'globalShortcuts')) {
            throw new Error('未声明 globalShortcuts 权限')
          }
          for (const s of shortcuts) {
            const accelerator = s.accelerator
            globalShortcut.register(accelerator, () => Promise.resolve(s.handler()).catch(e => pluginLogger.error('快捷键执行失败:', e)))
            this.registeredShortcuts.add(accelerator)
          }
        },
      },
    }
  }

  private findToolOwner(toolId: string): string | undefined {
    for (const [id, c] of this.contributions) {
      if (c.agentTools.some(t => (t as { id: string }).id === toolId)) return id
    }
    return undefined
  }

  private buildLegacyReader() {
    const db = DatabaseService.getInstance().getDb()
    const isSelect = (sql: string) => /^\s*select/i.test(sql)
    return {
      listTables: () =>
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name),
      all: (sql: string, ...params: unknown[]) => {
        if (!isSelect(sql)) throw new Error('legacy 只读：仅允许 SELECT')
        return db.prepare(sql).all(...params)
      },
      get: (sql: string, ...params: unknown[]) => {
        if (!isSelect(sql)) throw new Error('legacy 只读：仅允许 SELECT')
        return db.prepare(sql).get(...params)
      },
      getSetting: (key: string) =>
        (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value,
    }
  }

  // ====== IPC 通用桥 ======

  /** preload 通用调用桥入口：按 plugin:<id>:<channel> 路由到插件 handler */
  dispatch(pluginId: string, channel: string, payload: unknown): Promise<unknown> {
    const record = this.records.get(pluginId)
    if (!record || record.status !== 'active') {
      return Promise.reject(new Error(`插件不可用: ${pluginId}`))
    }
    const handler = this.handlers.get(`plugin:${pluginId}:${channel}`)
    if (!handler) return Promise.reject(new Error(`通道未注册: plugin:${pluginId}:${channel}`))
    return Promise.resolve(handler(payload))
  }

  /** 主进程 → 本插件所有渲染端推送事件 */
  broadcast(pluginId: string, event: string, payload?: unknown): void {
    const message: PluginEventPayload = { pluginId, event, payload }
    for (const win of this.targets) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.PLUGIN_EVENT, message)
      }
    }
  }

  addTarget(win: BrowserWindow): void {
    this.targets.add(win)
    win.on('closed', () => this.targets.delete(win))
  }

  // ====== 渲染端信息 ======

  listPlugins(): PluginInfo[] {
    return Array.from(this.records.values()).map(r => ({
      id: r.manifest.id,
      name: r.manifest.name,
      version: r.manifest.version,
      description: r.manifest.description,
      author: r.manifest.author,
      source: r.source,
      enabled: r.enabled,
      status: r.status,
      statusMessage: r.statusMessage,
      nav: r.manifest.nav ? {
        label: r.manifest.nav.label,
        icon: r.manifest.nav.icon,
        order: r.manifest.nav.order ?? 100,
        detachable: r.manifest.nav.detachable ?? false,
      } : undefined,
      hasRenderer: !!r.manifest.renderer,
    })).sort((a, b) => a.id.localeCompare(b.id))
  }

  /** 渲染端动态加载所需的插件信息（仅激活成功且有渲染端入口） */
  getRendererPlugins(): PluginRendererInfo[] {
    const result: PluginRendererInfo[] = []
    for (const r of this.records.values()) {
      if (r.status !== 'active' || !r.manifest.renderer) continue
      const locales: Record<string, Record<string, unknown>> = {}
      const localeDir = path.join(r.rootDir, r.manifest.locale ?? 'locale')
      try {
        for (const file of fs.readdirSync(localeDir)) {
          const m = /^([\w-]+)\.json$/.exec(file)
          if (!m) continue
          try { locales[m[1]] = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf-8')) } catch { /* 忽略坏文件 */ }
        }
      } catch { /* 无 locale 目录 */ }
      result.push({
        id: r.manifest.id,
        name: r.manifest.name,
        entry: r.manifest.renderer,
        nav: r.manifest.nav ? {
          label: r.manifest.nav.label,
          icon: r.manifest.nav.icon,
          order: r.manifest.nav.order ?? 100,
          detachable: r.manifest.nav.detachable ?? false,
        } : undefined,
        locales,
      })
    }
    return result
  }

  // ====== 管理操作 ======

  setEnabled(pluginId: string, enabled: boolean): void {
    const record = this.records.get(pluginId)
    if (!record) throw new Error(`插件不存在: ${pluginId}`)
    const disabled = this.readDisabledList()
    if (enabled) disabled.delete(pluginId)
    else disabled.add(pluginId)
    this.writeDisabledList(disabled)
    record.enabled = enabled
    logger.info(`插件${enabled ? '启用' : '禁用'}: ${pluginId}（重启生效）`)
  }

  deletePlugin(pluginId: string): void {
    const record = this.records.get(pluginId)
    if (!record) throw new Error(`插件不存在: ${pluginId}`)
    if (record.source !== 'user') throw new Error('内置插件不可删除，可改为禁用')
    fs.rmSync(record.rootDir, { recursive: true, force: true })
    this.records.delete(pluginId)
    logger.info(`插件已删除: ${pluginId}`)
  }

  openUserPluginsDir(): void {
    fs.mkdirSync(this.getUserDir(), { recursive: true })
    shell.openPath(this.getUserDir())
  }

  // ====== 查询接口（宿主内部使用） ======

  getPluginNavItem(id: string): PluginNavItemInfo | undefined {
    const r = this.records.get(id)
    if (!r?.manifest.nav || r.status !== 'active') return undefined
    return {
      label: r.manifest.nav.label,
      icon: r.manifest.nav.icon,
      order: r.manifest.nav.order ?? 100,
      detachable: r.manifest.nav.detachable ?? false,
    }
  }

  getPluginName(id: string): string | undefined {
    const r = this.records.get(id)
    return r?.manifest.name
  }

  /** tab 分离窗口用：内核 tab 或插件的 detachable 均可分离 */
  isDetachable(tabKey: string): boolean {
    return this.getPluginNavItem(tabKey)?.detachable === true
  }

  getAgentTools(): unknown[] {
    const tools: unknown[] = []
    for (const c of this.contributions.values()) tools.push(...c.agentTools)
    return tools
  }

  getFileAssociationOwner(extension: string): string | undefined {
    const ext = extension.toLowerCase()
    for (const [id, c] of this.contributions) {
      if (c.fileAssociations.has(ext)) return id
    }
    return undefined
  }

  // ====== plugin:// 协议 ======

  /** plugin://<id>/<相对路径> → 插件目录内文件；越权路径 403，未启用插件 404 */
  servePluginFile(url: string): Response {
    const parsed = new URL(url)
    const id = parsed.hostname
    const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
    const record = this.records.get(id)
    if (!record || record.status !== 'active') {
      return new Response('Plugin not available', { status: 404 })
    }
    const root = path.resolve(record.rootDir)
    const target = path.resolve(root, rel)
    if (target !== root && !target.startsWith(root + path.sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return new Response('File not found', { status: 404 })
    }
    const ext = path.extname(target).slice(1).toLowerCase()
    const mime = PLUGIN_MIME[ext] ?? 'application/octet-stream'
    return new Response(fs.readFileSync(target), {
      headers: { 'Content-Type': mime },
    })
  }

  // ====== 退出清理 ======

  shutdown(): void {
    for (const accelerator of this.registeredShortcuts) {
      try { globalShortcut.unregister(accelerator) } catch { /* ignore */ }
    }
    this.registeredShortcuts.clear()
    for (const record of this.records.values()) {
      if (record.status === 'active' && record.module?.deactivate) {
        try { record.module.deactivate() } catch (err) {
          logger.warn(`插件 deactivate 失败: ${record.manifest.id}`, err)
        }
      }
    }
  }
}

const PLUGIN_MIME: Record<string, string> = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  html: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  wasm: 'application/wasm',
  onnx: 'application/octet-stream',
  txt: 'text/plain',
  md: 'text/markdown',
}

export default PluginHostService
