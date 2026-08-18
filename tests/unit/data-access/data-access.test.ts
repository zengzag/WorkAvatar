import { describe, it, expect, vi } from 'vitest'
import { createDataAccessService, type DataAccessDeps } from '../../../electron/main/services/plugin/plugin-data-access'

function makeDeps(overrides: Partial<DataAccessDeps> = {}): DataAccessDeps {
  return {
    workspace: {
      getAllConversationsWithEmployee: vi.fn(() => [{ id: 'c1', title: '对话1' }]),
      getConversation: vi.fn(() => ({ id: 'c1' })),
      createConversation: vi.fn(() => ({ id: 'new-conv' })),
      updateConversation: vi.fn(() => true),
      deleteConversation: vi.fn(() => ({ ok: true })),
      getEmployeeList: vi.fn(() => [{ id: 'e1', name: '员工1' }]),
      getEmployee: vi.fn(() => ({ id: 'e1' })),
      createEmployee: vi.fn(() => ({ id: 'new-emp' })),
      updateEmployee: vi.fn(() => ({ id: 'e1' })),
      deleteEmployee: vi.fn(() => true),
    },
    llm: {
      getProviderList: vi.fn(() => [{ id: 'p1', name: 'Provider', api_key: 'secret' }]),
      getProvider: vi.fn(() => ({ id: 'p1' })),
      createProvider: vi.fn(async () => ({ id: 'new-prov' })),
      updateProvider: vi.fn(async () => ({ id: 'p1' })),
      deleteProvider: vi.fn(async () => true),
    },
    memory: {
      listMemories: vi.fn(() => [{ id: 'm1', content: '记忆1' }]),
      searchMemories: vi.fn(() => [{ id: 'm1' }]),
      createMemory: vi.fn(() => ({ id: 'new-mem' })),
      updateMemory: vi.fn(() => ({ id: 'm1' })),
      deleteMemory: vi.fn(() => true),
      togglePin: vi.fn(() => ({ id: 'm1' })),
    },
    settings: {
      get: vi.fn(() => 'value'),
    },
    ...overrides,
  }
}

describe('createDataAccessService.query', () => {
  it('conversations 查询走 getAllConversationsWithEmployee', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    const rows = await svc.query('conversations', { limit: 10 })
    expect(rows).toEqual([{ id: 'c1', title: '对话1' }])
    expect(deps.workspace.getAllConversationsWithEmployee).toHaveBeenCalledWith({ limit: 10, offset: undefined, employee_ids: undefined })
  })

  it('conversations 支持 employee_ids 过滤', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.query('conversations', { filter: { employeeIds: ['e1', 'e2'] } })
    expect(deps.workspace.getAllConversationsWithEmployee).toHaveBeenCalledWith(
      expect.objectContaining({ employee_ids: ['e1', 'e2'] })
    )
  })

  it('employees 查询走 getEmployeeList', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    const rows = await svc.query('employees')
    expect(rows).toEqual([{ id: 'e1', name: '员工1' }])
  })

  it('llmProviders 查询剥离 api_key', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    const rows = await svc.query('llmProviders')
    expect(rows).toEqual([{ id: 'p1', name: 'Provider' }])
    expect((rows[0] as Record<string, unknown>).api_key).toBeUndefined()
  })

  it('memories 查询需要 employeeId', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.query('memories')).rejects.toThrow('employeeId')
  })

  it('memories 带 query 走 searchMemories', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.query('memories', { filter: { employeeId: 'e1', query: '关键词' } })
    expect(deps.memory.searchMemories).toHaveBeenCalledWith('e1', '关键词', undefined)
  })

  it('memories 无 query 走 listMemories', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.query('memories', { filter: { employeeId: 'e1' } })
    expect(deps.memory.listMemories).toHaveBeenCalledWith('e1')
  })

  it('settings 查询需要 key', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.query('settings')).rejects.toThrow('key')
  })

  it('settings 查询返回单值数组', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    const rows = await svc.query('settings', { filter: { key: 'theme' } })
    expect(rows).toEqual(['value'])
  })

  it('未知实体拒绝', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.query('unknown' as never)).rejects.toThrow('未知数据实体')
  })
})

describe('createDataAccessService.mutate', () => {
  it('conversations create 需要 employeeId', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.mutate('conversations', 'create', {})).rejects.toThrow('employeeId')
  })

  it('conversations create 走 createConversation', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    const result = await svc.mutate('conversations', 'create', { employeeId: 'e1', title: '标题' })
    expect(result).toEqual({ id: 'new-conv' })
    expect(deps.workspace.createConversation).toHaveBeenCalledWith('e1', undefined, '标题', undefined, undefined)
  })

  it('conversations update 需要 id', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.mutate('conversations', 'update', {})).rejects.toThrow('id')
  })

  it('conversations update 剥离 id 后传 data', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.mutate('conversations', 'update', { id: 'c1', title: '新标题' })
    expect(deps.workspace.updateConversation).toHaveBeenCalledWith('c1', { title: '新标题' })
  })

  it('conversations delete 走 deleteConversation', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.mutate('conversations', 'delete', { id: 'c1' })
    expect(deps.workspace.deleteConversation).toHaveBeenCalledWith('c1')
  })

  it('employees create 需要 name', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.mutate('employees', 'create', {})).rejects.toThrow('name')
  })

  it('llmProviders create 走 createProvider', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.mutate('llmProviders', 'create', { name: 'P' })
    expect(deps.llm.createProvider).toHaveBeenCalledWith({ name: 'P' })
  })

  it('memories create 走 createMemory', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.mutate('memories', 'create', { employee_id: 'e1', key: 'k', topic: 't', content: 'c' })
    expect(deps.memory.createMemory).toHaveBeenCalledWith({ employee_id: 'e1', key: 'k', topic: 't', content: 'c' })
  })

  it('settings 只读拒绝写', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.mutate('settings', 'create', {})).rejects.toThrow('只读')
  })

  it('不支持的 op 拒绝', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.mutate('conversations', 'hack' as never, {})).rejects.toThrow('不支持的 conversation 操作')
  })
})

