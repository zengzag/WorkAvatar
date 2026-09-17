/**
 * MCP 注册中心单测（database/mcp-client 打桩，内存表模拟 employee_mcp_servers）：
 * - 配置校验（名称/传输方式/command/URL 合法性）
 * - CRUD 与归属校验（跨员工更新/删除/启停拒绝）
 * - 工具命名约定 mcp_<serverId前8位>_<原始名>（含非法字符清洗、前缀冲突暴露）
 * - buildAgentTools 的失败容忍、引用计数与 release 语义、生命周期清理
 * - 工具结果格式化与 MCP isError 语义
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockState = vi.hoisted(() => {
  const table = new Map<string, any>()
  const clients: any[] = []
  const mcpTestResult: { value: any } = { value: { success: true, tools: [] } }
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

  const db = {
    prepare(sql: string) {
      const s = norm(sql)
      if (s === 'SELECT * FROM employee_mcp_servers WHERE employee_id = ? ORDER BY created_at ASC') {
        return { all: (empId: string) => [...table.values()].filter(r => r.employee_id === empId) }
      }
      if (s === 'SELECT * FROM employee_mcp_servers WHERE employee_id = ? AND is_enabled = 1') {
        return { all: (empId: string) => [...table.values()].filter(r => r.employee_id === empId && r.is_enabled === 1) }
      }
      if (s === 'SELECT * FROM employee_mcp_servers WHERE id = ?') {
        return { get: (id: string) => (table.has(id) ? table.get(id) : undefined) }
      }
      if (s.startsWith('INSERT INTO employee_mcp_servers')) {
        return {
          run: (...a: any[]) => {
            table.set(a[0], {
              id: a[0], employee_id: a[1], name: a[2], transport_type: a[3],
              command: a[4], args_json: a[5], env_json: a[6], url: a[7], headers_json: a[8],
              is_enabled: a[9], status: 'unknown', last_error: null, tools_json: '[]',
              created_at: a[10], updated_at: a[11],
            })
            return { changes: 1 }
          },
        }
      }
      if (s.startsWith('UPDATE employee_mcp_servers SET name = ?')) {
        return {
          run: (...a: any[]) => {
            const row = table.get(a[8])
            if (!row) return { changes: 0 }
            Object.assign(row, {
              name: a[0], transport_type: a[1], command: a[2], args_json: a[3], env_json: a[4],
              url: a[5], headers_json: a[6], status: 'unknown', last_error: null, updated_at: a[7],
            })
            return { changes: 1 }
          },
        }
      }
      if (s.startsWith('UPDATE employee_mcp_servers SET is_enabled = ?')) {
        return {
          run: (...a: any[]) => {
            const row = table.get(a[2])
            if (!row) return { changes: 0 }
            row.is_enabled = a[0]
            row.updated_at = a[1]
            return { changes: 1 }
          },
        }
      }
      if (s.startsWith('UPDATE employee_mcp_servers SET status = ')) {
        const connected = s.includes("status = 'connected'")
        return {
          run: (...a: any[]) => {
            const row = table.get(a[2])
            if (!row) return { changes: 0 }
            if (connected) {
              row.status = 'connected'
              row.last_error = null
              row.tools_json = a[0]
            } else {
              row.status = 'error'
              row.last_error = a[0]
            }
            row.updated_at = a[1]
            return { changes: 1 }
          },
        }
      }
      if (s === 'DELETE FROM employee_mcp_servers WHERE id = ?') {
        return { run: (id: string) => ({ changes: table.delete(id) ? 1 : 0 }) }
      }
      throw new Error(`unexpected sql: ${s}`)
    },
  }

  const createMcpClient = vi.fn()
  const testMcpServer = vi.fn()

  return { table, clients, mcpTestResult, db, createMcpClient, testMcpServer }
})

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => mockState.db }) },
}))

vi.mock('../../../electron/main/services/mcp-client.service', () => ({
  createMcpClient: mockState.createMcpClient,
  testMcpServer: mockState.testMcpServer,
}))

import McpRegistryService from '../../../electron/main/services/mcp-registry.service'
import type { McpServerConfig } from '../../../electron/shared/channels/mcp'

const service = McpRegistryService.getInstance()
const priv = service as any

function makeClient(tools: any[] = [], callTool?: (name: string, args: any) => Promise<any>) {
  const client = {
    initialize: vi.fn(async () => undefined),
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(callTool ?? (async () => ({ content: [], raw: null, isError: false }))),
    close: vi.fn(async () => undefined),
    getServerInfo: vi.fn(() => ({ name: 'mock', version: '1.0.0' })),
    getProtocolVersion: vi.fn(() => '2024-11-05'),
  }
  mockState.clients.push(client)
  return client
}

/** 让后续每次 createMcpClient 都返回携带指定工具清单的 client */
function mockClientsWith(tools: any[]): void {
  mockState.createMcpClient.mockImplementation(() => makeClient(tools))
}

