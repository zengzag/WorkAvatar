import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * 渲染端插件 loader 补充用例：
 * - rev 相同/缺省但 version 相同 → 跳过；rev 由 undefined 变为 '' → 仍视为同一内容跳过
 * - 降级（v2 → v1）重新 init 并 dispose 旧实例
 * - navIcon 先清后设（新版本不再声明时移除旧图标）
 * - locale 覆盖注册、失败回滚、升级时清理新版本未再声明的旧语言
 * - 串行化 syncPlugins（一次失败不阻塞后续队列）
 * - 宿主能力：外部文件订阅队列回放、关闭守卫、文件对话框、剪贴板兜底
 */

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
  getPluginNavIcon,
  unloadPluginById,
  hasDirtyCloseGuard,
  injectHostGlobals,
  rendererModuleLoader,
} from '../../../src/plugins/loader'

/** 主进程 app 事件监听捕获（外部文件打开） */
let openExternalFileHandler: ((absPath: string) => void) | null = null
const onOpenExternalFileCalls: Array<unknown> = []

function installWindow() {
  ;(globalThis as any).window = {
    electronAPI: {
      settings: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
      plugin: {
        list: vi.fn(async () => ({ plugins: [], rendererPlugins: [] })),
        onEvent: () => () => { /* noop */ },
        invoke: vi.fn(async () => ({})),
      },
      app: {
        onOpenExternalFile: (cb: (absPath: string) => void) => {
          onOpenExternalFileCalls.push(cb)
          openExternalFileHandler = cb
          return () => { /* noop */ }
        },
        showOpenDialog: async () => ({ filePaths: ['C:/picked.txt'] }),
        showSaveDialog: async () => ({ filePath: 'C:/saved.txt' }),
      },
    },
  }
}

installWindow()

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
      routes: [{ path: '', component: function Home() { return null } }],
      init: vi.fn(),
      dispose: vi.fn(),
      ...overrides,
    },
  }
}

const origLoad = rendererModuleLoader.load

beforeEach(() => {
  vi.resetAllMocks()
  rendererModuleLoader.load = store.loadRendererModule as typeof rendererModuleLoader.load
  for (const p of getLoadedPlugins()) unloadPluginById(p.id)
  store.getResourceBundle.mockReturnValue(undefined)
  installWindow()
})

afterEach(() => {
  rendererModuleLoader.load = origLoad
})

describe('loader / 版本与 rev 判定', () => {
  it('version 与 rev 均相同时跳过重新加载', async () => {
    const entry = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(entry)
    await syncPlugins([info({ rev: 'abc' })])
    store.loadRendererModule.mockClear()
    await syncPlugins([info({ rev: 'abc' })])
    expect(store.loadRendererModule).not.toHaveBeenCalled()
    expect(entry.default.init).toHaveBeenCalledTimes(1)
  })

  it('rev 均为缺省值时同样跳过（undefined === undefined）', async () => {
    const entry = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(entry)
    await syncPlugins([info()])
    store.loadRendererModule.mockClear()
    await syncPlugins([info()])
    expect(store.loadRendererModule).not.toHaveBeenCalled()
  })

  it('rev 由 undefined 变为空串按同一内容处理（规范化比较）→ 跳过重新加载', async () => {
    const v1 = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(v1)
    await syncPlugins([info()])
    store.loadRendererModule.mockClear()
    const v2 = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(v2)
    await syncPlugins([info({ rev: '' })])
    // (existing.rev ?? '') === (info.rev ?? '') → 不触发无谓的 import/init/dispose
    expect(store.loadRendererModule).not.toHaveBeenCalled()
    expect(v1.default.dispose).not.toHaveBeenCalled()
    expect(v2.default.init).not.toHaveBeenCalled()
  })

  it('rev 由空串变为 undefined 同样跳过（反向规范化）', async () => {
    const v1 = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(v1)
    await syncPlugins([info({ rev: '' })])
    store.loadRendererModule.mockClear()
    const v2 = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(v2)
    await syncPlugins([info({ rev: undefined })])
    expect(store.loadRendererModule).not.toHaveBeenCalled()
    expect(v1.default.dispose).not.toHaveBeenCalled()
  })

  it('cache-bust URL 对 rev 做 URL 编码', async () => {
    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    await syncPlugins([info({ rev: '100/2 3' })])
    expect(store.loadRendererModule).toHaveBeenCalledWith('plugin://demo/index.js?v=1.0.0&r=100%2F2%203')
  })

  it('降级（v2 → v1）：重新 init 并 dispose 旧实例', async () => {
    const v2 = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(v2)
    await syncPlugins([info({ version: '2.0.0' })])
    const v1 = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(v1)
    await syncPlugins([info({ version: '1.0.0' })])

    expect(getLoadedPlugin('demo')!.version).toBe('1.0.0')
    expect(store.loadRendererModule).toHaveBeenLastCalledWith('plugin://demo/index.js?v=1.0.0')
    expect(v2.default.dispose).toHaveBeenCalledTimes(1)
    expect(v1.default.init).toHaveBeenCalledTimes(1)
  })

  it('路由路径归一化："/" → ""，多级路径去掉前导斜杠', async () => {
    store.loadRendererModule.mockResolvedValueOnce({
      default: {
        routes: [
          { path: '/', component: () => null },
          { path: '/a/b', component: () => null },
        ],
        init: vi.fn(),
      },
    })
    await syncPlugins([info()])
    expect(getLoadedPlugin('demo')!.routes.map(r => r.path)).toEqual(['', 'a/b'])
  })

  it('dispose 抛错时被捕获，不影响卸载流程', async () => {
    const entry = makeEntry({ dispose: vi.fn(() => { throw new Error('dispose boom') }) })
    store.loadRendererModule.mockResolvedValueOnce(entry)
    await syncPlugins([info()])
    const spy = vi.spyOn(console, 'error').mockImplementation(() => { /* silence */ })
    await syncPlugins([])
    expect(getLoadedPlugin('demo')).toBeUndefined()
    spy.mockRestore()
  })
})

