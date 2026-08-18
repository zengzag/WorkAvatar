import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockContext } from '../../helpers/mock-plugin-context'

// mock electron（vitest node 环境无 electron；outlook-auth 用 BrowserWindow）
vi.mock('electron', () => ({
  app: { getPath: () => '/mock' },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    loadURL() {}
    loadFile() {}
    on() {}
    once() {}
    close() {}
    destroy() {}
    isDestroyed() { return true }
    isVisible() { return false }
    show() {}
    hide() {}
    setSize() {}
    webContents = { send: vi.fn() }
  },
  shell: { openExternal: vi.fn(async () => {}) },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))

/**
 * calendar 插件单测：验证 activate 注册行为 + IPC handler 数据操作。
 */

async function loadPlugin() {
  vi.resetModules()
  const mod = await import('../../../plugins/calendar/src/main/index')
  return mod
}

describe('calendar 插件 activate', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(() => {
    mock = createMockContext('calendar')
  })

  it('注册 20 个 IPC handler', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    const channels = ['list-events', 'create-event', 'update-event', 'delete-event', 'delete-event-instance',
      'list-todos', 'list-todo-instances', 'create-todo', 'update-todo', 'delete-todo', 'delete-todo-instance', 'complete-todo', 'todo-stats',
      'get-settings', 'set-settings',
      'outlook-login', 'outlook-logout', 'outlook-status', 'outlook-set-config', 'outlook-sync-now']
    for (const c of channels) {
      expect(mock.ipc.handlers.has(c)).toBe(true)
    }
    expect(mock.ipc.handlers.size).toBe(20)
  })

  it('注册 10 个 agent 工具', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(mock.contributions.agentTools.length).toBe(10)
    const ids = mock.contributions.agentTools.map(t => t.id)
    expect(ids).toContain('calendar_event_list')
    expect(ids).toContain('calendar_todo_create')
  })

  it('调用 scheduler.every 启动调度', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    await new Promise((r) => setTimeout(r, 0))
    expect(mock.services.scheduler!.every).toHaveBeenCalled()
  })

  it('deactivate 不抛错', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(() => mod.deactivate()).not.toThrow()
  })
})

describe('calendar 插件 IPC handler', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('calendar')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('create-event 创建事件', async () => {
    const handler = mock.ipc.handlers.get('create-event')!
    const res = await handler({
      title: '会议',
      start_at: Math.floor(Date.now() / 1000),
      end_at: Math.floor(Date.now() / 1000) + 3600,
    }) as { id?: string; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.id).toBeTruthy()
  })

  it('list-events 返回已创建事件', async () => {
    const create = mock.ipc.handlers.get('create-event')!
    await create({
      title: '会议A',
      start_at: Math.floor(Date.now() / 1000),
      end_at: Math.floor(Date.now() / 1000) + 3600,
    })
    const list = mock.ipc.handlers.get('list-events')!
    const res = await list({
      start_at: Math.floor(Date.now() / 1000) - 3600,
      end_at: Math.floor(Date.now() / 1000) + 7200,
    }) as Array<{ title: string }>
    expect(res.length).toBe(1)
    expect(res[0].title).toBe('会议A')
  })

  it('create-todo 创建待办', async () => {
    const handler = mock.ipc.handlers.get('create-todo')!
    const res = await handler({
      title: '待办事项',
      due_at: Math.floor(Date.now() / 1000) + 3600,
    }) as { id?: string; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.id).toBeTruthy()
  })

  it('list-todos 返回已创建待办', async () => {
    const create = mock.ipc.handlers.get('create-todo')!
    await create({ title: '待办A', due_at: Math.floor(Date.now() / 1000) + 3600 })
    const list = mock.ipc.handlers.get('list-todos')!
    const res = await list({}) as Array<{ title: string }>
    expect(res.length).toBe(1)
    expect(res[0].title).toBe('待办A')
  })

  it('complete-todo 完成待办', async () => {
    const create = mock.ipc.handlers.get('create-todo')!
    const created = await create({ title: '待办B', due_at: Math.floor(Date.now() / 1000) + 3600 }) as { id: string }
    const complete = mock.ipc.handlers.get('complete-todo')!
    const res = await complete({ id: created.id, completed: true }) as { status?: string }
    expect(res.status).toBe('completed')
  })

  it('delete-event 删除事件', async () => {
    const create = mock.ipc.handlers.get('create-event')!
    const created = await create({
      title: '待删事件',
      start_at: Math.floor(Date.now() / 1000),
      end_at: Math.floor(Date.now() / 1000) + 3600,
    }) as { id: string }
    const del = mock.ipc.handlers.get('delete-event')!
    const res = await del({ id: created.id }) as { success?: boolean; error?: string }
    expect(res.error).toBeUndefined()
  })
})

describe('calendar 插件 IPC 边界 case', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('calendar')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('create-event 缺 title 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-event')!
    const res = await handler({ start_at: 1 }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('create-event 缺 start_at 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-event')!
    const res = await handler({ title: 't' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('list-events 缺 start_at/end_at 拒绝', async () => {
    const handler = mock.ipc.handlers.get('list-events')!
    const res = await handler({}) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('update-event 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('update-event')!
    const res = await handler({ title: 'x' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('delete-event 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('delete-event')!
    const res = await handler({}) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('create-todo 缺 title 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-todo')!
    const res = await handler({ due_at: 1 }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('update-todo 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('update-todo')!
    const res = await handler({ title: 'x' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('delete-todo 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('delete-todo')!
    const res = await handler({}) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('complete-todo 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('complete-todo')!
    const res = await handler({ completed: true }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('todo-stats 返回统计', async () => {
    const handler = mock.ipc.handlers.get('todo-stats')!
    const res = await handler({}) as Record<string, unknown>
    expect(res).toBeTruthy()
  })

  it('get-settings 返回默认设置', async () => {
    const handler = mock.ipc.handlers.get('get-settings')!
    const res = await handler() as Record<string, unknown>
    expect(res).toBeTruthy()
  })

  it('set-settings 更新设置', async () => {
    const set = mock.ipc.handlers.get('set-settings')!
    const res = await set({ reminders_enabled: false }) as { success?: boolean; error?: string }
    expect(res.error).toBeUndefined()
  })
})
