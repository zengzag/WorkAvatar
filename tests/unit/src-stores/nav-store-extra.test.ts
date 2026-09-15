import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * src/stores/nav.store 补充：reindex 锁定项归位、未知 key 的 no-op、与锁定项换位的净效果、
 * reset 对插件项的保留、setPlugins 与内置项冲突、initialize 非法持久化兜底。
 */

const settingsCalls: Array<{ op: 'get' | 'set'; key: string; value?: string }> = []
let getThrows = false
let setThrows = false

;(globalThis as any).window = {
  electronAPI: {
    settings: {
      get: async ({ key }: { key: string }) => {
        if (getThrows) throw new Error('ipc down')
        settingsCalls.push({ op: 'get', key })
        const found = [...settingsCalls].reverse().find(c => c.op === 'set' && c.key === key)
        return found?.value
      },
      set: ({ key, value }: { key: string; value: string }) => {
        // 同步抛错（persist 的 try/catch 只覆盖同步异常）
        if (setThrows) throw new Error('ipc denied')
        settingsCalls.push({ op: 'set', key, value })
        return Promise.resolve()
      },
    },
  },
}

const { useNavConfigStore, LOCKED_KEYS, DEFAULT_NAV_CONFIG, getVisibleNavItems } = await import(
  '../../../src/stores/nav.store'
)

const plugin = (key: string, order: number) => ({ key, label: key, order, detachable: false })

const orderOf = () => useNavConfigStore.getState().config.slice().sort((a, b) => a.order - b.order).map(c => c.key)

const lastPersisted = (): any[] | undefined => {
  const found = [...settingsCalls].reverse().find(c => c.op === 'set' && c.key === 'nav_items_config')
  return found?.value ? JSON.parse(found.value) : undefined
}

const seedPersisted = (config: unknown) => {
  settingsCalls.push({ op: 'set', key: 'nav_items_config', value: typeof config === 'string' ? config : JSON.stringify(config) })
}

beforeEach(() => {
  settingsCalls.length = 0
  getThrows = false
  setThrows = false
  useNavConfigStore.setState({
    config: DEFAULT_NAV_CONFIG.map(c => ({ ...c })),
    pluginItems: [],
    initialized: false,
  })
})

describe('nav.store / reindex 与 setConfig', () => {
  it('锁定项被强制排到末尾（忽略持久化中的历史排序）', () => {
    useNavConfigStore.getState().setConfig([
      { key: 'settings', visible: true, order: 0 },
      { key: 'tasks', visible: true, order: 5 },
      { key: 'kms', visible: true, order: 6 },
    ])
    expect(orderOf()).toEqual(['tasks', 'kms', 'settings'])
    expect(useNavConfigStore.getState().config.map(c => c.order)).toEqual([0, 1, 2])
  })

  it('order 相同时保持稳定顺序并重排为 0..n', () => {
    useNavConfigStore.getState().setConfig([
      { key: 'tasks', visible: true, order: 3 },
      { key: 'kms', visible: true, order: 3 },
      { key: 'settings', visible: true, order: 3 },
    ])
    expect(orderOf()).toEqual(['tasks', 'kms', 'settings'])
  })

  it('setConfig 写盘内容为 reindex 后的结果', () => {
    useNavConfigStore.getState().setConfig([
      { key: 'settings', visible: true, order: -5 },
      { key: 'tasks', visible: false, order: 1 },
    ])
    expect(lastPersisted()).toEqual([
      { key: 'tasks', visible: false, order: 0 },
      { key: 'settings', visible: true, order: 1 },
    ])
  })

  it('setConfig 不修改入参数组', () => {
    const input = [
      { key: 'settings', visible: true, order: 0 },
      { key: 'tasks', visible: true, order: 9 },
    ]
    useNavConfigStore.getState().setConfig(input)
    expect(input[0].order).toBe(0)
    expect(input[1].order).toBe(9)
  })

  it('settings.set 同步抛错时被吞掉（不影响内存状态）', () => {
    setThrows = true
    expect(() => useNavConfigStore.getState().setConfig([{ key: 'tasks', visible: false, order: 0 }])).not.toThrow()
    expect(useNavConfigStore.getState().config).toHaveLength(1)
  })
})