describe('loader / navIcon 与视图', () => {
  const NavIcon = function NavIcon() { return null }

  it('升级后新版本未声明 navIcon 时移除旧图标（先清后设）', async () => {
    store.loadRendererModule.mockResolvedValueOnce(makeEntry({ navIcon: NavIcon }))
    await syncPlugins([info()])
    expect(getPluginNavIcon('demo')).toBe(NavIcon)

    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    await syncPlugins([info({ version: '2.0.0' })])
    expect(getPluginNavIcon('demo')).toBeUndefined()
    expect(getLoadedPlugin('demo')!.navIcon).toBeUndefined()
  })

  it('navIcon 变化时替换为新图标', async () => {
    const Other = function Other() { return null }
    store.loadRendererModule.mockResolvedValueOnce(makeEntry({ navIcon: NavIcon }))
    await syncPlugins([info()])
    store.loadRendererModule.mockResolvedValueOnce(makeEntry({ navIcon: Other }))
    await syncPlugins([info({ version: '2.0.0' })])
    expect(getPluginNavIcon('demo')).toBe(Other)
  })

  it('升级时先 unregister 再 register 视图', async () => {
    const views = [{ slot: 'chat.header', component: () => null }]
    store.loadRendererModule.mockResolvedValueOnce(makeEntry({ views }))
    await syncPlugins([info()])
    expect(store.registerPluginViews).toHaveBeenCalledWith('demo', views)
    expect(store.unregisterPluginViews).toHaveBeenCalledWith('demo')

    store.registerPluginViews.mockClear()
    store.unregisterPluginViews.mockClear()
    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    await syncPlugins([info({ version: '2.0.0' })])
    expect(store.unregisterPluginViews).toHaveBeenCalledWith('demo')
    expect(store.registerPluginViews).toHaveBeenCalledWith('demo', undefined)
  })

  it('卸载时清理导航图标、视图与 locale', async () => {
    store.loadRendererModule.mockResolvedValueOnce(makeEntry({ navIcon: NavIcon }))
    await syncPlugins([info({ locales: { 'zh-CN': { a: 1 } } })])
    unloadPluginById('demo')
    expect(getPluginNavIcon('demo')).toBeUndefined()
    expect(store.unregisterPluginViews).toHaveBeenCalledWith('demo')
    expect(store.removeResourceBundle).toHaveBeenCalledWith('zh-CN', 'demo')
    expect(getLoadedPlugin('demo')).toBeUndefined()
  })

  it('卸载未知插件 id 为 no-op', () => {
    expect(() => unloadPluginById('nope')).not.toThrow()
  })
})