function seedServer(overrides: Partial<Record<string, any>> = {}) {
  const id = overrides.id ?? 'abcdefgh12345678'
  mockState.table.set(id, {
    id,
    employee_id: overrides.employee_id ?? 'emp-1',
    name: overrides.name ?? 'Server',
    transport_type: overrides.transport_type ?? 'stdio',
    command: overrides.command ?? 'node',
    args_json: overrides.args_json ?? '[]',
    env_json: overrides.env_json ?? '{}',
    url: overrides.url ?? null,
    headers_json: overrides.headers_json ?? '{}',
    is_enabled: overrides.is_enabled ?? 1,
    status: overrides.status ?? 'unknown',
    last_error: overrides.last_error ?? null,
    tools_json: overrides.tools_json ?? '[]',
    created_at: overrides.created_at ?? 1,
    updated_at: overrides.updated_at ?? 1,
  })
  return mockState.table.get(id)
}

function stdioConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name: 'Server', transport_type: 'stdio', command: 'node', ...overrides }
}

function lastClient() {
  return mockState.clients[mockState.clients.length - 1]
}

const TOOL = { name: 't', description: '', inputSchema: { type: 'object' } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  mockState.table.clear()
  mockState.clients.length = 0
  mockState.mcpTestResult.value = { success: true, tools: [] }
  mockState.createMcpClient.mockReset()
  mockState.createMcpClient.mockImplementation(() => makeClient([]))
  mockState.testMcpServer.mockReset()
  mockState.testMcpServer.mockImplementation(async () => mockState.mcpTestResult.value)
})

afterEach(async () => {
  await service.shutdownAll()
  vi.useRealTimers()
})

describe('mcp-registry / 配置校验', () => {
  it('名称为空或纯空白被拒绝', () => {
    for (const name of ['', '   ']) {
      expect(() => service.add({ employee_id: 'emp-1', config: stdioConfig({ name }) })).toThrow('MCP server 名称不能为空')
    }
    expect(mockState.table.size).toBe(0)
  })

  it('缺少传输方式被拒绝', () => {
    expect(() =>
      service.add({ employee_id: 'emp-1', config: { name: 'x', transport_type: '' as any } }),
    ).toThrow('传输方式不能为空')
  })

  it('stdio 缺少 command / command 纯空白被拒绝', () => {
    for (const command of [undefined, '', '   ']) {
      expect(() => service.add({ employee_id: 'emp-1', config: stdioConfig({ command }) })).toThrow(
        'stdio 模式必须指定 command',
      )
    }
  })

  it('HTTP/SSE 缺少 URL 被拒绝', () => {
    for (const transport_type of ['streamableHttp', 'sse'] as const) {
      expect(() =>
        service.add({ employee_id: 'emp-1', config: { name: 'x', transport_type } }),
      ).toThrow('必须指定 URL')
    }
  })

  it('URL 非法被拒绝', () => {
    expect(() =>
      service.add({ employee_id: 'emp-1', config: { name: 'x', transport_type: 'sse', url: 'not a url' } }),
    ).toThrow('URL 格式不合法')
  })

  it('未知传输方式被拒绝', () => {
    expect(() =>
      service.add({ employee_id: 'emp-1', config: { name: 'x', transport_type: 'websocket' as any } }),
    ).toThrow('不支持的传输方式: websocket')
  })

  it('合法的 sse / streamableHttp 配置可保存', () => {
    const a = service.add({ employee_id: 'emp-1', config: { name: 'SSE', transport_type: 'sse', url: 'https://x.test/sse' } })
    const b = service.add({ employee_id: 'emp-1', config: { name: 'HTTP', transport_type: 'streamableHttp', url: 'https://x.test/mcp' } })
    expect(a.transport_type).toBe('sse')
    expect(b.transport_type).toBe('streamableHttp')
  })
})