describe('nav.store / toggleVisible 与移动的 no-op 路径', () => {
  it('未知 key 的 toggleVisible / moveUp / moveDown 均不影响配置', () => {
    const before = JSON.stringify(useNavConfigStore.getState().config)
    const s = useNavConfigStore.getState()
    s.toggleVisible('nope')
    s.moveUp('nope')
    s.moveDown('nope')
    expect(JSON.stringify(useNavConfigStore.getState().config)).toBe(before)
  })

  it('对锁定项的 moveUp / moveDown 均无效', () => {
    useNavConfigStore.getState().moveUp('settings')
    expect(orderOf()).toEqual(['tasks', 'kms', 'employees', 'settings'])
    useNavConfigStore.getState().moveDown('settings')
    expect(orderOf()).toEqual(['tasks', 'kms', 'employees', 'settings'])
    expect(LOCKED_KEYS).toEqual(['settings'])
  })

  it('紧邻锁定项上方的项 moveDown 净效果为 no-op（reindex 归位）', () => {
    expect(orderOf()).toEqual(['tasks', 'kms', 'employees', 'settings'])
    useNavConfigStore.getState().moveDown('employees')
    expect(orderOf()).toEqual(['tasks', 'kms', 'employees', 'settings'])
  })

  it('moveDown 中间项生效并写盘', () => {
    useNavConfigStore.getState().moveDown('kms')
    expect(orderOf()).toEqual(['tasks', 'employees', 'kms', 'settings'])
    expect(lastPersisted()!.map((c: any) => c.key)).toEqual(['tasks', 'employees', 'kms', 'settings'])
  })

  it('连续 moveUp 不会越过首位', () => {
    const s = useNavConfigStore.getState()
    s.moveUp('employees')
    useNavConfigStore.getState().moveUp('employees')
    useNavConfigStore.getState().moveUp('employees')
    expect(orderOf()).toEqual(['employees', 'tasks', 'kms', 'settings'])
  })
})

describe('nav.store / setPlugins 合并细节', () => {
  it('pluginItems 按 order 排序，config 中插件项保留用户排序/显隐', () => {
    useNavConfigStore.getState().setPlugins([plugin('p2', 20), plugin('p1', 10)])
    expect(useNavConfigStore.getState().pluginItems.map(p => p.key)).toEqual(['p1', 'p2'])
    expect(orderOf()).toEqual(['tasks', 'kms', 'employees', 'p1', 'p2', 'settings'])
  })

  it('插件 key 与内置项冲突时不产生重复条目', () => {
    useNavConfigStore.getState().setPlugins([plugin('tasks', 10)])
    const keys = useNavConfigStore.getState().config.map(c => c.key)
    expect(keys.filter(k => k === 'tasks')).toHaveLength(1)
    expect(keys.filter(k => k === 'plugin:tasks')).toHaveLength(0)
  })

  it('installedIds 为空数组时视为清单可用：插件项全部移除', () => {
    useNavConfigStore.getState().setPlugins([plugin('p1', 10)], ['p1'])
    expect(orderOf()).toContain('p1')
    useNavConfigStore.getState().setPlugins([], [])
    expect(orderOf()).not.toContain('p1')
  })

  it('installedIds 缺省时退回保守合并（仅保留当前插件项）', () => {
    useNavConfigStore.getState().setPlugins([plugin('p1', 10), plugin('p2', 11)], ['p1', 'p2'])
    useNavConfigStore.getState().setPlugins([plugin('p1', 10)])
    expect(orderOf()).not.toContain('p2')
    expect(orderOf()).toContain('p1')
  })

  it('插件被停用后重新加载时保留用户调整过的显隐', () => {
    useNavConfigStore.getState().setPlugins([plugin('p1', 10)], ['p1'])
    useNavConfigStore.getState().toggleVisible('p1')
    useNavConfigStore.getState().setPlugins([], ['p1'])
    expect(useNavConfigStore.getState().config.find(c => c.key === 'p1')?.visible).toBe(false)
    useNavConfigStore.getState().setPlugins([plugin('p1', 10)], ['p1'])
    expect(useNavConfigStore.getState().config.find(c => c.key === 'p1')?.visible).toBe(false)
  })

  it('未初始化时不写盘（避免覆盖用户已保存排序）', () => {
    useNavConfigStore.getState().setPlugins([plugin('p1', 10)])
    expect(lastPersisted()).toBeUndefined()
  })
})