describe('loader / locale 注册与回滚', () => {
  it('多语言资源逐个注册，localeLngs 记录全部语言', async () => {
    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    await syncPlugins([info({ locales: { 'zh-CN': { a: '中' }, 'en-US': { a: 'en' } } })])
    expect(store.addResourceBundle).toHaveBeenCalledWith('zh-CN', 'demo', { a: '中' }, true, true)
    expect(store.addResourceBundle).toHaveBeenCalledWith('en-US', 'demo', { a: 'en' }, true, true)
    expect(getLoadedPlugin('demo')!.localeLngs.sort()).toEqual(['en-US', 'zh-CN'])
  })

  it('升级时覆盖同语言资源（真值合并）', async () => {
    store.getResourceBundle.mockReturnValue({ stale: '旧' })
    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    await syncPlugins([info({ locales: { 'zh-CN': { a: 'v1' } } })])
    store.addResourceBundle.mockClear()

    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    await syncPlugins([info({ version: '2.0.0', locales: { 'zh-CN': { a: 'v2' } } })])
    expect(store.addResourceBundle).toHaveBeenCalledWith('zh-CN', 'demo', { a: 'v2' }, true, true)
  })

  it('升级时清理新版本未再声明的旧语言（避免 bundle 永久残留）', async () => {
    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    await syncPlugins([info({ locales: { 'zh-CN': { a: 1 }, 'ja-JP': { a: 2 } } })])
    store.removeResourceBundle.mockClear()

    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    await syncPlugins([info({ version: '2.0.0', locales: { 'zh-CN': { a: 3 } } })])
    // 新版只声明 zh-CN → 旧版注册的 ja-JP 必须先移除
    expect(store.removeResourceBundle).toHaveBeenCalledWith('ja-JP', 'demo')
    expect(store.removeResourceBundle).toHaveBeenCalledWith('zh-CN', 'demo')
    expect(getLoadedPlugin('demo')!.localeLngs).toEqual(['zh-CN'])
  })

  it('加载失败且无旧 bundle 时移除已注册语言', async () => {
    store.getResourceBundle.mockReturnValue(undefined)
    store.loadRendererModule.mockRejectedValueOnce(new Error('boom'))
    await syncPlugins([info({ locales: { 'zh-CN': { a: 1 } } })])
    expect(store.removeResourceBundle).toHaveBeenCalledWith('zh-CN', 'demo')
    expect(getLoadedPlugin('demo')).toBeUndefined()
  })

  it('加载失败且空旧 bundle 时按无旧资源处理', async () => {
    store.getResourceBundle.mockReturnValue({})
    store.loadRendererModule.mockRejectedValueOnce(new Error('boom'))
    await syncPlugins([info({ locales: { 'en-US': { a: 1 } } })])
    const restore = store.addResourceBundle.mock.calls.find(c => c[2] && Object.keys(c[2]).length === 0)
    expect(restore).toBeUndefined()
    expect(store.removeResourceBundle).toHaveBeenCalledWith('en-US', 'demo')
  })
})

describe('loader / syncPlugins 串行化', () => {
  it('一次同步内部异常不阻塞后续队列', async () => {
    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    store.setPlugins.mockImplementationOnce(() => { throw new Error('nav store boom') })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => { /* silence */ })

    await expect(syncPlugins([info()])).rejects.toThrow('nav store boom')

    store.loadRendererModule.mockClear()
    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    await expect(syncPlugins([info({ id: 'other', name: 'Other' })])).resolves.toBeUndefined()
    expect(getLoadedPlugin('other')).toBeTruthy()
    spy.mockRestore()
  })

  it('多次广播按调用顺序串行执行', async () => {
    const order: string[] = []
    store.loadRendererModule.mockImplementation(async (url: string) => {
      order.push(`load:${url}`)
      await new Promise(r => setTimeout(r, 5))
      return makeEntry()
    })
    const p1 = syncPlugins([info({ id: 'a', name: 'A' })])
    const p2 = syncPlugins([info({ id: 'b', name: 'B' })])
    await Promise.all([p1, p2])
    expect(order).toEqual([
      'load:plugin://a/index.js?v=1.0.0',
      'load:plugin://b/index.js?v=1.0.0',
    ])
  })

  it('同步过程中新增的插件不会与并发同步互相干扰', async () => {
    store.loadRendererModule.mockImplementation(async () => makeEntry())
    await Promise.all([
      syncPlugins([info({ id: 'a', name: 'A' })]),
      syncPlugins([info({ id: 'b', name: 'B' })]),
      syncPlugins([info({ id: 'a', name: 'A' }), info({ id: 'b', name: 'B' })]),
    ])
    expect(getLoadedPlugins().map(p => p.id).sort()).toEqual(['a', 'b'])
  })
})

