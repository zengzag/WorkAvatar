import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentRunOptions } from '../../../electron/main/services/agent/core/types'
import type { ToolDefinition } from '../../../electron/main/services/agent/tools/types'

const h = vi.hoisted(() => ({
  calls: [] as any[],
  impl: ((_params: any) => Promise.resolve({})) as (params: any) => Promise<any>,
}))

vi.mock('../../../electron/main/services/agent/core/pi-agent-adapter', () => ({
  runPiAgentLoop: (params: any) => {
    h.calls.push(params)
    return h.impl(params)
  },
}))

vi.mock('../../../electron/main/services/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

import { BaseAgent } from '../../../electron/main/services/agent/core/base-agent'

const toolDef = (name: string, handler?: ToolDefinition['handler']): ToolDefinition => ({
  id: name, name, title: name, description: `desc-${name}`,
  parameters: { type: 'object', properties: {} },
  handler: handler ?? (async () => ({ success: true, output: `${name}-out` })),
  source: 'builtin',
})

class TestAgent extends BaseAgent {
  prompts: string[] = []
  protected buildSystemPrompt(options: AgentRunOptions): string {
    this.prompts.push(options.query)
    return `SYS:${options.query}`
  }
}

const makeAgent = (options: ConstructorParameters<typeof BaseAgent>[1] = {}) =>
  new TestAgent({ model: 'gpt-x', providerType: 'openai' }, options)

const statesOf = (agent: TestAgent) => {
  const states: string[] = []
  agent.getEventEmitter().on('state:change', e => states.push(e.data.to))
  return states
}

/** 让 runStream 内部的 await 链推进到调用 runPiAgentLoop（全部为微任务） */
const flushMicrotasks = async (times = 12) => {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

beforeEach(() => {
  h.calls = []
  h.impl = () => Promise.resolve({})
})

describe('BaseAgent / 配置归一化与 getter', () => {
  it('缺省 name/instructions/maxIterations/logLevel/debug 被补全', async () => {
    const agent = makeAgent()
    expect(agent.name).toMatch(/^Agent_[0-9a-f]{24}$/)
    expect(agent.instructions).toBe('You are a helpful assistant.')
    expect(agent.version).toBe('2.0.0')
    await agent.run({ query: 'q' })
    expect(h.calls[0].maxIterations).toBe(100)
    expect(h.calls[0].config.logLevel).toBe('info')
    expect(h.calls[0].config.debug).toBe(false)
  })

  it('显式 name/instructions/maxIterations 不被覆盖', async () => {
    const agent = new TestAgent({ model: 'm', name: '小王', instructions: '自定义', maxIterations: 3 })
    expect(agent.name).toBe('小王')
    expect(agent.instructions).toBe('自定义')
    await agent.run({ query: 'q' })
    expect(h.calls[0].maxIterations).toBe(3)
  })

  it('run options.maxIterations 优先于 config', async () => {
    const agent = new TestAgent({ model: 'm', maxIterations: 3 })
    await agent.run({ query: 'q', maxIterations: 7 })
    expect(h.calls[0].maxIterations).toBe(7)
  })

  it('getContextStats 初始为 null；getTools/registerTool/unregisterTool 可用', () => {
    const agent = makeAgent()
    expect(agent.getContextStats()).toBeNull()
    expect(agent.registerTool(toolDef('tool_a'))).toBe(true)
    expect(agent.registerTool(toolDef('tool_a'))).toBe(false)
    expect(agent.getTools().map(t => t.function.name)).toEqual(['tool_a'])
    expect(agent.unregisterTool('tool_a')).toBe(true)
    expect(agent.unregisterTool('tool_a')).toBe(false)
    expect(agent.getTools()).toEqual([])
  })

  it('onEvent 桥接：run:start / run:end / state:change 均转发', async () => {
    const events: string[] = []
    const agent = makeAgent({ onEvent: (name) => events.push(name) })
    await agent.run({ query: 'q' })
    expect(events).toContain('run:start')
    expect(events).toContain('run:end')
    expect(events).toContain('state:change')
  })

  it('useToolMiddleware：before 插链首可短路，after 追加链尾', async () => {
    const handler = vi.fn(async () => ({ success: true, output: 'real' }))
    const agent = makeAgent()
    agent.registerTool(toolDef('tool_a', handler))

    const order: string[] = []
    agent.useToolMiddleware({
      name: 'gate',
      fn: async () => {
        order.push('before')
        return { success: false, error: 'blocked', toolName: 'tool_a' }
      },
    }, 'before')
    agent.useToolMiddleware({
      name: 'after',
      fn: async (_n, _a, next) => {
        order.push('after')
        return next()
      },
    }, 'after')

    const res = await agent.getToolDispatcher().dispatch('tool_a', {})
    expect(res.success).toBe(false)
    expect(order).toEqual(['before']) // before 短路，未进入下游与 after
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('BaseAgent / run 主流程', () => {
  it('成功路径：累积 content/thought/toolCalls，返回 metadata 与 contextStats', async () => {
    h.impl = async (params: any) => {
      params.callbacks.onChunk?.('你好')
      params.callbacks.onChunk?.('世界')
      params.callbacks.onThought?.('思考')
      await params.onToolCallExecuted?.('tool_a', { a: 1 }, { success: true, output: 'OUT', latencyMs: 5, toolName: 'tool_a' })
      await params.onToolCallExecuted?.('tool_b', { b: 2 }, { success: false, error: 'E', toolName: 'tool_b' })
      return { tokenUsage: { promptTokens: 10 }, aborted: false }
    }
    const agent = makeAgent()
    agent.registerTools([toolDef('tool_a'), toolDef('tool_b')])

    const res = await agent.run({ query: '问题' })
    expect(res.success).toBe(true)
    expect(res.content).toBe('你好世界')
    expect(res.reasoning_content).toBe('思考')
    expect(res.toolCalls).toEqual([
      { name: 'tool_a', args: { a: 1 }, result: 'OUT', latencyMs: 5, success: true },
      { name: 'tool_b', args: { b: 2 }, result: 'E', latencyMs: undefined, success: false },
    ])
    expect(res.metadata?.contextStats?.totalMessages).toBeGreaterThan(0)
    expect(typeof res.metadata?.totalLatencyMs).toBe('number')
    expect(agent.getContextStats()).not.toBeNull()
    // system prompt 由子类构建，query 作为最后一条 user
    expect(h.calls[0].messages[0]).toMatchObject({ role: 'system', content: 'SYS:问题' })
    expect(h.calls[0].messages[h.calls[0].messages.length - 1]).toMatchObject({ role: 'user', content: '问题' })
  })

  it('reasoning_content 为空时不返回该字段', async () => {
    const agent = makeAgent()
    const res = await agent.run({ query: 'q' })
    expect(res.reasoning_content).toBeUndefined()
    expect(res.toolCalls).toEqual([])
  })

  it('错误路径：返回 success=false，state=error 并触发 run:error', async () => {
    h.impl = async () => { throw new Error('provider boom') }
    const agent = makeAgent()
    const states = statesOf(agent)
    const errors: any[] = []
    agent.getEventEmitter().on('run:error', e => errors.push(e.data))

    const res = await agent.run({ query: 'q' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('provider boom')
    expect(res.content).toBe('')
    expect(states).toEqual(['running', 'error'])
    expect(errors).toEqual([{ error: 'provider boom' }])
  })

  it('queryImages 注入最后一条 user 消息；空数组不注入', async () => {
    const agent = makeAgent()
    await agent.run({ query: 'q', history: [{ role: 'user', content: 'h' }], metadata: { queryImages: ['img-1'] } })
    expect(h.calls[0].messages[h.calls[0].messages.length - 1].images).toEqual(['img-1'])

    h.calls = []
    await agent.run({ query: 'q', metadata: { queryImages: [] } })
    expect(h.calls[0].messages[h.calls[0].messages.length - 1].images).toBeUndefined()

    h.calls = []
    await agent.run({ query: 'q' })
    expect(h.calls[0].messages[h.calls[0].messages.length - 1].images).toBeUndefined()
  })

  it('options.tools 过滤活跃工具，未指定时使用全部已注册工具', async () => {
    const agent = makeAgent()
    agent.registerTools([toolDef('tool_a'), toolDef('tool_b')])
    await agent.run({ query: 'q', tools: ['tool_b'] })
    expect(h.calls[0].toolDefinitions.map((d: any) => d.function.name)).toEqual(['tool_b'])

    await agent.run({ query: 'q' })
    expect(h.calls[1].toolDefinitions.map((d: any) => d.function.name).sort()).toEqual(['tool_a', 'tool_b'])
  })

  it('压缩发生时发出 memory:compressed 事件', async () => {
    const agent = makeAgent({ memoryConfig: { maxTokens: 60, reservedResponseTokens: 0, strategy: 'sliding_window' } })
    const compressed: any[] = []
    agent.getEventEmitter().on('memory:compressed', e => compressed.push(e.data))
    await agent.run({
      query: '问题',
      history: Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `历史${i}` + 'x'.repeat(100) })),
    })
    expect(compressed).toHaveLength(1)
    expect(compressed[0].wasCompressed).toBe(true)
  })

  it('onPromptTokens 回写真实 token 数；第二次 run 重置 _lastKnownPromptTokens', async () => {
    h.impl = async (params: any) => {
      if (h.calls.length === 1) params.onPromptTokens?.(777)
      return {}
    }
    const agent = makeAgent()
    await agent.run({ query: 'q' })
    expect(agent.getContextStats()?.actualPromptTokens).toBe(777)

    await agent.run({ query: 'q' })
    // 新一轮 lastKnownPromptTokens 已重置，stats 用 undefined 重建
    expect(agent.getContextStats()?.actualPromptTokens).toBeUndefined()
  })
})

describe('BaseAgent / 并发保护与 stale lock（run）', () => {
  it('并发 run 抛错，不启动第二次', async () => {
    const resolvers: Array<(v: any) => void> = []
    h.impl = () => new Promise(res => resolvers.push(res))
    const agent = makeAgent()

    const first = agent.run({ query: 'first' })
    expect(agent.isRunning()).toBe(true)
    await expect(agent.run({ query: 'second' })).rejects.toThrow(/already running/)
    expect(h.calls).toHaveLength(1)

    resolvers[0]({})
    await first
    expect(agent.isRunning()).toBe(false)
  })

  it('run 抛错后 finally 释放锁，可再次 run', async () => {
    h.impl = async () => { throw new Error('boom') }
    const agent = makeAgent()
    await agent.run({ query: 'q' })
    expect(agent.isRunning()).toBe(false)
    h.impl = async () => ({})
    await expect(agent.run({ query: 'q2' })).resolves.toMatchObject({ success: true })
  })
})

describe('BaseAgent / runStream 并发、stale lock 与状态', () => {
  it('并发 runStream 抛错（signal 未中止时）', async () => {
    const resolvers: Array<(v: any) => void> = []
    h.impl = () => new Promise(res => resolvers.push(res))
    const agent = makeAgent()
    const ctrl = new AbortController()

    const first = agent.runStream({ query: 'first' }, {}, ctrl.signal)
    await expect(agent.runStream({ query: 'second' }, {}, new AbortController().signal))
      .rejects.toThrow(/already running/)

    resolvers[0]({})
    await first
  })

  it('stale lock：上次 signal 已中止时强制恢复，允许新 runStream', async () => {
    const resolvers: Array<(v: any) => void> = []
    h.impl = () => new Promise(res => resolvers.push(res))
    const agent = makeAgent()
    const ctrlA = new AbortController()

    const pA = agent.runStream({ query: 'A' }, {}, ctrlA.signal)
    ctrlA.abort()
    const pB = agent.runStream({ query: 'B' }, {}, new AbortController().signal)
    expect(agent.isRunning()).toBe(true)
    await flushMicrotasks()
    expect(resolvers).toHaveLength(2)

    resolvers[0]({ aborted: true })
    await pA
    // 旧 run 的 finally 不应清除新 run 的锁（不同 signal 实例）
    expect(agent.isRunning()).toBe(true)
    resolvers[1]({})
    await pB
    expect(h.calls).toHaveLength(2)
    expect(agent.isRunning()).toBe(false)
  })

  // 回归：复用同一 AbortSignal 实例时，旧 run 的 finally 不得清除新 run 的锁（按 run 令牌判定）
  it('复用同一 signal 实例时，旧 run 结束不应清除新 run 的锁', async () => {
    const resolvers: Array<(v: any) => void> = []
    h.impl = () => new Promise(res => resolvers.push(res))
    const agent = makeAgent()
    const shared = new AbortController()

    const pA = agent.runStream({ query: 'A' }, {}, shared.signal)
    shared.abort()
    const pB = agent.runStream({ query: 'B' }, {}, shared.signal)
    await flushMicrotasks()
    expect(resolvers).toHaveLength(2)

    resolvers[0]({ aborted: true })
    await pA
    const runningWhileBInFlight = agent.isRunning()
    resolvers[1]({})
    await pB
    expect(runningWhileBInFlight).toBe(true)
  })

  it('成功路径：state=completed，onDone 带 tokenUsage 与 contextStats', async () => {
    h.impl = async (params: any) => {
      params.callbacks.onIterationStart?.(1)
      params.callbacks.onIterationEnd?.(1)
      return { tokenUsage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 }, aborted: false }
    }
    const agent = makeAgent()
    const states = statesOf(agent)
    const onDone = vi.fn()
    const onError = vi.fn()

    await agent.runStream({ query: 'q' }, { onDone, onError }, new AbortController().signal)
    // 单轮 run 只发出一次 state=running（runStream 与 executeLoopStream 不再重复设置）
    expect(states).toEqual(['running', 'completed'])
    expect(onError).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      aborted: false,
      tokenUsage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    }))
    expect(onDone.mock.calls[0][0].contextStats).toBeTruthy()
    expect(agent.isRunning()).toBe(false)
  })

  it('底层返回 aborted=true：state=aborted，onDone 带 abortReason', async () => {
    h.impl = async () => ({ aborted: true, abortReason: '用户主动停止（signal 已中止）', tokenUsage: { promptTokens: 3 } })
    const agent = makeAgent()
    const states = statesOf(agent)
    const onDone = vi.fn()

    await agent.runStream({ query: 'q' }, { onDone }, new AbortController().signal)
    expect(states).toEqual(['running', 'aborted'])
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      aborted: true,
      abortReason: '用户主动停止（signal 已中止）',
      tokenUsage: { promptTokens: 3 },
    }))
    expect(agent.isRunning()).toBe(false)
  })

  it('抛错且 signal 已中止：走 aborted 分支（onDone，不触发 onError）', async () => {
    const ctrl = new AbortController()
    h.impl = async () => {
      ctrl.abort()
      throw Object.assign(new Error('socket hang up'), { name: 'AbortError' })
    }
    const agent = makeAgent()
    const states = statesOf(agent)
    const onDone = vi.fn()
    const onError = vi.fn()

    await agent.runStream({ query: 'q' }, { onDone, onError }, ctrl.signal)
    expect(states).toEqual(['running', 'aborted'])
    expect(onError).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ aborted: true, abortReason: 'socket hang up' }))
    expect(agent.isRunning()).toBe(false)
  })

  it('抛错且未中止：state=error，onError 收到消息', async () => {
    h.impl = async () => { throw new Error('stream boom') }
    const agent = makeAgent()
    const states = statesOf(agent)
    const onDone = vi.fn()
    const onError = vi.fn()

    await agent.runStream({ query: 'q' }, { onDone, onError })
    expect(states).toEqual(['running', 'error'])
    expect(onError).toHaveBeenCalledWith('stream boom')
    expect(onDone).not.toHaveBeenCalled()
    expect(agent.isRunning()).toBe(false)
  })

  it('每次 runStream 重置迭代计数（context.reset）', async () => {
    h.impl = async (params: any) => {
      params.agentContext.incrementIteration()
      params.agentContext.incrementIteration()
      return {}
    }
    const agent = makeAgent()
    const onDone = vi.fn()
    await agent.runStream({ query: 'q1' }, { onDone }, new AbortController().signal)
    expect(onDone.mock.calls[0][0].iterations).toBe(2)
    await agent.runStream({ query: 'q2' }, { onDone }, new AbortController().signal)
    expect(onDone.mock.calls[1][0].iterations).toBe(2)
  })

  it('中止后 onDone 刷新 contextStats（catch 兜底路径）', async () => {
    const ctrl = new AbortController()
    h.impl = async () => {
      ctrl.abort()
      throw new Error('boom')
    }
    const agent = makeAgent()
    const onDone = vi.fn()
    await agent.runStream({ query: 'q' }, { onDone }, ctrl.signal)
    expect(onDone.mock.calls[0][0].contextStats).toBeTruthy()
    expect(onDone.mock.calls[0][0].tokenUsage).toBeUndefined()
  })
})

