import { describe, it, expect, beforeEach, vi } from 'vitest'

const settingsCalls: Array<{ op: 'get' | 'set'; key: string; value?: string }> = []

;(globalThis as any).window = {
  electronAPI: {
    settings: {
      get: async ({ key }: { key: string }) => {
        settingsCalls.push({ op: 'get', key })
        const found = [...settingsCalls].reverse().find(c => c.op === 'set' && c.key === key)
        return found?.value
      },
      set: async ({ key, value }: { key: string; value: string }) => {
        settingsCalls.push({ op: 'set', key, value })
      },
    },
  },
}

const { useNavConfigStore, LOCKED_KEYS, DEFAULT_NAV_CONFIG, getVisibleNavItems } = await import(
  '../../../src/stores/nav.store'
)

describe('stores/nav.store', () => {
  beforeEach(() => {
    settingsCalls.length = 0
    useNavConfigStore.setState({
      config: DEFAULT_NAV_CONFIG.map(c => ({ ...c })),
      pluginItems: [],
      initialized: false,
    })
    vi.clearAllMocks()
  })

  it('常量：settings 锁定且默认顺序', () => {
    expect(LOCKED_KEYS).toEqual(['settings'])
    expect(DEFAULT_NAV_CONFIG.map(c => c.key)).toEqual(['tasks', 'kms', 'employees', 'settings'])
  })

  it('toggleVisible 切换可见性并持久化；锁定项不响应', () => {
    const store = useNavConfigStore.getState()
    store.toggleVisible('kms')
    let kms = useNavConfigStore.getState().config.find(c => c.key === 'kms')
    expect(kms?.visible).toBe(false)
    store.toggleVisible('kms')
    kms = useNavConfigStore.getState().config.find(c => c.key === 'kms')
    expect(kms?.visible).toBe(true)

    const before = useNavConfigStore.getState().config.find(c => c.key === 'settings')
    store.toggleVisible('settings')
    expect(useNavConfigStore.getState().config.find(c => c.key === 'settings')?.visible).toBe(before?.visible)
  })

  it('moveUp/moveDown 交换顺序；锁定项排最后', () => {
    const store = useNavConfigStore.getState()
    store.moveDown('tasks')
    let keys = useNavConfigStore.getState().config.slice().sort((a, b) => a.order - b.order).map(c => c.key)
    expect(keys[0]).toBe('kms')

    useNavConfigStore.getState().moveUp('tasks')
    keys = useNavConfigStore.getState().config.slice().sort((a, b) => a.order - b.order).map(c => c.key)
    expect(keys[0]).toBe('tasks')
  })

  it('moveUp 首项/moveDown 末项为 no-op', () => {
    const store = useNavConfigStore.getState()
    const before = useNavConfigStore.getState().config.map(c => c.order).join(',')
    store.moveUp('tasks')
    useNavConfigStore.getState().moveDown('settings')
    expect(useNavConfigStore.getState().config.map(c => c.order).join(',')).toBe(before)
  })

  it('setPlugins 合并插件项；卸载插件项应被移除', () => {
    const store = useNavConfigStore.getState()
    store.setPlugins([
      { key: 'plugin:notes', label: '笔记', order: 10, detachable: false },
      { key: 'plugin:voice', label: '语音', order: 11, detachable: false },
    ])
    let keys = useNavConfigStore.getState().config.map(c => c.key)
    expect(keys).toContain('plugin:notes')
    expect(keys).toContain('plugin:voice')

    // 卸载 voice 后再同步：voice 应从 config 中移除
    useNavConfigStore.getState().setPlugins([{ key: 'plugin:notes', label: '笔记', order: 10, detachable: false }])
    keys = useNavConfigStore.getState().config.map(c => c.key)
    expect(keys).toContain('plugin:notes')
    expect(keys).not.toContain('plugin:voice')
    // 已安装插件项不得重复（每次 setPlugins 重建而非追加）
    expect(keys.filter(k => k === 'plugin:notes').length).toBe(1)

    // 重复同步同一列表：结果稳定且不重复
    useNavConfigStore.getState().setPlugins([{ key: 'plugin:notes', label: '笔记', order: 10, detachable: false }])
    keys = useNavConfigStore.getState().config.map(c => c.key)
    expect(keys.filter(k => k === 'plugin:notes').length).toBe(1)
  })

  it('reset 仅重置内置项，插件项保留', () => {
    useNavConfigStore.getState().setPlugins([{ key: 'plugin:notes', label: '笔记', order: 10, detachable: false }])
    useNavConfigStore.getState().toggleVisible('tasks')
    useNavConfigStore.getState().reset()
    const tasks = useNavConfigStore.getState().config.find(c => c.key === 'tasks')
    expect(tasks?.visible).toBe(true)
    expect(useNavConfigStore.getState().config.some(c => c.key === 'plugin:notes')).toBe(true)
  })

  it('initialize 从持久化读取并补充新增内置项', async () => {
    settingsCalls.push({
      op: 'set',
      key: 'nav_items_config',
      value: JSON.stringify([
        { key: 'tasks', visible: false, order: 0 },
        { key: 'plugin:notes', visible: true, order: 9 },
      ]),
    })
    await useNavConfigStore.getState().initialize()
    const config = useNavConfigStore.getState().config
    expect(useNavConfigStore.getState().initialized).toBe(true)
    expect(config.find(c => c.key === 'tasks')?.visible).toBe(false)
    // 新增内置项被补充
    expect(config.find(c => c.key === 'kms')).toBeTruthy()
    expect(config.find(c => c.key === 'plugin:notes')).toBeTruthy()
  })

  it('启动期插件先于 initialize 注入时，不得用 manifest 顺序覆盖已保存排序/显隐', async () => {
    settingsCalls.push({
      op: 'set',
      key: 'nav_items_config',
      value: JSON.stringify([
        { key: 'tasks', visible: true, order: 0 },
        { key: 'kms', visible: true, order: 1 },
        { key: 'employees', visible: true, order: 2 },
        { key: 'plugin:voice', visible: true, order: 3 },
        { key: 'plugin:notes', visible: false, order: 4 },
        { key: 'settings', visible: true, order: 5 },
      ]),
    })
    // 启动时序：loadPlugins 早于 UI 挂载触发的 initialize；manifest order 与用户排序相反
    useNavConfigStore.getState().setPlugins([
      { key: 'plugin:voice', label: '语音', order: 20, detachable: false },
      { key: 'plugin:notes', label: '笔记', order: 10, detachable: false },
    ])
    await useNavConfigStore.getState().initialize()

    const config = useNavConfigStore.getState().config
    const keys = config.slice().sort((a, b) => a.order - b.order).map((c) => c.key)
    expect(keys.indexOf('plugin:voice')).toBeLessThan(keys.indexOf('plugin:notes'))
    expect(config.find((c) => c.key === 'plugin:notes')?.visible).toBe(false)
  })

  it('无持久化时 initialize 保留启动期已注入的插件项', async () => {
    useNavConfigStore.getState().setPlugins([{ key: 'plugin:notes', label: '笔记', order: 10, detachable: false }])
    await useNavConfigStore.getState().initialize()
    expect(useNavConfigStore.getState().config.some((c) => c.key === 'plugin:notes')).toBe(true)
  })

  it('initialize 完成后 setPlugins 合并结果才写盘', async () => {
    await useNavConfigStore.getState().initialize()
    settingsCalls.length = 0
    useNavConfigStore.getState().setPlugins([{ key: 'plugin:notes', label: '笔记', order: 10, detachable: false }])
    const persisted = settingsCalls.filter((c) => c.op === 'set' && c.key === 'nav_items_config')
    expect(persisted.length).toBeGreaterThan(0)
    const saved = JSON.parse(persisted[persisted.length - 1].value!)
    expect(saved.some((c: any) => c.key === 'plugin:notes')).toBe(true)
  })

  it('setPlugins 传入安装清单时：停用插件保留排序/显隐，卸载插件移除', async () => {
    await useNavConfigStore.getState().initialize()
    useNavConfigStore.getState().setPlugins([
      { key: 'plugin:notes', label: '笔记', order: 10, detachable: false },
      { key: 'plugin:voice', label: '语音', order: 20, detachable: false },
    ], ['plugin:notes', 'plugin:voice'])
    useNavConfigStore.getState().moveUp('plugin:voice')
    useNavConfigStore.getState().toggleVisible('plugin:notes')

    // voice 停用（仍在安装清单）：条目保留，排序/显隐不变
    useNavConfigStore.getState().setPlugins(
      [{ key: 'plugin:notes', label: '笔记', order: 10, detachable: false }],
      ['plugin:notes', 'plugin:voice'],
    )
    let config = useNavConfigStore.getState().config
    const keys = config.slice().sort((a, b) => a.order - b.order).map((c) => c.key)
    expect(keys).toContain('plugin:voice')
    expect(keys.indexOf('plugin:voice')).toBeLessThan(keys.indexOf('plugin:notes'))
    expect(config.find((c) => c.key === 'plugin:notes')?.visible).toBe(false)

    // voice 卸载（安装清单里也没有）：条目移除
    useNavConfigStore.getState().setPlugins(
      [{ key: 'plugin:notes', label: '笔记', order: 10, detachable: false }],
      ['plugin:notes'],
    )
    config = useNavConfigStore.getState().config
    expect(config.some((c) => c.key === 'plugin:voice')).toBe(false)
    expect(config.some((c) => c.key === 'plugin:notes')).toBe(true)
  })

  it('getVisibleNavItems 过滤不可见并按 order 排序', () => {
    const items = getVisibleNavItems([
      { key: 'b', visible: true, order: 2 },
      { key: 'a', visible: true, order: 1 },
      { key: 'c', visible: false, order: 0 },
    ])
    expect(items.map(i => i.key)).toEqual(['a', 'b'])
  })
})
