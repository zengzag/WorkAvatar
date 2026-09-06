/**
 * 插件宿主热加载核心逻辑单测（多尺度）：
 * - 集成尺度：真实临时目录放置插件工程 + 真实主进程模块加载（activate/deactivate 真实执行），
 *   覆盖 扫描校验 / 激活 / 启停 / 依赖拓扑 / 依赖循环守卫 / 删除 / zip 导入（含多选与覆盖升级）/ reconcile / dispatch / shutdown
 * - 白盒尺度：构造记录直接调用 activateSingle 等私有方法，验证边界与状态机
 * 插件 fixtures 使用真实 CJS 入口（module.exports），经宿主 createRequire 加载，行为由注入 config 参数化。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import AdmZip from 'adm-zip'
import { EventEmitter } from 'events'
import Module from 'module'
import { dialog, BrowserWindow } from 'electron'
import PluginHostService from '../../../electron/main/services/plugin/plugin-host.service'
import { IPC_CHANNELS } from '../../../electron/shared/ipc-channels'

// ====== 共享 mock 状态（hoisted，供 vi.mock 工厂与测试断言共用） ======

const mockState = vi.hoisted(() => {
  const settings = new Map<string, string>()
  const agent = {
    bumpToolEpoch: vi.fn(),
    clearAgentCache: vi.fn(),
  }
  const registry = {
    registerPluginEmployees: vi.fn(),
    unregisterPluginEmployees: vi.fn(),
    resetPluginEmployees: vi.fn(),
  }
  const skills = {
    registerPluginSkills: vi.fn(),
    markPluginSkillsInactive: vi.fn(),
    removePluginSkills: vi.fn(),
  }
  const shortcuts = { register: vi.fn(() => true), unregister: vi.fn() }
  let currentUserData = ''
  let currentDataDir = ''
  const fakeDb = {
    prepare: (sql: string) => {
      if (sql.includes('FROM settings')) {
        return {
          get: (key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined),
        }
      }
      if (sql.includes('INSERT INTO settings')) {
        return {
          run: (key: string, value: string) => {
            settings.set(key, value)
            return { changes: 1 }
          },
        }
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
  }
  return {
    settings,
    fakeDb,
    agent,
    registry,
    skills,
    shortcuts,
    getCurrentUserData: () => currentUserData,
    setCurrentUserData: (v: string) => { currentUserData = v },
    getCurrentDataDir: () => currentDataDir,
    setCurrentDataDir: (v: string) => { currentDataDir = v },
  }
})

// ====== 宿主依赖 mock：运行时 require('../xxx.service') 经 Module._load 拦截 ======
// 插件宿主的服务依赖都是方法体内的延迟 require（避免循环依赖）。vitest 的 vi.mock 只拦截
// ESM import；方法体内的 require 经 vite-node 转换为原生 require 无法解析 .ts 无扩展名路径，
// 因此在测试进程中挂 Module._load 拦截器，把这些运行时 require 指向 vi.fn mock。

const origModuleLoad = (Module as any)._load

function installServiceLoadInterceptor(): void {
  ;(Module as any)._load = function (this: any, request: string, parent: any, isMain: boolean) {
    const name = request.split('/').pop()
    const svc: { [k: string]: object } = {
      'path.service': { default: { getInstance: () => ({ getDataDir: () => mockState.getCurrentDataDir() }) } },
      'database.service': { default: { getInstance: () => ({ getDb: () => mockState.fakeDb }) } },
      'employee-agent.service': { default: { getInstance: () => mockState.agent } },
      'employee-registry.service': { default: { getInstance: () => mockState.registry } },
      'skill-registry.service': { default: { getInstance: () => mockState.skills } },
    }
    if (name && svc[name]) return svc[name]
    return origModuleLoad.call(this, request, parent, isMain)
  }
}

function restoreServiceLoadInterceptor(): void {
  ;(Module as any)._load = origModuleLoad
}

// ====== 宿主依赖 mock（ESM 顶层依赖） ======

vi.mock('electron', () => ({
  app: {
    isPackaged: true, // 测试统一按 release 扫描（跳过项目 plugins/ 真实子模块目录）
    getPath: vi.fn(() => mockState.getCurrentUserData()),
    getVersion: () => '1.1.0',
  },
  BrowserWindow: class extends EventEmitter {
    destroyed = false
    webContents = { send: vi.fn() }
    constructor(public options: Record<string, unknown>) { super() }
    isDestroyed() { return this.destroyed }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
    close() { this.destroy() }
    show() { /* noop */ }
    hide() { /* noop */ }
    isVisible() { return false }
    setSize() { /* noop */ }
    loadFile() { return Promise.resolve() }
    loadURL() { return Promise.resolve() }
  },
  dialog: { showOpenDialog: vi.fn() },
  globalShortcut: mockState.shortcuts,
  shell: { openPath: vi.fn() },
}))

