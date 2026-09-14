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

  it('getVisibleNavItems 过滤不可见并按 order 排序', () => {
    const items = getVisibleNavItems([
      { key: 'b', visible: true, order: 2 },
      { key: 'a', visible: true, order: 1 },
      { key: 'c', visible: false, order: 0 },
    ])
    expect(items.map(i => i.key)).toEqual(['a', 'b'])
  })
})
