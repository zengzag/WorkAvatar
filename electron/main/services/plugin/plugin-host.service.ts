import { app, BrowserWindow, dialog, globalShortcut, shell } from 'electron'
import AdmZip from 'adm-zip'
import { createRequire } from 'module'
import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'
import { createLogger } from '../logger'
import DatabaseService from '../database.service'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { PLUGIN_PACKAGE_EXT } from '../../../shared/channels/plugin'
import type {
  PluginEventPayload,
  PluginInfo,
  PluginImportResult,
  PluginNavItemInfo,
  PluginRendererInfo,
} from '../../../shared/channels/plugin'
import type {
  PluginContext,
  PluginDatabase,
  PluginManifest,
  PluginMigration,
  PluginServices,
  PluginWindowOptions,
  PluginWindowHandle,
  PluginNotificationPayload,
  PluginMessageAction,
  PluginMessageActionResult,
  PluginViewContribution,
  PluginCommand,
  PluginToolMiddleware,
} from '../../../../plugin-sdk/src'
import { HOST_NATIVE_DEPENDENCIES } from '../../../../plugin-sdk/src'
import { toToolMiddleware } from './middleware-adapter'
import type { ToolMiddleware } from '../agent/tools/tool-middleware'
import type { RegisteredEmployee } from '../employee-registry.service'
import {
  getCapability,
  canRegisterView,
  hasSystemFeature,
  canQueryKms,
  hasCollaboration,
  getSharedCapability,
  canCallPlugin,
  validateCapabilities,
} from './plugin-capability'
import { createDataAccessService } from './plugin-data-access'
import { createExecuteService } from './plugin-execute'
import { createEventBus } from './plugin-events'

const logger = createLogger('PluginHost')

/** 宿主插件协议版本（manifest.engine 与此比对，破坏性变更升 major） */
export const PLUGIN_PROTOCOL_VERSION = '0.2.0'

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
  /** 统一为用户来源；项目/dev 插件与导入插件落地后不再区分内置特权 */
  source: 'user'
  rootDir: string
  enabled: boolean
  engineOk: boolean
  /** active: activate 成功；error: 激活抛错；invalid: manifest/engine 校验失败；pending: 已安装未重启激活 */
  status: 'active' | 'disabled' | 'invalid' | 'error' | 'pending'
  statusMessage?: string
  /** activate 成功后的主进程模块（含 deactivate） */
  module?: { deactivate?: () => void | Promise<void> }
}

/** manifest 员工 key 命名规则（与插件 id 一致） */
const EMPLOYEE_KEY_RE = /^[a-z][a-z0-9-]{1,63}$/

interface CollectedContributions {
  agentTools: unknown[]
  mcpTools: unknown[]
  fileAssociations: Map<string, string> // 扩展名(小写含点) → pluginId
  /** 插件注册的数字员工工具调用中间件（agentMiddleware 能力门控） */
  agentMiddlewares: PluginToolMiddleware[]
}

const SETTINGS_KEY = 'plugins.config'