// plugin-host 顶部 ESM import DatabaseService，需走 vi.mock；方法体内运行时 require 走 Module._load 拦截器
vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => mockState.fakeDb }) },
}))

// ====== fixture 工具 ======

type FixtureCfg = {
  registerIpcs?: boolean
  registerTools?: boolean
  subscribeEvents?: boolean
  scheduler?: boolean
  registerCommand?: boolean
  registerView?: boolean
  createWindow?: boolean
  registerShortcut?: boolean
  throw?: boolean
  throwMessage?: string
  /** 覆盖升级场景：deactivate 标记写到插件目录外（目录会被整体替换），便于断言旧实例确被下线 */
  deactivateMarkerPath?: string
}

function makeMainJs(cfg: FixtureCfg): string {
  const deactLine = cfg.deactivateMarkerPath
    ? `fs.writeFileSync(${JSON.stringify(cfg.deactivateMarkerPath)}, '')`
    : `fs.writeFileSync(path.join(rootDir, '.deactivated'), '')`
  return `
const fs = require('fs')
const path = require('path')
const config = ${JSON.stringify(cfg)}
let rootDir = ''
module.exports = {
  activate(ctx) {
    rootDir = ctx.paths.root
    const f = path.join(rootDir, '.activate-count')
    const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf-8')) : 0
    fs.writeFileSync(f, String(n + 1))
    if (config.registerIpcs) ctx.ipc.handle('ping', () => ({ pong: true }))
    if (config.registerTools) ctx.contributions.registerAgentTools([{ id: 'tool-' + path.basename(ctx.paths.root), name: 'Tool', description: 'x', inputSchema: { type: 'object' }, handler: () => 'ok', permission: 'allow', source: 'plugin' }])
    if (config.subscribeEvents) ctx.services.events.subscribe('kernel:evt', () => { fs.writeFileSync(path.join(rootDir, '.event-received'), '') })
    if (config.scheduler) ctx.services.scheduler.every(600000, () => {})
    if (config.registerCommand) ctx.contributions.registerCommand({ id: 'cmd1', title: 'Cmd', handler: () => 'ok' })
    if (config.registerView) ctx.contributions.registerView({ view: 'chat.toolbar', component: {} })
    if (config.createWindow) ctx.services.windows.create({ width: 200, height: 200 })
    if (config.registerShortcut) ctx.contributions.registerGlobalShortcuts([{ accelerator: 'CommandOrControl+Alt+X', handler: () => {} }])
    if (config.throw) throw new Error(config.throwMessage || 'activate boom')
  },
  deactivate() { ${deactLine} },
}
`
}

let root = ''
let dataDir = ''
let pluginsDir = ''

function pluginDir(id: string) {
  return path.join(pluginsDir, id)
}

function writePlugin(
  id: string,
  opts: {
    name?: string
    version?: string
    engine?: string
    renderer?: string
    locale?: { [lng: string]: Record<string, unknown> }
    deps?: Record<string, string>
    ipc?: string[]
    employees?: Array<{ key: string; name: string; systemPrompt: string }>
    capabilities?: unknown[]
    cfg?: FixtureCfg
  } = {},
) {
  const dir = pluginDir(id)
  fs.mkdirSync(dir, { recursive: true })
  const manifest: Record<string, unknown> = {
    id,
    name: opts.name ?? `Plugin ${id}`,
    version: opts.version ?? '1.0.0',
    engine: opts.engine ?? '*',
    main: 'main.js',
    ipc: opts.ipc ?? (opts.cfg?.registerIpcs ? ['ping'] : []), // 声明了 IPC 处理器时必须放行对应通道
    capabilities: opts.capabilities ?? [],
  }
  if (opts.renderer) manifest.renderer = opts.renderer
  if (opts.deps) manifest.dependencies = opts.deps
  if (opts.employees) manifest.employees = opts.employees
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(dir, 'main.js'), makeMainJs(opts.cfg ?? {}))
  if (opts.locale) {
    fs.mkdirSync(path.join(dir, 'locale'), { recursive: true })
    for (const [lng, res] of Object.entries(opts.locale)) {
      fs.writeFileSync(path.join(dir, 'locale', `${lng}.json`), JSON.stringify(res))
    }
  }
  if (opts.renderer) fs.writeFileSync(path.join(dir, opts.renderer), 'export default {}')
}

/** capabilities 生成器：按 fixture 行为声明对应能力域（system 特性合并去重） */
function capsFor(cfg: FixtureCfg): Record<string, unknown>[] {
  const features = new Set<string>()
  if (cfg.scheduler) features.add('scheduler')
  if (cfg.createWindow) features.add('windows')
  if (cfg.registerShortcut) features.add('globalShortcuts')
  const caps: Record<string, unknown>[] = []
  if (cfg.subscribeEvents) caps.push({ domain: 'events', subscribe: ['kernel:evt'] })
  if (cfg.registerView) caps.push({ domain: 'ui', views: ['chat.toolbar'] })
  if (features.size > 0) caps.push({ domain: 'system', features: Array.from(features) })
  return caps
}

