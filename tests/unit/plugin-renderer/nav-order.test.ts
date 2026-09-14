import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * 导航排序持久化集成回归（loader + 真实 nav.store）：
 * 1. 启动期插件逐个加载：每次加载都同步导航会把尚未加载的插件当成已卸载删除并写盘，
 *    用户保存的插件排序随之丢失（插件按 manifest order 重新追加）。
 * 2. 停用插件（仍在安装清单中）不应被当成卸载，否则重新启用后排序/显隐同样丢失。
 */

const settingsStore = new Map<string, string>()

/** 已安装插件（含停用）：plugin.list() 的 plugins 字段 */
let installedList: any[] = []
/** 已激活且有渲染端的插件：plugin.list() 的 rendererPlugins 字段 */
let rendererList: any[] = []

;(globalThis as any).window = {
  electronAPI: {
    settings: {
      get: async ({ key }: { key: string }) => settingsStore.get(key),
      set: async ({ key, value }: { key: string; value: string }) => { settingsStore.set(key, value) },
    },
    plugin: {
      list: async () => ({ plugins: installedList, rendererPlugins: rendererList }),
      onEvent: () => () => { /* noop */ },
      invoke: async () => ({}),
    },
  },
}

vi.mock('../../../src/i18n', () => ({
  default: {
    addResourceBundle: vi.fn(),
    removeResourceBundle: vi.fn(),
    getResourceBundle: vi.fn(() => undefined),
    t: (key: string) => key,
  },
}))

vi.mock('../../../src/plugins/view-slot', () => ({
  registerPluginViews: vi.fn(),
  unregisterPluginViews: vi.fn(),
  getPluginViews: vi.fn(() => []),
}))

vi.mock('../../../src/components/workbench', () => ({
  GenericChatView: () => null,
}))

const { useNavConfigStore, DEFAULT_NAV_CONFIG } = await import('../../../src/stores/nav.store')
const { loadPlugins, syncPlugins, getLoadedPlugins, unloadPluginById, rendererModuleLoader } = await import(
  '../../../src/plugins/loader'
)

// 渲染端入口加载注入点：假模块（node 环境无法解析 plugin:// ESM）
rendererModuleLoader.load = async () => ({
  default: { routes: [{ path: '', component: () => null }] },
}) as any

function plugin(id: string, order: number): any {
  return {
    id,
    name: id,
    version: '1.0.0',
    entry: 'index.js',
    nav: { label: id, order, detachable: false },
  }
}

function orderOf(config: Array<{ key: string; order: number }>): string[] {
  return config.slice().sort((a, b) => a.order - b.order).map((c) => c.key)
}

function persistedConfig(): any[] {
  return JSON.parse(settingsStore.get('nav_items_config')!)
}

