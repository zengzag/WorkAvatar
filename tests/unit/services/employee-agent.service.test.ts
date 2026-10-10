/**
 * EmployeeAgentService 真实实例化测试：
 * agent 创建与缓存（cacheKey 隔离/epoch 失效/并发去重由缓存逻辑保证）、
 * chatStream 编排与回调透传、system 覆盖、极简模式、compact、contextStats、缓存清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { DatabaseSync as DbType } from 'node:sqlite'

const dbState = vi.hoisted(() => ({ db: null as unknown as DbType }))

function createDb(): DbType {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE employees (
      id TEXT PRIMARY KEY, name TEXT, memory_enabled INTEGER DEFAULT 1,
      rules TEXT, profile_json TEXT, delegation_json TEXT,
      description TEXT, workspace_path TEXT
    );
    CREATE TABLE employee_tools (employee_id TEXT, tool_id TEXT, tool_mode TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, created_at INTEGER, system_prompt TEXT);
  `)
  return db
}

const { FakeEmployeeAgent, agentControl } = vi.hoisted(() => {
  const agentControl = { running: false, minimal: false, instances: [] as any[] }

  class FakeEmployeeAgent {
    registerTools = vi.fn()
    setMinimalMode = vi.fn()
    updateMemoryPrompt = vi.fn()
    updateWorkspaceContextPrompt = vi.fn()
    updateTaskTimePrompt = vi.fn()
    updateKBContextPrompt = vi.fn()
    setCachedSystemPrompt = vi.fn()
    getCachedSystemPrompt = vi.fn(() => 'cached-prompt')
    useToolMiddleware = vi.fn()
    getToolRegistry = vi.fn(() => ({}))
    getToolDispatcher = vi.fn(() => ({}))
    isRunning = vi.fn(() => agentControl.running)
    getMinimalMode = vi.fn(() => agentControl.minimal)
    getContextStats = vi.fn(() => ({ contextStats: 1 }))
    runStream = vi.fn(async (_input: any, cbs: any) => cbs.onDone?.({ tokens: 10 }))
    compactConversation = vi.fn(async () => ({ summary: '对话摘要', stats: { compacted: 1 } }))
    constructor() {
      agentControl.instances.push(this)
    }
  }
  return { FakeEmployeeAgent, agentControl }
})

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => dbState.db }) },
}))

const providerConfigValue = {
  provider_type: 'openai',
  base_url: 'https://api.test.com/v1',
  api_key: 'sk-test',
  model: 'gpt-4o',
  models_json: JSON.stringify([{ id: 'm1', model: 'gpt-4o', category: 'chat' }]),
  temperature: 0.7,
  max_tokens: 4096,
  timeout_ms: 60000,
}
vi.mock('../../../electron/main/services/llm-client.service', () => ({
  default: {
    getInstance: () => ({
      getProviderConfig: vi.fn(async () => providerConfigValue),
      getBaseURL: vi.fn(() => 'https://api.test.com/v1'),
    }),
  },
}))

vi.mock('../../../electron/main/services/skill-registry.service', () => ({
  default: { getInstance: () => ({ getEmployeeSkills: vi.fn(() => ({ enabled: [] })) }) },
}))
vi.mock('../../../electron/main/services/employee-memory.service', () => ({
  default: {
    getInstance: () => ({
      buildInjectionMemoryPrompt: vi.fn(() => undefined),
      getRevision: vi.fn(() => 0),
    }),
  },
}))
vi.mock('../../../electron/main/services/mcp-registry.service', () => ({
  default: {
    getInstance: () => ({ buildAgentTools: vi.fn(async () => ({ tools: [], release: vi.fn() })) }),
  },
}))
vi.mock('../../../electron/main/services/workspace-manager.service', () => ({
  default: { getInstance: () => ({ getConversationWorkspacePath: vi.fn(() => '') }) },
}))

vi.mock('../../../electron/main/services/agent/business/employee-agent', () => ({
  EmployeeAgent: FakeEmployeeAgent,
}))

vi.mock('../../../electron/main/services/agent/tools', () => ({
  allBuiltinTools: [{ id: 'builtin_1', name: 'b', description: '', parameters: {}, handler: vi.fn() }],
  createKMSTools: vi.fn(() => [{ id: 'kms_search' }]),
  createKMSCollectionTools: vi.fn(() => [{ id: 'kms_list_collections' }]),
  javascriptExecTool: { id: 'javascript_exec' },
  delegateTool: { id: 'delegate' },
  followupTool: { id: 'followup' },
  launchAgentsTool: { id: 'launch_agents' },
  awaitAgentsTool: { id: 'await_agents' },
  createListAvailableToolsTool: vi.fn(() => ({ id: 'list_available_tools' })),
  createInvokeToolTool: vi.fn(() => ({ id: 'invoke_tool' })),
  runSkillScriptTool: { id: 'run_skill_script' },
}))
vi.mock('../../../electron/main/services/agent/tools/conversation-search.tool', () => ({
  createConversationSearchTool: vi.fn(() => [{ id: 'search_conversations' }]),
}))
vi.mock('../../../electron/main/services/agent/tools/conversation-list.tool', () => ({
  createConversationListTool: vi.fn(() => [{ id: 'list_conversations' }]),
}))
vi.mock('../../../electron/main/services/agent/tools/memory-search.tool', () => ({
  createMemorySearchTool: vi.fn(() => [{ id: 'search_memories' }]),
}))
vi.mock('../../../electron/main/services/agent/llm/provider-compat', () => ({
  resolveImageSupport: vi.fn(() => false),
}))

vi.mock('../../../electron/main/services/llm-logger.service', () => ({
  default: {
    getInstance: () => ({ runWithContext: vi.fn((_ctx: any, fn: () => any) => fn()) }),
  },
}))
vi.mock('../../../electron/main/services/plugin/plugin-host.service', () => ({
  default: {
    getInstance: () => ({
      notifyKernelEvent: vi.fn(),
      notifyAgentEvent: vi.fn(),
      getAgentToolMiddlewares: vi.fn(() => []),
      getAgentTools: vi.fn(() => []),
    }),
  },
}))
vi.mock('../../../electron/main/services/employee-registry.service', () => ({
  default: {
    getInstance: () => ({
      getRegistered: vi.fn(),
      toDBEmployee: vi.fn(),
      isEnabled: vi.fn(() => true),
      getDefaultToolModes: vi.fn(),
      getToolAllowlist: vi.fn(() => null),
    }),
  },
}))
vi.mock('../../../electron/main/services/unified-interaction.service', () => ({
  interactionContext: { getStore: vi.fn(() => undefined) },
}))

import EmployeeAgentService from '../../../electron/main/services/employee-agent.service'

const baseParams = (over: Record<string, any> = {}) => ({
  employee_id: 'e1',
  provider_id: 'p1',
  messages: [
    { role: 'user', content: '历史消息' },
    { role: 'user', content: '用户问题' },
  ],
  ...over,
})

const noopCallbacks = () => ({
  onChunk: vi.fn(),
  onThought: vi.fn(),
  onToolCall: vi.fn(),
  onToolResult: vi.fn(),
  onDone: vi.fn(),
  onError: vi.fn(),
})

beforeEach(() => {
  dbState.db = createDb()
  dbState.db.exec('DELETE FROM employees; DELETE FROM employee_tools; DELETE FROM settings; DELETE FROM conversations')
  dbState.db.prepare("INSERT INTO employees (id, name, memory_enabled) VALUES ('e1','小明',1)").run()
  ;(EmployeeAgentService as any).instance = undefined
  agentControl.instances.length = 0
  agentControl.running = false
  agentControl.minimal = false
})

afterEach(() => {
  ;(EmployeeAgentService as any).instance = undefined
  vi.restoreAllMocks()
})

describe('isMemoryEnabled', () => {
  it('DB 员工：按 memory_enabled 判定', () => {
    const svc = EmployeeAgentService.getInstance()
    expect(svc.isMemoryEnabled('e1')).toBe(true)
    dbState.db.prepare("UPDATE employees SET memory_enabled=0 WHERE id='e1'").run()
    expect(svc.isMemoryEnabled('e1')).toBe(false)
  })

  it('员工与注册记录均不存在：false', () => {
    expect(EmployeeAgentService.getInstance().isMemoryEnabled('nobody')).toBe(false)
  })
})

describe('全局委托开关（delegation_enabled）', () => {
  const registeredToolIds = () => {
    const agent = agentControl.instances.at(-1)!
    return agent.registerTools.mock.calls.flat().flatMap((list: any[]) => (list || []).map((t: any) => t.id))
  }

  it('默认（未设置）：注册委托类工具', async () => {
    await EmployeeAgentService.getInstance().chatStream(baseParams(), noopCallbacks())
    expect(registeredToolIds()).toContain('delegate')
    expect(registeredToolIds()).toContain('launch_agents')
  })

  it('全局关闭：不注册任何委托类工具（提示词随之不含委托段）', async () => {
    dbState.db.prepare("INSERT INTO settings (key, value) VALUES ('delegation_enabled','0')").run()
    await EmployeeAgentService.getInstance().chatStream(baseParams(), noopCallbacks())
    expect(registeredToolIds()).not.toContain('delegate')
    expect(registeredToolIds()).not.toContain('launch_agents')
    expect(registeredToolIds()).not.toContain('followup')
  })

  it('极简模式：不注册任何委托类工具（不传工具、不注入能力段）', async () => {
    await EmployeeAgentService.getInstance().chatStream(baseParams({ minimal_mode: true }), noopCallbacks())
    expect(registeredToolIds()).not.toContain('delegate')
    expect(registeredToolIds()).not.toContain('launch_agents')
  })
})

describe('chatStream', () => {
  it('完整编排：agent 被创建，runStream 收到 query/history，onDone 透传元数据', async () => {
    const callbacks = noopCallbacks()
    await EmployeeAgentService.getInstance().chatStream(baseParams(), callbacks)

    expect(agentControl.instances).toHaveLength(1)
    const agent = agentControl.instances[0]
    expect(agent.runStream).toHaveBeenCalledTimes(1)
    const [streamInput] = agent.runStream.mock.calls[0]
    expect(streamInput.query).toBe('用户问题')
    expect(streamInput.history).toHaveLength(1)

    expect(callbacks.onDone).toHaveBeenCalledWith({ tokens: 10 })
  })

  it('再次调用命中缓存：不重复创建 agent', async () => {
    const svc = EmployeeAgentService.getInstance()
    await svc.chatStream(baseParams(), noopCallbacks())
    await svc.chatStream(baseParams(), noopCallbacks())

    expect(agentControl.instances).toHaveLength(1)
  })

  it('system 覆盖：经 runStream systemPromptOverride 传递，不写入 agent 缓存', async () => {
    await EmployeeAgentService.getInstance().chatStream(
      baseParams({ system: '自定义系统提示词' }),
      noopCallbacks()
    )
    const agent = agentControl.instances[0]
    const [streamInput] = agent.runStream.mock.calls[0]
    expect(streamInput.systemPromptOverride).toBe('自定义系统提示词')
    // 不写缓存：避免插件提示词污染会话（缓存泄漏进下一轮并可能被持久化）
    expect(agent.setCachedSystemPrompt).not.toHaveBeenCalledWith('自定义系统提示词')
  })

  it('极简模式：prepareSystemPrompt 收到 agent.getMinimalMode()=true，KB 上下文被清空', async () => {
    agentControl.minimal = true
    await EmployeeAgentService.getInstance().chatStream(
      baseParams({ minimal_mode: true }),
      noopCallbacks()
    )
    const agent = agentControl.instances[0]
    expect(agent.getMinimalMode()).toBe(true)
    expect(agent.updateKBContextPrompt).toHaveBeenCalledWith(undefined)
  })

  it('runStream 抛错时错误向上传播', async () => {
    const callbacks = noopCallbacks()
    const svc = EmployeeAgentService.getInstance()
    await svc.chatStream(baseParams(), callbacks)
    // 第二次调用命中缓存，令其 runStream 失败
    agentControl.instances[0].runStream.mockRejectedValueOnce(new Error('stream boom'))
    await expect(svc.chatStream(baseParams(), callbacks)).rejects.toThrow('stream boom')
  })
})

describe('bumpToolEpoch / 缓存失效', () => {
  it('epoch 递增后，非运行中的旧缓存被丢弃重建', async () => {
    const svc = EmployeeAgentService.getInstance()
    await svc.chatStream(baseParams(), noopCallbacks())
    expect(agentControl.instances).toHaveLength(1)

    svc.bumpToolEpoch()
    await svc.chatStream(baseParams(), noopCallbacks())
    expect(agentControl.instances).toHaveLength(2)
  })

  it('agent 运行中：epoch 变更不丢弃，沿用旧实例', async () => {
    const svc = EmployeeAgentService.getInstance()
    await svc.chatStream(baseParams(), noopCallbacks())

    svc.bumpToolEpoch()
    agentControl.running = true
    await svc.chatStream(baseParams(), noopCallbacks())
    expect(agentControl.instances).toHaveLength(1)
    agentControl.running = false
  })
})

describe('clearAgentCache', () => {
  it('清除指定员工的缓存；运行中的跳过', async () => {
    const svc = EmployeeAgentService.getInstance()
    await svc.chatStream(baseParams(), noopCallbacks())

    agentControl.running = true
    svc.clearAgentCache('e1')
    agentControl.running = false
    // 运行中未清除：再调用仍同实例
    await svc.chatStream(baseParams(), noopCallbacks())
    expect(agentControl.instances).toHaveLength(1)

    svc.clearAgentCache('e1')
    await svc.chatStream(baseParams(), noopCallbacks())
    expect(agentControl.instances).toHaveLength(2)
  })
})

describe('compactConversation / getContextStats', () => {
  it('compactConversation：返回 agent 的摘要与统计', async () => {
    const r = await EmployeeAgentService.getInstance().compactConversation(baseParams())
    expect(r.summary).toBe('对话摘要')
    expect(r.stats).toEqual({ compacted: 1 })
  })

  it('getContextStats：无 agent 返回 null；有则返回统计', async () => {
    const svc = EmployeeAgentService.getInstance()
    expect(svc.getContextStats({ employee_id: 'e1', provider_id: 'p1' })).toBeNull()

    await svc.chatStream(baseParams(), noopCallbacks())
    expect(svc.getContextStats({ employee_id: 'e1', provider_id: 'p1' })).toEqual({ contextStats: 1 })
  })
})