describe('mcp-registry / CRUD', () => {
  it('add 规范化字段与默认值，且不主动建立连接', () => {
    const info = service.add({ employee_id: 'emp-1', config: stdioConfig({ name: '  My Server  ' }) })
    expect(info.name).toBe('My Server')
    expect(info.args).toEqual([])
    expect(info.env).toEqual({})
    expect(info.headers).toEqual({})
    expect(info.is_enabled).toBe(true)
    expect(info.status).toBe('unknown')
    expect(info.tools).toEqual([])
    expect(priv.activeClients.size).toBe(0)
    expect(mockState.createMcpClient).not.toHaveBeenCalled()
  })

  it('add 支持 is_enabled=false 与显式 args/env/headers', () => {
    const info = service.add({
      employee_id: 'emp-1',
      config: stdioConfig({ is_enabled: false, args: ['-y', 'pkg'], env: { TOKEN: 't' }, headers: { 'X-A': '1' } }),
    })
    expect(info.is_enabled).toBe(false)
    expect(info.args).toEqual(['-y', 'pkg'])
    expect(info.env).toEqual({ TOKEN: 't' })
    expect(info.headers).toEqual({ 'X-A': '1' })
  })

  it('listByEmployee 只返回该员工的记录', () => {
    service.add({ employee_id: 'emp-1', config: stdioConfig({ name: 'A' }) })
    service.add({ employee_id: 'emp-2', config: stdioConfig({ name: 'B' }) })
    expect(service.listByEmployee('emp-1').map(s => s.name)).toEqual(['A'])
    expect(service.listByEmployee('emp-2').map(s => s.name)).toEqual(['B'])
    expect(service.listByEmployee('none')).toEqual([])
  })

  it('update 缺 id / 记录不存在 / 归属不符均拒绝', () => {
    expect(() => service.update({ employee_id: 'emp-1', config: stdioConfig() })).toThrow('缺少 id')
    expect(() => service.update({ employee_id: 'emp-1', config: stdioConfig({ id: 'nope' }) })).toThrow(
      '不存在或不属于该员工',
    )

    const created = service.add({ employee_id: 'emp-2', config: stdioConfig({ name: 'X' }) })
    expect(() =>
      service.update({ employee_id: 'emp-1', config: { ...stdioConfig({ name: 'X2' }), id: created.id } }),
    ).toThrow('不存在或不属于该员工')
  })

  it('update 覆盖字段并重置状态与错误', () => {
    const created = service.add({ employee_id: 'emp-1', config: stdioConfig({ name: 'Old' }) })
    mockState.table.get(created.id)!.status = 'error'
    mockState.table.get(created.id)!.last_error = 'boom'

    const updated = service.update({
      employee_id: 'emp-1',
      config: { id: created.id, name: 'New', transport_type: 'stdio', command: 'python', args: ['a.py'] },
    })
    expect(updated.name).toBe('New')
    expect(updated.command).toBe('python')
    expect(updated.args).toEqual(['a.py'])
    expect(updated.status).toBe('unknown')
    expect(updated.last_error).toBeUndefined()
  })

  it('delete 带归属校验时跨员工删除被拒绝', () => {
    const created = service.add({ employee_id: 'emp-1', config: stdioConfig() })
    expect(() => service.delete(created.id, 'emp-2')).toThrow('不存在或不属于该员工')
    expect(service.getById(created.id)).not.toBeNull()
  })

  it('delete 归属匹配 / 不带归属校验时均删除', () => {
    const a = service.add({ employee_id: 'emp-1', config: stdioConfig() })
    expect(service.delete(a.id, 'emp-1')).toEqual({ success: true })
    expect(service.getById(a.id)).toBeNull()

    const b = service.add({ employee_id: 'emp-1', config: stdioConfig() })
    expect(service.delete(b.id)).toEqual({ success: true })
    expect(service.getById(b.id)).toBeNull()
  })

  it('toggle 带归属校验与状态写入', () => {
    const created = service.add({ employee_id: 'emp-1', config: stdioConfig() })
    expect(() => service.toggle(created.id, false, 'emp-2')).toThrow('不存在或不属于该员工')
    expect(service.toggle(created.id, false, 'emp-1').is_enabled).toBe(false)
    expect(service.toggle(created.id, true).is_enabled).toBe(true)
  })

  it('rowToInfo 对损坏的 JSON 字段回落默认值', () => {
    seedServer({ id: 'broken', args_json: '{oops', env_json: 'not json', headers_json: '', tools_json: '[]x' })
    const info = service.getById('broken')!
    expect(info.args).toEqual([])
    expect(info.env).toEqual({})
    expect(info.headers).toEqual({})
    expect(info.tools).toEqual([])
  })

  it('rowToInfo 空 command / url 归一为 undefined', () => {
    seedServer({ id: 'empty-fields', command: '', url: '' })
    const info = service.getById('empty-fields')!
    expect(info.command).toBeUndefined()
    expect(info.url).toBeUndefined()
  })
})