/** 白盒：直接构造记录并放入 host.records（不入盘扫描），供私有方法精确测试 */
function makeRecord(id: string, opts: { version?: string; deps?: Record<string, string>; enabled?: boolean } = {}) {
  const dir = pluginDir(id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id,
    name: `Plugin ${id}`,
    version: opts.version ?? '1.0.0',
    engine: '*',
    main: 'main.js',
    dependencies: opts.deps,
    capabilities: [],
  }))
  fs.writeFileSync(path.join(dir, 'main.js'), makeMainJs({}))
  return {
    manifest: { id, name: `Plugin ${id}`, version: opts.version ?? '1.0.0', engine: '*', main: 'main.js', dependencies: opts.deps, capabilities: [] },
    source: 'user',
    rootDir: dir,
    enabled: opts.enabled ?? true,
    engineOk: true,
    status: (opts.enabled === false ? 'disabled' : 'error') as 'disabled' | 'error',
    statusMessage: opts.enabled === false ? undefined : '尚未激活',
  }
}

function makeHost(): PluginHostService {
  return new (PluginHostService as unknown as { new (): PluginHostService })()
}

function readPluginFlag(id: string, name: string): boolean {
  return fs.existsSync(path.join(pluginDir(id), name))
}

function readActivateCount(id: string): number {
  const f = path.join(pluginDir(id), '.activate-count')
  return fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf-8')) : 0
}

function buildZip(id: string, version: string, cfg: FixtureCfg, dest: string) {
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify({
      id,
      name: `Plugin ${id}`,
      version,
      engine: '*',
      main: 'main.js',
      ipc: ['ping'],
      capabilities: capsFor(cfg),
    })),
  )
  zip.addFile('main.js', Buffer.from(makeMainJs(cfg)))
  zip.writeZip(dest)
  return dest
}

function makeWin() {
  return new (BrowserWindow as unknown as new (o?: Record<string, unknown>) => any)({})
}

beforeEach(() => {
  vi.clearAllMocks()
  installServiceLoadInterceptor()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-host-test-'))
  dataDir = path.join(root, 'data')
  pluginsDir = path.join(dataDir, 'plugins')
  fs.mkdirSync(pluginsDir, { recursive: true })
  mockState.setCurrentUserData(path.join(root, 'user-data'))
  mockState.setCurrentDataDir(dataDir)
  mockState.settings.clear()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  restoreServiceLoadInterceptor()
})

// ====== 扫描 / 校验 / 激活 ======

describe('扫描与校验（init / scanPluginInto）', () => {
  it('激活有效插件，无效/禁用插件按状态归位，renderer 快照含版本', () => {
    writePlugin('good', {
      renderer: 'index.js',
      locale: { 'zh-CN': { hello: '你好' } },
      ipc: ['ping'],
      cfg: { registerIpcs: true },
      capabilities: capsFor({ registerIpcs: true }),
    })
    writePlugin('no-main-ready') // 视作正常
    fs.rmSync(path.join(pluginDir('no-main-ready'), 'main.js')) // 缺 main 入口 → invalid
    writePlugin('bad-engine', { engine: '^9.0.0' }) // engine 不兼容 → invalid
    writePlugin('offed', {})
    mockState.settings.set('plugins.config', JSON.stringify({ disabled: ['offed'] }))

    const host = makeHost()
    host.init()

    const byId = new Map(host.listPlugins().map(p => [p.id, p]))
    expect(byId.get('good')!.status).toBe('active')
    expect(byId.get('good')!.enabled).toBe(true)
    expect(byId.get('no-main-ready')!.status).toBe('invalid')
    expect(byId.get('bad-engine')!.status).toBe('invalid')
    expect(byId.get('offed')!.status).toBe('disabled')
    expect(byId.get('offed')!.enabled).toBe(false)

    const renderer = host.getRendererPlugins()
    expect(renderer).toHaveLength(1)
    expect(renderer[0].id).toBe('good')
    expect(renderer[0].version).toBe('1.0.0')
    expect(renderer[0].locales['zh-CN']).toEqual({ hello: '你好' })
  })

  it('id 非法 / 保留字 / capabilities 非法 → invalid', () => {
    writePlugin('BadID') // 大写开头 → 非法 id（以目录名作为 key）
    writePlugin('settings') // 保留字
    writePlugin('badcaps', { capabilities: [{ domain: 'nope' }] })
    const host = makeHost()
    host.init()
    const statusOf = (id: string) => host.listPlugins().find(p => p.id === id)?.status
    expect(statusOf('BadID')).toBe('invalid')
    expect(statusOf('settings')).toBe('invalid')
    expect(statusOf('badcaps')).toBe('invalid')
  })

  it('激活失败（activate 抛错）隔离为 error 且清理部分注册的贡献点，修复后可重试激活', () => {
    writePlugin('boom', {
      cfg: { registerIpcs: true, registerTools: true, subscribeEvents: true, throw: true, throwMessage: 'boom!' },
      capabilities: capsFor({ registerIpcs: true, registerTools: true, subscribeEvents: true }),
    })
    const host = makeHost()
    host.init()
    const record = host.listPlugins().find(p => p.id === 'boom')!
    expect(record.status).toBe('error')
    expect(record.statusMessage).toBe('boom!')
    // 激活失败不得残留部分注册（工具/处理器/事件订阅均被清理）
    expect(host.getAgentTools()).toHaveLength(0)
    expect((host as any).handlers.has('plugin:boom:ping')).toBe(false)
    expect((host as any).kernelEventListeners.has('kernel:evt')).toBe(false)
    expect((host as any).contributions.size).toBe(0)

    // 修复 fixture（manifest 不变，仅重建 main.js）后可无需重启直接重试激活
    fs.writeFileSync(path.join(pluginDir('boom'), 'main.js'), makeMainJs({ registerIpcs: true }))
    const r = (host as any).activateSingle('boom')
    expect(r.ok).toBe(true)
    expect(host.listPlugins().find(p => p.id === 'boom')!.status).toBe('active')
    expect((host as any).handlers.has('plugin:boom:ping')).toBe(true)
  })
})

