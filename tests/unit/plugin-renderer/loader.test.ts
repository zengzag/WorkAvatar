/**
 * 渲染端插件 loader 增量热加载单测：
 * - 加载单个插件（locale 注册 / 路由归一化 / init(host) 桥 / nav 注入 / 视图注册）
 * - 幂等（同版本跳过）、覆盖升级（v1→v2 原子替换 + dispose 旧实例 + cache-bust URL）
 * - 升级失败保留旧渲染端与旧 locale（回归）
 * - 增删 diff（syncPlugins 卸载已移除插件）
 * - 多播并发竞态：多次广播串行执行，不重复 import/init（回归）
 * rendererModuleLoader.load 为注入点：测试直接替换加载器，避免真实 plugin:// 协议依赖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ====== 依赖 mock（loader 的宿主单例/桥替换为可控替身） ======

const store = vi.hoisted(() => {
  const setPlugins = vi.fn()
  const addResourceBundle = vi.fn()
  const removeResourceBundle = vi.fn()
  const getResourceBundle = vi.fn()
  const registerPluginViews = vi.fn()
  const unregisterPluginViews = vi.fn()
  const loadRendererModule = vi.fn()
  const i18nT = vi.fn((key: string) => key)
  return {
    setPlugins,
    addResourceBundle,
    removeResourceBundle,
    getResourceBundle,
    registerPluginViews,
    unregisterPluginViews,
    loadRendererModule,
    i18nT,
  }
})

// 渲染端入口加载注入点：loader 在调用时刻读取 rendererModuleLoader.load，测试直接替换为可控假模块
// （插件 plugin:// ESM import 在 node 测试环境不可解析，也无需真实加载）
vi.mock('../../../src/i18n', () => ({
  default: {
    addResourceBundle: store.addResourceBundle,
    removeResourceBundle: store.removeResourceBundle,
    getResourceBundle: store.getResourceBundle,
    t: store.i18nT,
  },
}))

vi.mock('../../../src/stores/nav.store', () => ({
  useNavConfigStore: { getState: () => ({ setPlugins: store.setPlugins }) },
}))

vi.mock('../../../src/stores/appearance.store', () => ({
  useAppearanceStore: {
    getState: () => ({ themeMode: 'system', locale: 'zh-CN' }),
    subscribe: () => () => { /* noop */ },
  },
  getEffectiveTheme: () => 'dark',
}))

vi.mock('../../../src/plugins/view-slot', () => ({
  registerPluginViews: store.registerPluginViews,
  unregisterPluginViews: store.unregisterPluginViews,
  getPluginViews: vi.fn(() => []),
}))

vi.mock('../../../src/components/workbench', () => ({
  GenericChatView: function GenericChatView() { return null },
}))

import type { PluginRendererInfo } from '../../../electron/shared/channels/plugin'
import {
  syncPlugins,
  loadPlugins,
  getLoadedPlugins,
  getLoadedPlugin,
  unloadPluginById,
  rendererModuleLoader,
} from '../../../src/plugins/loader'

function info(overrides: Partial<PluginRendererInfo> = {}): PluginRendererInfo {
  return {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    entry: 'index.js',
    locales: {},
    nav: { label: 'Demo', order: 100, detachable: false },
    ...overrides,
  }
}

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    default: {
      routes: [{ path: '', component: function Home() { return null } }, { path: '/settings', component: function Settings() { return null } }],
      init: vi.fn(),
      dispose: vi.fn(),
      navIcon: function NavIcon() { return null },
      ...overrides,
    },
  }
}

async function settleSync(promise: Promise<void>): Promise<void> {
  await promise
}

const origLoad = rendererModuleLoader.load

beforeEach(() => {
  // resetAllMocks：连同 mockImplementationOnce 队列一起清空，避免跨用例残留被下一个用例消费
  vi.resetAllMocks()
  // 注入假模块加载器（reset 后需在每例重设）
  rendererModuleLoader.load = store.loadRendererModule as typeof rendererModuleLoader.load
  // 清空 loader 运行时单例（模块级 Map 跨用例共享）
  for (const p of getLoadedPlugins()) unloadPluginById(p.id)
  store.getResourceBundle.mockReturnValue(undefined)
})

afterEach(() => {
  rendererModuleLoader.load = origLoad
})