describe('mcp-registry / 工具命名与注入', () => {
  it('工具名为 mcp_<serverId前8位>_<原始名>，非法字符替换为下划线', async () => {
    seedServer({ id: 'abcdefgh00000000', name: 'S1' })
    mockClientsWith([
      { name: 'search.web', description: 'd', inputSchema: { type: 'object' } },
      { name: 'a b/c', description: '', inputSchema: null },
    ])
    const { tools } = await service.buildAgentTools('emp-1')
    expect(tools.map(t => t.name)).toEqual(['mcp_abcdefgh_search_web', 'mcp_abcdefgh_a_b_c'])
    expect(tools[0].title).toBe('[S1] search.web')
    expect(tools[0].source).toBe('dynamic')
    expect(tools[0].permission).toBe('safe')
    expect(tools[0].timeoutMs).toBe(120000)
    expect(tools[0].metadata).toEqual({
      mcpServerId: 'abcdefgh00000000',
      mcpServerName: 'S1',
      mcpToolName: 'search.web',
    })
  })

  it('前缀冲突：前 8 位相同的两个 server 会产生完全同名的工具（命名冲突面）', async () => {
    seedServer({ id: 'abcdefgh111111111111', name: 'S1' })
    seedServer({ id: 'abcdefgh222222222222', name: 'S2' })
    mockClientsWith([{ name: 'search', description: '', inputSchema: { type: 'object' } }])
    const { tools } = await service.buildAgentTools('emp-1')
    expect(tools).toHaveLength(2)
    expect(tools[0].name).toBe('mcp_abcdefgh_search')
    expect(tools[0].name).toBe(tools[1].name)
  })

  it('工具描述：空描述仅保留来源，非空描述追加换行来源', async () => {
    seedServer({ id: 'desc000000000001', name: 'S' })
    mockClientsWith([
      { name: 'empty', description: '', inputSchema: { type: 'object' } },
      { name: 'ws', description: '   ', inputSchema: { type: 'object' } },
      { name: 'text', description: '做某事', inputSchema: { type: 'object' } },
    ])
    const { tools } = await service.buildAgentTools('emp-1')
    expect(tools[0].description).toBe('MCP 来源：S')
    expect(tools[1].description).toBe('（MCP 来源：S）')
    expect(tools[2].description).toBe('做某事\n（MCP 来源：S）')
  })

  it('inputSchema 规范化：缺失/非对象 → 空对象 schema；required 非数组 → undefined', async () => {
    seedServer({ id: 'schema0000000001', name: 'S' })
    mockClientsWith([
      { name: 'a', description: '', inputSchema: null },
      { name: 'b', description: '', inputSchema: 'nope' },
      { name: 'c', description: '', inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: 'x' } },
    ])
    const { tools } = await service.buildAgentTools('emp-1')
    expect(tools[0].parameters).toEqual({ type: 'object', properties: {} })
    expect(tools[1].parameters).toEqual({ type: 'object', properties: {} })
    expect(tools[2].parameters).toEqual({ type: 'object', properties: { x: { type: 'string' } }, required: undefined })
  })

  it('禁用的 server 不参与注入', async () => {
    seedServer({ id: 'enabled000000000', is_enabled: 1 })
    seedServer({ id: 'disabled00000000', is_enabled: 0 })
    mockClientsWith([TOOL])
    const { tools } = await service.buildAgentTools('emp-1')
    expect(tools).toHaveLength(1)
    expect(mockState.createMcpClient).toHaveBeenCalledTimes(1)
  })

  it('listTools 失败：跳过该 server、标记 error，release 不重复释放引用', async () => {
    seedServer({ id: 'failing000000000', name: 'Bad' })
    mockState.createMcpClient.mockImplementation(() => {
      const client = makeClient([])
      client.listTools.mockRejectedValue(new Error('list boom'))
      return client
    })
    const { tools, release } = await service.buildAgentTools('emp-1')
    expect(tools).toEqual([])
    const row = mockState.table.get('failing000000000')
    expect(row.status).toBe('error')
    expect(row.last_error).toBe('list boom')
    // 失败时已释放一次引用（refCount 归零），release() 不应再释放导致负计数/多余 close
    await release()
    expect(lastClient().close).not.toHaveBeenCalled()
    expect(priv.activeClients.get('failing000000000').refCount).toBe(0)
  })

  it('createMcpClient 抛错时隔离该 server，不影响其他 server', async () => {
    seedServer({ id: 'good000000000000', name: 'Good' })
    seedServer({ id: 'bad0000000000000', name: 'Bad' })
    mockState.createMcpClient.mockImplementation((config: McpServerConfig) => {
      if (config.name === 'Bad') throw new Error('spawn failed')
      return makeClient([TOOL])
    })
    const { tools } = await service.buildAgentTools('emp-1')
    expect(tools).toHaveLength(1)
    const bad = mockState.table.get('bad0000000000000')
    expect(bad.status).toBe('error')
    expect(bad.last_error).toBe('spawn failed')
  })

  it('顺序复用：同一 server 第二次构建复用 client 并累加引用计数', async () => {
    seedServer({ id: 'reuse00000000000' })
    mockClientsWith([TOOL])
    const a = await service.buildAgentTools('emp-1')
    const b = await service.buildAgentTools('emp-1')
    expect(mockState.createMcpClient).toHaveBeenCalledTimes(1)
    expect(a.tools).toHaveLength(1)
    expect(b.tools).toHaveLength(1)
    expect(priv.activeClients.get('reuse00000000000').refCount).toBe(2)

    await a.release()
    expect(priv.activeClients.get('reuse00000000000').refCount).toBe(1)
    expect(lastClient().close).not.toHaveBeenCalled()
    await b.release()
    expect(priv.activeClients.get('reuse00000000000').refCount).toBe(0)
    expect(priv.activeClients.get('reuse00000000000').idleTimer).not.toBeNull()
  })

  it('并发构建同一 server 复用进行中的创建 Promise：只 spawn 一次且引用计数正确', async () => {
    seedServer({ id: 'concurrent000000' })
    mockClientsWith([TOOL])
    const [a, b] = await Promise.all([service.buildAgentTools('emp-1'), service.buildAgentTools('emp-1')])
    // in-flight 去重生效 → 不会重复 spawn
    expect(mockState.createMcpClient).toHaveBeenCalledTimes(1)
    expect(a.tools).toHaveLength(1)
    expect(b.tools).toHaveLength(1)
    const entry = priv.activeClients.get('concurrent000000')
    expect(entry.client).toBe(mockState.clients[0])
    // 两次构建各自持有一个引用
    expect(entry.refCount).toBe(2)

    await a.release()
    expect(entry.refCount).toBe(1)
    await b.release()
    expect(entry.refCount).toBe(0)
    expect(mockState.clients[0].close).not.toHaveBeenCalled()
  })

  it('创建失败时清理 in-flight 记录，后续构建可重新创建', async () => {
    seedServer({ id: 'failflight000000' })
    mockState.createMcpClient.mockImplementationOnce(() => {
      throw new Error('spawn boom')
    })
    await service.buildAgentTools('emp-1')
    expect(priv.clientCreationInFlight.size).toBe(0)
    expect(mockState.table.get('failflight000000').status).toBe('error')

    mockClientsWith([TOOL])
    const { tools } = await service.buildAgentTools('emp-1')
    expect(tools).toHaveLength(1)
    expect(mockState.createMcpClient).toHaveBeenCalledTimes(2)
  })

  it('引用归零后空闲 10 分钟自动关闭 client', async () => {
    seedServer({ id: 'idle000000000000' })
    mockClientsWith([TOOL])
    vi.useFakeTimers()
    const { release } = await service.buildAgentTools('emp-1')
    await release()
    expect(priv.activeClients.get('idle000000000000').idleTimer).not.toBeNull()

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1)
    expect(priv.activeClients.has('idle000000000000')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(priv.activeClients.has('idle000000000000')).toBe(false)
    expect(lastClient().close).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('成功注入时同步状态与工具缓存', async () => {
    seedServer({ id: 'sync000000000000' })
    mockClientsWith([TOOL])
    await service.buildAgentTools('emp-1')
    const row = mockState.table.get('sync000000000000')
    expect(row.status).toBe('connected')
    expect(row.last_error).toBeNull()
    expect(JSON.parse(row.tools_json)).toHaveLength(1)
  })
})

describe('mcp-registry / 工具调用与结果格式化', () => {
  async function injectTool() {
    seedServer({ id: 'invoke0000000000', name: 'S' })
    mockClientsWith([{ name: 'do', description: '', inputSchema: { type: 'object' } }])
    const { tools } = await service.buildAgentTools('emp-1')
    return tools[0]
  }

  it('调用成功：仅文本内容直接返回拼接字符串', async () => {
    const tool = await injectTool()
    lastClient().callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }],
      raw: null,
      isError: false,
    })
    await expect(tool.handler({}, {} as any)).resolves.toBe('line1\nline2')
    expect(lastClient().callTool).toHaveBeenCalledWith('do', {})
  })

  it('handler 无参时以空对象调用', async () => {
    const tool = await injectTool()
    lastClient().callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], raw: null, isError: false })
    await tool.handler(undefined as any, {} as any)
    expect(lastClient().callTool).toHaveBeenCalledWith('do', {})
  })

  it('含非文本内容时返回结构化对象', async () => {
    const tool = await injectTool()
    lastClient().callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'cap' }, { type: 'image', data: 'base64' }],
      raw: { raw: true },
      isError: false,
    })
    await expect(tool.handler({}, {} as any)).resolves.toEqual({
      text: 'cap',
      other: [{ type: 'image', data: 'base64' }],
      raw: { raw: true },
    })
  })

  it('内容为空时返回 raw 序列化结果', async () => {
    const tool = await injectTool()
    lastClient().callTool.mockResolvedValue({ content: [], raw: 'plain', isError: false })
    await expect(tool.handler({}, {} as any)).resolves.toBe('plain')

    lastClient().callTool.mockResolvedValue({ content: null, raw: { a: 1 }, isError: false })
    await expect(tool.handler({}, {} as any)).resolves.toBe('{"a":1}')
  })

  it('isError=true 时抛出 content 中文本拼接的错误', async () => {
    const tool = await injectTool()
    lastClient().callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'boom-a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'boom-b' }],
      raw: null,
      isError: true,
    })
    await expect(tool.handler({}, {} as any)).rejects.toThrow('boom-a\nboom-b')
  })

  it('isError=true 且无文本时抛出兜底错误信息', async () => {
    const tool = await injectTool()
    lastClient().callTool.mockResolvedValue({ content: [{ type: 'image' }], raw: null, isError: true })
    await expect(tool.handler({}, {} as any)).rejects.toThrow('MCP 工具 do 调用失败')
  })

  it('client 已关闭后调用报"未连接"', async () => {
    const tool = await injectTool()
    await priv.closeActiveClient('invoke0000000000')
    await expect(tool.handler({}, {} as any)).rejects.toThrow('未连接')
  })

  it('callTool 抛错原样向上传递', async () => {
    const tool = await injectTool()
    lastClient().callTool.mockRejectedValue(new Error('transport closed'))
    await expect(tool.handler({}, {} as any)).rejects.toThrow('transport closed')
  })
})