// ====== dispatch / IPC 桥 ======

describe('dispatch（通用 IPC 桥）', () => {
  it('路由到激活插件 handler；未激活 / 未注册通道均明确拒绝', async () => {
    writePlugin('alpha', { ipc: ['ping'], cfg: { registerIpcs: true }, capabilities: capsFor({ registerIpcs: true }) })
    writePlugin('offed', {})
    mockState.settings.set('plugins.config', JSON.stringify({ disabled: ['offed'] }))
    const host = makeHost()
    host.init()
    await expect(host.dispatch('alpha', 'ping', { x: 1 })).resolves.toEqual({ pong: true })
    await expect(host.dispatch('alpha', 'missing', {})).rejects.toThrow('通道未注册')
    await expect(host.dispatch('offed', 'ping', {})).rejects.toThrow('插件不可用')
  })
})

// ====== 启用 / 禁用 ======

describe('setEnabled（启用/禁用即时生效）', () => {
  it('禁用激活插件：完整清理 handler/工具/事件/命令/视图/调度/窗口/快捷键并调用 deactivate', () => {
    writePlugin('alpha', {
      cfg: {
        registerIpcs: true,
        registerTools: true,
        subscribeEvents: true,
        scheduler: true,
        registerCommand: true,
        registerView: true,
        createWindow: true,
        registerShortcut: true,
      },
      capabilities: capsFor({
        registerIpcs: true,
        registerTools: true,
        subscribeEvents: true,
        scheduler: true,
        registerCommand: true,
        registerView: true,
        createWindow: true,
        registerShortcut: true,
      }),
    })
    const host = makeHost()
    host.init()

    const s = host as any
    expect(s.records.get('alpha').status).toBe('active')
    expect(s.handlers.has('plugin:alpha:ping')).toBe(true)
    expect(s.schedulerJobs.size).toBe(1)
    expect(s.commands.has('alpha:cmd1')).toBe(true)
    expect(s.viewContributions.has('alpha:chat.toolbar')).toBe(true)
    expect(s.kernelEventListeners.get('kernel:evt')?.size).toBe(1)
    expect(s.pluginWindows.size).toBe(1)
    expect(host.getAgentTools()).toHaveLength(1)

    host.setEnabled('alpha', false)

    expect(s.records.get('alpha').status).toBe('disabled')
    expect(s.handlers.has('plugin:alpha:ping')).toBe(false)
    expect(s.schedulerJobs.size).toBe(0)
    expect(s.commands.has('alpha:cmd1')).toBe(false)
    expect(s.viewContributions.has('alpha:chat.toolbar')).toBe(false)
    expect(s.kernelEventListeners.has('kernel:evt')).toBe(false)
    expect(s.pluginWindows.size).toBe(0)
    expect(host.getAgentTools()).toHaveLength(0)
    expect(mockState.shortcuts.unregister).toHaveBeenCalled()
    expect(readPluginFlag('alpha', '.deactivated')).toBe(true)
    // 变更通知：工具集 epoch 递增 + agent 缓存清理 + 渲染端广播
    expect(mockState.agent.bumpToolEpoch).toHaveBeenCalled()
    expect(mockState.agent.clearAgentCache).toHaveBeenCalled()
  })

  it('禁用不触碰其他插件', () => {
    writePlugin('alpha', { cfg: { registerIpcs: true }, capabilities: capsFor({ registerIpcs: true }) })
    writePlugin('beta', { cfg: { registerIpcs: true }, capabilities: capsFor({ registerIpcs: true }) })
    const host = makeHost()
    host.init()
    host.setEnabled('alpha', false)
    expect((host as any).handlers.has('plugin:beta:ping')).toBe(true)
    expect(host.listPlugins().find(p => p.id === 'beta')!.status).toBe('active')
  })

  it('启用已禁用的插件即时激活', () => {
    writePlugin('offed', {})
    mockState.settings.set('plugins.config', JSON.stringify({ disabled: ['offed'] }))
    const host = makeHost()
    host.init()
    expect(host.listPlugins().find(p => p.id === 'offed')!.status).toBe('disabled')
    host.setEnabled('offed', true)
    expect(host.listPlugins().find(p => p.id === 'offed')!.status).toBe('active')
  })

  it('重复启用已激活插件不二次 activate（回归：防重复注册 handler/定时任务/订阅）', () => {
    writePlugin('alpha', { cfg: { registerIpcs: true }, capabilities: capsFor({ registerIpcs: true }) })
    const host = makeHost()
    host.init()
    expect(readActivateCount('alpha')).toBe(1)
    host.setEnabled('alpha', true)
    expect(readActivateCount('alpha')).toBe(1)
    expect((host as any).handlers.has('plugin:alpha:ping')).toBe(true)
    expect((host as any).schedulerJobs.size).toBe(0)
  })

  it('静态校验失败的插件启用被拒绝且保持 invalid', () => {
    writePlugin('bad-engine', { engine: '^99.0.0' })
    const host = makeHost()
    host.init()
    expect(host.listPlugins().find(p => p.id === 'bad-engine')!.status).toBe('invalid')
    host.setEnabled('bad-engine', true)
    expect(host.listPlugins().find(p => p.id === 'bad-engine')!.status).toBe('invalid')
    expect(mockState.agent.bumpToolEpoch).toHaveBeenCalled()
  })

  it('启用依赖缺失的插件被拒绝为 invalid 并给出文案', () => {
    writePlugin('lonely', { deps: { ghost: '*' } })
    const host = makeHost()
    host.init()
    host.setEnabled('lonely', true)
    const p = host.listPlugins().find(x => x.id === 'lonely')!
    expect(p.status).toBe('invalid')
    expect(p.statusMessage).toContain('缺少依赖插件')
  })
})

