import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockContext } from '../../helpers/mock-plugin-context'

/**
 * automation 插件单测：验证 activate 注册行为 + IPC handler 数据操作。
 * 插件入口有模块级状态，用 vi.resetModules + 动态 import 隔离。
 */

async function loadPlugin() {
  vi.resetModules()
  const mod = await import('../../../plugins/automation/src/main/index')
  return mod
}

describe('automation 插件 activate', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(() => {
    mock = createMockContext('automation')
  })

  it('注册 11 个 IPC handler', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    const channels = ['list-tasks', 'get-task', 'create-task', 'update-task', 'delete-task', 'toggle-task',
      'run-now', 'preview-runs', 'list-runs', 'delete-run', 'clear-runs']
    for (const c of channels) {
      expect(mock.ipc.handlers.has(c)).toBe(true)
    }
    expect(mock.ipc.handlers.size).toBe(11)
  })

  it('注册 8 个 agent 工具', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(mock.contributions.agentTools.length).toBe(8)
    const ids = mock.contributions.agentTools.map(t => t.id)
    expect(ids).toContain('automation_task_list')
    expect(ids).toContain('automation_task_create')
    expect(ids).toContain('automation_run_list')
  })

  it('订阅 conversation:deleted 和 model:renamed 事件', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    const events = mock.events.subscriptions.map(s => s.event)
    expect(events).toContain('conversation:deleted')
    expect(events).toContain('model:renamed')
  })

  it('调用 scheduler.every 启动调度', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    // scheduler.start() 是异步的，activate 不 await，需等待微任务完成
    await new Promise((r) => setTimeout(r, 0))
    expect(mock.services.scheduler!.every).toHaveBeenCalled()
  })

  it('deactivate 清理订阅与调度', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(() => mod.deactivate()).not.toThrow()
  })
})

describe('automation 插件 IPC handler', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('automation')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('create-task 校验必填字段', async () => {
    const handler = mock.ipc.handlers.get('create-task')!
    const res = await handler({ title: 'x' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('create-task 成功创建任务', async () => {
    const handler = mock.ipc.handlers.get('create-task')!
    const res = await handler({
      title: '测试任务',
      prompt: '帮我整理文档',
      employee_id: 'emp-1',
      provider_id: 'prov-1',
      start_at: Math.floor(Date.now() / 1000),
    }) as { id?: string; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.id).toBeTruthy()
    // 创建后广播 data-changed
    expect(mock.ipc.broadcasts.some(b => b.event === 'data-changed')).toBe(true)
  })

  it('list-tasks 返回已创建任务', async () => {
    const create = mock.ipc.handlers.get('create-task')!
    await create({
      title: '任务A',
      prompt: 'p',
      employee_id: 'emp-1',
      provider_id: 'prov-1',
      start_at: Math.floor(Date.now() / 1000),
    })
    const list = mock.ipc.handlers.get('list-tasks')!
    const res = await list({}) as Array<{ title: string }>
    expect(res.length).toBe(1)
    expect(res[0].title).toBe('任务A')
  })

  it('get-task 返回指定任务', async () => {
    const create = mock.ipc.handlers.get('create-task')!
    const created = await create({
      title: '任务B',
      prompt: 'p',
      employee_id: 'emp-1',
      provider_id: 'prov-1',
      start_at: Math.floor(Date.now() / 1000),
    }) as { id: string }
    const get = mock.ipc.handlers.get('get-task')!
    const res = await get(created.id) as { id?: string; error?: string }
    expect(res.id).toBe(created.id)
  })

  it('toggle-task 切换启用状态', async () => {
    const create = mock.ipc.handlers.get('create-task')!
    const created = await create({
      title: '任务C',
      prompt: 'p',
      employee_id: 'emp-1',
      provider_id: 'prov-1',
      start_at: Math.floor(Date.now() / 1000),
    }) as { id: string }
    const toggle = mock.ipc.handlers.get('toggle-task')!
    const res = await toggle({ id: created.id, enabled: false }) as { is_enabled?: boolean }
    expect(res.is_enabled).toBe(false)
  })

  it('delete-task 删除任务', async () => {
    const create = mock.ipc.handlers.get('create-task')!
    const created = await create({
      title: '任务D',
      prompt: 'p',
      employee_id: 'emp-1',
      provider_id: 'prov-1',
      start_at: Math.floor(Date.now() / 1000),
    }) as { id: string }
    const del = mock.ipc.handlers.get('delete-task')!
    const res = await del({ id: created.id }) as { success?: boolean }
    expect(res.success).toBe(true)
    const list = mock.ipc.handlers.get('list-tasks')!
    const remaining = await list({}) as unknown[]
    expect(remaining.length).toBe(0)
  })
})

describe('automation 插件 IPC 边界 case', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('automation')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('create-task 缺 title 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-task')!
    const res = await handler({ prompt: 'p', employee_id: 'e', provider_id: 'p', start_at: 1 }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('create-task 缺 prompt 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-task')!
    const res = await handler({ title: 't', employee_id: 'e', provider_id: 'p', start_at: 1 }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('create-task 缺 employee_id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-task')!
    const res = await handler({ title: 't', prompt: 'p', provider_id: 'p', start_at: 1 }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('create-task 缺 provider_id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-task')!
    const res = await handler({ title: 't', prompt: 'p', employee_id: 'e', start_at: 1 }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('create-task 缺 start_at 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-task')!
    const res = await handler({ title: 't', prompt: 'p', employee_id: 'e', provider_id: 'p' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('update-task 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('update-task')!
    const res = await handler({ title: 'x' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('delete-task 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('delete-task')!
    const res = await handler({}) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('toggle-task 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('toggle-task')!
    const res = await handler({}) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('toggle-task 不存在的任务返回 null', async () => {
    const handler = mock.ipc.handlers.get('toggle-task')!
    const res = await handler({ id: 'nonexistent', enabled: false })
    expect(res).toBeNull()
  })

  it('run-now 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('run-now')!
    const res = await handler({}) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('preview-runs 缺 task_id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('preview-runs')!
    const res = await handler({}) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('preview-runs 不存在的任务返回错误', async () => {
    const handler = mock.ipc.handlers.get('preview-runs')!
    const res = await handler({ task_id: 'nonexistent' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('delete-run 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('delete-run')!
    const res = await handler({}) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('get-task 空 id 返回错误', async () => {
    const handler = mock.ipc.handlers.get('get-task')!
    const res = await handler('') as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('get-task 不存在的任务返回 null', async () => {
    const handler = mock.ipc.handlers.get('get-task')!
    const res = await handler('nonexistent')
    expect(res).toBeNull()
  })

  it('list-runs 空数据返回空数组', async () => {
    const handler = mock.ipc.handlers.get('list-runs')!
    const res = await handler({}) as unknown[]
    expect(res).toEqual([])
  })

  it('clear-runs 无任务时返回 0', async () => {
    const handler = mock.ipc.handlers.get('clear-runs')!
    const res = await handler({}) as { success?: boolean; count?: number }
    expect(res.success).toBe(true)
    expect(res.count).toBe(0)
  })
})