describe('loader / 宿主能力', () => {
  async function loadWithHost(): Promise<any> {
    const entry = makeEntry()
    store.loadRendererModule.mockResolvedValueOnce(entry)
    await syncPlugins([info()])
    return entry.default.init.mock.calls[0][0]
  }

  it('外部文件事件：懒注册一次；无订阅者时入队，首个订阅者回放后清空', async () => {
    const host = await loadWithHost()
    // 首个订阅者触发懒注册（此前的插件加载不会注册监听）
    host.hostCapabilities.subscribeExternalFiles(() => { /* warm-up */ })
    expect(typeof openExternalFileHandler).toBe('function')
    const registrations = onOpenExternalFileCalls.length
    expect(registrations).toBeGreaterThanOrEqual(1)

    // 队列中存在未被消费的路径 → 首个订阅者回放并清空
    openExternalFileHandler!('C:/pending.txt')
    const first: string[] = []
    const second: string[] = []
    const offFirst = host.hostCapabilities.subscribeExternalFiles((p: string) => first.push(p))
    const offSecond = host.hostCapabilities.subscribeExternalFiles((p: string) => second.push(p))
    expect(first).toEqual(['C:/pending.txt'])
    expect(second).toEqual([])

    openExternalFileHandler!('C:/after.txt')
    expect(first).toEqual(['C:/pending.txt', 'C:/after.txt'])
    expect(second).toEqual(['C:/after.txt'])

    offFirst()
    offSecond()
    openExternalFileHandler!('C:/ignored.txt')
    expect(first).toHaveLength(2)

    // 后续订阅不再重复注册全局监听
    host.hostCapabilities.subscribeExternalFiles(() => { /* noop */ })
    expect(onOpenExternalFileCalls.length).toBe(registrations)
  })

  it('关闭守卫：任一守卫命中即为脏；守卫抛错被忽略；取消注册生效', async () => {
    const host = await loadWithHost()
    expect(hasDirtyCloseGuard()).toBe(false)

    const offTrue = host.hostCapabilities.registerCloseGuard(() => true)
    expect(hasDirtyCloseGuard()).toBe(true)
    offTrue()
    expect(hasDirtyCloseGuard()).toBe(false)

    host.hostCapabilities.registerCloseGuard(() => { throw new Error('guard boom') })
    expect(hasDirtyCloseGuard()).toBe(false)
  })

  it('文件对话框：透传 filters 并归一化返回值为路径数组/字符串', async () => {
    const host = await loadWithHost()
    expect(await host.hostCapabilities.showOpenDialog({ filters: [{ name: 'txt', extensions: ['txt'] }] }))
      .toEqual(['C:/picked.txt'])
    expect(await host.hostCapabilities.showOpenDialog()).toEqual(['C:/picked.txt'])
    expect(await host.hostCapabilities.showSaveDialog({ defaultPath: 'C:/x.txt' })).toBe('C:/saved.txt')
    expect(await host.hostCapabilities.showSaveDialog()).toBe('C:/saved.txt')
  })

  it('文件对话框返回空结果时退化为空数组/空串', async () => {
    const host = await loadWithHost()
    ;(globalThis as any).window.electronAPI.app.showOpenDialog = async () => undefined
    ;(globalThis as any).window.electronAPI.app.showSaveDialog = async () => undefined
    expect(await host.hostCapabilities.showOpenDialog()).toEqual([])
    expect(await host.hostCapabilities.showSaveDialog()).toBe('')
  })

  it('剪贴板读写失败时兜底（返回空串/不抛错）', async () => {
    const host = await loadWithHost()
    const stubClipboard = (clipboard: unknown) => {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: { clipboard },
      })
    }
    stubClipboard({
      readText: async () => { throw new Error('denied') },
      writeText: async () => { throw new Error('denied') },
    })
    expect(await host.hostCapabilities.clipboard.readText()).toBe('')
    await expect(host.hostCapabilities.clipboard.writeText('x')).resolves.toBeUndefined()

    stubClipboard({ readText: async () => 'text', writeText: async () => { /* ok */ } })
    expect(await host.hostCapabilities.clipboard.readText()).toBe('text')
    await expect(host.hostCapabilities.clipboard.writeText('text')).resolves.toBeUndefined()
  })

  it('主题与语言能力来自 appearance store', async () => {
    const host = await loadWithHost()
    expect(host.hostCapabilities.getTheme()).toBe('dark')
    expect(host.hostCapabilities.getLocale()).toBe('zh-CN')
    expect(typeof host.hostCapabilities.onThemeChange(() => { /* noop */ })).toBe('function')
    expect(typeof host.hostCapabilities.onLocaleChange(() => { /* noop */ })).toBe('function')
  })

  it('i18n：common.* 走宿主 translation 命名空间，其余走插件命名空间', async () => {
    const host = await loadWithHost()
    host.i18n.t('common.ok', { defaultValue: 'OK' })
    expect(store.i18nT).toHaveBeenCalledWith('common.ok', { ns: 'translation', defaultValue: 'OK' })
    host.i18n.t('title', { defaultValue: 'T' })
    expect(store.i18nT).toHaveBeenCalledWith('title', { ns: 'demo', defaultValue: 'T' })
  })

  it('bridge.invoke 固定插件 id，onEvent 按事件名过滤', async () => {
    const host = await loadWithHost()
    const invoke = (globalThis as any).window.electronAPI.plugin.invoke as ReturnType<typeof vi.fn>
    let received: unknown
    ;(globalThis as any).window.electronAPI.plugin.onEvent = (_id: string, cb: (msg: any) => void) => {
      cb({ event: 'other', payload: 'x' })
      cb({ event: 'target', payload: 'y' })
      return () => { /* noop */ }
    }
    host.bridge.onEvent('target', (payload: unknown) => { received = payload })
    expect(received).toBe('y')
    await host.bridge.invoke('channel', { a: 1 })
    expect(invoke).toHaveBeenCalledWith('demo', 'channel', { a: 1 })
  })

  it('injectHostGlobals 注入宿主共享单例', () => {
    injectHostGlobals()
    const g = globalThis as any
    expect(g.__WA_HOST__.React).toBeTruthy()
    expect(g.__WA_HOST__.ReactDOM).toBeTruthy()
    expect(g.__WA_HOST__.jsxRuntime).toBeTruthy()
    expect(g.__WA_HOST__.antd).toBeTruthy()
    expect(g.__WA_HOST__.icons).toBeTruthy()
    expect(g.__WA_HOST__.i18n).toBeTruthy()
    expect(g.__WA_HOST__.reactI18n).toBeTruthy()
  })
})