// ====== 依赖拓扑 / 传播 ======

describe('依赖处理（activateSingle / collectDependents）', () => {
  it('禁用插件连带下线依赖它的插件；依赖恢复后重新启用可自愈', () => {
    writePlugin('dep-a', { cfg: { registerTools: true }, capabilities: capsFor({ registerTools: true }) })
    writePlugin('app-b', { deps: { 'dep-a': '*' }, cfg: { registerTools: true }, capabilities: capsFor({ registerTools: true }) })
    const host = makeHost()
    host.init()
    const s = host as any
    expect(s.records.get('app-b').status).toBe('active')
    expect(host.getAgentTools()).toHaveLength(2)

    host.setEnabled('dep-a', false)
    expect(s.records.get('dep-a').status).toBe('disabled')
    expect(s.records.get('app-b').status).toBe('invalid')
    expect(s.records.get('app-b').enabled).toBe(false)
    expect(s.records.get('app-b').statusMessage).toContain('依赖插件 dep-a')
    expect(host.getAgentTools()).toHaveLength(0)

    // 恢复依赖后，被连带禁用的 app-b 需手动重新启用（自愈路径）
    host.setEnabled('dep-a', true)
    expect(s.records.get('dep-a').status).toBe('active')
    host.setEnabled('app-b', true)
    expect(s.records.get('app-b').status).toBe('active')
    expect(host.getAgentTools()).toHaveLength(2)
  })

  it('依赖版本不满足的插件判为 invalid（caret 语义）', () => {
    writePlugin('lib', { version: '0.3.0' })
    writePlugin('app', { deps: { lib: '^0.2.0' } }) // ^0.2.0 不接受 0.3.0
    const host = makeHost()
    host.init()
    const p = host.listPlugins().find(x => x.id === 'app')!
    expect(p.status).toBe('invalid')
    expect(p.statusMessage).toContain('版本不满足')
  })

  it('依赖循环被激活链路检测并拒绝，不无限递归（回归）', () => {
    const host = makeHost()
    const records = (host as any).records
    records.set('a', makeRecord('a', { deps: { b: '*' } }))
    records.set('b', makeRecord('b', { deps: { a: '*' } }))
    const r = (host as any).activateSingle('a')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('依赖循环')
  })
})

// ====== 删除 ======