describe('mcp-registry / 连接测试与生命周期', () => {
  it('testConnection 透传 testMcpServer 结果', async () => {
    mockState.mcpTestResult.value = { success: true, tools: [TOOL] }
    await expect(service.testConnection(stdioConfig())).resolves.toMatchObject({ success: true })
  })

  it('refreshTools：server 不存在返回失败', async () => {
    await expect(service.refreshTools('nope')).resolves.toEqual({ success: false, error: 'MCP server 不存在' })
  })

  it('refreshTools 成功：状态 connected 且工具缓存落库', async () => {
    seedServer({ id: 'refresh0000000000' })
    mockState.mcpTestResult.value = { success: true, tools: [TOOL] }
    const r = await service.refreshTools('refresh0000000000')
    expect(r.success).toBe(true)
    const row = mockState.table.get('refresh0000000000')
    expect(row.status).toBe('connected')
    expect(row.last_error).toBeNull()
    expect(JSON.parse(row.tools_json)).toHaveLength(1)
  })

  it('refreshTools 失败：状态 error 且错误信息截断到 1000 字符', async () => {
    seedServer({ id: 'refresh-fail00000' })
    mockState.mcpTestResult.value = { success: false, error: 'e'.repeat(5000) }
    const r = await service.refreshTools('refresh-fail00000')
    expect(r.success).toBe(false)
    const row = mockState.table.get('refresh-fail00000')
    expect(row.status).toBe('error')
    expect(row.last_error.length).toBe(1000)
  })

  it('refreshTools 先关闭旧活跃 client 再重连', async () => {
    seedServer({ id: 'refresh-close0000' })
    mockClientsWith([TOOL])
    await service.buildAgentTools('emp-1')
    const client = lastClient()
    await service.refreshTools('refresh-close0000')
    expect(client.close).toHaveBeenCalled()
  })

  it('toggle 禁用关闭活跃 client，启用不主动连接', async () => {
    seedServer({ id: 'toggle0000000000' })
    mockClientsWith([TOOL])
    await service.buildAgentTools('emp-1')
    const client = lastClient()
    mockState.createMcpClient.mockClear()

    service.toggle('toggle0000000000', false)
    await Promise.resolve()
    expect(client.close).toHaveBeenCalled()

    service.toggle('toggle0000000000', true)
    await Promise.resolve()
    expect(mockState.createMcpClient).not.toHaveBeenCalled()
  })

  it('delete 关闭活跃 client', async () => {
    seedServer({ id: 'delete0000000000' })
    mockClientsWith([TOOL])
    await service.buildAgentTools('emp-1')
    const client = lastClient()
    service.delete('delete0000000000')
    await Promise.resolve()
    expect(client.close).toHaveBeenCalled()
  })

  it('update 关闭活跃 client 以强制重连', async () => {
    seedServer({ id: 'update0000000000' })
    mockClientsWith([TOOL])
    await service.buildAgentTools('emp-1')
    const client = lastClient()
    service.update({
      employee_id: 'emp-1',
      config: { id: 'update0000000000', name: 'S2', transport_type: 'stdio', command: 'node' },
    })
    await Promise.resolve()
    expect(client.close).toHaveBeenCalled()
  })

  it('shutdownAll 关闭全部活跃 client 且可重复调用', async () => {
    seedServer({ id: 'shut000000000000' })
    seedServer({ id: 'shut200000000000' })
    mockClientsWith([TOOL])
    await service.buildAgentTools('emp-1')
    expect(priv.activeClients.size).toBe(2)
    await service.shutdownAll()
    expect(priv.activeClients.size).toBe(0)
    expect(mockState.clients[0].close).toHaveBeenCalled()
    expect(mockState.clients[1].close).toHaveBeenCalled()
    await expect(service.shutdownAll()).resolves.toBeUndefined()
  })

  it('client.close 抛错不影响关闭流程（记录日志后继续）', async () => {
    seedServer({ id: 'closeerr00000000' })
    mockState.createMcpClient.mockImplementation(() => {
      const client = makeClient([TOOL])
      client.close.mockRejectedValue(new Error('close failed'))
      return client
    })
    await service.buildAgentTools('emp-1')
    await expect(service.shutdownAll()).resolves.toBeUndefined()
    expect(priv.activeClients.size).toBe(0)
  })

  it('release 可安全重复调用', async () => {
    seedServer({ id: 'rel000000000000' })
    mockClientsWith([TOOL])
    const { release } = await service.buildAgentTools('emp-1')
    await release()
    await expect(release()).resolves.toBeUndefined()
    expect(priv.activeClients.get('rel000000000000').refCount).toBe(0)
  })

  it('releaseClient 对不存在的 server 是空操作', async () => {
    await expect(priv.releaseClient('never')).resolves.toBeUndefined()
  })

  it('getActiveClient 对未知 server 返回 null', async () => {
    await expect(priv.getActiveClient('never')).resolves.toBeNull()
  })
})