describe('BaseAgent / compactConversation', () => {
  const fakeProvider = (chat: any) => ({
    name: 'fake', chat, chatStream: async () => ({ content: '' }), estimateTokens: () => 0,
  })

  it('历史不足 2 条时返回空摘要与回退 stats', async () => {
    const agent = makeAgent()
    const res = await agent.compactConversation([{ role: 'user', content: 'only' }])
    expect(res.summary).toBe('')
    expect(res.stats.strategy).toBe('sliding_window')
    expect(res.stats.wasCompressed).toBe(true)
  })

  it('LLM 正常返回时使用其摘要', async () => {
    const agent = makeAgent()
    ;(agent as any).llmProvider = fakeProvider(async () => ({ content: 'LLM 摘要' }))
    const res = await agent.compactConversation([
      { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
    ])
    expect(res.summary).toBe('LLM 摘要')
  })

  it('chat 抛错时回退为规则摘要', async () => {
    const agent = makeAgent()
    ;(agent as any).llmProvider = fakeProvider(async () => { throw new Error('down') })
    const res = await agent.compactConversation([
      { role: 'user', content: '话题一' }, { role: 'assistant', content: 'a1' },
    ])
    expect(res.summary).toContain('讨论了 1 个话题')
    expect(res.summary).toContain('话题一')
  })

  it('chat 返回空内容时同样回退规则摘要，且 content 为 undefined 不抛错', async () => {
    const agent = makeAgent()
    ;(agent as any).llmProvider = fakeProvider(async () => ({ content: '' }))
    const res = await agent.compactConversation([
      { role: 'user', content: 'x' }, { role: 'assistant', content: undefined as any },
    ])
    expect(res.summary).toContain('讨论了 1 个话题')
  })

  it('已有 memory stats 时复用（不被回退 stats 覆盖）', async () => {
    const agent = makeAgent()
    ;(agent as any).llmProvider = fakeProvider(async () => ({ content: 'S' }))
    await agent.run({ query: 'q' })
    const statsBefore = agent.getContextStats()
    const res = await agent.compactConversation([{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }])
    expect(res.stats).toEqual(statsBefore)
  })
})
