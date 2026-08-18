import { describe, it, expect } from 'vitest'
import {
  canAccessData,
  canExecute,
  canSubscribeEvent,
  canPublishEvent,
  canRegisterView,
  hasSystemFeature,
  validateCapabilities,
  getCapability,
} from '../../../electron/main/services/plugin/plugin-capability'
import type { PluginCapability } from '../../../plugins/plugin-sdk/src'

const fullCaps: PluginCapability[] = [
  { domain: 'data', entities: ['conversations', 'employees'], access: 'write' },
  { domain: 'execute', kinds: ['agent-task', 'llm-stream'] },
  { domain: 'events', subscribe: ['conversation:deleted'], publish: true },
  { domain: 'ui', views: ['chat.toolbar'] },
  { domain: 'system', features: ['notification', 'scheduler'] },
]

describe('validateCapabilities', () => {
  it('undefined 视为合法（无能力声明）', () => {
    expect(validateCapabilities(undefined).ok).toBe(true)
  })

  it('合法 capabilities 通过', () => {
    expect(validateCapabilities(fullCaps).ok).toBe(true)
  })

  it('非数组拒绝', () => {
    expect(validateCapabilities({} as never).ok).toBe(false)
  })

  it('重复 domain 拒绝', () => {
    const caps = [
      { domain: 'data', entities: ['conversations'], access: 'read' },
      { domain: 'data', entities: ['employees'], access: 'read' },
    ] as PluginCapability[]
    const r = validateCapabilities(caps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('重复')
  })

  it('data 缺 entities 拒绝', () => {
    const caps = [{ domain: 'data', access: 'read' }] as unknown as PluginCapability[]
    expect(validateCapabilities(caps).ok).toBe(false)
  })

  it('data access 非法拒绝', () => {
    const caps = [{ domain: 'data', entities: ['conversations'], access: 'all' }] as unknown as PluginCapability[]
    expect(validateCapabilities(caps).ok).toBe(false)
  })

  it('未知 domain 拒绝', () => {
    const caps = [{ domain: 'hack', entities: [] }] as unknown as PluginCapability[]
    expect(validateCapabilities(caps).ok).toBe(false)
  })
})

describe('canAccessData', () => {
  it('白名单内实体 + read 通过', () => {
    expect(canAccessData(fullCaps, 'conversations', 'read').ok).toBe(true)
  })

  it('白名单内实体 + write 通过（access=write）', () => {
    expect(canAccessData(fullCaps, 'conversations', 'write').ok).toBe(true)
  })

  it('白名单外实体拒绝', () => {
    const r = canAccessData(fullCaps, 'memories', 'read')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('memories')
  })

  it('未声明 data 能力域拒绝', () => {
    expect(canAccessData(undefined, 'conversations', 'read').ok).toBe(false)
  })

  it('只读声明下 write 拒绝', () => {
    const readOnly: PluginCapability[] = [{ domain: 'data', entities: ['conversations'], access: 'read' }]
    const r = canAccessData(readOnly, 'conversations', 'write')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('只读')
  })
})

describe('canExecute', () => {
  it('白名单内 kind 通过', () => {
    expect(canExecute(fullCaps, 'agent-task').ok).toBe(true)
  })

  it('白名单外 kind 拒绝', () => {
    const r = canExecute(fullCaps, 'agent-chat')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('agent-chat')
  })

  it('未声明 execute 能力域拒绝', () => {
    expect(canExecute(undefined, 'llm-chat').ok).toBe(false)
  })
})

describe('canSubscribeEvent / canPublishEvent', () => {
  it('白名单内事件订阅通过', () => {
    expect(canSubscribeEvent(fullCaps, 'conversation:deleted').ok).toBe(true)
  })

  it('白名单外事件订阅拒绝', () => {
    const r = canSubscribeEvent(fullCaps, 'model:renamed')
    expect(r.ok).toBe(false)
  })

  it('声明 publish 后发布通过', () => {
    expect(canPublishEvent(fullCaps).ok).toBe(true)
  })

  it('未声明 publish 拒绝发布', () => {
    const noPub: PluginCapability[] = [{ domain: 'events', subscribe: ['conversation:deleted'] }]
    const r = canPublishEvent(noPub)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('publish')
  })
})

describe('canRegisterView', () => {
  it('白名单内 view 通过', () => {
    expect(canRegisterView(fullCaps, 'chat.toolbar').ok).toBe(true)
  })

  it('白名单外 view 拒绝', () => {
    const r = canRegisterView(fullCaps, 'sidebar.footer')
    expect(r.ok).toBe(false)
  })
})

describe('hasSystemFeature', () => {
  it('白名单内 feature 返回 true', () => {
    expect(hasSystemFeature(fullCaps, 'notification')).toBe(true)
  })

  it('白名单外 feature 返回 false', () => {
    expect(hasSystemFeature(fullCaps, 'windows')).toBe(false)
  })

  it('未声明 system 返回 false', () => {
    expect(hasSystemFeature(undefined, 'notification')).toBe(false)
  })
})

describe('getCapability', () => {
  it('提取指定 domain', () => {
    const cap = getCapability(fullCaps, 'data')
    expect(cap?.domain).toBe('data')
  })

  it('不存在的 domain 返回 undefined', () => {
    expect(getCapability(fullCaps, 'hack' as never)).toBeUndefined()
  })

  it('空数组返回 undefined', () => {
    expect(getCapability([], 'data')).toBeUndefined()
  })

  it('undefined 返回 undefined', () => {
    expect(getCapability(undefined, 'data')).toBeUndefined()
  })
})

describe('capability 边界 case', () => {
  it('canAccessData 空 entities 拒绝', () => {
    const caps = [{ domain: 'data', entities: [], access: 'read' }] as unknown as PluginCapability[]
    expect(canAccessData(caps, 'conversations', 'read').ok).toBe(false)
  })

  it('canAccessData 空数组拒绝', () => {
    expect(canAccessData([], 'conversations', 'read').ok).toBe(false)
  })

  it('canExecute 空 kinds 拒绝', () => {
    const caps = [{ domain: 'execute', kinds: [] }] as unknown as PluginCapability[]
    expect(canExecute(caps, 'llm-chat').ok).toBe(false)
  })

  it('canSubscribeEvent 未声明 subscribe 时拒绝任意事件', () => {
    const caps = [{ domain: 'events' }] as unknown as PluginCapability[]
    expect(canSubscribeEvent(caps, 'conversation:deleted').ok).toBe(false)
  })

  it('canSubscribeEvent 空 subscribe 数组拒绝', () => {
    const caps = [{ domain: 'events', subscribe: [] }] as unknown as PluginCapability[]
    expect(canSubscribeEvent(caps, 'conversation:deleted').ok).toBe(false)
  })

  it('canRegisterView 空 views 拒绝', () => {
    const caps = [{ domain: 'ui', views: [] }] as unknown as PluginCapability[]
    expect(canRegisterView(caps, 'chat.toolbar').ok).toBe(false)
  })

  it('hasSystemFeature 空 features 返回 false', () => {
    const caps = [{ domain: 'system', features: [] }] as unknown as PluginCapability[]
    expect(hasSystemFeature(caps, 'notification')).toBe(false)
  })

  it('validateCapabilities 空数组通过', () => {
    expect(validateCapabilities([]).ok).toBe(true)
  })

  it('validateCapabilities null 元素拒绝', () => {
    expect(validateCapabilities([null] as unknown as PluginCapability[]).ok).toBe(false)
  })

  it('validateCapabilities 非对象元素拒绝', () => {
    expect(validateCapabilities(['data'] as unknown as PluginCapability[]).ok).toBe(false)
  })

  it('validateCapabilities 缺 domain 拒绝', () => {
    expect(validateCapabilities([{ entities: ['conversations'], access: 'read' }] as unknown as PluginCapability[]).ok).toBe(false)
  })

  it('validateCapabilities data 空 entities 拒绝', () => {
    const caps = [{ domain: 'data', entities: [], access: 'read' }] as unknown as PluginCapability[]
    expect(validateCapabilities(caps).ok).toBe(false)
  })

  it('validateCapabilities execute 空 kinds 拒绝', () => {
    const caps = [{ domain: 'execute', kinds: [] }] as unknown as PluginCapability[]
    expect(validateCapabilities(caps).ok).toBe(false)
  })

  it('validateCapabilities events subscribe 非数组拒绝', () => {
    const caps = [{ domain: 'events', subscribe: 'x' }] as unknown as PluginCapability[]
    expect(validateCapabilities(caps).ok).toBe(false)
  })

  it('validateCapabilities events publish 非布尔拒绝', () => {
    const caps = [{ domain: 'events', publish: 'yes' }] as unknown as PluginCapability[]
    expect(validateCapabilities(caps).ok).toBe(false)
  })

  it('validateCapabilities ui views 非数组拒绝', () => {
    const caps = [{ domain: 'ui', views: 'chat.toolbar' }] as unknown as PluginCapability[]
    expect(validateCapabilities(caps).ok).toBe(false)
  })

  it('validateCapabilities system features 非数组拒绝', () => {
    const caps = [{ domain: 'system', features: 'notification' }] as unknown as PluginCapability[]
    expect(validateCapabilities(caps).ok).toBe(false)
  })

  it('validateCapabilities 未知 domain 拒绝', () => {
    const caps = [{ domain: 'unknown', entities: [] }] as unknown as PluginCapability[]
    expect(validateCapabilities(caps).ok).toBe(false)
  })

  it('validateCapabilities 合法 events（仅 subscribe）通过', () => {
    const caps = [{ domain: 'events', subscribe: ['conversation:deleted'] }] as PluginCapability[]
    expect(validateCapabilities(caps).ok).toBe(true)
  })

  it('validateCapabilities 合法 ui（空 views）通过', () => {
    const caps = [{ domain: 'ui', views: [] }] as PluginCapability[]
    expect(validateCapabilities(caps).ok).toBe(true)
  })
})