describe('插件加载与导航排序持久化', () => {
  beforeEach(() => {
    settingsStore.clear()
    installedList = []
    rendererList = []
    // loader / store 均为模块级单例，逐例重置避免串扰
    for (const p of getLoadedPlugins()) unloadPluginById(p.id)
    useNavConfigStore.setState({
      config: DEFAULT_NAV_CONFIG.map((c) => ({ ...c })),
      pluginItems: [],
      initialized: false,
    })
  })

  it('启动期插件逐个加载时，不得丢失已保存的插件排序/显隐', async () => {
    settingsStore.set('nav_items_config', JSON.stringify([
      { key: 'tasks', visible: true, order: 0 },
      { key: 'kms', visible: true, order: 1 },
      { key: 'employees', visible: true, order: 2 },
      { key: 'beta', visible: true, order: 3 },
      { key: 'alpha', visible: false, order: 4 },
      { key: 'settings', visible: true, order: 5 },
    ]))
    await useNavConfigStore.getState().initialize()

    // manifest order 与用户保存的排序相反
    installedList = [{ id: 'alpha' }, { id: 'beta' }]
    rendererList = [plugin('alpha', 10), plugin('beta', 20)]
    await loadPlugins()

    const config = useNavConfigStore.getState().config
    const keys = orderOf(config)
    expect(keys.indexOf('beta')).toBeLessThan(keys.indexOf('alpha'))
    expect(config.find((c) => c.key === 'alpha')?.visible).toBe(false)

    // 写盘内容也必须保留用户排序（否则下次启动再次丢失）
    const persisted = persistedConfig()
    const persistedKeys = orderOf(persisted)
    expect(persistedKeys.indexOf('beta')).toBeLessThan(persistedKeys.indexOf('alpha'))
    expect(persisted.find((c: any) => c.key === 'alpha')?.visible).toBe(false)
  })

  it('停用插件（仍安装但无渲染端）保留排序/显隐，重新启用即回到原位', async () => {
    await useNavConfigStore.getState().initialize()
    installedList = [{ id: 'alpha' }, { id: 'beta' }]
    rendererList = [plugin('alpha', 10), plugin('beta', 20)]
    await loadPlugins()

    // 用户把 beta 排到 alpha 前面，并隐藏 alpha
    useNavConfigStore.getState().moveUp('beta')
    useNavConfigStore.getState().toggleVisible('alpha')

    // beta 被停用：仍安装（installedList 保留），仅从 rendererPlugins 移除
    rendererList = [plugin('alpha', 10)]
    await loadPlugins()
    const config = useNavConfigStore.getState().config
    expect(config.some((c) => c.key === 'beta')).toBe(true)
    expect(config.find((c) => c.key === 'alpha')?.visible).toBe(false)
    expect(orderOf(config).indexOf('beta')).toBeLessThan(orderOf(config).indexOf('alpha'))

    // 重新启用：排序与显隐保持用户设置，而非回到 manifest order
    rendererList = [plugin('alpha', 10), plugin('beta', 20)]
    await loadPlugins()
    const reEnabled = useNavConfigStore.getState().config
    expect(orderOf(reEnabled).indexOf('beta')).toBeLessThan(orderOf(reEnabled).indexOf('alpha'))
    expect(reEnabled.find((c) => c.key === 'alpha')?.visible).toBe(false)
  })

  it('插件确实被卸载时，条目应从配置中清理', async () => {
    await useNavConfigStore.getState().initialize()
    installedList = [{ id: 'alpha' }, { id: 'beta' }]
    rendererList = [plugin('alpha', 10), plugin('beta', 20)]
    await loadPlugins()
    expect(useNavConfigStore.getState().config.some((c) => c.key === 'alpha')).toBe(true)

    // beta 卸载：安装清单与渲染端清单同时移除
    installedList = [{ id: 'alpha' }]
    rendererList = [plugin('alpha', 10)]
    await loadPlugins()
    const keys = useNavConfigStore.getState().config.map((c) => c.key)
    expect(keys).toContain('alpha')
    expect(keys).not.toContain('beta')
    expect(persistedConfig().some((c: any) => c.key === 'beta')).toBe(false)
  })

  it('渲染端加载失败（仍安装）时条目保留，恢复后回到原排序', async () => {
    await useNavConfigStore.getState().initialize()
    installedList = [{ id: 'alpha' }, { id: 'beta' }]
    rendererList = [plugin('alpha', 10), plugin('beta', 20)]
    await loadPlugins()
    useNavConfigStore.getState().moveUp('beta')

    // beta 渲染端加载失败：安装清单不变，渲染端清单缺失
    rendererModuleLoader.load = async () => { throw new Error('boom') }
    await syncPlugins([plugin('alpha', 10)], ['alpha', 'beta'])
    const keys = useNavConfigStore.getState().config.map((c) => c.key)
    expect(keys).toContain('beta')

    // 恢复后排序保持
    rendererModuleLoader.load = async () => ({
      default: { routes: [{ path: '', component: () => null }] },
    }) as any
    await syncPlugins([plugin('alpha', 10), plugin('beta', 20)], ['alpha', 'beta'])
    expect(orderOf(useNavConfigStore.getState().config).indexOf('beta'))
      .toBeLessThan(orderOf(useNavConfigStore.getState().config).indexOf('alpha'))
  })
})
