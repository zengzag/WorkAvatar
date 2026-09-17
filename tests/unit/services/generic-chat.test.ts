/**
 * 通用对话服务单测（LLMClient / GenericAgent / LLMLogger 打桩）：
 * - agent 缓存键（配置指纹）、并发去重、LRU 淘汰、清理
 * - 前端消息 → agent 消息的展开规则（toolCalls 过滤、tool 结果消息、空结果兜底）
 * - chatStream 参数透传（query/图片/技能开关/最大迭代/AbortSignal）
 * - compactConversation 透传与 getContextStats 缓存键一致性
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockState = vi.hoisted(() => {
  const created: any[] = []
  class FakeAgent {
    registerTools = vi.fn()
    setMinimalMode = vi.fn()
    updateMemoryPrompt = vi.fn()
    updateWorkspaceContextPrompt = vi.fn()
    updateKBContextPrompt = vi.fn()
    getContextStats = vi.fn(() => ({ count: 7, totalChars: 100 }))
    runStream = vi.fn(async (_opts: any, cbs: any) => { cbs?.onDone?.({ finished: true }) })
    compactConversation = vi.fn(async (history: any[]) => ({ summary: 'SUM', stats: { n: history.length } }))
    constructor(public config: any, public options: any) {
      created.push(this)
    }
  }
  const provider = {
    id: 'p1',
    api_key: 'sk',
    base_url: '',
    model: 'base-model',
    provider_type: 'openai',
    models_json: JSON.stringify([
      { id: 'alias', model: 'gpt-4o-mini', enable_thinking: true, context_window: 1000, tool_timeout_ms: 111 },
      { id: 'other', model: 'qwen-max', category: 'chat' },
    ]),
  }
  let providerResult: any = provider
  const llm = {
    getProviderConfig: vi.fn(async () => providerResult),
    getBaseURL: vi.fn(() => 'http://base-url'),
  }
  const runWithContext = vi.fn(async (_ctx: any, fn: any) => fn())
  return {
    created,
    FakeAgent,
    provider,
    llm,
    runWithContext,
    setProvider: (v: any) => { providerResult = v },
  }
})

vi.mock('../../../electron/main/services/llm-client.service', () => ({
  default: { getInstance: () => mockState.llm },
}))

vi.mock('../../../electron/main/services/agent/business/generic-agent', () => ({
  GenericAgent: mockState.FakeAgent,
}))

vi.mock('../../../electron/main/services/llm-logger.service', () => ({
  default: { getInstance: () => ({ runWithContext: mockState.runWithContext }) },
}))

import GenericChatService, {
  type GenericChatConfig,
} from '../../../electron/main/services/generic-chat.service'

const service = GenericChatService.getInstance()
const priv = service as any

function cfg(overrides: Partial<GenericChatConfig> = {}): GenericChatConfig {
  return { providerId: 'p1', systemPrompt: 'sys', tools: [], ...overrides }
}

function callbacks() {
  return {
    onChunk: vi.fn(),
    onThought: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  service.clearAgentCache()
  mockState.created.length = 0
  mockState.setProvider(mockState.provider)
})

describe('generic-chat / agent 创建与缓存', () => {
  it('模型解析：按 modelId 命中 models_json，思考模式与上下文参数来自模型配置', async () => {
    await service.compactConversation(cfg({ modelId: 'alias' }), [])
    const agent = mockState.created[0]
    expect(agent.config.model).toBe('gpt-4o-mini')
    expect(agent.config.enableThinking).toBe(true)
    expect(agent.config.apiKey).toBe('sk')
    expect(agent.config.baseUrl).toBe('http://base-url')
    expect(agent.config.sessionId).toBeUndefined()
    expect(agent.options.memoryConfig).toEqual({
      maxTokens: 1000,
      strategy: 'sliding_window_with_summary',
      recentTurnsToKeep: 10,
    })
    expect(agent.options.toolTimeoutMs).toBe(111)
    expect(agent.options.toolMaxRetries).toBe(2)
    expect(agent.options.toolMaxResultSize).toBe(50000)
  })

  it('未命中模型配置时回落 modelId / provider.model', async () => {
    await service.compactConversation(cfg({ modelId: 'not-in-list' }), [])
    expect(mockState.created[0].config.model).toBe('not-in-list')

    service.clearAgentCache()
    mockState.created.length = 0
    await service.compactConversation(cfg({ modelId: undefined }), [])
    // 未传 modelId 时 getModelConfig 取第一个 chat 模型（无 category 视为 chat）
    expect(mockState.created[0].config.model).toBe('gpt-4o-mini')
  })

  it('显式 modelConfig 优先于 models_json 解析', async () => {
    await service.compactConversation(cfg({ modelId: 'alias', modelConfig: { model: 'explicit-model' } as any }), [])
    expect(mockState.created[0].config.model).toBe('explicit-model')
  })

  it('minimalMode / 提示词 / 技能路径按配置下发', async () => {
    await service.compactConversation(
      cfg({
        minimalMode: true,
        memoryPrompt: 'mem',
        workspaceContextPrompt: 'ws',
        kbContextPrompt: 'kb',
        allowedSkillPaths: ['/skills/a'],
        useSkills: false,
        workspaceGuidance: 'guide',
        conversationId: 'conv-1',
      }),
      [],
    )
    const agent = mockState.created[0]
    expect(agent.setMinimalMode).toHaveBeenCalledWith(true)
    expect(agent.updateMemoryPrompt).toHaveBeenCalledWith('mem')
    expect(agent.updateWorkspaceContextPrompt).toHaveBeenCalledWith('ws')
    expect(agent.updateKBContextPrompt).toHaveBeenCalledWith('kb')
    expect(agent.config.allowedSkillPaths).toEqual(['/skills/a'])
    expect(agent.config.autoDiscoverSkills).toBe(false) // useSkills=false 时禁用自动发现
    expect(agent.config.workspaceGuidance).toBe('guide')
    expect(agent.config.sessionId).toBe('conv-1')
  })

  it('registerTools 仅在工具非空时调用', async () => {
    await service.compactConversation(cfg({ tools: [] }), [])
    expect(mockState.created[0].registerTools).not.toHaveBeenCalled()

    service.clearAgentCache()
    mockState.created.length = 0
    await service.compactConversation(cfg({ tools: [{ id: 't', name: 't' } as any] }), [])
    expect(mockState.created[0].registerTools).toHaveBeenCalledTimes(1)
  })

  it('相同配置复用同一 agent，配置变化则重建', async () => {
    const same = cfg({ conversationId: 'c1' })
    await service.compactConversation(same, [])
    await service.compactConversation(same, [])
    expect(mockState.created).toHaveLength(1)

    await service.compactConversation(cfg({ conversationId: 'c1', minimalMode: true }), [])
    expect(mockState.created).toHaveLength(2)

    await service.compactConversation(cfg({ conversationId: 'c2' }), [])
    expect(mockState.created).toHaveLength(3)
  })

  it('并发同配置创建去重（in-flight 复用）', async () => {
    const same = cfg({ conversationId: 'c-conc' })
    await Promise.all([
      service.compactConversation(same, []),
      service.compactConversation(same, []),
      service.compactConversation(same, []),
    ])
    expect(mockState.created).toHaveLength(1)
  })

  it('provider 不存在时抛错', async () => {
    mockState.setProvider(null)
    await expect(service.compactConversation(cfg({ conversationId: 'no-provider' }), [])).rejects.toThrow(
      'Provider p1 not found',
    )
  })

  it('缓存上限 50：超出后淘汰最早创建的会话', async () => {
    for (let i = 0; i < 51; i++) {
      await service.compactConversation(cfg({ conversationId: `conv-${i}` }), [])
    }
    expect(priv.agentEntries.size).toBe(50)
    const keys = [...priv.agentEntries.keys()]
    expect(keys.some(k => k.includes('conv-0'))).toBe(false)
    expect(keys.some(k => k.includes('conv-50'))).toBe(true)
  })

  it('clearAgentCache 清空缓存', async () => {
    await service.compactConversation(cfg({ conversationId: 'c-clear' }), [])
    expect(priv.agentEntries.size).toBe(1)
    service.clearAgentCache()
    expect(priv.agentEntries.size).toBe(0)
  })
})

describe('generic-chat / chatStream 参数透传', () => {
  it('历史消息展开：assistant + toolCalls → tool 结果消息，最后一条作为 query', async () => {
    const cbs = callbacks()
    const messages = [
      { role: 'user', content: '第一问' },
      {
        role: 'assistant',
        content: '思考中',
        reasoning_content: 'r',
        toolCalls: [
          { id: 't1', name: 'search', args: { q: 'x' }, result: { hits: 1 } },
          { id: 't2', name: 'read', args: '{"p":"a"}', result: null },
          { id: 't3', name: 'broken', args: {}, isComplete: false },
          { id: 't4', name: '', args: {} },
        ],
      },
      { role: 'user', content: '最后一句', images: ['img-1'] },
    ]
    await service.chatStream(cfg({ conversationId: 'c-hist' }), messages, cbs as any)

    const args = mockState.created[0].runStream.mock.calls[0][0]
    expect(args.query).toBe('最后一句')
    expect(args.metadata).toEqual({ queryImages: ['img-1'] })
    expect(args.history).toEqual([
      { role: 'user', content: '第一问', images: undefined, reasoning_content: undefined, toolCallId: undefined },
      {
        role: 'assistant',
        content: '思考中',
        images: undefined,
        reasoning_content: 'r',
        toolCalls: [
          { id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
          { id: 't2', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } },
        ],
      },
      { role: 'tool', toolCallId: 't1', content: '{"hits":1}' },
      { role: 'tool', toolCallId: 't2', content: '工具执行完成，无返回值' },
    ])
  })

  it('toolCalls 全部无效时 assistant 消息不含 toolCalls 字段', async () => {
    const cbs = callbacks()
    await service.chatStream(cfg({ conversationId: 'c-invalid-tc' }), [
      { role: 'assistant', content: 'x', toolCalls: [{ id: '', name: '', args: {} }] },
      { role: 'user', content: 'q' },
    ], cbs as any)
    const history = mockState.created[0].runStream.mock.calls[0][0].history
    expect(history[0].toolCalls).toBeUndefined()
  })

  it('空消息列表：query 为空串、history 为空', async () => {
    const cbs = callbacks()
    await service.chatStream(cfg({ conversationId: 'c-empty' }), [], cbs as any)
    const args = mockState.created[0].runStream.mock.calls[0][0]
    expect(args.query).toBe('')
    expect(args.history).toEqual([])
  })

  it('useSkills 默认开启，显式 false 关闭；maxIterations 读 modelConfig.max_retry', async () => {
    const cbs = callbacks()
    await service.chatStream(cfg({ conversationId: 'c-skill', modelConfig: { max_retry: 5 } as any }), [{ role: 'user', content: 'q' }], cbs as any)
    expect(mockState.created[0].runStream.mock.calls[0][0]).toMatchObject({ useSkills: true, maxIterations: 5 })

    service.clearAgentCache()
    mockState.created.length = 0
    await service.chatStream(cfg({ conversationId: 'c-skill2', useSkills: false }), [{ role: 'user', content: 'q' }], cbs as any)
    const args = mockState.created[0].runStream.mock.calls[0][0]
    expect(args.useSkills).toBe(false)
    expect(args.maxIterations).toBe(100)
  })

  it('AbortSignal 透传给 agent', async () => {
    const cbs = callbacks()
    const controller = new AbortController()
    await service.chatStream(cfg({ conversationId: 'c-abort' }), [{ role: 'user', content: 'q' }], cbs as any, controller.signal)
    expect(mockState.created[0].runStream.mock.calls[0][2]).toBe(controller.signal)
  })

  it('回调逐项透传，onDone 收到 agent 元数据', async () => {
    const cbs = callbacks()
    await service.chatStream(cfg({ conversationId: 'c-cb' }), [{ role: 'user', content: 'q' }], cbs as any)
    expect(cbs.onDone).toHaveBeenCalledWith({ finished: true })
  })

  it('日志上下文按 logName 归属', async () => {
    const cbs = callbacks()
    await service.chatStream(cfg({ conversationId: 'c-log', logName: 'my-plugin' }), [{ role: 'user', content: 'q' }], cbs as any)
    expect(mockState.runWithContext).toHaveBeenCalledWith(
      { conversationId: 'c-log', employeeName: 'my-plugin', source: 'generic-chat' },
      expect.any(Function),
    )
  })
})

describe('generic-chat / compactConversation 与上下文统计', () => {
  it('compactConversation 展开全部消息并透传 agent 结果', async () => {
    const r = await service.compactConversation(cfg({ conversationId: 'c-compact' }), [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ])
    expect(r).toEqual({ summary: 'SUM', stats: { n: 2 } })
  })

  it('compactConversation 空消息列表不抛错', async () => {
    await expect(service.compactConversation(cfg({ conversationId: 'c-compact-empty' }), [])).resolves.toEqual({
      summary: 'SUM',
      stats: { n: 0 },
    })
  })

  // 回归：getContextStats 与 getOrCreateAgent 必须共用同一 cacheKey（含配置指纹），否则恒返回 null
  it('getContextStats 在 agent 已创建后应返回统计信息', async () => {
    const config = cfg({ conversationId: 'c-stats' })
    await service.compactConversation(config, [])
    expect(service.getContextStats(config)).toEqual({ count: 7, totalChars: 100 })
  })

  it('getContextStats 未创建过 agent 时返回 null', () => {
    expect(service.getContextStats(cfg({ conversationId: 'never-created' }))).toBeNull()
  })
})
