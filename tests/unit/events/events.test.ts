import { describe, it, expect, vi } from 'vitest'
import { createEventBus, notifyEvent, type EventListenerMap } from '../../../electron/main/services/plugin/plugin-events'

function makeLogger() {
  return { warn: vi.fn() }
}

describe('createEventBus.subscribe', () => {
  it('订阅后收到发布的事件', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    const cb = vi.fn()
    bus.subscribe('plugin:plugin-a:thing', cb)
    bus.publish('thing', { data: 1 })
    expect(cb).toHaveBeenCalledWith({ data: 1 })
  })

  it('取消订阅后不再收到', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    const cb = vi.fn()
    const unsub = bus.subscribe('plugin:plugin-a:thing', cb)
    unsub()
    bus.publish('thing', {})
    expect(cb).not.toHaveBeenCalled()
  })

  it('多个订阅者都收到', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    bus.subscribe('plugin:plugin-a:thing', cb1)
    bus.subscribe('plugin:plugin-a:thing', cb2)
    bus.publish('thing', {})
    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
  })
})

describe('createEventBus.publish', () => {
  it('事件名强制加 plugin:<id>: 前缀', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    const cb = vi.fn()
    bus.subscribe('plugin:plugin-a:thing', cb)
    bus.publish('thing', {})
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('已带 plugin: 前缀的事件不重复加', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    const cb = vi.fn()
    bus.subscribe('plugin:plugin-a:thing', cb)
    bus.publish('plugin:plugin-a:thing', {})
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('无订阅者时发布不报错', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    expect(() => bus.publish('thing', {})).not.toThrow()
  })

  it('回调抛错被捕获并记录日志', () => {
    const map: EventListenerMap = new Map()
    const logger = makeLogger()
    const bus = createEventBus(map, 'plugin-a', logger)
    bus.subscribe('plugin:plugin-a:thing', () => { throw new Error('boom') })
    expect(() => bus.publish('thing', {})).not.toThrow()
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('notifyEvent（宿主广播）', () => {
  it('向订阅插件广播事件', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    const cb = vi.fn()
    bus.subscribe('conversation:deleted', cb)
    notifyEvent(map, 'conversation:deleted', 'conv-1')
    expect(cb).toHaveBeenCalledWith('conv-1')
  })

  it('无订阅者时不报错', () => {
    const map: EventListenerMap = new Map()
    expect(() => notifyEvent(map, 'conversation:deleted', 'x')).not.toThrow()
  })
})

describe('events 边界 case', () => {
  it('订阅后取消再发布不触发', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    const cb = vi.fn()
    const unsub = bus.subscribe('plugin:plugin-a:thing', cb)
    unsub()
    bus.publish('thing', {})
    expect(cb).not.toHaveBeenCalled()
  })

  it('多个插件共享 listenerMap 实现跨插件协作', () => {
    const map: EventListenerMap = new Map()
    const busA = createEventBus(map, 'plugin-a', makeLogger())
    const busB = createEventBus(map, 'plugin-b', makeLogger())
    const cb = vi.fn()
    // B 订阅 A 发布的事件（完整 plugin: 前缀）
    busB.subscribe('plugin:plugin-a:thing', cb)
    busA.publish('thing', { data: 1 })
    expect(cb).toHaveBeenCalledWith({ data: 1 })
  })

  it('发布空事件名不报错', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    expect(() => bus.publish('', {})).not.toThrow()
  })

  it('订阅空事件名后发布带前缀事件不触发（空名 publish 会加前缀）', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    const cb = vi.fn()
    bus.subscribe('', cb)
    bus.publish('', {})
    // publish('') → plugin:plugin-a:，与订阅的空名 '' 不匹配
    expect(cb).not.toHaveBeenCalled()
  })

  it('notifyEvent 回调抛错被捕获不中断其他回调', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    const cb1 = vi.fn(() => { throw new Error('boom') })
    const cb2 = vi.fn()
    bus.subscribe('conversation:deleted', cb1)
    bus.subscribe('conversation:deleted', cb2)
    expect(() => notifyEvent(map, 'conversation:deleted', 'x')).not.toThrow()
    expect(cb2).toHaveBeenCalled()
  })

  it('同一回调重复订阅只触发一次（Set 去重）', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    const cb = vi.fn()
    bus.subscribe('plugin:plugin-a:thing', cb)
    bus.subscribe('plugin:plugin-a:thing', cb)
    bus.publish('thing', {})
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('publish 带 plugin: 前缀的事件不重复加前缀', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    const cb = vi.fn()
    bus.subscribe('plugin:plugin-a:thing', cb)
    bus.publish('plugin:plugin-a:thing', {})
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('订阅者收到 payload 透传', () => {
    const map: EventListenerMap = new Map()
    const bus = createEventBus(map, 'plugin-a', makeLogger())
    const cb = vi.fn()
    bus.subscribe('plugin:plugin-a:thing', cb)
    const payload = { a: 1, b: [2, 3] }
    bus.publish('thing', payload)
    expect(cb).toHaveBeenCalledWith(payload)
  })
})