describe('nav.store / reset', () => {
  it('内置项恢复默认显隐与顺序，插件项保留且排在锁定项之前', () => {
    useNavConfigStore.getState().setPlugins([plugin('p1', 10)], ['p1'])
    useNavConfigStore.getState().toggleVisible('tasks')
    useNavConfigStore.getState().moveDown('tasks')
    useNavConfigStore.getState().moveUp('p1')

    useNavConfigStore.getState().reset()
    expect(orderOf()).toEqual(['tasks', 'kms', 'employees', 'p1', 'settings'])
    expect(useNavConfigStore.getState().config.find(c => c.key === 'tasks')?.visible).toBe(true)
    expect(orderOf()).toContain('p1')
  })

  it('两次 reset 结果稳定', () => {
    useNavConfigStore.getState().reset()
    const first = JSON.stringify(useNavConfigStore.getState().config)
    useNavConfigStore.getState().reset()
    expect(JSON.stringify(useNavConfigStore.getState().config)).toBe(first)
  })
})

describe('nav.store / initialize 兜底', () => {
  it('持久化为非法 JSON 字符串时回退默认配置', async () => {
    seedPersisted('{broken')
    await useNavConfigStore.getState().initialize()
    expect(useNavConfigStore.getState().initialized).toBe(true)
    expect(orderOf()).toEqual(['tasks', 'kms', 'employees', 'settings'])
  })

  it('持久化为 JSON 对象（非数组）时不应崩溃并回退默认配置（真实 Bug）', async () => {
    // 生产代码对 JSON.parse 结果未做 Array.isArray 校验，后续 parsed.find 直接 TypeError
    seedPersisted(JSON.stringify({ tasks: false }))
    await useNavConfigStore.getState().initialize()
    expect(useNavConfigStore.getState().initialized).toBe(true)
    expect(orderOf()).toEqual(['tasks', 'kms', 'employees', 'settings'])
  })

  it('持久化为合法 JSON 字符串数组时正常解析，并补齐新增内置项', async () => {
    seedPersisted(JSON.stringify([
      { key: 'tasks', visible: false, order: 1 },
      { key: 'settings', visible: true, order: 0 },
    ]))
    await useNavConfigStore.getState().initialize()
    // 锁定项归位到最后，未出现在持久化中的内置项按默认顺序补齐
    expect(orderOf()).toEqual(['tasks', 'kms', 'employees', 'settings'])
    expect(useNavConfigStore.getState().config.find(c => c.key === 'tasks')?.visible).toBe(false)
  })

  it('空白字符串视为无持久化', async () => {
    seedPersisted('   ')
    await useNavConfigStore.getState().initialize()
    expect(orderOf()).toEqual(['tasks', 'kms', 'employees', 'settings'])
  })

  it('读取抛错时使用默认配置并标记已初始化', async () => {
    getThrows = true
    await useNavConfigStore.getState().initialize()
    expect(useNavConfigStore.getState().initialized).toBe(true)
    expect(orderOf()).toEqual(['tasks', 'kms', 'employees', 'settings'])
  })

  it('重复 initialize 幂等，不再读取设置', async () => {
    await useNavConfigStore.getState().initialize()
    const getsBefore = settingsCalls.filter(c => c.op === 'get').length
    await useNavConfigStore.getState().initialize()
    expect(settingsCalls.filter(c => c.op === 'get').length).toBe(getsBefore)
  })

  it('持久化中已卸载插件的条目在 setPlugins 前保留（待整轮同步清理）', async () => {
    seedPersisted([
      { key: 'tasks', visible: true, order: 0 },
      { key: 'stale_plugin', visible: true, order: 1 },
    ])
    await useNavConfigStore.getState().initialize()
    expect(orderOf()).toContain('stale_plugin')
    useNavConfigStore.getState().setPlugins([], [])
    expect(orderOf()).not.toContain('stale_plugin')
  })
})

describe('nav.store / getVisibleNavItems 边界', () => {
  it('空数组返回空', () => {
    expect(getVisibleNavItems([])).toEqual([])
  })

  it('全部隐藏时返回空', () => {
    expect(getVisibleNavItems([{ key: 'a', visible: false, order: 0 }])).toEqual([])
  })

  it('不修改入参顺序', () => {
    const input = [
      { key: 'b', visible: true, order: 2 },
      { key: 'a', visible: true, order: 1 },
    ]
    getVisibleNavItems(input)
    expect(input.map(i => i.key)).toEqual(['b', 'a'])
  })
})