describe('loadSinglePlugin / syncPlugins（增量加载）', () => {
  it('加载单个插件：locale 注册 → 动态 import（cache-bust）→ init(host) → registry/nav/views', async () => {
    const entry = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(entry)
    await syncPlugins([info({ locales: { 'zh-CN': { k: 'v' } } })])

    // cache-bust URL 带版本
    expect(store.loadRendererModule).toHaveBeenCalledWith('plugin://demo/index.js?v=1.0.0')
    // locale 注册到插件命名空间
    expect(store.addResourceBundle).toHaveBeenCalledWith('zh-CN', 'demo', { k: 'v' }, true, true)
    // init 收到宿主桥（含 bridge/i18n/hostCapabilities）
    expect(entry.default.init).toHaveBeenCalledTimes(1)
    const host = entry.default.init.mock.calls[0][0]
    expect(host.bridge).toBeDefined()
    expect(host.i18n.t('demo.title')).toBe('demo.title')
    expect(host.hostCapabilities.getTheme()).toBe('dark')
    // 路由归一化：'' 与 '/settings' → '' / 'settings'
    const plugin = getLoadedPlugin('demo')!
    expect(plugin.routes.map(r => r.path)).toEqual(['', 'settings'])
    expect(plugin.nav).toBeDefined()
    expect(store.registerPluginViews).toHaveBeenCalled()
    // 导航注入 nav store
    expect(store.setPlugins).toHaveBeenCalled()
  })

  it('同版本已加载 → 幂等跳过（不再 import/init）', async () => {
    const entry = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(entry)
    await syncPlugins([info()])
    store.loadRendererModule.mockClear()
    await syncPlugins([info()])
    expect(store.loadRendererModule).not.toHaveBeenCalled()
    expect(entry.default.init).toHaveBeenCalledTimes(1)
  })

  it('覆盖升级：dispose 旧实例 + 新版本 atomic 替换，cache-bust 版本号更新', async () => {
    const oldEntry = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(oldEntry)
    await syncPlugins([info()])

    const newEntry = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(newEntry)
    await syncPlugins([info({ version: '2.0.0' })])

    expect(store.loadRendererModule).toHaveBeenLastCalledWith('plugin://demo/index.js?v=2.0.0')
    expect(oldEntry.default.dispose).toHaveBeenCalledTimes(1) // 旧实例清理
    expect(getLoadedPlugin('demo')!.version).toBe('2.0.0')
    expect(newEntry.default.init).toHaveBeenCalledTimes(1)
  })

  it('升级失败：旧渲染端保留、旧 locale 恢复（回归：不因失败清空旧文案）', async () => {
    const oldBundle = { hello: '你好' }
    store.getResourceBundle.mockReturnValue(oldBundle)
    const oldEntry = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(oldEntry)
    await syncPlugins([info({ locales: { 'zh-CN': { hello: '你好' } } })])

    // 升级版本模块加载抛出
    store.loadRendererModule.mockRejectedValueOnce(new Error('module broken'))
    await syncPlugins([info({ version: '2.0.0', locales: { 'zh-CN': { hello: 'new' } } })])

    // 旧版本 registry 保留
    expect(getLoadedPlugin('demo')!.version).toBe('1.0.0')
    // 失败路径：removeResourceBundle 后重新 addResourceBundle 旧 bundle 恢复
    const restoreCall = store.addResourceBundle.mock.calls.find(c => c[2] === oldBundle)
    expect(restoreCall).toBeDefined()
    // 旧实例未被 dispose
    expect(oldEntry.default.dispose).not.toHaveBeenCalled()
  })

  it('渲染端入口缺少 routes → 失败跳过且不登记', async () => {
    store.loadRendererModule.mockResolvedValueOnce({ default: { init: vi.fn() } })
    await syncPlugins([info()])
    expect(getLoadedPlugin('demo')).toBeUndefined()
  })

  it('syncPlugins 卸载已移除插件（dispose + locale 清理 + nav 移除）', async () => {
    const entry = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(entry)
    await syncPlugins([info({ locales: { 'zh-CN': { k: 'v' } } })])
    await syncPlugins([])
    expect(entry.default.dispose).toHaveBeenCalledTimes(1)
    expect(store.removeResourceBundle).toHaveBeenCalledWith('zh-CN', 'demo')
    expect(store.unregisterPluginViews).toHaveBeenCalledWith('demo')
    expect(getLoadedPlugin('demo')).toBeUndefined()
  })

  it('多播并发竞态：多次快速广播串行执行，同一插件仅 import/init 一次（回归）', async () => {
    const entry = makeEntry()
    // 第一次加载延迟完成，期间第二次广播同版本到达
    let resolveFirst!: () => void
    const gate = new Promise<void>(r => { resolveFirst = r })
    store.loadRendererModule.mockImplementationOnce(() => {
      return gate.then(() => entry)
    })
    store.loadRendererModule.mockResolvedValueOnce(entry) // 第二次（同版本，应被幂等跳过）

    const p1 = syncPlugins([info()])
    const p2 = syncPlugins([info()])
    resolveFirst()
    await settleSync(p1)
    await settleSync(p2)

    expect(store.loadRendererModule).toHaveBeenCalledTimes(1) // 串行 + 幂等 → 只 import 一次
    expect(entry.default.init).toHaveBeenCalledTimes(1)
    expect(getLoadedPlugin('demo')!.version).toBe('1.0.0')
  })

  it('并发升级广播：两次不同版本快照最终收敛到最新版本', async () => {
    const v1 = makeEntry()
    const v2 = makeEntry()
    store.loadRendererModule.mockImplementationOnce(() => Promise.resolve(v1))
    store.loadRendererModule.mockImplementationOnce(() => Promise.resolve(v2))
    const p1 = syncPlugins([info()])
    const p2 = syncPlugins([info({ version: '2.0.0' })])
    await settleSync(p1)
    await settleSync(p2)
    expect(getLoadedPlugin('demo')!.version).toBe('2.0.0')
    expect(v1.default.dispose).toHaveBeenCalledTimes(1)
    expect(v2.default.init).toHaveBeenCalledTimes(1)
    expect(v1.default.init).toHaveBeenCalledTimes(1)
  })
})

describe('loadPlugins（启动期加载）', () => {
  it('拉取清单后增量加载全部插件', async () => {
    const entry = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(entry)
    globalThis.window = {
      electronAPI: {
        plugin: { list: vi.fn(async () => ({ rendererPlugins: [info()] })) },
      },
    } as any
    const list = await loadPlugins()
    expect(list.map(p => p.id)).toEqual(['demo'])
    expect(entry.default.init).toHaveBeenCalledTimes(1)
  })
})