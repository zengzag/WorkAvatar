import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockContext } from '../../helpers/mock-plugin-context'

/**
 * hello-world 示例插件单测：验证 activate 注册行为 + IPC handler。
 */

async function loadPlugin() {
  vi.resetModules()
  const mod = await import('../../../plugins/examples/hello-world/src/main/index')
  return mod
}

describe('hello-world 插件 activate', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(() => {
    mock = createMockContext('example-hello-world')
  })

  it('注册 greet 和 count 两个 IPC handler', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(mock.ipc.handlers.has('greet')).toBe(true)
    expect(mock.ipc.handlers.has('count')).toBe(true)
  })

  it('注册 hello 命令', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(mock.contributions.commands.length).toBe(1)
    expect((mock.contributions.commands[0] as { id: string }).id).toBe('hello')
  })

  it('deactivate 不抛错', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(() => mod.deactivate()).not.toThrow()
  })
})

describe('hello-world 插件 IPC handler', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('example-hello-world')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('greet 返回问候语', async () => {
    const handler = mock.ipc.handlers.get('greet')!
    const res = await handler({ name: 'Plugin' }) as { message: string }
    expect(res.message).toBe('Hello, Plugin!')
  })

  it('count 递增并发布事件', async () => {
    const handler = mock.ipc.handlers.get('count')!
    const res1 = await handler() as { count: number }
    const res2 = await handler() as { count: number }
    expect(res1.count).toBe(1)
    expect(res2.count).toBe(2)
    // 发布事件（原始名；plugin:<id>: 前缀由宿主 createEventBus 负责）
    expect(mock.events.publishes.length).toBe(2)
    expect(mock.events.publishes[0].event).toBe('count-changed')
  })
})

describe('hello-world 插件 IPC 边界 case', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('example-hello-world')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('greet 无参数返回默认 World', async () => {
    const handler = mock.ipc.handlers.get('greet')!
    const res = await handler() as { message: string }
    expect(res.message).toBe('Hello, World!')
  })

  it('greet 空 name 保留空串（?? 只对 null/undefined 生效）', async () => {
    const handler = mock.ipc.handlers.get('greet')!
    const res = await handler({ name: '' }) as { message: string }
    expect(res.message).toBe('Hello, !')
  })

  it('count 每次发布事件携带当前计数', async () => {
    const handler = mock.ipc.handlers.get('count')!
    await handler()
    await handler()
    await handler()
    expect(mock.events.publishes.length).toBe(3)
    expect(mock.events.publishes[2].payload).toEqual({ count: 3 })
  })
})