describe('loader / loadPlugins', () => {
  it('插件清单为空时 installedIds 为 undefined，仍执行同步', async () => {
    ;(globalThis as any).window.electronAPI.plugin.list = vi.fn(async () => ({ plugins: [], rendererPlugins: [] }))
    const list = await loadPlugins()
    expect(list).toEqual([])
    expect(store.setPlugins).toHaveBeenCalledWith([], undefined)
  })

  it('插件列表为空数组时 installedIds 退化为 undefined', async () => {
    ;(globalThis as any).window.electronAPI.plugin.list = vi.fn(async () => ({
      plugins: [],
      rendererPlugins: [info()],
    }))
    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    await loadPlugins()
    expect(store.setPlugins).toHaveBeenLastCalledWith(
      [expect.objectContaining({ key: 'demo' })],
      undefined,
    )
  })

  it('插件列表非空时传递安装清单（用于保留停用插件排序）', async () => {
    ;(globalThis as any).window.electronAPI.plugin.list = vi.fn(async () => ({
      plugins: [{ id: 'demo' }, { id: 'disabled' }],
      rendererPlugins: [info()],
    }))
    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    await loadPlugins()
    expect(store.setPlugins).toHaveBeenLastCalledWith(
      [expect.objectContaining({ key: 'demo' })],
      ['demo', 'disabled'],
    )
  })

  it('nav 缺省的插件不注入导航项', async () => {
    ;(globalThis as any).window.electronAPI.plugin.list = vi.fn(async () => ({
      plugins: [{ id: 'demo' }],
      rendererPlugins: [info({ nav: undefined })],
    }))
    store.loadRendererModule.mockResolvedValueOnce(makeEntry())
    await loadPlugins()
    expect(store.setPlugins).toHaveBeenLastCalledWith([], ['demo'])
    expect(getLoadedPlugin('demo')!.nav).toBeUndefined()
  })
})
