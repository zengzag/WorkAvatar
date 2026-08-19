import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockContext } from '../../helpers/mock-plugin-context'

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

async function loadPlugin() {
  vi.resetModules()
  const mod = await import('../../../plugins/data-model/src/main/index')
  return mod
}

describe('data-model 插件 activate', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(() => {
    mock = createMockContext('data-model')
  })

  it('注册 IPC handler', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    const channels = ['project-list', 'project-create', 'project-open', 'project-delete', 'project-save',
      'project-export-file', 'project-import-file',
      'model-get', 'model-sync', 'dbml-import', 'dbml-export',
      'employees-list', 'providers-list',
      'settings-get', 'settings-set', 'data-dir', 'data-dir-open',
      'chat-send', 'chat-cancel', 'chat-history', 'chats-list', 'chat-delete']
    for (const c of channels) {
      expect(mock.ipc.handlers.has(c)).toBe(true)
    }
  })

  it('注册 18 个 agent 工具', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(mock.contributions.agentTools.length).toBe(18)
    const ids = mock.contributions.agentTools.map(t => t.id)
    expect(ids).toContain('create_table')
    expect(ids).toContain('add_field')
    expect(ids).toContain('create_relationship')
    expect(ids).toContain('list_tables')
  })

  it('deactivate 不抛错', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(() => mod.deactivate()).not.toThrow()
  })
})