describe('deletePlugin', () => {
  it('删除激活插件：物理移除目录、卸载员工、连带下线依赖者', () => {
    writePlugin('victim', {
      cfg: { registerTools: true },
      capabilities: capsFor({ registerTools: true }),
      employees: [{ key: 'dev', name: 'Dev', systemPrompt: 'dev' }],
    })
    writePlugin('fan', { deps: { victim: '*' }, cfg: { registerTools: true }, capabilities: capsFor({ registerTools: true }) })
    const host = makeHost()
    host.init()
    expect(mockState.registry.registerPluginEmployees).toHaveBeenCalledWith('victim', expect.any(String), expect.any(Array))

    host.deletePlugin('victim')

    expect(fs.existsSync(pluginDir('victim'))).toBe(false)
    expect(host.listPlugins().find(p => p.id === 'victim')).toBeUndefined()
    const fan = host.listPlugins().find(p => p.id === 'fan')!
    expect(fan.status).toBe('invalid')
    expect(fan.enabled).toBe(false)
    expect(mockState.registry.unregisterPluginEmployees).toHaveBeenCalledWith('victim')
    expect(mockState.agent.bumpToolEpoch).toHaveBeenCalled()
  })

  it('删除不存在的插件抛错', () => {
    const host = makeHost()
    host.init()
    expect(() => host.deletePlugin('nope')).toThrow('插件不存在')
  })
})

// ====== zip 导入 ======

describe('importPluginFromPath（单包导入与覆盖升级）', () => {
  it('导入合法 zip 即时激活', async () => {
    const zipPath = buildZip('newp', '1.0.0', { registerIpcs: true }, path.join(root, 'newp.wap'))
    const host = makeHost()
    host.init()
    const r = await host.importPluginFromPath(zipPath, false)
    expect(r.ok).toBe(true)
    expect(r.id).toBe('newp')
    expect(host.listPlugins().find(p => p.id === 'newp')!.status).toBe('active')
    await expect(host.dispatch('newp', 'ping', {})).resolves.toEqual({ pong: true })
    expect(mockState.agent.bumpToolEpoch).toHaveBeenCalled()
  })

  it('覆盖升级：旧贡献完整下线（deactivate 执行 + 处理器清理）后按新版本激活', async () => {
    const marker = path.join(root, 'up.deactivated')
    // 旧版本（v1）的 deactivate 也要写外部 marker：升级时包目录会被整体替换，外部文件才能存证
    const z1 = buildZip('up', '1.0.0', { registerIpcs: true, deactivateMarkerPath: marker }, path.join(root, 'up1.wap'))
    const z2 = buildZip('up', '2.0.0', { registerIpcs: true }, path.join(root, 'up2.wap'))
    const host = makeHost()
    host.init()
    await expect(host.importPluginFromPath(z1, false)).resolves.toMatchObject({ ok: true, version: '1.0.0' })
    await expect(host.dispatch('up', 'ping', {})).resolves.toEqual({ pong: true })

    await expect(host.importPluginFromPath(z2, true)).resolves.toMatchObject({ ok: true, version: '2.0.0' })
    const p = host.listPlugins().find(x => x.id === 'up')!
    expect(p.version).toBe('2.0.0')
    expect(p.status).toBe('active')
    expect(fs.existsSync(marker)).toBe(true) // 旧实例 deactivate 被调用
    await expect(host.dispatch('up', 'ping', {})).resolves.toEqual({ pong: true })
  })

  it('无效包（缺 manifest / 缺 main 字段）明确失败且不产生记录', async () => {
    const bad1 = path.join(root, 'bad1.wap')
    new AdmZip().writeZip(bad1) // 空 zip

    const bad2 = path.join(root, 'bad2.wap')
    const z2 = new AdmZip()
    z2.addFile('manifest.json', Buffer.from(JSON.stringify({ id: 'bad2', version: '1.0.0' }))) // 缺 main
    z2.writeZip(bad2)

    const host = makeHost()
    host.init()
    await expect(host.importPluginFromPath(bad1, false)).resolves.toMatchObject({ ok: false })
    await expect(host.importPluginFromPath(bad2, false)).resolves.toMatchObject({ ok: false })
    expect(host.listPlugins()).toHaveLength(0)
  })

  it('extractPluginZip 拒绝路径穿越与自带 .node 原生模块（note：AdmZip 写入时会规范化 ../，故直接喂鸭子类型 zip）', async () => {
    const host = makeHost()
    host.init()
    const dest = path.join(pluginsDir, 'evilp')
    const fakeZip = {
      getEntries: () => [
        { isDirectory: false, entryName: 'manifest.json', getData: () => Buffer.from('{}') },
        { isDirectory: false, entryName: '../../evil.txt', getData: () => Buffer.from('x') },
      ],
    }
    expect(() => (host as any).extractPluginZip(fakeZip, dest)).toThrow('非法路径')

    const fakeZipNode = {
      getEntries: () => [
        { isDirectory: false, entryName: 'manifest.json', getData: () => Buffer.from('{}') },
        { isDirectory: false, entryName: 'lib/native.node', getData: () => Buffer.from('x') },
      ],
    }
    expect(() => (host as any).extractPluginZip(fakeZipNode, dest)).toThrow('禁止自带原生模块')
  })
})