describe('data-access 边界 case', () => {
  it('conversations 查询传 offset', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.query('conversations', { limit: 10, offset: 20 })
    expect(deps.workspace.getAllConversationsWithEmployee).toHaveBeenCalledWith({ limit: 10, offset: 20, employee_ids: undefined })
  })

  it('conversations 查询 employee_ids 过滤非字符串元素', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.query('conversations', { filter: { employeeIds: ['e1', 123, null] } })
    expect(deps.workspace.getAllConversationsWithEmployee).toHaveBeenCalledWith(
      expect.objectContaining({ employee_ids: ['e1'] })
    )
  })

  it('conversations 查询 employee_ids 非数组时忽略', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.query('conversations', { filter: { employeeIds: 'e1' } })
    expect(deps.workspace.getAllConversationsWithEmployee).toHaveBeenCalledWith(
      expect.objectContaining({ employee_ids: undefined })
    )
  })

  it('memories 查询用 employee_id 别名', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.query('memories', { filter: { employee_id: 'e1' } })
    expect(deps.memory.listMemories).toHaveBeenCalledWith('e1')
  })

  it('memories 查询传 limit 给 searchMemories', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.query('memories', { filter: { employeeId: 'e1', query: 'q' }, limit: 5 })
    expect(deps.memory.searchMemories).toHaveBeenCalledWith('e1', 'q', 5)
  })

  it('settings 查询 key 非字符串拒绝', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.query('settings', { filter: { key: 123 } })).rejects.toThrow('key')
  })

  it('llmProviders 查询剥离 api_key（含 null 行）', async () => {
    const deps = makeDeps()
    deps.llm.getProviderList = vi.fn(() => [{ id: 'p1', api_key: 'secret' }, null, 'str'])
    const svc = createDataAccessService(deps)
    const rows = await svc.query('llmProviders')
    expect(rows[0]).toEqual({ id: 'p1' })
    expect(rows[1]).toBeNull()
    expect(rows[2]).toBe('str')
  })

  it('conversations create 用 employee_id 别名', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.mutate('conversations', 'create', { employee_id: 'e1', title: 't' })
    expect(deps.workspace.createConversation).toHaveBeenCalledWith('e1', undefined, 't', undefined, undefined)
  })

  it('conversations create 传完整参数', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.mutate('conversations', 'create', {
      employeeId: 'e1', skillId: 's1', title: 't', minimalMode: true, parentConversationId: 'p1',
    })
    expect(deps.workspace.createConversation).toHaveBeenCalledWith('e1', 's1', 't', true, 'p1')
  })

  it('conversations update 空 payload 仍调用（无 id 校验通过后）', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.mutate('conversations', 'update', { id: 'c1' })
    expect(deps.workspace.updateConversation).toHaveBeenCalledWith('c1', {})
  })

  it('employees create 传完整参数', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.mutate('employees', 'create', { name: 'n', description: 'd', profileJson: 'p', rules: 'r' })
    expect(deps.workspace.createEmployee).toHaveBeenCalledWith('n', 'd', 'p', 'r')
  })

  it('employees delete 传 deleteWorkspace', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.mutate('employees', 'delete', { id: 'e1', deleteWorkspace: true })
    expect(deps.workspace.deleteEmployee).toHaveBeenCalledWith('e1', true)
  })

  it('llmProviders update 剥离 id 后传 data', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await svc.mutate('llmProviders', 'update', { id: 'p1', name: '新名' })
    expect(deps.llm.updateProvider).toHaveBeenCalledWith('p1', { name: '新名' })
  })

  it('llmProviders delete 需要 id', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.mutate('llmProviders', 'delete', {})).rejects.toThrow('id')
  })

  it('memories update 需要 id', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.mutate('memories', 'update', {})).rejects.toThrow('id')
  })

  it('memories delete 需要 id', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.mutate('memories', 'delete', {})).rejects.toThrow('id')
  })

  it('memories 不支持的 op 拒绝', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.mutate('memories', 'hack' as never, {})).rejects.toThrow('不支持的 memory 操作')
  })

  it('employees 不支持的 op 拒绝', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.mutate('employees', 'hack' as never, {})).rejects.toThrow('不支持的 employee 操作')
  })

  it('llmProviders 不支持的 op 拒绝', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.mutate('llmProviders', 'hack' as never, {})).rejects.toThrow('不支持的 llmProvider 操作')
  })

  it('mutate 未知实体拒绝', async () => {
    const deps = makeDeps()
    const svc = createDataAccessService(deps)
    await expect(svc.mutate('unknown' as never, 'create', {})).rejects.toThrow('未知数据实体')
  })
})
