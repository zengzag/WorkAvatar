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
  shell: { openExternal: vi.fn(async () => {}), openPath: vi.fn(async () => '') },
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
      'providers-list',
      'settings-get', 'settings-set', 'data-dir', 'data-dir-open',
      'chat-send', 'chat-cancel', 'chat-history', 'chats-list', 'chat-delete']
    for (const c of channels) {
      expect(mock.ipc.handlers.has(c)).toBe(true)
    }
  })

  it('注册 8 个分层协议 agent 工具', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(mock.contributions.agentTools.length).toBe(8)
    const ids = mock.contributions.agentTools.map(t => t.id)
    expect(ids).toContain('get_model_meta')
    expect(ids).toContain('get_model_json')
    expect(ids).toContain('set_model_json')
    expect(ids).toContain('patch_model')
    expect(ids).toContain('import_dbml')
    expect(ids).toContain('import_dbml_file')
    expect(ids).toContain('export_model_file')
    expect(ids).toContain('import_model_file')
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

  it('agent 工具 set_model_json 应用到模型会话并广播', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: 'A' })
    const tool = mock.contributions.agentTools.find(t => t.id === 'set_model_json')!
    const res = await tool.handler({ model: { tables: [{ id: 't1', name: 'users', fields: [{ id: 'f1', name: 'id', type: 'bigint', primaryKey: true }] }] }, mode: 'replace' }, {})
    expect(res).toMatchObject({ success: true })
    const get = mock.ipc.handlers.get('model-get')!
    const got = await get() as { model: any }
    expect(got.model.tables.length).toBe(1)
    expect(got.model.tables[0].name).toBe('users')
    // 广播 model-changed
    expect(mock.ipc.broadcasts.some(b => b.event === 'model-changed')).toBe(true)
  })

  it('set_model_json 兼容 fromTable/fromField/toTable/toField 关系命名，连接边不失效', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: 'A' })
    const tool = mock.contributions.agentTools.find(t => t.id === 'set_model_json')!
    const res = await tool.handler({
      model: {
        tables: [
          { name: 'users', fields: [{ name: 'id', type: 'bigint', primaryKey: true }] },
          { name: 'orders', fields: [{ name: 'id', type: 'bigint', primaryKey: true }, { name: 'user_id', type: 'bigint' }] }
        ],
        relationships: [
          { name: 'fk_orders_user', fromTable: 'orders', fromField: 'user_id', toTable: 'users', toField: 'id', type: 'many-to-one' }
        ]
      },
      mode: 'replace'
    }, {})
    expect(res).toMatchObject({ success: true })
    const get = mock.ipc.handlers.get('model-get')!
    const got = await get() as { model: any }
    const rel = got.model.relationships[0]
    // 关系必须解析到真实表/字段 id，否则画布连接边失效
    expect(rel.sourceTableId).toBeTruthy()
    expect(rel.sourceFieldId).toBeTruthy()
    expect(rel.targetTableId).toBeTruthy()
    expect(rel.targetFieldId).toBeTruthy()
    expect(rel.sourceCardinality).toBe('many')
    expect(rel.targetCardinality).toBe('one')
    const orders = got.model.tables.find((t: any) => t.name === 'orders')
    const users = got.model.tables.find((t: any) => t.name === 'users')
    expect(rel.sourceTableId).toBe(orders.id)
    expect(rel.sourceFieldId).toBe(orders.fields.find((f: any) => f.name === 'user_id').id)
    expect(rel.targetTableId).toBe(users.id)
    expect(rel.targetFieldId).toBe(users.fields.find((f: any) => f.name === 'id').id)
  })

  it('set_model_json 兼容嵌套 from/to 关系命名，连接边不失效', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: 'A' })
    const tool = mock.contributions.agentTools.find(t => t.id === 'set_model_json')!
    const res = await tool.handler({
      model: {
        tables: [
          { name: 'users', fields: [{ name: 'id', type: 'bigint', primaryKey: true }] },
          { name: 'orders', fields: [{ name: 'id', type: 'bigint', primaryKey: true }, { name: 'user_id', type: 'bigint' }] }
        ],
        relationships: [
          { name: 'fk_orders_user', from: { table: 'orders', field: 'user_id' }, to: { table: 'users', field: 'id' }, type: 'many-to-one' }
        ]
      },
      mode: 'replace'
    }, {})
    expect(res).toMatchObject({ success: true })
    const get = mock.ipc.handlers.get('model-get')!
    const got = await get() as { model: any }
    const rel = got.model.relationships[0]
    expect(rel.sourceTableId).toBeTruthy()
    expect(rel.sourceFieldId).toBeTruthy()
    expect(rel.targetTableId).toBeTruthy()
    expect(rel.targetFieldId).toBeTruthy()
    expect(rel.sourceCardinality).toBe('many')
    expect(rel.targetCardinality).toBe('one')
    const orders = got.model.tables.find((t: any) => t.name === 'orders')
    const users = got.model.tables.find((t: any) => t.name === 'users')
    expect(rel.sourceTableId).toBe(orders.id)
    expect(rel.sourceFieldId).toBe(orders.fields.find((f: any) => f.name === 'user_id').id)
    expect(rel.targetTableId).toBe(users.id)
    expect(rel.targetFieldId).toBe(users.fields.find((f: any) => f.name === 'id').id)
  })

  it('get_model_json 的 output 包含完整 JSON 内容', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: 'A' })
    const set = mock.contributions.agentTools.find(t => t.id === 'set_model_json')!
    await set.handler({ model: { tables: [{ name: 'users', fields: [{ name: 'id', type: 'bigint', primaryKey: true }] }] }, mode: 'replace' }, {})
    const get = mock.contributions.agentTools.find(t => t.id === 'get_model_json')!
    const res = await get.handler({}, {})
    expect(res).toMatchObject({ success: true })
    // output 应包含 JSON 内容（含表名），而非仅提示文字
    expect((res as any).output).toContain('users')
    expect((res as any).output).toContain('"tables"')
  })

  it('set_model_json 省略 name 时保留当前模型名（不退回未命名）', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: '我的电商' })
    const tool = mock.contributions.agentTools.find(t => t.id === 'set_model_json')!
    // LLM 生成的 JSON 省略 model 级 name → 不应把模型改名为"未命名数据模型"
    const res = await tool.handler({
      model: { tables: [{ name: 'users', fields: [{ name: 'id', type: 'bigint', primaryKey: true }] }] },
      mode: 'replace'
    }, {})
    expect(res).toMatchObject({ success: true })
    const get = mock.ipc.handlers.get('model-get')!
    const got = await get() as { model: any }
    expect(got.model.name).toBe('我的电商')
  })

  it('set_model_json 兼容索引 table/fields 简写与枚举字符串值', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: 'A' })
    const tool = mock.contributions.agentTools.find(t => t.id === 'set_model_json')!
    const res = await tool.handler({
      model: {
        tables: [
          { name: 'users', fields: [{ name: 'id', type: 'bigint', primaryKey: true }, { name: 'email', type: 'varchar', notNull: true }] }
        ],
        indexes: [{ name: 'idx_users_email', table: 'users', fields: ['email'] }],
        enums: [{ name: 'user_status', values: ['active', 'inactive'] }]
      },
      mode: 'replace'
    }, {})
    expect(res).toMatchObject({ success: true })
    const get = mock.ipc.handlers.get('model-get')!
    const got = await get() as { model: any }
    const users = got.model.tables.find((t: any) => t.name === 'users')
    // notNull 简写 → nullable=false
    expect(users.fields.find((f: any) => f.name === 'email').nullable).toBe(false)
    // 索引解析到真实表/字段 id
    const idx = got.model.indexes[0]
    expect(idx.tableId).toBe(users.id)
    expect(idx.fieldIds).toEqual([users.fields.find((f: any) => f.name === 'email').id])
    // 枚举字符串值解析为对象
    expect(got.model.enums[0].values.map((v: any) => v.name)).toEqual(['active', 'inactive'])
  })

  it('agent 工具 get_model_meta 返回轻量概览', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: 'A' })
    const set = mock.contributions.agentTools.find(t => t.id === 'set_model_json')!
    await set.handler({ model: { tables: [{ id: 't1', name: 'users', fields: [{ id: 'f1', name: 'id', type: 'bigint', primaryKey: true }] }] }, mode: 'replace' }, {})
    const meta = mock.contributions.agentTools.find(t => t.id === 'get_model_meta')!
    const res = await meta.handler({}, {})
    expect(res).toMatchObject({ success: true })
    expect((res as any).data.tablesCount).toBe(1)
    expect((res as any).data.tables[0].name).toBe('users')
  })

  it('agent 工具 get_model_json 返回完整 JSON', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: 'A' })
    const set = mock.contributions.agentTools.find(t => t.id === 'set_model_json')!
    await set.handler({ model: { tables: [{ id: 't1', name: 'users', fields: [{ id: 'f1', name: 'id', type: 'bigint', primaryKey: true }] }] }, mode: 'replace' }, {})
    const get = mock.contributions.agentTools.find(t => t.id === 'get_model_json')!
    const res = await get.handler({}, {})
    expect(res).toMatchObject({ success: true })
    expect((res as any).data.model.tables[0].name).toBe('users')
  })

  it('agent 工具 patch_model 增量添加表与字段', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: 'A' })
    const patch = mock.contributions.agentTools.find(t => t.id === 'patch_model')!
    const res = await patch.handler({
      operations: [
        { op: 'addTable', table: { name: 'orders', fields: [{ name: 'id', type: 'bigint', primaryKey: true }] } },
        { op: 'addField', table: 'orders', field: { name: 'total', type: 'decimal' } }
      ]
    }, {})
    expect(res).toMatchObject({ success: true })
    const get = mock.ipc.handlers.get('model-get')!
    const got = await get() as { model: any }
    const orders = got.model.tables.find((t: any) => t.name === 'orders')
    expect(orders).toBeTruthy()
    expect(orders.fields.some((f: any) => f.name === 'total')).toBe(true)
  })

  it('agent 工具 patch_model 失败时整体回滚', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    await create({ name: 'A' })
    const patch = mock.contributions.agentTools.find(t => t.id === 'patch_model')!
    const res = await patch.handler({
      operations: [
        { op: 'addTable', table: { name: 'orders' } },
        { op: 'addTable', table: { name: 'orders' } } // 重复表名，应失败
      ]
    }, {})
    expect(res).toMatchObject({ success: false })
    const get = mock.ipc.handlers.get('model-get')!
    const got = await get() as { model: any }
    expect(got.model.tables.some((t: any) => t.name === 'orders')).toBe(false)
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
    const res = await handler({ providerId: 'p1', messages: [{ role: 'user', content: '建表' }] })
    expect(res).toMatchObject({ conversationId: 'conv-1' })
    // 新对话应创建任务工作区文件夹并返回路径
    expect(typeof (res as any).workspacePath).toBe('string')
    expect((res as any).workspacePath).toBeTruthy()
    // 记录到 dm_chats，且带任务工作区目录
    const list = mock.ipc.handlers.get('chats-list')!
    const chats = await list({}) as any[]
    const rec = chats.find(c => c.conversationId === 'conv-1')
    expect(rec).toBeTruthy()
    expect(rec.workspacePath).toBe((res as any).workspacePath)
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
    await send({ providerId: 'p1', messages: [{ role: 'user', content: 'x' }] })

    const del = mock.ipc.handlers.get('chat-delete')!
    const res = await del({ conversationId: 'conv-2' })
    expect(res).toEqual({ ok: true })
    const list = mock.ipc.handlers.get('chats-list')!
    const chats = await list({}) as any[]
    expect(chats.some(c => c.conversationId === 'conv-2')).toBe(false)
  })

  it('project-rename 重命名项目并同步当前模型名称', async () => {
    const create = mock.ipc.handlers.get('project-create')!
    const created = await create({ name: '旧名' }) as { model: any }
    const rename = mock.ipc.handlers.get('project-rename')!
    const res = await rename({ id: created.model.id, name: '新名' })
    expect(res).toMatchObject({ ok: true })
    const get = mock.ipc.handlers.get('model-get')!
    const got = await get() as { model: any }
    expect(got.model.name).toBe('新名')
  })

  it('chat-delete 对非空任务文件夹上报 taskDirNonEmpty', async () => {
    mock.services.execute!.execute = vi.fn(async (_req: any, callbacks?: any) => {
      callbacks?.onDone?.({})
      return { conversationId: 'conv-3' }
    }) as any
    mock.services.data!.query = vi.fn(async () => []) as any
    mock.services.data!.mutate = vi.fn(async () => ({})) as any
    const send = mock.ipc.handlers.get('chat-send')!
    const resSend = await send({ providerId: 'p1', messages: [{ role: 'user', content: 'x' }] }) as any
    // 在任务文件夹中写入文件，使其非空
    const fs = await import('node:fs')
    const path = await import('node:path')
    fs.writeFileSync(path.join(resSend.workspacePath, 'note.txt'), 'hello')
    const del = mock.ipc.handlers.get('chat-delete')!
    const res = await del({ conversationId: 'conv-3' }) as any
    expect(res.ok).toBe(true)
    expect(res.taskDirNonEmpty).toBe(true)
    expect(res.taskDir).toBe(resSend.workspacePath)
    // 确认后删除文件夹（chat-delete-task-dir）
    const delDir = mock.ipc.handlers.get('chat-delete-task-dir')!
    const dres = await delDir({ path: res.taskDir }) as any
    expect(dres.ok).toBe(true)
    expect(fs.existsSync(res.taskDir)).toBe(false)
  })

  it('chat-open-dir 打开任务文件夹', async () => {
    mock.services.execute!.execute = vi.fn(async (_req: any, callbacks?: any) => {
      callbacks?.onDone?.({})
      return { conversationId: 'conv-4' }
    }) as any
    mock.services.data!.query = vi.fn(async () => []) as any
    mock.services.data!.mutate = vi.fn(async () => ({})) as any
    const send = mock.ipc.handlers.get('chat-send')!
    const resSend = await send({ providerId: 'p1', messages: [{ role: 'user', content: 'x' }] }) as any
    const openDir = mock.ipc.handlers.get('chat-open-dir')!
    const res = await openDir({ conversationId: 'conv-4' }) as any
    // 任务文件夹已创建，故应返回 ok（shell.openPath 在 mock 下成功调用）
    expect(res.ok).toBe(true)
    expect(typeof (resSend as any).workspacePath).toBe('string')
  })

  it('settings-set 保存 / settings-get 读取', async () => {
    const set = mock.ipc.handlers.get('settings-set')!
    await set({ settings: { defaultProviderId: 'p1', defaultModelId: 'm1' } })
    const get = mock.ipc.handlers.get('settings-get')!
    const res = await get() as { settings: any }
    expect(res.settings.defaultProviderId).toBe('p1')
    expect(res.settings.defaultModelId).toBe('m1')
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
    const res = await handler({ messages: [{ role: 'user', content: 'x' }] })
    expect(res).toMatchObject({ conversationId: 'conv-3' })
    // 应使用默认 provider
    expect(mock.services.execute!.execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'p-default', modelId: 'm1' }),
      expect.anything(),
      expect.anything()
    )
  })
})