describe('data-model 插件 IPC handler', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('data-model')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('project-create 创建空白项目', async () => {
    const handler = mock.ipc.handlers.get('project-create')!
    const res = await handler({ name: '测试项目' }) as { model?: any; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.model).toBeTruthy()
    expect(res.model.name).toBe('测试项目')
    expect(res.model.tables).toEqual([])
  })

  it('model-get 返回当前模型', async () => {
    const handler = mock.ipc.handlers.get('model-get')!
    const res = await handler() as { model: any }
    expect(res.model).toBeTruthy()
  })

  it('model-sync 同步模型', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    const created = await create({ name: 'A' }) as { model: any }
    const sync = mock.ipc.handlers.get('model-sync')!
    const res = await sync({ model: { ...created.model, name: '改名' } }) as { ok?: boolean; error?: string }
    expect(res.error).toBeUndefined()
    const get = mock.ipc.handlers.get('model-get')!
    const got = await get() as { model: any }
    expect(got.model.name).toBe('改名')
  })

  it('dbml-import 解析 DBML', async () => {
    const handler = mock.ipc.handlers.get('dbml-import')!
    const res = await handler({ dbml: 'Table users {\n  id bigint [pk]\n  name varchar\n}' }) as { model?: any; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.model.tables.length).toBe(1)
    expect(res.model.tables[0].name).toBe('users')
  })

  it('dbml-export 导出 DBML', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: 'A' })
    const sync = mock.ipc.handlers.get('model-sync')!
    await sync({ model: { ...(await (mock.ipc.handlers.get('model-get')! as any)()).model, tables: [] } })
    const handler = mock.ipc.handlers.get('dbml-export')!
    const res = await handler() as { dbml?: string; error?: string }
    expect(res.error).toBeUndefined()
    expect(typeof res.dbml).toBe('string')
  })

  it('agent 工具 create_table 应用到模型会话并广播', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: 'A' })
    const tool = mock.contributions.agentTools.find(t => t.id === 'create_table')!
    const res = await tool.handler({ name: 'users', fields: [{ name: 'id', type: 'bigint', primaryKey: true }] }, {})
    expect(res).toMatchObject({ success: true })
    const get = mock.ipc.handlers.get('model-get')!
    const got = await get() as { model: any }
    expect(got.model.tables.length).toBe(1)
    expect(got.model.tables[0].name).toBe('users')
    // 广播 model-changed
    expect(mock.ipc.broadcasts.some(b => b.event === 'model-changed')).toBe(true)
  })

  it('agent 工具 list_tables 返回表清单', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: 'A' })
    const createTable = mock.contributions.agentTools.find(t => t.id === 'create_table')!
    await createTable.handler({ name: 'users' }, {})
    const list = mock.contributions.agentTools.find(t => t.id === 'list_tables')!
    const res = await list.handler({}, {})
    expect(res).toMatchObject({ success: true })
    expect((res as any).data.length).toBe(1)
  })

  it('chat-send 调用宿主 execute 并记录对话', async () => {
    // mock execute 返回会话 id，并驱动 onChunk/onDone 回调
    mock.services.execute!.execute = vi.fn(async (_req: any, callbacks?: any) => {
      callbacks?.onChunk?.('你好')
      callbacks?.onDone?.({})
      return { conversationId: 'conv-1' }
    }) as any
    // mock data 查询/写入
    mock.services.data!.query = vi.fn(async () => []) as any
    mock.services.data!.mutate = vi.fn(async () => ({})) as any

    const handler = mock.ipc.handlers.get('chat-send')!
    const res = await handler({ employeeId: 'e1', providerId: 'p1', messages: [{ role: 'user', content: '建表' }] })
    expect(res).toEqual({ conversationId: 'conv-1' })
    // 记录到 dm_chats
    const list = mock.ipc.handlers.get('chats-list')!
    const chats = await list({}) as any[]
    expect(chats.some(c => c.conversationId === 'conv-1')).toBe(true)
    // 广播 chat-event 与 chats-changed
    expect(mock.ipc.broadcasts.some(b => b.event === 'chat-event')).toBe(true)
    expect(mock.ipc.broadcasts.some(b => b.event === 'chats-changed')).toBe(true)
  })

  it('chat-delete 删除对话记录', async () => {
    mock.services.execute!.execute = vi.fn(async (_req: any, callbacks?: any) => {
      callbacks?.onDone?.({})
      return { conversationId: 'conv-2' }
    }) as any
    mock.services.data!.query = vi.fn(async () => []) as any
    mock.services.data!.mutate = vi.fn(async () => ({})) as any

    const send = mock.ipc.handlers.get('chat-send')!
    await send({ employeeId: 'e1', providerId: 'p1', messages: [{ role: 'user', content: 'x' }] })

    const del = mock.ipc.handlers.get('chat-delete')!
    const res = await del({ conversationId: 'conv-2' })
    expect(res).toEqual({ ok: true })
    const list = mock.ipc.handlers.get('chats-list')!
    const chats = await list({}) as any[]
    expect(chats.some(c => c.conversationId === 'conv-2')).toBe(false)
  })

  it('settings-set 保存 / settings-get 读取', async () => {
    const set = mock.ipc.handlers.get('settings-set')!
    await set({ settings: { defaultEmployeeId: 'e1', defaultProviderId: 'p1' } })
    const get = mock.ipc.handlers.get('settings-get')!
    const res = await get() as { settings: any }
    expect(res.settings.defaultEmployeeId).toBe('e1')
    expect(res.settings.defaultProviderId).toBe('p1')
  })

  it('data-dir 返回插件数据目录', async () => {
    const handler = mock.ipc.handlers.get('data-dir')!
    const res = await handler() as { dataDir: string }
    expect(typeof res.dataDir).toBe('string')
    expect(res.dataDir.length).toBeGreaterThan(0)
  })

  it('chat-send 无 providerId 时从默认 provider 兜底', async () => {
    mock.services.data!.query = vi.fn(async (entity: string) => {
      if (entity === 'llmProviders') return [{ id: 'p-default', name: '默认', is_default: true, model: 'm1' }]
      return []
    }) as any
    mock.services.data!.mutate = vi.fn(async () => ({})) as any
    mock.services.execute!.execute = vi.fn(async (req: any, callbacks?: any) => {
      callbacks?.onDone?.({})
      return { conversationId: 'conv-3' }
    }) as any

    const handler = mock.ipc.handlers.get('chat-send')!
    const res = await handler({ employeeId: 'e1', messages: [{ role: 'user', content: 'x' }] })
    expect(res).toEqual({ conversationId: 'conv-3' })
    // 应使用默认 provider
    expect(mock.services.execute!.execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'p-default', modelId: 'm1' }),
      expect.anything(),
      expect.anything()
    )
  })
})