describe('importPlugin（多选导入 / 冲突预检）', () => {
  it('多选批量导入成功聚合 count', async () => {
    const zA = buildZip('zip-a', '1.0.0', {}, path.join(root, 'a.wap'))
    const zB = buildZip('zip-b', '1.0.0', {}, path.join(root, 'b.wap'))
    vi.mocked(dialog).showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [zA, zB] })
    const host = makeHost()
    host.init()
    const r = await host.importPlugin()
    expect(r.ok).toBe(true)
    expect(r.count).toBe(2)
  })

  it('部分失败：失败项带文件名聚合上报', async () => {
    const zA = buildZip('zip-ok', '1.0.0', {}, path.join(root, 'ok.wap'))
    const bad = path.join(root, 'bad.wap')
    new AdmZip().writeZip(bad)
    vi.mocked(dialog).showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [zA, bad] })
    const host = makeHost()
    host.init()
    const r = await host.importPlugin()
    expect(r.ok).toBe(false)
    expect(r.count).toBe(1)
    expect(r.message).toContain('bad.wap')
  })

  it('已装同 id 冲突：先整体返回 needsUpgradeConfirm，确认后批量覆盖（复用路径不再弹框）', async () => {
    const v1 = buildZip('conflict', '1.0.0', {}, path.join(root, 'v1.wap'))
    const v2 = buildZip('conflict', '2.0.0', {}, path.join(root, 'v2.wap'))
    const showOpenDialog = vi.mocked(dialog).showOpenDialog
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [v1] })
    const host = makeHost()
    host.init()
    await host.importPlugin()
    expect(host.listPlugins().find(p => p.id === 'conflict')!.version).toBe('1.0.0')

    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [v2] })
    const pending = await host.importPlugin()
    expect(pending.ok).toBe(false)
    expect(pending.needsUpgradeConfirm).toBeDefined()
    expect(pending.needsUpgradeConfirm!.existingVersion).toBe('1.0.0')
    expect(pending.needsUpgradeConfirm!.newVersion).toBe('2.0.0')

    const done = await host.importPlugin(true) // 复用 pendingImportZips，不再弹框
    expect(done.ok).toBe(true)
    expect(host.listPlugins().find(p => p.id === 'conflict')!.version).toBe('2.0.0')
    expect(showOpenDialog).toHaveBeenCalledTimes(2)
  })

  it('取消选择返回 cancelled', async () => {
    vi.mocked(dialog).showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const host = makeHost()
    host.init()
    const r = await host.importPlugin()
    expect(r.ok).toBe(false)
    expect(r.message).toBe('cancelled')
  })
})

// ====== reconcile（增量热插拔核心） ======