/**
 * 插件宿主：
 * - 加载：dev 额外扫描项目 plugins/（开发源），release 仅扫 userData/plugins；双源撞 id 时 dev 优先，不拷贝不覆盖用户安装
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
  /** 插件经 ctx.services.windows 创建的窗口（退出/禁用时统一回收） */
  private pluginWindows = new Set<BrowserWindow>()
  /** 插件经 ctx.services.scheduler 注册的定时任务清理函数（pluginId:id → dispose） */
  private schedulerJobs = new Map<string, () => void>()
  /** 最近一次待导入的 zip 路径（已装同 id 插件引导覆盖时复用，避免二次弹文件选择） */
  private pendingImportZip = ''
  /** 插件注册的对话消息快捷操作（pluginId → actions，供前端清单查询与 IPC 路由） */
  private messageActions = new Map<string, PluginMessageAction[]>()
  /** 跨插件 RPC 的响应式方法（fully-qualified 'pluginId:method' → handler） */
  private busResponders = new Map<string, (payload: unknown) => unknown | Promise<unknown>>()
  /** 跨插件共享 KV 宿主库（dataDir/plugin-shared.db，惰性打开） */
  private sharedDb: Database.Database | null = null
  /** 订阅内核事件的插件监听器（ctx.services.events.subscribe 注册）：event → Set<callback> */
  private kernelEventListeners = new Map<string, Set<(payload: unknown) => void>>()
  /** 插件注册的 UI 视图注入（pluginId:view → contribution，供渲染端查询） */
  private viewContributions = new Map<string, PluginViewContribution>()
  /** 插件注册的命令（pluginId:commandId → command） */
  private commands = new Map<string, PluginCommand>()
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

  /**
   * 开发期插件源目录：项目根 plugins/（predev 已由 build-plugins 生成 dist）。
   * 仅非打包时作为额外扫描目录；release 不加载该目录。
   */
  private getDevPluginSourceDir(): string {
    return path.join(process.cwd(), 'plugins')
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
    this.scanAndActivate(disabled)
  }

  /** 扫描目录 → 校验 → 激活。init 与 reload 复用 */
  private scanAndActivate(disabled: Set<string>): void {
    const userDir = this.getUserDir()
    // 扫描目录（顺序 = 优先级，同 id 只保留先发现的）：
    //   dev：项目 plugins/ 作为开发插件源，仅非打包时扫描；release 不加载
    //   user：用户安装目录 userData/plugins
    // dev 在前 → 用户目录与 dev 插件目录撞 id 时优先加载 dev 插件（不拷贝、不覆盖用户已安装包，避免开发误伤 release 安装）
    const scanDirs: Array<{ label: string; dir: string }> = []
    if (!app.isPackaged) {
      const devDir = this.getDevPluginSourceDir()
      if (fs.existsSync(devDir)) scanDirs.push({ label: 'dev', dir: devDir })
    }
    scanDirs.push({ label: 'user', dir: userDir })
    logger.info(`插件扫描: isPackaged=${app.isPackaged} ${scanDirs.map(d => `${d.label}=${d.dir} (存在=${fs.existsSync(d.dir)})`).join(' | ')}`)
    for (const { dir } of scanDirs) {
      let entries: string[] = []
      try {
        // 只扫描真正的插件目录：必须包含 manifest.json。dev 源 plugins/ 为 git submodule，
        // 含 .git/node_modules/tests/examples 等非插件目录，统一以 manifest 存在与否判定。
        entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'manifest.json')))
          .map(e => e.name)
      } catch { /* 目录不存在则跳过 */ }
      for (const name of entries) {
        this.scanPlugin(path.join(dir, name), disabled)
      }
    }
    logger.info(`插件扫描完成: 共 ${this.records.size} 个插件，${Array.from(this.records.values()).filter(r => r.status === 'invalid').length} 个无效`)
    for (const [id, r] of this.records) {
      if (r.status === 'invalid') logger.warn(`插件无效 ${id}: ${r.statusMessage ?? ''}`)
    }

    // 依赖满足性校验 + 拓扑顺序激活
    const candidates = Array.from(this.records.values()).filter(r => r.enabled && r.status !== 'invalid')
    for (const r of candidates) {
      const reason = this.checkDependencies(r)
      if (reason) {
        r.status = 'invalid'
        r.statusMessage = reason
        r.enabled = false
      }
    }
    const remaining = candidates.filter(r => r.status !== 'invalid')
    const activated = new Set<string>()
    let progressed = true
    while (remaining.length > 0 && progressed) {
      progressed = false
      for (const r of [...remaining]) {
        const deps = Object.keys(r.manifest.dependencies ?? {})
        if (deps.every(d => activated.has(d))) {
          this.activateRecord(r)
          if (r.status === 'active') activated.add(r.manifest.id)
          const idx = remaining.indexOf(r)
          if (idx >= 0) remaining.splice(idx, 1)
          progressed = true
        }
      }
    }
  }

  /** 校验某插件的依赖是否满足（缺失/未启用/无效/版本不满足均返回错误文案） */
  private checkDependencies(r: PluginRecord): string | undefined {
    const deps = r.manifest.dependencies ?? {}
    for (const [depId, range] of Object.entries(deps)) {
      const dep = this.records.get(depId)
      if (!dep) return `缺少依赖插件 ${depId}`
      if (!dep.enabled) return `依赖插件 ${depId} 未启用`
      if (dep.status === 'invalid') return `依赖插件 ${depId} 无效（${dep.statusMessage ?? ''}）`
      if (dep.manifest.version && !engineSatisfies(range, dep.manifest.version)) {
        return `依赖插件 ${depId} 版本不满足 ${range}（当前 ${dep.manifest.version}）`
      }
    }
    return undefined
  }

  /**
   * 热重载插件：启停/导入/删除/升级后无需重启应用即可生效。
   * 流程：deactivate 全部激活插件 → 清 require 缓存与宿主状态 → 重新扫描激活。
   * 注意：插件贡献的 agent 工具已注册进内核 ToolRegistry，重载后需调用
   * EmployeeAgentService.clearAgentCache 刷新员工工具列表；渲染端由调用方 reload 窗口重建。
   */
  reload(): void {
    // 1. deactivate 全部激活插件
    for (const record of this.records.values()) {
      if (record.status === 'active') {
        // 技能随插件下线（DB 记录保留，重新激活后自动恢复）
        this.unregisterPluginSkills(record.manifest.id)
        if (record.module?.deactivate) {
          try { record.module.deactivate() } catch (err: any) {
            logger.warn(`插件 deactivate 失败: ${record.manifest.id}`, err?.message || err)
          }
        }
      }
    }
    // 2. 清 require 缓存（插件主进程模块是 CJS，require 有缓存，必须删除才能重新加载）
    for (const record of this.records.values()) {
      const entry = path.join(record.rootDir, record.manifest.main)
      try { delete require.cache[require.resolve(entry)] } catch { /* ignore */ }
    }
    // 3. 清宿主状态
    this.records.clear()
    this.handlers.clear()
    this.contributions.clear()
    this.messageActions.clear()
    this.kernelEventListeners.clear()
    this.viewContributions.clear()
    this.commands.clear()
    this.busResponders.clear()
    this.schedulerJobs.clear()
    // 插件员工随热重载整体下线，重新激活后按新声明重建（内置员工不受影响）
    const { default: EmployeeRegistryService } = require('../employee-registry.service') as typeof import('../employee-registry.service')
    EmployeeRegistryService.getInstance().resetPluginEmployees()
    for (const accelerator of this.registeredShortcuts) {
      try { globalShortcut.unregister(accelerator) } catch { /* ignore */ }
    }
    this.registeredShortcuts.clear()
    for (const win of this.pluginWindows) {
      if (!win.isDestroyed()) try { win.destroy() } catch { /* ignore */ }
    }
    this.pluginWindows.clear()
    // 4. 重新扫描激活
    this.scanAndActivate(this.readDisabledList())
    logger.info('插件已热重载')
  }

  private scanPlugin(rootDir: string, disabled: Set<string>): void {
    // 无效插件统一以 id（目录名）为 key，与有效插件一致，保证可被删除/管理
    const fail = (id: string, message: string) => {
      this.records.set(id, {
        manifest: { id, name: id, version: '0.0.0', engine: '*', main: '' },
        source: 'user', rootDir, enabled: false, engineOk: false, status: 'invalid', statusMessage: message,
      })
    }
    const manifestPath = path.join(rootDir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) return fail(path.basename(rootDir), '缺少 manifest.json')
    let manifest: PluginManifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (err: any) {
      return fail(path.basename(rootDir), `manifest.json 解析失败: ${err?.message || err}`)
    }
    if (!ID_RE.test(manifest.id ?? '')) return fail(path.basename(rootDir), `id 非法: ${manifest.id}`)
    if (RESERVED_IDS.includes(manifest.id)) return fail(manifest.id, `id 为保留字: ${manifest.id}`)
    if (!manifest.main) return fail(manifest.id, '缺少 main 入口')
    const entryPath = path.join(rootDir, manifest.main)
    if (!fs.existsSync(entryPath)) return fail(manifest.id, `主进程入口不存在: ${manifest.main}`)
    const engineOk = engineSatisfies(manifest.engine ?? '*', PLUGIN_PROTOCOL_VERSION)
    if (!engineOk) return fail(manifest.id, `engine 不兼容: 需要 ${manifest.engine}，宿主协议 ${PLUGIN_PROTOCOL_VERSION}`)
    const capCheck = validateCapabilities(manifest.capabilities)
    if (!capCheck.ok) return fail(manifest.id, `capabilities 非法: ${capCheck.reason}`)
    if (this.records.has(manifest.id)) {
      logger.warn(`插件 id 冲突，忽略后发现的: ${manifest.id} (${rootDir})`)
      return
    }
    const enabled = !disabled.has(manifest.id)
    this.records.set(manifest.id, {
      manifest, source: 'user', rootDir, enabled, engineOk,
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
      // 插件激活成功后注册其 manifest 声明的数字员工（异常隔离：单员工声明非法只跳过，不影响插件运行）
      this.registerManifestEmployees(record)
      // 插件激活成功后注册其内置 skills（<插件根>/skills/，source='plugin'，异常隔离单技能跳过）
      this.registerPluginSkills(record)
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

  /** 校验 legacyMigration 权限（v2 保留在 permissions 数组，仅迁移专用） */
  private hasPermission(record: PluginRecord, permission: string): boolean {
    return (record.manifest.permissions ?? []).includes(permission as never)
  }

  /** 将插件 manifest.employees 声明注册进员工注册表（激活成功后调用） */
  private registerManifestEmployees(record: PluginRecord): void {
    const list = record.manifest.employees
    if (!list || list.length === 0) return
    const employees: RegisteredEmployee[] = []
    for (const e of list) {
      if (!e || typeof e.key !== 'string' || !EMPLOYEE_KEY_RE.test(e.key)) {
        logger.warn(`插件 ${record.manifest.id} 员工 key 非法，已跳过: ${e?.key}`)
        continue
      }
      if (!e.name || typeof e.systemPrompt !== 'string') {
        logger.warn(`插件 ${record.manifest.id} 员工缺少 name/systemPrompt，已跳过: ${e.key}`)
        continue
      }
      employees.push({
        id: e.key,
        source_key: e.key,
        name: e.name,
        description: e.description || '',
        rules: e.systemPrompt,
        profile_json: '',
        avatar_type: e.avatarType || 'default',
        memory_enabled: false,
        arch_version: 1,
        total_tasks: 0,
        total_approvals: 0,
        created_at: 0,
        updated_at: 0,
        defaultTools: e.defaultTools,
      })
    }
    if (employees.length === 0) return
    const { default: EmployeeRegistryService } = require('../employee-registry.service') as typeof import('../employee-registry.service')
    EmployeeRegistryService.getInstance().registerPluginEmployees(record.manifest.id, record.manifest.name, employees)
  }

  /** 注册插件内置 skills（<插件根>/skills/ 目录约定，source='plugin'）。无 skills 目录则直接返回 */
  private registerPluginSkills(record: PluginRecord): void {
    const skillsDir = path.join(record.rootDir, 'skills')
    if (!fs.existsSync(skillsDir)) return
    try {
      const { default: SkillRegistryService } = require('../skill-registry.service') as typeof import('../skill-registry.service')
      SkillRegistryService.getInstance().registerPluginSkills(record.manifest.id, skillsDir)
    } catch (err: any) {
      logger.warn(`插件 ${record.manifest.id} 技能注册失败（跳过，不影响插件运行）:`, err?.message || err)
    }
  }

  /** 插件下线（禁用/热重载/删除）时把其技能从可用集合移除（DB 记录保留，员工分配不丢失） */
  private unregisterPluginSkills(pluginId: string): void {
    try {
      const { default: SkillRegistryService } = require('../skill-registry.service') as typeof import('../skill-registry.service')
      SkillRegistryService.getInstance().markPluginSkillsInactive(pluginId)
    } catch (err: any) {
      logger.warn(`插件 ${pluginId} 技能下线失败（忽略）:`, err?.message || err)
    }
  }

  /** 物理删除插件技能（仅插件删除时）：连同员工分配关联级联清除 */
  private removePluginSkills(pluginId: string): void {
    try {
      const { default: SkillRegistryService } = require('../skill-registry.service') as typeof import('../skill-registry.service')
      SkillRegistryService.getInstance().removePluginSkills(pluginId)
    } catch (err: any) {
      logger.warn(`插件 ${pluginId} 技能删除失败（忽略）:`, err?.message || err)
    }
  }

  /** 校验系统能力特性（capabilities.system.features） */
  private hasSystemFeature(record: PluginRecord, feature: Parameters<typeof hasSystemFeature>[1]): boolean {
    return hasSystemFeature(record.manifest.capabilities, feature)
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

  /** 跨插件共享 KV 宿主库（惰性打开，跨插件/跨热重载持久） */
  private getSharedDb(): Database.Database {
    if (!this.sharedDb) {
      this.sharedDb = new Database(path.join(this.dataDir, 'plugin-shared.db'))
      this.sharedDb.pragma('journal_mode = WAL')
      this.sharedDb.exec(`
        CREATE TABLE IF NOT EXISTS plugin_shared (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (namespace, key)
        )
      `)
    }
    return this.sharedDb
  }

  /** 校验共享 KV key 与插件方法名的简单命名规则（防冲突与路径穿越语义混淆） */
  private assertSimpleName(name: string, what: string): void {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
      throw new Error(`${what} 非法: ${name}（仅允许字母/数字/._-，≤128）`)
    }
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
        listNativeModules: () => ({ ...HOST_NATIVE_DEPENDENCIES }),
      },
    }

    // ====== 数据访问层（services.data，需 capabilities.data 授权） ======
    if (getCapability(record.manifest.capabilities, 'data')) {
      const { default: WorkspaceManagerService } = require('../workspace-manager.service')
      const { default: LLMClientService } = require('../llm-client.service')
      const { default: EmployeeMemoryService } = require('../employee-memory.service')
      const db = DatabaseService.getInstance().getDb()
      services.data = createDataAccessService({
        workspace: {
          getAllConversationsWithEmployee: (p) => WorkspaceManagerService.getInstance().getAllConversationsWithEmployee(p),
          getConversation: (id) => WorkspaceManagerService.getInstance().getConversation(id),
          getConversationMessages: (id) => {
            const conv = WorkspaceManagerService.getInstance().getConversation(id) as { messages_json?: string } | null
            if (!conv) return []
            try {
              const arr = JSON.parse(conv.messages_json ?? '[]')
              return Array.isArray(arr) ? arr : []
            } catch {
              return []
            }
          },
          createConversation: (e, s, t, m, p) => WorkspaceManagerService.getInstance().createConversation(e, s, t, m, p),
          updateConversation: (id, data) => WorkspaceManagerService.getInstance().updateConversation(id, data),
          deleteConversation: (id) => WorkspaceManagerService.getInstance().deleteConversation(id),
          getEmployeeList: () => WorkspaceManagerService.getInstance().getEmployeeList(),
          getEmployee: (id) => WorkspaceManagerService.getInstance().getEmployee(id),
          createEmployee: (n, d, p, r) => WorkspaceManagerService.getInstance().createEmployee(n, d, p, r),
          updateEmployee: (id, data) => WorkspaceManagerService.getInstance().updateEmployee(id, data),
          deleteEmployee: (id, dw) => WorkspaceManagerService.getInstance().deleteEmployee(id, dw),
        },
        llm: {
          getProviderList: () => LLMClientService.getInstance().getProviderList(),
          getProvider: (id) => LLMClientService.getInstance().getProvider(id),
          createProvider: (p) => LLMClientService.getInstance().createProvider(p),
          updateProvider: (id, p) => LLMClientService.getInstance().updateProvider(id, p),
          deleteProvider: (id) => LLMClientService.getInstance().deleteProvider(id),
        },
        memory: {
          listMemories: (e) => EmployeeMemoryService.getInstance().listMemories(e),
          searchMemories: (e, q, l) => EmployeeMemoryService.getInstance().searchMemories(e, q, l),
          createMemory: (p) => EmployeeMemoryService.getInstance().createMemory(p),
          updateMemory: (id, p) => EmployeeMemoryService.getInstance().updateMemory(id, p),
          deleteMemory: (id) => EmployeeMemoryService.getInstance().deleteMemory(id),
          togglePin: (id) => EmployeeMemoryService.getInstance().togglePin(id),
        },
        settings: {
          get: (key) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value,
        },
      })
    }

    // ====== 宿主能力层（services.execute，需 capabilities.execute 授权） ======
    if (getCapability(record.manifest.capabilities, 'execute')) {
      const EmployeeAgentService = require('../employee-agent.service').default
      const LLMClientService = require('../llm-client.service').default
      const { createPiProvider } = require('../agent/llm/pi-provider-factory')
      const pluginId = manifest.id
      services.execute = createExecuteService({
        runAgentTask: async (params, callbacks, signal) => {
          const employeeAgent = EmployeeAgentService.getInstance()
          const { provider_id, model_id } = (() => {
            const db = DatabaseService.getInstance().getDb()
            const emp = db.prepare('SELECT provider_id, model_id FROM employees WHERE id = ?').get(params.employeeId) as any
            return emp || { provider_id: null, model_id: null }
          })()
          let conversationId = params.conversationId
          if (!conversationId) {
            const { default: WorkspaceManagerService } = require('../workspace-manager.service')
            const conv = WorkspaceManagerService.getInstance().createConversation(params.employeeId)
            conversationId = conv.id
          }
          let resultText = ''
          await employeeAgent.chatStream(
            {
              employee_id: params.employeeId,
              provider_id: provider_id,
              model_id: model_id,
              messages: [{ role: 'user', content: params.prompt }],
              conversation_id: conversationId,
              use_skills: false,
              collection_ids: [] as string[],
              minimal_mode: true,
              high_permission: false,
            },
            {
              onChunk: (text: string) => { resultText += text; callbacks?.onChunk?.(text) },
              onDone: () => callbacks?.onDone?.({ text: resultText }),
              onError: (err: string) => callbacks?.onError?.(err),
            },
            signal,
          )
          return { conversationId, text: resultText }
        },
        runAgentChat: async (params, callbacks, signal) => {
          // 通用模式：不传 employeeId，走通用对话引擎（不绑定员工，自定义 system + tools）
          if (!params.employeeId) {
            const GenericChatService = require('../generic-chat.service').default
            const genericChat = GenericChatService.getInstance()
            // 会话 id：复用传入或新建（通用对话不进入任务列表，conversationId 由调用方管理）
            let conversationId = params.conversationId
            if (!conversationId) {
              conversationId = `generic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            }
            const tools = (params.tools || []).map((t: any) => ({
              ...t,
              source: 'plugin' as const,
              permission: t.permission as any,
              handler: (args: any, context: any) => t.handler(args, {
                ...(context || {}),
                employeeId: null,
              }),
            }))

            // 可选：注入宿主内置 shell/文件工具，并分配任务工作区（类似数字员工）
            let builtinTools: any[] = []
            let taskWorkspace = params.workspacePath
            if (params.enableBuiltinTools) {
              const { shellExecTool } = require('../agent/tools/shell-exec.tool')
              const { residentFileTools } = require('../agent/tools/fs-tools')
              builtinTools = [shellExecTool, ...residentFileTools]
              // 插件已指定任务工作区（持久化到会话）则直接复用，否则在插件数据目录下为本次会话新建
              if (!taskWorkspace) {
                const { default: PathService } = require('../path.service')
                const base = path.join(PathService.getInstance().getDataDir(), 'plugins', manifest.id, 'tasks')
                const ts = new Date()
                const pad = (n: number) => String(n).padStart(2, '0')
                const dirName = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`
                taskWorkspace = path.join(base, dirName)
                let i = 1
                while (fs.existsSync(taskWorkspace)) {
                  taskWorkspace = path.join(base, `${dirName}_${i}`)
                  i++
                }
                fs.mkdirSync(taskWorkspace, { recursive: true })
              }
              // 插件传入的目录可能尚未创建，确保存在以便文件工具使用
              if (!fs.existsSync(taskWorkspace)) fs.mkdirSync(taskWorkspace, { recursive: true })
            }

            const run = () => genericChat.chatStream(
              {
                providerId: params.providerId,
                modelId: params.modelId,
                systemPrompt: params.system,
                tools: [...builtinTools, ...tools],
                useSkills: params.useSkills ?? false,
                enableThinking: params.enableThinking ? 'high' : false,
                minimalMode: params.minimalMode ?? false,
                conversationId,
                // LLM 调用日志按插件名/会话分文件，便于定位
                logName: pluginId,
              },
              params.messages,
              {
                onChunk: (text: string) => callbacks?.onChunk?.(text),
                onThought: (thought: string) => callbacks?.onThought?.(thought),
                onToolCall: (tc: any) => callbacks?.onToolCall?.({ id: tc.id, name: tc.name, arguments: tc.args }),
                onToolCallDelta: (delta: any) => callbacks?.onToolCallDelta?.(delta),
                onToolResult: (tr: any) => callbacks?.onToolResult?.(tr),
                onToolProgress: (p: any) => callbacks?.onToolProgress?.(p),
                onDone: (metadata?: any) => callbacks?.onDone?.(metadata),
                onError: (err: string) => callbacks?.onError?.(err),
              },
              signal,
            )

            if (taskWorkspace) {
              const { interactionContext } = require('../unified-interaction.service')
              await interactionContext.run(
                {
                  sessionId: conversationId,
                  employeeId: 'generic',
                  conversationId,
                  workspacePath: taskWorkspace,
                  highPermission: params.highPermission === true,
                },
                run,
              )
            } else {
              await run()
            }
            return { conversationId }
          }

          const employeeAgent = EmployeeAgentService.getInstance()
          // 会话 id 必须为字符串：复用传入或新建（ExecuteDeps 契约要求返回 { conversationId: string }）
          let conversationId: string
          if (params.conversationId) {
            conversationId = params.conversationId
          } else {
            const { default: WorkspaceManagerService } = require('../workspace-manager.service')
            conversationId = WorkspaceManagerService.getInstance().createConversation(params.employeeId).id
          }
          await employeeAgent.chatStream(
            {
              employee_id: params.employeeId,
              provider_id: params.providerId,
              model_id: params.modelId,
              messages: params.messages,
              conversation_id: conversationId,
              use_skills: params.useSkills ?? false,
              enable_thinking: params.enableThinking ? 'high' : false,
              minimal_mode: params.minimalMode ?? true,
              high_permission: params.highPermission ?? false,
              system: params.system,
            },
            {
              onChunk: (text: string) => callbacks?.onChunk?.(text),
              onThought: (thought: string) => callbacks?.onThought?.(thought),
              onToolCall: (tc: any) => callbacks?.onToolCall?.({ id: tc.id, name: tc.name, arguments: tc.args }),
              onToolCallDelta: (delta: any) => callbacks?.onToolCallDelta?.(delta),
              onToolResult: (tr: any) => callbacks?.onToolResult?.(tr),
              onToolProgress: (p: any) => callbacks?.onToolProgress?.(p),
              onDone: (metadata?: any) => callbacks?.onDone?.(metadata),
              onError: (err: string) => callbacks?.onError?.(err),
            },
            signal,
          )
          return { conversationId }
        },
        runLlmChat: async (params) => {
          const llmClient = LLMClientService.getInstance()
          const providerId = params.providerId || (() => {
            const providers = llmClient.getProviderList() as any[]
            return providers.find((p: any) => p.is_default)?.id || providers[0]?.id
          })()
          const provider = await llmClient.getProviderConfig(providerId)
          if (!provider) throw new Error('No LLM provider available')
          const pi = await createPiProvider(provider.id, params.modelId || provider.model)
          if (!pi) throw new Error('Failed to create LLM provider')
          const messages: any[] = []
          if (params.system) messages.push({ role: 'system', content: params.system })
          messages.push({ role: 'user', content: params.prompt })
          const response = await pi.chat(messages, [], { logSource: `plugin:${pluginId}` })
          return response.content
        },
        runLlmStream: async (params, callbacks, signal) => {
          const llmClient = LLMClientService.getInstance()
          const providerId = params.providerId || (() => {
            const providers = llmClient.getProviderList() as any[]
            return providers.find((p: any) => p.is_default)?.id || providers[0]?.id
          })()
          const provider = await llmClient.getProviderConfig(providerId)
          if (!provider) throw new Error('No LLM provider available')
          const pi = await createPiProvider(provider.id, params.modelId || provider.model)
          if (!pi) throw new Error('Failed to create LLM provider')
          const messages: any[] = []
          if (params.system) messages.push({ role: 'system', content: params.system })
          if (params.history) {
            for (const h of params.history) messages.push({ role: 'user', content: h })
          }
          messages.push({ role: 'user', content: params.prompt })
          let accumulated = ''
          await pi.chatStream(
            messages,
            [],
            {
              onChunk: (chunk: string) => { accumulated += chunk; callbacks?.onChunk?.(chunk) },
              onThought: (thought: string) => callbacks?.onThought?.(thought),
              onToolCall: (tc: any) => callbacks?.onToolCall?.(tc),
            },
            signal,
            { temperature: params.temperature, maxTokens: params.maxTokens, logSource: `plugin:${pluginId}` },
          )
          return accumulated
        },
      })
    }

    // ====== 系统集成层（services.events，需 capabilities.events 授权） ======
    if (getCapability(record.manifest.capabilities, 'events')) {
      services.events = createEventBus(this.kernelEventListeners, manifest.id, pluginLogger)
    }

    // ====== KMS 数据查询层（services.kms，需 capabilities.kms 授权） ======
    if (getCapability(record.manifest.capabilities, 'kms')) {
      const { default: KMSService } = require('../kms/kms.service')
      const kms = KMSService.getInstance()
      const guard = (kind: 'search' | 'content' | 'collections') => {
        const check = canQueryKms(record.manifest.capabilities, kind)
        if (!check.ok) throw new Error(check.reason)
      }
      services.kms = {
        search: async (query, options) => {
          guard('search')
          if (typeof query !== 'string' || !query.trim()) throw new Error('kms.search 需要 query')
          return kms.search(query, {
            collectionIds: options?.collectionIds,
            fileExtensions: options?.fileExtensions,
            topK: options?.limit,
          })
        },
        listCollections: async () => {
          guard('collections')
          return (kms.listCollections() as Array<{ id: string; name: string; description: string; file_count: number }>)
            .map((c) => ({ id: c.id, name: c.name, description: c.description ?? '', file_count: c.file_count ?? 0 }))
        },
        getContent: async (fileId, options) => {
          guard('content')
          if (typeof fileId !== 'string' || !fileId) throw new Error('kms.getContent 需要 fileId')
          return kms.getFileContent(fileId, {
            paragraphId: options?.paragraphId,
            maxChars: options?.maxChars,
          })
        },
      }
    }

    // ====== 插件协作层（services.shared / bus，需 capabilities.collaboration 授权） ======
    if (hasCollaboration(record.manifest.capabilities)) {
      const pluginId = manifest.id
      const sharedCap = getSharedCapability(record.manifest.capabilities)
      if (sharedCap) {
        const db = this.getSharedDb()
        const readAll = !!sharedCap.read
        const sharedGet = <T,>(namespace: string, key: string, def?: T): Promise<T | undefined> => {
          const row = db.prepare('SELECT value FROM plugin_shared WHERE namespace = ? AND key = ?').get(namespace, key) as { value: string } | undefined
          return Promise.resolve(row ? JSON.parse(row.value) as T : def)
        }
        services.shared = {
          set: (key, value) => {
            this.assertSimpleName(key, '共享 key')
            db.prepare(
              'INSERT INTO plugin_shared (namespace, key, value, updated_at) VALUES (?, ?, ?, ?) ' +
              'ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
            ).run(pluginId, key, JSON.stringify(value), Date.now())
            return Promise.resolve()
          },
          get: (key, def) => {
            this.assertSimpleName(key, '共享 key')
            return sharedGet(pluginId, key, def)
          },
          getFrom: (target, key, def) => {
            this.assertSimpleName(target, '插件 id'); this.assertSimpleName(key, '共享 key')
            if (target !== pluginId && !readAll) throw new Error('跨插件读共享数据需要 collaboration.shared.read 能力')
            return sharedGet(target, key, def)
          },
          delete: (key) => {
            this.assertSimpleName(key, '共享 key')
            db.prepare('DELETE FROM plugin_shared WHERE namespace = ? AND key = ?').run(pluginId, key)
            return Promise.resolve()
          },
          keys: () => {
            const rows = db.prepare('SELECT key FROM plugin_shared WHERE namespace = ?').all(pluginId) as { key: string }[]
            return Promise.resolve(rows.map(r => r.key))
          },
          keysAll: () => {
            if (!readAll) return Promise.reject(new Error('列出全部共享 key 需要 collaboration.shared.read 能力'))
            const rows = db.prepare('SELECT namespace, key FROM plugin_shared').all() as { namespace: string; key: string }[]
            return Promise.resolve(rows.map(r => `${r.namespace}:${r.key}`))
          },
        }
      }
      services.bus = {
        respond: (method, handler) => {
          this.assertSimpleName(method, '方法名')
          const full = `${pluginId}:${method}`
          this.busResponders.set(full, handler)
          return () => { if (this.busResponders.get(full) === handler) this.busResponders.delete(full) }
        },
        call: <T,>(targetMethod: string, payload?: unknown): Promise<T> => {
          const check = canCallPlugin(record.manifest.capabilities, targetMethod)
          if (!check.ok) return Promise.reject(new Error(check.reason))
          const handler = this.busResponders.get(targetMethod)
          if (!handler) return Promise.reject(new Error(`跨插件方法未注册: ${targetMethod}`))
          return Promise.resolve().then(() => handler(payload)) as Promise<T>
        },
      }
    }

    if (this.hasSystemFeature(record, 'notification')) {
      const { default: NotificationService } = require('../notification.service')
      services.notification = {
        notify: (payload: PluginNotificationPayload) => NotificationService.getInstance().notify({
          title: payload.title,
          body: payload.body,
          clickTarget: payload.clickTarget as any,
          clickId: payload.clickId,
          source: `plugin:${manifest.id}`,
          silent: payload.silent,
          i18nKey: payload.i18nKey,
          i18nParams: payload.i18nParams,
        } as any),
      }
    }

    if (this.hasSystemFeature(record, 'scheduler')) {
      const jobMap = this.schedulerJobs
      const pluginId = manifest.id
      // 回调异常隔离：单插件定时回调抛错不允许冒泡为 uncaughtException 导致宿主退出
      const safeFn = (fn: (...args: any[]) => any) => (...args: any[]) => {
        try {
          const ret = fn(...args)
          if (ret && typeof ret.catch === 'function') {
            ret.catch((err: any) => logger.error(`Plugin ${pluginId} scheduler callback rejected:`, err))
          }
        } catch (err) {
          logger.error(`Plugin ${pluginId} scheduler callback threw:`, err)
        }
      }
      services.scheduler = {
        every: (intervalMs, fn) => {
          const id = `${pluginId}:every:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
          const timer = setInterval(safeFn(fn), intervalMs)
          if (timer.unref) timer.unref()
          jobMap.set(id, () => clearInterval(timer))
          return id
        },
        cron: (expression, fn) => {
          const id = `${pluginId}:cron:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
          // 仅支持 5 段式且每段为 * 或单个精确值；*/n、区间、列表等语法不支持，显式抛错避免静默失效
          const parts = expression.trim().split(/\s+/)
          if (parts.length !== 5) throw new Error(`cron 表达式必须为 5 段式: ${expression}`)
          for (const part of parts) {
            if (part !== '*' && !/^\d+$/.test(part)) {
              throw new Error(`cron 表达式仅支持 * 或单个数值（不支持 */n、区间、列表）: ${expression}`)
            }
          }
          const safe = safeFn(fn)
          // 简单实现：每分钟检查一次 cron 表达式
          const check = () => {
            const now = new Date()
            const matchMin = parts[0] === '*' || parts[0] === String(now.getMinutes())
            const matchHour = parts[1] === '*' || parts[1] === String(now.getHours())
            const matchDay = parts[2] === '*' || parts[2] === String(now.getDate())
            const matchMonth = parts[3] === '*' || parts[3] === String(now.getMonth() + 1)
            const matchDow = parts[4] === '*' || parts[4] === String(now.getDay())
            if (matchMin && matchHour && matchDay && matchMonth && matchDow) safe()
          }
          // 先对齐到下一分钟边界再启动，避免 setInterval 从注册时刻起算导致漏触发/重复触发
          const msToNextMinute = 60_000 - (Date.now() % 60_000)
          const timer = setTimeout(() => {
            check()
            const interval = setInterval(check, 60_000)
            if (interval.unref) interval.unref()
            jobMap.set(id, () => clearInterval(interval))
          }, msToNextMinute)
          if (timer.unref) timer.unref()
          jobMap.set(id, () => clearTimeout(timer))
          return id
        },
        cancel: (jobId) => {
          const dispose = jobMap.get(jobId)
          if (dispose) { dispose(); jobMap.delete(jobId) }
        },
      }
    }

    if (this.hasSystemFeature(record, 'windows')) {
      // 预加载脚本路径
      const getPreloadPath = () => {
        if (!app.isPackaged) {
          return path.join(process.cwd(), 'dist-electron', 'preload', 'index.js')
        }
        return path.join(__dirname, '..', '..', '..', 'preload', 'index.js')
      }
      services.windows = {
        create: (options: PluginWindowOptions): PluginWindowHandle => {
          const id = `${manifest.id}:win:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
          const winOptions: any = {
            width: options.width,
            height: options.height,
            title: options.title || manifest.name,
            autoHideMenuBar: true,
            show: false,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              preload: getPreloadPath(),
            },
          }
          if (options.alwaysOnTop) winOptions.alwaysOnTop = true
          if (options.frame !== undefined) winOptions.frame = options.frame
          if (options.transparent) {
            winOptions.transparent = true
            winOptions.hasShadow = options.hasShadow ?? false
          }
          if (options.skipTaskbar) winOptions.skipTaskbar = true
          if (options.focusable !== undefined) winOptions.focusable = options.focusable
          if (options.resizable !== undefined) winOptions.resizable = options.resizable
          if (options.x !== undefined) winOptions.x = options.x
          if (options.y !== undefined) winOptions.y = options.y

          const win = new BrowserWindow(winOptions)
          win.once('ready-to-show', () => win.show())
          this.pluginWindows.add(win)
          // 窗口纳入广播目标；closed 时统一从两个集合清理
          this.targets.add(win)
          win.on('closed', () => { this.pluginWindows.delete(win); this.targets.delete(win) })

          // 加载内容
          if (options.contentPath) {
            const fullPath = path.resolve(record.rootDir, options.contentPath)
            win.loadFile(fullPath)
          } else if (options.url) {
            win.loadURL(options.url)
          }

          return {
            id,
            close: () => { if (!win.isDestroyed()) win.close() },
            send: (event, payload) => { if (!win.isDestroyed()) win.webContents.send(event, payload) },
            onClosed: (cb) => { win.on('closed', () => cb()) },
            setSize: (w, h) => { if (!win.isDestroyed()) win.setSize(w, h) },
            show: () => { if (!win.isDestroyed()) win.show() },
            hide: () => { if (!win.isDestroyed()) win.hide() },
            isVisible: () => !win.isDestroyed() && win.isVisible(),
          }
        },
      }
    }

    if (this.hasSystemFeature(record, 'native')) {
      // 校验模块在宿主原生白名单内；不在则拒绝借用并提示，避免插件依赖宿主未提供模块
      const assertNativeWhitelisted = (name: string) => {
        if (!(name in HOST_NATIVE_DEPENDENCIES)) {
          throw new Error(`宿主不提供原生模块 "${name}"；可用：${Object.keys(HOST_NATIVE_DEPENDENCIES).join(', ')}`)
        }
      }
      services.native = {
        borrow: (name) => {
          assertNativeWhitelisted(name)
          try { return require(name) } catch { return null }
        },
        modulePath: (name) => {
          assertNativeWhitelisted(name)
          try { return require.resolve(name) } catch { return '' }
        },
      }
    }

    const contributions: CollectedContributions = {
      agentTools: [], mcpTools: [], fileAssociations: new Map(), agentMiddlewares: [],
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
        registerAgentMiddleware: (middlewares) => {
          if (!this.hasSystemFeature(record_, 'agentMiddleware')) {
            throw new Error('未声明 agentMiddleware 能力')
          }
          contributions.agentMiddlewares.push(...middlewares)
        },
        registerMcpTools: (tools) => { contributions.mcpTools.push(...tools) },
        registerFileAssociations: (assocs) => {
          for (const a of assocs) contributions.fileAssociations.set(a.extension.toLowerCase(), manifest.id)
        },
        registerGlobalShortcuts: (shortcuts) => {
          if (!this.hasSystemFeature(record_, 'globalShortcuts')) {
            throw new Error('未声明 globalShortcuts 能力')
          }
          for (const s of shortcuts) {
            const accelerator = s.accelerator
            const ok = globalShortcut.register(accelerator, () => Promise.resolve(s.handler()).catch(e => pluginLogger.error('快捷键执行失败:', e)))
            if (!ok) {
              pluginLogger.warn(`全局快捷键注册失败（可能已被占用）: ${accelerator}`)
              continue
            }
            this.registeredShortcuts.add(accelerator)
          }
        },
        registerMessageActions: (actions) => {
          for (const action of actions) {
            const channel = `message-action:${action.id}`
            this.handlers.set(`plugin:${manifest.id}:${channel}`, async (payload: any) => {
              try {
                const result: PluginMessageActionResult | undefined | void =
                  await action.handler({ content: payload?.content ?? '', messageId: payload?.messageId })
                return result || {}
              } catch (err: any) {
                return { error: err?.message || String(err) } as PluginMessageActionResult
              }
            })
          }
          this.messageActions.set(manifest.id, actions)
        },
        registerView: (view: PluginViewContribution) => {
          const check = canRegisterView(record_.manifest.capabilities, view.view)
          if (!check.ok) throw new Error(check.reason)
          this.viewContributions.set(`${manifest.id}:${view.view}`, view)
        },
        registerCommand: (command: PluginCommand) => {
          const channel = `command:${command.id}`
          this.handlers.set(`plugin:${manifest.id}:${channel}`, async (payload: any) => {
            try {
              return await command.handler(payload?.args)
            } catch (err: any) {
              return { error: err?.message || String(err) }
            }
          })
          this.commands.set(`${manifest.id}:${command.id}`, command)
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
    const makeReader = (sourceDb: any) => ({
      listTables: () =>
        (sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name),
      all: (sql: string, ...params: unknown[]) => {
        if (!isSelect(sql)) throw new Error('legacy 只读：仅允许 SELECT')
        return sourceDb.prepare(sql).all(...params)
      },
      get: (sql: string, ...params: unknown[]) => {
        if (!isSelect(sql)) throw new Error('legacy 只读：仅允许 SELECT')
        return sourceDb.prepare(sql).get(...params)
      },
    })
    let kmsReader: ReturnType<typeof makeReader> | null = null
    try {
      // KMS 向量库（kms_voice_tasks 等历史遗留表所在）；库未初始化时惰性访问失败置 null
      const { default: KMSDatabaseService } = require('../kms/kms-database.service')
      kmsReader = makeReader(KMSDatabaseService.getInstance().getDb())
    } catch {
      kmsReader = null
    }
    return {
      ...makeReader(db),
      getSetting: (key: string) =>
        (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value,
      kms: kmsReader,
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
    // 用 Promise.resolve().then 包裹，handler 同步抛错也统一转为 rejected promise
    return Promise.resolve().then(() => handler(payload))
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
      dependencies: r.manifest.dependencies,
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
    // 禁用时同步下线插件员工（重新启用需重启激活）
    if (!enabled) {
      const { default: EmployeeRegistryService } = require('../employee-registry.service') as typeof import('../employee-registry.service')
      EmployeeRegistryService.getInstance().unregisterPluginEmployees(pluginId)
      this.unregisterPluginSkills(pluginId)
    }
    logger.info(`插件${enabled ? '启用' : '禁用'}: ${pluginId}（重启生效）`)
  }

  deletePlugin(pluginId: string): void {
    const record = this.records.get(pluginId)
    if (!record) throw new Error(`插件不存在: ${pluginId}`)
    // 删除时物理清理插件技能（连同员工分配关联）
    this.removePluginSkills(pluginId)
    fs.rmSync(record.rootDir, { recursive: true, force: true })
    this.records.delete(pluginId)
    // 删除时卸载插件员工
    const { default: EmployeeRegistryService } = require('../employee-registry.service') as typeof import('../employee-registry.service')
    EmployeeRegistryService.getInstance().unregisterPluginEmployees(pluginId)
    logger.info(`插件已删除: ${pluginId}（重启生效）`)
  }

  // ====== 插件包导入 ======

  /** 从 zip 包解压到目标目录；防空路径穿越、拒绝自带原生模块 */
  private extractPluginZip(zip: AdmZip, destDir: string): void {
    fs.mkdirSync(destDir, { recursive: true })
    const root = path.resolve(destDir)
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue
      const entryName = entry.entryName.replace(/\\/g, '/')
      if (/\.node$/i.test(entryName)) throw new Error('插件禁止自带原生模块（.node），请改用宿主 native 服务租借')
      const target = path.resolve(destDir, entryName)
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`非法路径: ${entryName}`)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, entry.getData())
    }
  }

  /**
   * 导入插件包：选择文件 → 读取 manifest 校验 → 解压到 userData/plugins/<id>。
   * 已安装相同 id 插件且未指定 overwrite 时返回 needsUpgradeConfirm（前端二次确认），
   * 确认后再以 overwrite=true 重装（复用上次 zip 路径，不再弹选择框）。
   */
  async importPlugin(overwrite?: boolean): Promise<PluginImportResult> {
    let zipPath = overwrite ? this.pendingImportZip : ''
    if (!zipPath || !fs.existsSync(zipPath)) {
      const res = await dialog.showOpenDialog({
        title: '导入 WorkAvatar 插件',
        properties: ['openFile'],
        filters: [{ name: 'WorkAvatar 插件包', extensions: [PLUGIN_PACKAGE_EXT] }],
      })
      if (res.canceled || !res.filePaths[0]) return { ok: false, message: 'cancelled' }
      zipPath = res.filePaths[0]
      this.pendingImportZip = zipPath
    }
    return this.importPluginFromPath(zipPath, overwrite)
  }

  /** 从指定路径导入插件包（系统"打开方式"直接加载 / 应用内导入复用） */
  async importPluginFromPath(zipPath: string, overwrite?: boolean): Promise<PluginImportResult> {
    let zip: AdmZip
    try {
      zip = new AdmZip(zipPath)
    } catch (err: any) {
      this.pendingImportZip = ''
      return { ok: false, message: `无法读取插件包: ${err?.message || err}` }
    }

    const manifestEntry = zip.getEntries().find(e =>
      e.entryName.replace(/\\/g, '/').toLowerCase() === 'manifest.json'
    )
    if (!manifestEntry) {
      this.pendingImportZip = ''
      return { ok: false, message: '插件包缺少 manifest.json' }
    }
    let manifest: PluginManifest
    try {
      manifest = JSON.parse(manifestEntry.getData().toString('utf-8'))
    } catch {
      this.pendingImportZip = ''
      return { ok: false, message: 'manifest.json 解析失败' }
    }
    if (!manifest.id || !manifest.main || !manifest.version) {
      this.pendingImportZip = ''
      return { ok: false, message: 'manifest 缺少 id/main/version 字段' }
    }

    const existing = this.records.get(manifest.id)
    const destDir = path.join(this.getUserDir(), manifest.id)
    // 已安装且未显式覆盖 → 引导二次确认（升级/重装）
    if (fs.existsSync(destDir) && !overwrite) {
      return {
        ok: false,
        needsUpgradeConfirm: {
          existingVersion: existing?.manifest.version ?? this.readLocalManifestVersion(destDir),
          newVersion: manifest.version,
        },
      }
    }

    try {
      if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true })
      this.extractPluginZip(zip, destDir)
      const mainEntry = path.join(destDir, manifest.main)
      if (!fs.existsSync(mainEntry)) {
        throw new Error(`解压后主进程入口不存在: ${manifest.main}`)
      }
    } catch (err: any) {
      this.pendingImportZip = ''
      return { ok: false, message: `导入失败: ${err?.message || err}` }
    }

    // 纳入记录（若此前是 invalid 状态也一并重建），供列表即时展示；激活需重启生效
    this.records.delete(manifest.id)
    this.scanPlugin(destDir, this.readDisabledList())
    const installed = this.records.get(manifest.id)
    if (installed && installed.status === 'error') {
      // 已安装但尚未重启激活 → 用独立状态 pending（前端展示"待重启生效"，避免误显失败）
      installed.enabled = true
      installed.status = 'pending'
      installed.statusMessage = undefined
    }
    logger.info(`插件已导入: ${manifest.id} v${manifest.version}`)
    return { ok: true, id: manifest.id, version: manifest.version }
  }

  /** 读取已安装插件目录下的版本（manifest 不在内存记录时的兜底） */
  private readLocalManifestVersion(dir: string): string | undefined {
    try {
      const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8')
      return JSON.parse(raw)?.version
    } catch {
      return undefined
    }
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

  /** 全部插件注册并已适配为宿主格式的数字员工工具中间件（供新建 agent 时挂载；仅激活成功插件） */
  getAgentToolMiddlewares(): ToolMiddleware[] {
    const middlewares: ToolMiddleware[] = []
    for (const [pluginId, c] of this.contributions) {
      const record = this.records.get(pluginId)
      if (!record || record.status !== 'active') continue
      for (const m of c.agentMiddlewares) middlewares.push(toToolMiddleware(m, pluginId))
    }
    return middlewares
  }

  /** 按插件分组的 agent 工具（仅激活成功且贡献了工具的插件），供工具分类按插件聚合 */
  getPluginAgentToolGroups(): Array<{ pluginId: string; pluginName: string; tools: unknown[] }> {
    const result: Array<{ pluginId: string; pluginName: string; tools: unknown[] }> = []
    for (const [pluginId, c] of this.contributions) {
      const record = this.records.get(pluginId)
      if (!record || record.status !== 'active') continue
      if (c.agentTools.length === 0) continue
      result.push({ pluginId, pluginName: record.manifest.name, tools: c.agentTools })
    }
    return result
  }

  /** 插件贡献的对话消息快捷操作清单（仅激活成功插件，供前端渲染按钮） */
  getMessageActions(): Array<{ pluginId: string; id: string; title: string; icon?: string; target?: string }> {
    const result: Array<{ pluginId: string; id: string; title: string; icon?: string; target?: string }> = []
    for (const [pluginId, actions] of this.messageActions) {
      const record = this.records.get(pluginId)
      if (!record || record.status !== 'active') continue
      for (const a of actions) {
        result.push({ pluginId, id: a.id, title: a.title, icon: a.icon, target: a.target })
      }
    }
    return result
  }

  getFileAssociationOwner(extension: string): string | undefined {
    const ext = extension.toLowerCase()
    for (const [id, c] of this.contributions) {
      if (c.fileAssociations.has(ext)) return id
    }
    return undefined
  }

  /** 内核广播事件给所有订阅插件（ctx.services.events.subscribe） */
  notifyKernelEvent(event: string, payload: unknown): void {
    const set = this.kernelEventListeners.get(event)
    if (!set) return
    for (const callback of set) {
      try { callback(payload) } catch (err: any) {
        logger.warn(`插件内核事件 ${event} 回调失败:`, err?.message || err)
      }
    }
  }

  /** 内核删除 conversation 时通知所有订阅插件（v2 事件名 conversation:deleted） */
  notifyConversationDeleted(conversationId: string): void {
    this.notifyKernelEvent('conversation:deleted', conversationId)
  }

  /**
   * 数字员工运行时事件桥：把 agent 事件广播给订阅 'agent:event' 的插件。
   * data 透传 agent 原始事件数据；无订阅者时 notifyKernelEvent 早退，零额外成本。
   */
  notifyAgentEvent(employeeId: string, conversationId: string | undefined, event: string, data: unknown): void {
    this.notifyKernelEvent('agent:event', { employeeId, conversationId, event, data })
  }

  /** 插件注册的 UI 视图注入清单（供渲染端查询渲染） */
  getViewContributions(): Array<{ pluginId: string; view: string; component: unknown }> {
    const result: Array<{ pluginId: string; view: string; component: unknown }> = []
    for (const [key, v] of this.viewContributions) {
      const sep = key.indexOf(':')
      const pluginId = key.slice(0, sep)
      const record = this.records.get(pluginId)
      if (!record || record.status !== 'active') continue
      result.push({ pluginId, view: v.view, component: v.component })
    }
    return result
  }

  /** 插件注册的命令清单（供渲染端斜杠菜单/宿主调用） */
  getCommands(): Array<{ pluginId: string; id: string; title: string }> {
    const result: Array<{ pluginId: string; id: string; title: string }> = []
    for (const [key, c] of this.commands) {
      const sep = key.indexOf(':')
      const pluginId = key.slice(0, sep)
      const record = this.records.get(pluginId)
      if (!record || record.status !== 'active') continue
      result.push({ pluginId, id: c.id, title: c.title })
    }
    return result
  }

  /** 按文件扩展名解析应路由到的插件 id（无插件声明该扩展名时返回 undefined） */
  getPluginForFileExtension(extension: string): string | undefined {
    return this.getFileAssociationOwner(extension)
  }

  // ====== plugin:// 协议 ======

  /** plugin://<id>/<相对路径> → 插件目录内文件；越权路径 403，未启用插件 404 */
  servePluginFile(url: string): Response {
    const parsed = new URL(url)
    const id = parsed.hostname
    let rel: string
    try {
      rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
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
    // no-store：禁止 Chromium 缓存插件文件，否则插件升级/重装后渲染端仍加载旧版本
    return new Response(fs.readFileSync(target), {
      headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' },
    })
  }

  // ====== 退出清理 ======

  shutdown(): void {
    for (const accelerator of this.registeredShortcuts) {
      try { globalShortcut.unregister(accelerator) } catch { /* ignore */ }
    }
    this.registeredShortcuts.clear()
    this.busResponders.clear()
    // 清理插件注册的定时任务
    for (const [, dispose] of this.schedulerJobs) {
      try { dispose() } catch { /* ignore */ }
    }
    this.schedulerJobs.clear()
    // 关闭跨插件共享库
    if (this.sharedDb) {
      try { this.sharedDb.close() } catch { /* ignore */ }
      this.sharedDb = null
    }
    // 清理插件创建的窗口
    for (const win of this.pluginWindows) {
      if (!win.isDestroyed()) try { win.destroy() } catch { /* ignore */ }
    }
    this.pluginWindows.clear()
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