describe('reconcile（重新扫描增量 diff）', () => {
  it('磁盘新增插件 → 增量激活并通知（bumpToolEpoch + PLUGIN_CHANGED 广播）', () => {
    writePlugin('keep', { cfg: { registerTools: true }, capabilities: capsFor({ registerTools: true }) })
    const host = makeHost()
    host.init()
    const win = makeWin()
    host.addTarget(win)
    mockState.agent.bumpToolEpoch.mockClear()

    writePlugin('added', { cfg: { registerTools: true }, capabilities: capsFor({ registerTools: true }) })
    const changed = host.reconcile()

    expect(changed).toContain('added')
    expect(host.listPlugins().find(p => p.id === 'added')!.status).toBe('active')
    expect(mockState.agent.bumpToolEpoch).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.PLUGIN_CHANGED,
      expect.objectContaining({ rendererPlugins: expect.any(Array) }),
    )
  })

  it('磁盘移除插件 → 下线并删除记录', () => {
    writePlugin('gone', { cfg: { registerTools: true }, capabilities: capsFor({ registerTools: true }) })
    writePlugin('keep', {})
    const host = makeHost()
    host.init()
    expect(host.listPlugins().find(p => p.id === 'gone')!.status).toBe('active')

    fs.rmSync(pluginDir('gone'), { recursive: true, force: true })
    const changed = host.reconcile()

    expect(changed).toContain('gone')
    expect(host.listPlugins().find(p => p.id === 'gone')).toBeUndefined()
    expect(host.listPlugins().find(p => p.id === 'keep')).toBeDefined()
  })

  it('磁盘版本变更 → 旧记录下线、新记录激活', () => {
    writePlugin('ver', { version: '1.0.0', cfg: { registerIpcs: true }, capabilities: capsFor({ registerIpcs: true }) })
    const host = makeHost()
    host.init()
    expect(host.listPlugins().find(p => p.id === 'ver')!.version).toBe('1.0.0')

    // 直接改磁盘 version（模拟手工替换/升级场景）
    const dir = pluginDir('ver')
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
    manifest.version = '2.0.0'
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
    const changed = host.reconcile()

    expect(changed).toContain('ver')
    const p = host.listPlugins().find(x => x.id === 'ver')!
    expect(p.version).toBe('2.0.0')
    expect(p.status).toBe('active')
    expect(readPluginFlag('ver', '.deactivated')).toBe(true)
  })

  it('禁用列表变更 → 对应插件下线（含依赖传播）', () => {
    writePlugin('dep-a', { cfg: { registerTools: true }, capabilities: capsFor({ registerTools: true }) })
    writePlugin('app-b', { deps: { 'dep-a': '*' }, cfg: { registerTools: true }, capabilities: capsFor({ registerTools: true }) })
    const host = makeHost()
    host.init()
    expect(host.listPlugins().find(p => p.id === 'app-b')!.status).toBe('active')

    mockState.settings.set('plugins.config', JSON.stringify({ disabled: ['dep-a'] }))
    const changed = host.reconcile()

    expect(changed).toContain('dep-a')
    const s = host as any
    expect(s.records.get('dep-a').status).toBe('disabled')
    expect(s.records.get('app-b').status).toBe('invalid')
    expect(s.records.get('app-b').enabled).toBe(false)
    expect(readPluginFlag('dep-a', '.deactivated')).toBe(true)
  })

  it('无变更时返回空列表且不触发通知', () => {
    writePlugin('keep', {})
    const host = makeHost()
    host.init()
    mockState.agent.bumpToolEpoch.mockClear()
    const changed = host.reconcile()
    expect(changed).toHaveLength(0)
    expect(mockState.agent.bumpToolEpoch).not.toHaveBeenCalled()
  })

  it('依赖被磁盘移除 → 依赖者连同下线；恢复后 reconcile 自动恢复激活', () => {
    writePlugin('base', { cfg: { registerTools: true }, capabilities: capsFor({ registerTools: true }) })
    writePlugin('child', { deps: { base: '*' }, cfg: { registerTools: true }, capabilities: capsFor({ registerTools: true }) })
    const host = makeHost()
    host.init()
    expect((host as any).records.get('child').status).toBe('active')

    fs.rmSync(pluginDir('base'), { recursive: true, force: true })
    const changed = host.reconcile()
    expect(changed).toContain('base')
    const s = host as any
    expect(s.records.has('base')).toBe(false)
    expect(s.records.get('child').status).toBe('invalid')

    // 恢复 base 后 reconcile → child 依赖满足自动恢复激活
    writePlugin('base', { cfg: { registerTools: true }, capabilities: capsFor({ registerTools: true }) })
    host.reconcile()
    expect(s.records.get('child').status).toBe('active')
  })
})

// ====== 员工 / 技能注册与下线 ======

describe('插件员工与技能生命周期', () => {
  it('激活注册员工与技能；禁用下线保留记录', () => {
    writePlugin('emp', {
      employees: [{ key: 'dev', name: 'Dev Assistant', systemPrompt: 'help' }],
    })
    fs.mkdirSync(path.join(pluginDir('emp'), 'skills', 'demo'), { recursive: true })
    fs.writeFileSync(path.join(pluginDir('emp'), 'skills', 'demo', 'SKILL.md'), '# demo')
    const host = makeHost()
    host.init()
    expect(mockState.registry.registerPluginEmployees).toHaveBeenCalledWith(
      'emp',
      'Plugin emp',
      expect.arrayContaining([expect.objectContaining({ id: 'dev', name: 'Dev Assistant' })]),
    )
    expect(mockState.skills.registerPluginSkills).toHaveBeenCalledWith('emp', path.join(pluginDir('emp'), 'skills'))

    host.setEnabled('emp', false)
    expect(mockState.skills.markPluginSkillsInactive).toHaveBeenCalledWith('emp')
    expect(mockState.registry.unregisterPluginEmployees).toHaveBeenCalledWith('emp')
  })
})

// ====== shutdown / 渲染端通知 ======

describe('shutdown 与渲染端通知', () => {
  it('shutdown 清理快捷键/调度/窗口且不抛错', () => {
    writePlugin('alpha', {
      cfg: { scheduler: true, createWindow: true, registerShortcut: true },
      capabilities: capsFor({ scheduler: true, createWindow: true, registerShortcut: true }),
    })
    const host = makeHost()
    host.init()
    expect(() => host.shutdown()).not.toThrow()
    expect(mockState.shortcuts.unregister).toHaveBeenCalled()
  })

  it('notifyRendererChanged 跳过已销毁窗口', () => {
    const host = makeHost()
    host.init()
    const win1 = makeWin()
    const win2 = makeWin()
    host.addTarget(win1)
    host.addTarget(win2)
    win2.destroy()
    host.notifyRendererChanged()
    expect(win1.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.PLUGIN_CHANGED, expect.anything())
    expect(win2.webContents.send).not.toHaveBeenCalled()
  })
})