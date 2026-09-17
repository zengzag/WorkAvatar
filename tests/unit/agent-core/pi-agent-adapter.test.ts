import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentEventEmitter } from '../../../electron/main/services/agent/core/agent-events'
import { AgentContext } from '../../../electron/main/services/agent/core/agent-context'
import { ToolRegistry } from '../../../electron/main/services/agent/tools/tool-registry'
import { ToolDispatcher } from '../../../electron/main/services/agent/tools/tool-dispatcher'
import type { ToolDefinition } from '../../../electron/main/services/agent/tools/types'
import type { Message } from '../../../electron/main/services/agent/core/types'

const h = vi.hoisted(() => ({
  agentLoopCalls: [] as any[][],
  agentLoopContinueCalls: [] as any[][],
  streamCalls: [] as any[],
  logCalls: [] as any[],
  loopImpl: undefined as any,
  continueImpl: undefined as any,
  innerStreamFactory: undefined as any,
}))

vi.mock('@earendil-works/pi-agent-core', () => ({
  agentLoop: (...args: any[]) => {
    h.agentLoopCalls.push(args)
    return h.loopImpl(...args)
  },
  agentLoopContinue: (...args: any[]) => {
    h.agentLoopContinueCalls.push(args)
    return h.continueImpl(...args)
  },
}))

vi.mock('@earendil-works/pi-ai/api/openai-completions', () => ({
  stream: (model: any, context: any, options: any) => {
    h.streamCalls.push({ model, context, options })
    return h.innerStreamFactory(model, context, options)
  },
}))

vi.mock('../../../electron/main/services/llm-logger.service', () => ({
  default: { getInstance: () => ({ logCall: (entry: any) => h.logCalls.push(entry) }) },
}))

vi.mock('../../../electron/main/services/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

import { runPiAgentLoop, findToolCallByContentIndex } from '../../../electron/main/services/agent/core/pi-agent-adapter'

const zeroUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const usage = (o: Record<string, any> = {}) => ({ ...zeroUsage, ...o })

const assistantMessage = (partial: Record<string, any> = {}) => ({
  role: 'assistant', content: [], api: 'openai-completions', provider: 'openai',
  model: 'gpt-x', usage: usage(), stopReason: 'stop', timestamp: 0, ...partial,
})

/** 构造可 async iterate 的事件流（模拟 pi-agent-core EventStream） */
function eventStream(events: any[], result?: any) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
    result: async () => result,
  }
}

/** 构造可 async iterate 的 AssistantMessageEventStream */
function innerStream(events: any[], finalMessage?: any) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
    result: async () => finalMessage ?? assistantMessage(),
  }
}

const toolDef = (name: string, handler: ToolDefinition['handler'], extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  id: name, name, title: name, description: `desc ${name}`,
  parameters: { type: 'object', properties: {} },
  handler, source: 'builtin', ...extra,
})

function makeHarness(overrides: Record<string, any> = {}) {
  const registry = new ToolRegistry()
  registry.registerTool(toolDef('tool_a', async () => ({ success: true, output: 'ok' })))
  registry.registerTool(toolDef('tool_b', async () => ({ success: true, output: 'b' })))
  const dispatcher = new ToolDispatcher(registry)
  const eventEmitter = new AgentEventEmitter()
  const agentContext = new AgentContext({ agentName: 'test-agent' })
  const params: any = {
    config: { model: 'gpt-x', providerType: 'openai' },
    messages: [systemMsg('sys'), userMsg('hi')] as Message[],
    toolDefinitions: registry.getOpenAISchemas(),
    toolDispatcher: dispatcher,
    toolRegistry: registry,
    callbacks: {},
    maxIterations: 3,
    eventEmitter,
    agentContext,
    ...overrides,
  }
  return { params, registry, dispatcher, eventEmitter, agentContext }
}

const systemMsg = (content: string): Message => ({ role: 'system', content })
const userMsg = (content: string, extra: Partial<Message> = {}): Message => ({ role: 'user', content, ...extra })
const asstMsg = (content: string, extra: Partial<Message> = {}): Message => ({ role: 'assistant', content, ...extra })
const toolMsg = (content: string, toolCallId?: string): Message => ({ role: 'tool', content, toolCallId })

beforeEach(() => {
  h.agentLoopCalls = []
  h.agentLoopContinueCalls = []
  h.streamCalls = []
  h.logCalls = []
  h.loopImpl = () => eventStream([{ type: 'agent_start' }, { type: 'agent_end', messages: [] }])
  h.continueImpl = () => eventStream([{ type: 'agent_start' }, { type: 'agent_end', messages: [] }])
  h.innerStreamFactory = () => innerStream([])
})

describe('findToolCallByContentIndex 边界', () => {
  const content = [
    { type: 'text', text: 'a' },
    { type: 'toolCall', id: 'A', name: 'ta', arguments: {} },
    { type: 'thinking', thinking: 't' },
    { type: 'toolCall', id: 'B', name: 'tb', arguments: {} },
  ]

  it('index 命中 toolCall / 命中非 toolCall 时回退第一个', () => {
    expect(findToolCallByContentIndex(content, 1)?.id).toBe('A')
    expect(findToolCallByContentIndex(content, 3)?.id).toBe('B')
    expect(findToolCallByContentIndex(content, 0)?.id).toBe('A') // text 占位 → 回退
    expect(findToolCallByContentIndex(content, 2)?.id).toBe('A') // thinking 占位 → 回退
  })

  it('负数 / 越界 / undefined index 均回退第一个 toolCall', () => {
    expect(findToolCallByContentIndex(content, -1)?.id).toBe('A')
    expect(findToolCallByContentIndex(content, 99)?.id).toBe('A')
    expect(findToolCallByContentIndex(content, undefined)?.id).toBe('A')
  })

  it('无 toolCall / 空数组返回 undefined', () => {
    expect(findToolCallByContentIndex([{ type: 'text', text: 'x' }], 0)).toBeUndefined()
    expect(findToolCallByContentIndex([], 0)).toBeUndefined()
    expect(findToolCallByContentIndex([], undefined)).toBeUndefined()
  })
})

describe('runPiAgentLoop / 消息转换', () => {
  it('多条 system 合并，最后一条 user 作为 prompt，其余作为上下文', async () => {
    const { params } = makeHarness({
      messages: [
        systemMsg('S1'),
        systemMsg('S2'),
        userMsg('u0'),
        asstMsg('a0'),
        toolMsg('r0', 'c0'),
        userMsg('last question'),
      ],
    })
    await runPiAgentLoop(params)

    expect(h.agentLoopCalls).toHaveLength(1)
    expect(h.agentLoopContinueCalls).toHaveLength(0)
    const [prompts, context] = h.agentLoopCalls[0]
    expect(context.systemPrompt).toBe('S1\n\nS2')
    expect(prompts).toHaveLength(1)
    expect(prompts[0].content).toBe('last question')
    // context 内的 user 不含最后一条
    expect(context.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'toolResult'])
  })

  it('无 user 消息时走 agentLoopContinue 且 prompts 为空', async () => {
    const { params } = makeHarness({ messages: [systemMsg('S'), asstMsg('a')] })
    await runPiAgentLoop(params)
    expect(h.agentLoopCalls).toHaveLength(0)
    expect(h.agentLoopContinueCalls).toHaveLength(1)
  })

  it('user 图片：data URL 解析为 image part，HTTP 链接丢弃并附提示', async () => {
    const { params } = makeHarness({
      messages: [userMsg('看这两张', { images: ['data:image/png;base64,QUJD', 'https://x.com/a.png'] })],
    })
    await runPiAgentLoop(params)
    const [prompts] = h.agentLoopCalls[0]
    const parts = prompts[0].content
    expect(Array.isArray(parts)).toBe(true)
    expect(parts[0].type).toBe('text')
    expect(parts[0].text).toContain('看这两张')
    expect(parts[0].text).toContain('1 张图片（HTTP 链接）未能随消息发送')
    expect(parts[0].text).toContain('https://x.com/a.png')
    expect(parts.filter((p: any) => p.type === 'image')).toEqual([
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ])
  })

  it('user 仅有 HTTP 图片时退化为纯文本提示（不产生 image part）', async () => {
    const { params } = makeHarness({ messages: [userMsg('', { images: ['https://x.com/a.png'] })] })
    await runPiAgentLoop(params)
    const content = h.agentLoopCalls[0][0][0].content
    expect(typeof content).toBe('string')
    expect(content).toContain('未能随消息发送')
    expect(content).not.toContain('data:')
  })

  it('user 仅 data URL 图片且无文本时不产生空 text part', async () => {
    const { params } = makeHarness({ messages: [userMsg('', { images: ['data:image/jpeg;base64,QQ=='] })] })
    await runPiAgentLoop(params)
    const parts = h.agentLoopCalls[0][0][0].content
    expect(parts).toHaveLength(1)
    expect(parts[0]).toEqual({ type: 'image', data: 'QQ==', mimeType: 'image/jpeg' })
  })

  it('assistant：reasoning_content 与 toolCalls 参数解析（非法 JSON 兜底空对象）', async () => {
    const { params } = makeHarness({
      messages: [
        systemMsg('S'),
        asstMsg('正文', {
          reasoning_content: '思考中',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'tool_a', arguments: '{"a":1}' } },
            { id: 'c2', type: 'function', function: { name: 'tool_b', arguments: 'not-json' } },
          ],
        }),
        userMsg('q'),
      ],
    })
    await runPiAgentLoop(params)
    const asst = h.agentLoopCalls[0][1].messages[0]
    expect(asst.role).toBe('assistant')
    expect(asst.content[0]).toEqual({ type: 'text', text: '正文' })
    expect(asst.content[1]).toEqual({ type: 'thinking', thinking: '思考中', thinkingSignature: 'reasoning_content' })
    expect(asst.content[2]).toMatchObject({ type: 'toolCall', id: 'c1', name: 'tool_a', arguments: { a: 1 } })
    expect(asst.content[3]).toMatchObject({ type: 'toolCall', id: 'c2', arguments: {} })
    expect(asst.provider).toBe('openai')
    expect(asst.model).toBe('gpt-x')
  })

  it('assistant 空内容不产生 text part', async () => {
    const { params } = makeHarness({ messages: [systemMsg('S'), asstMsg(''), userMsg('q')] })
    await runPiAgentLoop(params)
    expect(h.agentLoopCalls[0][1].messages[0].content).toEqual([])
  })

  it('tool 消息 → toolResult（空内容为 [] 且 toolCallId 兜底空串）', async () => {
    const { params } = makeHarness({
      messages: [systemMsg('S'), userMsg('u'), toolMsg('', undefined), userMsg('q')],
    })
    await runPiAgentLoop(params)
    const [user1, tool1] = h.agentLoopCalls[0][1].messages
    expect(user1.role).toBe('user')
    expect(tool1).toMatchObject({ role: 'toolResult', toolCallId: '', toolName: '', content: [], isError: false })
  })

  it('system 消息内容为 undefined 时不抛错', async () => {
    const { params } = makeHarness({
      messages: [{ role: 'system', content: undefined as any }, userMsg('q')],
    })
    await runPiAgentLoop(params)
    expect(h.agentLoopCalls[0][1].systemPrompt).toBe('')
  })
})

describe('runPiAgentLoop / agentTools 包装', () => {
  const runWithTools = async (customTool?: ToolDefinition) => {
    const harness = makeHarness({ messages: [systemMsg('S'), userMsg('q')] })
    if (customTool) harness.registry.registerTool(customTool)
    harness.params.toolDefinitions = [customTool
      ? { type: 'function', function: { name: customTool.name, description: '', parameters: customTool.parameters } }
      : { type: 'function', function: { name: 'tool_a', description: '', parameters: {} } }]
    await runPiAgentLoop(harness.params)
    return h.agentLoopCalls.at(-1)![1].tools
  }

  it('未注册到 registry 的工具定义被忽略', async () => {
    const { params } = makeHarness({
      messages: [systemMsg('S'), userMsg('q')],
      toolDefinitions: [{ type: 'function', function: { name: 'ghost', description: '', parameters: {} } }],
    })
    await runPiAgentLoop(params)
    expect(h.agentLoopCalls[0][1].tools).toEqual([])
  })

  it('成功结果：output 直接作为文本，isError=false', async () => {
    const tools = await runWithTools()
    const res = await tools[0].execute('call_1', { p: 1 }, undefined, undefined)
    expect(res.content[0].text).toBe('ok')
    expect(res.isError).toBe(false)
    expect(res.details).toMatchObject({ success: true, output: 'ok' })
    expect(typeof res.details.latencyMs).toBe('number')
  })

  it('对象 output 序列化；空 output 输出占位文案', async () => {
    const tools = await runWithTools(toolDef('tool_obj', async () => ({ success: true, output: { a: 1 } })))
    const obj = await tools[0].execute('c', {}, undefined, undefined)
    expect(obj.content[0].text).toBe('{\n  "a": 1\n}')

    const tools2 = await runWithTools(toolDef('tool_empty', async () => ({ success: true, output: '' })))
    const empty = await tools2[0].execute('c', {}, undefined, undefined)
    expect(empty.content[0].text).toBe('(工具执行成功，无输出)')
  })

  it('业务失败：错误信息 + output 组合，isError 仍为 false', async () => {
    const tools = await runWithTools(toolDef('tool_fail', async () => ({ success: false, error: '炸了', output: 'partial' })))
    const res = await tools[0].execute('c', {}, undefined, undefined)
    expect(res.content[0].text).toBe('[错误] 炸了\n\npartial')
    expect(res.isError).toBe(false)
    expect(res.details.success).toBe(false)
  })

  it('业务失败且无错误信息时输出占位（与 formatToolMessageContent 同一中文占位）', async () => {
    const tools = await runWithTools(toolDef('tool_fail2', async () => ({ success: false })))
    const res = await tools[0].execute('c', {}, undefined, undefined)
    expect(res.content[0].text).toBe('[错误] (无错误信息)\n\n(工具执行成功，无输出)')
  })

  it('signal 已中止 → 直接返回"操作已取消"，不调用工具', async () => {
    const handler = vi.fn(async () => ({ success: true, output: 'never' }))
    const tools = await runWithTools(toolDef('tool_abort', handler))
    const ctrl = new AbortController()
    ctrl.abort()
    const res = await tools[0].execute('c', {}, ctrl.signal, undefined)
    expect(res.isError).toBe(true)
    expect(res.details.error).toBe('操作已取消')
    expect(handler).not.toHaveBeenCalled()
  })

  it('dispatcher.dispatch 抛异常 → isError=true 且信息含异常', async () => {
    const harness = makeHarness({ messages: [systemMsg('S'), userMsg('q')] })
    harness.params.toolDispatcher = { dispatch: async () => { throw new Error('boom') } }
    await runPiAgentLoop(harness.params)
    const res = await h.agentLoopCalls[0][1].tools[0].execute('c', {}, undefined, undefined)
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('工具 "tool_a" 执行异常: boom')
  })

  it('onUpdate 存在时透传 progress 到 details.progress', async () => {
    const tools = await runWithTools(toolDef('tool_prog', async (_args, ctx) => {
      ctx?.onProgress?.({ percent: 50 })
      return { success: true, output: 'done' }
    }))
    const updates: any[] = []
    await tools[0].execute('c', {}, undefined, (u: any) => updates.push(u))
    expect(updates).toHaveLength(1)
    expect(updates[0].details.progress).toEqual({ percent: 50 })
    expect(updates[0].content).toEqual([{ type: 'text', text: '' }])
  })
})

describe('runPiAgentLoop / 事件转换与 token 累计', () => {
  it('turn_start：iteration 自增、state=running、回调与事件均触发', async () => {
    const harness = makeHarness()
    const onIterationStart = vi.fn()
    harness.params.callbacks = { onIterationStart }
    const events: any[] = []
    harness.eventEmitter.on('iteration:start', e => events.push(e.data))
    h.loopImpl = () => eventStream([{ type: 'turn_start' }])

    await runPiAgentLoop(harness.params)
    expect(harness.agentContext.getIterationCount()).toBe(1)
    expect(onIterationStart).toHaveBeenCalledWith(1)
    expect(events).toEqual([{ iteration: 1 }])
  })

  it('turn_end：累计 tokenUsage（含缓存）并回调 onPromptTokens', async () => {
    const harness = makeHarness()
    const onPromptTokens = vi.fn()
    const onIterationEnd = vi.fn()
    harness.params.onPromptTokens = onPromptTokens
    harness.params.callbacks = { onIterationEnd }
    h.loopImpl = () => eventStream([
      { type: 'turn_end', message: assistantMessage({ usage: usage({ input: 100, output: 20, cacheRead: 50, totalTokens: 170 }) }) },
      { type: 'turn_end', message: assistantMessage({ usage: usage({ input: 10, output: 5, cacheRead: 30, totalTokens: 45 }) }) },
      { type: 'turn_end', message: assistantMessage({ usage: usage({ input: 7, output: 3, totalTokens: 10 }) }) },
    ])

    const result = await runPiAgentLoop(harness.params)
    expect(result.tokenUsage).toEqual({
      promptTokens: 197, completionTokens: 28, totalTokens: 225, cachedTokens: 80,
    })
    expect(onPromptTokens.mock.calls.map(c => c[0])).toEqual([150, 40, 7])
    expect(onIterationEnd.mock.calls.map(c => c[0])).toEqual([0, 0, 0])
  })

  it('promptTokens 为 0 时不调用 onPromptTokens（保留原 falsy 判断）', async () => {
    const harness = makeHarness()
    const onPromptTokens = vi.fn()
    harness.params.onPromptTokens = onPromptTokens
    h.loopImpl = () => eventStream([
      { type: 'turn_end', message: assistantMessage({ usage: usage({ input: 0, output: 5, totalTokens: 5 }) }) },
    ])
    const result = await runPiAgentLoop(harness.params)
    expect(onPromptTokens).not.toHaveBeenCalled()
    expect(result.tokenUsage).toEqual({ promptTokens: 0, completionTokens: 5, totalTokens: 5 })
  })

  it('无 usage 事件时 tokenUsage 为 undefined', async () => {
    const harness = makeHarness()
    const result = await runPiAgentLoop(harness.params)
    expect(result.tokenUsage).toBeUndefined()
    expect(result.aborted).toBe(false)
  })

  it('turn_end stopReason=error 时不抛错则冒泡为 runPiAgentLoop 拒绝', async () => {
    const harness = makeHarness()
    h.loopImpl = () => eventStream([
      { type: 'turn_end', message: assistantMessage({ stopReason: 'error', errorMessage: '上游 500' }) },
    ])
    await expect(runPiAgentLoop(harness.params)).rejects.toThrow('LLM 请求失败: 上游 500')
  })

  it('turn_end stopReason=error 但无 errorMessage 时不抛错', async () => {
    const harness = makeHarness()
    h.loopImpl = () => eventStream([{ type: 'turn_end', message: assistantMessage({ stopReason: 'error' }) }])
    await expect(runPiAgentLoop(harness.params)).resolves.toBeTruthy()
  })

  it('message_update：text / thinking / toolcall delta 转回调，未知类型忽略', async () => {
    const harness = makeHarness()
    const onChunk = vi.fn()
    const onThought = vi.fn()
    const onToolCallDelta = vi.fn()
    harness.params.callbacks = { onChunk, onThought, onToolCallDelta }
    h.loopImpl = () => eventStream([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '文' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '思' } },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_delta', contentIndex: 1, delta: '{"a"',
          partial: { content: [{ type: 'text', text: '' }, { type: 'toolCall', id: 'c9', name: 'tool_b', arguments: {} }] },
        },
      },
      { type: 'message_update', assistantMessageEvent: { type: 'start' } },
      { type: 'message_start' },
      { type: 'agent_start' },
      { type: 'agent_end', messages: [] },
    ])
    await runPiAgentLoop(harness.params)
    expect(onChunk).toHaveBeenCalledWith('文')
    expect(onThought).toHaveBeenCalledWith('思')
    expect(onToolCallDelta).toHaveBeenCalledWith({ index: 1, id: 'c9', name: 'tool_b', arguments: '{"a"' })
  })

  it('tool_execution_start/end：事件、回调、args 缓存与 latencyMs', async () => {
    const harness = makeHarness()
    const onToolCall = vi.fn()
    const onToolResult = vi.fn()
    const onToolProgress = vi.fn()
    const executed: any[] = []
    harness.params.callbacks = { onToolCall, onToolResult, onToolProgress }
    harness.params.onToolCallExecuted = async (name: string, args: any, result: any) => {
      executed.push({ name, args, result })
    }
    const startEvents: any[] = []
    const endEvents: any[] = []
    harness.eventEmitter.on('tool:call:start', e => startEvents.push(e.data))
    harness.eventEmitter.on('tool:call:end', e => endEvents.push(e.data))

    h.loopImpl = () => eventStream([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'tool_a', args: { p: 1 } },
      { type: 'tool_execution_update', toolCallId: 'c1', toolName: 'tool_a', args: {}, partialResult: { details: { progress: 0.5 } } },
      { type: 'tool_execution_update', toolCallId: 'c1', toolName: 'tool_a', args: {}, partialResult: 'raw-progress' },
      {
        type: 'tool_execution_end', toolCallId: 'c1', toolName: 'tool_a', isError: false,
        result: { details: { success: true, output: 'OUT', rawOutput: { x: 1 }, generatedFiles: [{ path: 'f.docx' }] } },
      },
    ])
    await runPiAgentLoop(harness.params)

    expect(harness.agentContext.getIterationCount()).toBe(0)
    expect(startEvents).toEqual([{ tool: 'tool_a', args: { p: 1 } }])
    expect(endEvents).toEqual([{ tool: 'tool_a', success: true }])
    expect(onToolCall).toHaveBeenCalledWith({ id: 'c1', name: 'tool_a', args: { p: 1 } })
    expect(onToolProgress.mock.calls.map(c => c[0].progress)).toEqual([0.5, 'raw-progress'])
    expect(onToolResult).toHaveBeenCalledWith({
      name: 'tool_a', result: 'OUT', rawResult: { x: 1 },
      generatedFiles: [{ path: 'f.docx' }], success: true,
    })
    expect(executed).toHaveLength(1)
    expect(executed[0].name).toBe('tool_a')
    expect(executed[0].args).toEqual({ p: 1 })
    expect(executed[0].result).toMatchObject({ success: true, output: 'OUT', toolName: 'tool_a' })
    expect(typeof executed[0].result.latencyMs).toBe('number')
  })

  it('tool_execution_end 失败（isError）时 result 字段取 error', async () => {
    const harness = makeHarness()
    const onToolResult = vi.fn()
    harness.params.callbacks = { onToolResult }
    h.loopImpl = () => eventStream([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'tool_a', args: {} },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'tool_a', isError: true, result: { details: { error: 'E' } } },
    ])
    await runPiAgentLoop(harness.params)
    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ success: false, result: 'E' }))
  })

  it('onToolCallExecuted 抛错被吞掉，且 args 缓存被清理', async () => {
    const harness = makeHarness()
    const calls: any[] = []
    harness.params.onToolCallExecuted = async (_n: string, args: any) => {
      calls.push(args)
      throw new Error('hook failed')
    }
    h.loopImpl = () => eventStream([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'tool_a', args: { p: 1 } },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'tool_a', isError: false, result: { details: {} } },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'tool_a', isError: false, result: { details: {} } },
    ])
    await expect(runPiAgentLoop(harness.params)).resolves.toBeTruthy()
    expect(calls).toEqual([{ p: 1 }, {}])
  })

  it('无 onToolCallExecuted 时同样清理缓存且不抛错', async () => {
    const harness = makeHarness()
    harness.params.onToolCallExecuted = undefined
    h.loopImpl = () => eventStream([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'tool_a', args: {} },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'tool_a', isError: false, result: {} },
    ])
    await expect(runPiAgentLoop(harness.params)).resolves.toBeTruthy()
  })
})

describe('runPiAgentLoop / 中止语义', () => {
  it('事件迭代中 signal 被中止 → aborted + 原因，且中止后不再处理事件', async () => {
    const harness = makeHarness()
    const ctrl = new AbortController()
    // 第一个事件处理完成后才中止，避免竞态：后续事件不再处理
    h.loopImpl = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'turn_start' }
        ctrl.abort()
        yield { type: 'turn_start' }
      },
      result: async () => [],
    })
    const result = await runPiAgentLoop({ ...harness.params, signal: ctrl.signal })
    expect(result.aborted).toBe(true)
    expect(result.abortReason).toContain('用户主动停止')
    expect(harness.agentContext.getIterationCount()).toBe(1)
  })

  it('中止且底层抛 AbortError → 保留已累计 tokenUsage', async () => {
    const harness = makeHarness()
    const ctrl = new AbortController()
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'turn_end', message: assistantMessage({ usage: usage({ input: 10, output: 1, totalTokens: 11 }) }) }
        ctrl.abort()
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
      result: async () => assistantMessage(),
    }
    h.loopImpl = () => stream
    const result = await runPiAgentLoop({ ...harness.params, signal: ctrl.signal })
    expect(result.aborted).toBe(true)
    expect(result.tokenUsage).toMatchObject({ promptTokens: 10, totalTokens: 11 })
    expect(result.abortReason).toContain('用户主动停止')
  })

  it('中止但底层抛非 abort 异常 → 原因中带上异常信息', async () => {
    const harness = makeHarness()
    const ctrl = new AbortController()
    const stream = {
      async *[Symbol.asyncIterator]() {
        ctrl.abort()
        throw new Error('socket hang up')
        // eslint-disable-next-line no-unreachable
        yield undefined
      },
      result: async () => assistantMessage(),
    }
    h.loopImpl = () => stream
    const result = await runPiAgentLoop({ ...harness.params, signal: ctrl.signal })
    expect(result.aborted).toBe(true)
    expect(result.abortReason).toContain('socket hang up')
  })

  it('未中止时底层异常继续上抛', async () => {
    const harness = makeHarness()
    h.loopImpl = () => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('provider down')
        // eslint-disable-next-line no-unreachable
        yield undefined
      },
      result: async () => assistantMessage(),
    })
    await expect(runPiAgentLoop(harness.params)).rejects.toThrow('provider down')
  })
})

describe('runPiAgentLoop / 上下文截断与停止条件', () => {
  it('低于阈值时 transformContext 返回同一数组引用', async () => {
    const harness = makeHarness()
    await runPiAgentLoop(harness.params)
    const config = h.agentLoopCalls[0][2]
    const msgs = [{ role: 'user', content: 'x'.repeat(1000) }]
    expect(await config.transformContext(msgs)).toBe(msgs)
  })

  it('超阈值（>80k 估算 token）时仅保留最近 6 条 toolResult，更早的截断', async () => {
    const harness = makeHarness()
    await runPiAgentLoop(harness.params)
    const config = h.agentLoopCalls[0][2]
    const big = 'A'.repeat(45000)
    const msgs: any[] = Array.from({ length: 8 }, (_, i) => ({
      role: 'toolResult', toolCallId: `c${i}`, toolName: '', isError: false, content: [{ type: 'text', text: big }],
    }))
    const out = await config.transformContext(msgs)

    expect(out).not.toBe(msgs)
    expect(out[0].content[0].text.startsWith('[已截断] ')).toBe(true)
    expect(out[0].content[0].text).toContain('原 45000 字符，已截断以节省上下文')
    expect(out[0].content[0].text.length).toBeLessThan(500)
    // 最近 6 条完整保留
    for (let i = 2; i < 8; i++) {
      expect(out[i].content[0].text).toBe(big)
    }
  })

  it('已带截断前缀 / 短文本的 toolResult 在截断阶段原样保留', async () => {
    const harness = makeHarness()
    await runPiAgentLoop(harness.params)
    const config = h.agentLoopCalls[0][2]
    const already = '[已截断] ' + 'B'.repeat(900)
    const msgs: any[] = [
      { role: 'toolResult', toolCallId: 'c0', toolName: '', isError: false, content: [{ type: 'text', text: already }] },
      { role: 'toolResult', toolCallId: 'c1', toolName: '', isError: false, content: [{ type: 'text', text: 'short' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'C'.repeat(300000) }] },
    ]
    const out = await config.transformContext(msgs)
    expect(out[0].content[0].text).toBe(already)
    expect(out[1].content[0].text).toBe('short')
  })

  it('超阈值但无 toolResult 时内容不变，仅返回浅拷贝', async () => {
    const harness = makeHarness()
    await runPiAgentLoop(harness.params)
    const config = h.agentLoopCalls[0][2]
    const msgs: any[] = [{ role: 'user', content: 'x'.repeat(300000) }]
    const out = await config.transformContext(msgs)
    expect(out).not.toBe(msgs)
    expect(out).toEqual(msgs)
  })

  it('convertToLlm 对无图片的消息与其入参相等（视觉注入新建数组），shouldStopAfterTurn 按 maxIterations 计数', async () => {
    const harness = makeHarness({ maxIterations: 2 })
    await runPiAgentLoop(harness.params)
    const config = h.agentLoopCalls[0][2]
    const msgs = [{ role: 'user', content: 'x' }]
    expect(config.convertToLlm(msgs)).toEqual(msgs)
    // 含图片的 toolResult 被抽出包裹为 user 消息注入（默认不支持视觉 → 丢弃并提示）
    const withImages: any[] = [
      { role: 'user', content: 'q' },
      {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'read_image',
        content: [
          { type: 'text', text: '已读取图片' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        isError: false,
        timestamp: 1,
      },
    ]
    const out = config.convertToLlm(withImages)
    expect(out).toHaveLength(2)
    expect(out[1].content).toEqual([{ type: 'text', text: '已读取图片' }, { type: 'text', text: expect.stringContaining('当前模型不支持图片输入') }])
    expect(config.toolExecution).toBe('sequential')
    expect(config.shouldStopAfterTurn()).toBe(false)
    expect(config.shouldStopAfterTurn()).toBe(true)
    expect(config.shouldStopAfterTurn()).toBe(true)
  })

  it('enableThinking / sessionId 按需注入 loopConfig', async () => {
    const harness = makeHarness({
      config: { model: 'gpt-x', providerType: 'openai', enableThinking: 'high' as const },
      sessionId: 'sess-1',
    })
    await runPiAgentLoop(harness.params)
    const config = h.agentLoopCalls[0][2]
    expect(config.reasoning).toBe('high')
    expect(config.sessionId).toBe('sess-1')
  })

  it('createPiModel：compat thinkingFormat 供应商强制 reasoning=true，maxTokens/baseUrl 兜底', async () => {
    const harness = makeHarness({ config: { model: 'glm-4', providerType: 'zhipu' } })
    await runPiAgentLoop(harness.params)
    const model = h.agentLoopCalls[0][2].model
    expect(model.reasoning).toBe(true)
    expect(model.compat.thinkingFormat).toBe('zai')
    expect(model.compat.zaiToolStream).toBe(true)
    expect(model.baseUrl).toBe('https://api.openai.com/v1')
    expect(model.maxTokens).toBe(8192)
  })

  it('createPiModel：opencode-go 的 alwaysReasoning 与会话亲和头', async () => {
    const harness = makeHarness({
      config: { model: 'kimi-k2', providerType: 'opencode-go', baseUrl: 'https://x/v1' },
      sessionId: 's1',
    })
    await runPiAgentLoop(harness.params)
    const model = h.agentLoopCalls[0][2].model
    expect(model.reasoning).toBe(true)
    expect(model.baseUrl).toBe('https://x/v1')
    expect(model.compat.sendSessionAffinityHeaders).toBe(true)
    expect(model.compat.sessionAffinityFormat).toBe('openai-nosession')
  })
})

describe('wrapStreamWithLogging（经 streamFn 驱动）', () => {
  /** 直接取 createStreamFn 产出的包装流（由 mock 的 agentLoop 捕获） */
  async function captureWrappedStream(paramsOverride: Record<string, any> = {}) {
    const harness = makeHarness(paramsOverride)
    await runPiAgentLoop(harness.params)
    const streamFn = h.agentLoopCalls[0][4]
    return streamFn
  }

  it('正常流：事件按序转发，done 覆盖内容与 usage，日志记录 success', async () => {
    h.innerStreamFactory = () => innerStream([
      { type: 'text_delta', contentIndex: 0, delta: '部分' },
      { type: 'thinking_delta', contentIndex: 0, delta: '思考' },
      { type: 'toolcall_delta', contentIndex: 1, delta: '{"a":1}' },
      { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'c1', name: 'tool_a', arguments: { a: 1 } } },
      {
        type: 'done',
        reason: 'stop',
        message: assistantMessage({
          content: [
            { type: 'text', text: '最终正文' },
            { type: 'thinking', thinking: '最终思考' },
            { type: 'toolCall', id: 'c1', name: 'tool_a', arguments: { a: 1 } },
          ],
          usage: usage({ input: 100, output: 20, cacheRead: 30, totalTokens: 150 }),
        }),
      },
    ])
    const streamFn = await captureWrappedStream()
    const wrapped: any = await streamFn(undefined, { systemPrompt: 'SYS', messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'tool_a', description: 'd', parameters: {} }] }, { temperature: 0.5, maxTokens: 100 })

    const received: any[] = []
    for await (const ev of wrapped) received.push(ev.type)
    expect(received).toEqual(['text_delta', 'thinking_delta', 'toolcall_delta', 'toolcall_end', 'done'])

    const delegated = await wrapped.result()
    expect(delegated.role).toBe('assistant')

    expect(h.logCalls).toHaveLength(1)
    const log = h.logCalls[0]
    expect(log).toMatchObject({ type: 'chatStream', source: 'agent', model: 'gpt-x', providerType: 'openai' })
    expect(log.error).toBeUndefined()
    expect(log.request.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'q' },
    ])
    expect(log.request.tools).toEqual([{ type: 'function', function: { name: 'tool_a', description: 'd', parameters: {} } }])
    expect(log.request.temperature).toBe(0.5)
    expect(log.request.max_tokens).toBe(100)
    expect(log.response).toMatchObject({
      content: '最终正文',
      reasoningContent: '最终思考',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'tool_a', arguments: '{"a":1}' } }],
      usage: { promptTokens: 130, completionTokens: 20, totalTokens: 150, cachedTokens: 30 },
    })
    expect(typeof log.response.latencyMs).toBe('number')
  })

  it('toolcall_end 有值而 done 无 toolCall 时保留已累积工具调用', async () => {
    h.innerStreamFactory = () => innerStream([
      { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'c1', name: 'tool_a', arguments: {} } },
      { type: 'done', reason: 'stop', message: assistantMessage({ content: [{ type: 'text', text: 'x' }] }) },
    ])
    const streamFn = await captureWrappedStream()
    const wrapped: any = await streamFn(undefined, { messages: [] }, {})
    for await (const _ev of wrapped) { /* drain */ }
    expect(h.logCalls[0].response.toolCalls).toHaveLength(1)
  })

  it('error 事件：日志走 error 字段且不再记录 response，result 委托底层', async () => {
    const final = assistantMessage({ stopReason: 'error', errorMessage: '上游炸了' })
    h.innerStreamFactory = () => innerStream([
      { type: 'text_delta', contentIndex: 0, delta: 'abc' },
      { type: 'error', reason: 'error', error: final },
    ], final)
    const streamFn = await captureWrappedStream()
    const wrapped: any = await streamFn(undefined, { messages: [] }, {})
    for await (const _ev of wrapped) { /* drain */ }

    expect(h.logCalls[0].error).toBe('上游炸了')
    expect(h.logCalls[0].response).toBeUndefined()
    const res = await wrapped.result()
    expect(res.errorMessage).toBe('上游炸了')
  })

  it('error 事件无 errorMessage 时回退固定文案', async () => {
    h.innerStreamFactory = () => innerStream([{ type: 'error', reason: 'error', error: undefined }])
    const streamFn = await captureWrappedStream()
    const wrapped: any = await streamFn(undefined, { messages: [] }, {})
    for await (const _ev of wrapped) { /* drain */ }
    expect(h.logCalls[0].error).toBe('LLM 流式请求失败')
  })

  it('正文循环：命中后停止转发、中止底层、result() 返回合成错误消息', async () => {
    const deltas = Array.from({ length: 12 }, () => 'ab'.repeat(64))
    h.innerStreamFactory = () => innerStream(
      deltas.map(d => ({ type: 'text_delta', contentIndex: 0, delta: d })),
      assistantMessage({ content: [{ type: 'text', text: 'never' }] }),
    )
    const streamFn = await captureWrappedStream()
    const wrapped: any = await streamFn(undefined, { messages: [] }, {})
    const signal = h.streamCalls[h.streamCalls.length - 1].options.signal as AbortSignal
    expect(signal.aborted).toBe(false)

    const received: any[] = []
    for await (const ev of wrapped) received.push(ev)

    expect(received.length).toBeLessThan(deltas.length)
    expect(received.length).toBeGreaterThanOrEqual(8)
    expect(signal.aborted).toBe(true)

    const res = await wrapped.result()
    expect(res.stopReason).toBe('error')
    expect(res.errorMessage).toContain('检测到循环输出（正文）')
    expect(res.errorMessage).toContain('周期 32 字符')
    expect(res.content[0].text).toBe(deltas.slice(0, received.length + 1).join(''))
    expect(res.usage).toMatchObject({ input: 0, output: 0 })
    expect(h.logCalls[0].error).toContain('检测到循环输出（正文）')
    expect(h.logCalls[0].response).toBeUndefined()
  })

  it('思考循环：错误信息标注"思考"，合成消息保留已产出思考内容', async () => {
    const deltas = Array.from({ length: 12 }, () => '好的没问题'.repeat(20))
    h.innerStreamFactory = (m: any, c: any, options: any) => innerStream(
      deltas.map(d => ({ type: 'thinking_delta', contentIndex: 0, delta: d })),
    )
    const streamFn = await captureWrappedStream()
    const wrapped: any = await streamFn(undefined, { messages: [] }, {})
    const received: any[] = []
    for await (const ev of wrapped) received.push(ev)

    expect(received.length).toBeLessThan(deltas.length)
    const res = await wrapped.result()
    expect(res.errorMessage).toContain('检测到循环输出（思考）')
    expect(res.content.some((c: any) => c.type === 'thinking' && c.thinking.length > 0)).toBe(true)
  })

  it('工具参数循环：按 contentIndex 独立检测，命中后中断', async () => {
    const loopDeltas = Array.from({ length: 12 }, () => 'a","'.repeat(32))
    const otherDeltas = Array.from({ length: 3 }, () => 'ok')
    const events: any[] = [
      ...loopDeltas.map(d => ({ type: 'toolcall_delta', contentIndex: 1, delta: d })),
      ...otherDeltas.map(d => ({ type: 'toolcall_delta', contentIndex: 0, delta: d })),
    ]
    h.innerStreamFactory = () => innerStream(events)
    const streamFn = await captureWrappedStream()
    const wrapped: any = await streamFn(undefined, { messages: [] }, {})
    const received: any[] = []
    for await (const ev of wrapped) received.push(ev)

    expect(received.length).toBeLessThan(events.length)
    const res = await wrapped.result()
    expect(res.errorMessage).toContain('检测到循环输出（工具参数）')
  })

  it('跨流相同重复内容（各自未达阈值）不判为循环', async () => {
    const seg = 'abcdefgh'.repeat(60) // 480 字符
    h.innerStreamFactory = () => innerStream([
      { type: 'text_delta', contentIndex: 0, delta: seg },
      { type: 'thinking_delta', contentIndex: 0, delta: seg },
      { type: 'toolcall_delta', contentIndex: 0, delta: seg },
      { type: 'done', reason: 'stop', message: assistantMessage({ content: [{ type: 'text', text: seg }] }) },
    ])
    const streamFn = await captureWrappedStream()
    const wrapped: any = await streamFn(undefined, { messages: [] }, {})
    const received: any[] = []
    for await (const ev of wrapped) received.push(ev)
    expect(received).toHaveLength(4)
    expect((await wrapped.result()).stopReason).toBe('stop')
    expect(h.logCalls[0].error).toBeUndefined()
  })

  it('外部 signal 中止级联到内部请求 signal；已中止的 signal 立即级联', async () => {
    h.innerStreamFactory = () => innerStream([])
    const streamFn = await captureWrappedStream()
    const external = new AbortController()
    const wrapped: any = await streamFn(undefined, { messages: [] }, { signal: external.signal })
    const innerSignal = h.streamCalls[h.streamCalls.length - 1].options.signal as AbortSignal
    expect(innerSignal.aborted).toBe(false)
    external.abort()
    expect(innerSignal.aborted).toBe(true)

    const already = new AbortController()
    already.abort()
    await streamFn(undefined, { messages: [] }, { signal: already.signal })
    const signal2 = h.streamCalls[h.streamCalls.length - 1].options.signal as AbortSignal
    expect(signal2.aborted).toBe(true)
  })

  it('消费者提前 break 时日志仍只写一次', async () => {
    h.innerStreamFactory = () => innerStream([
      { type: 'text_delta', contentIndex: 0, delta: 'x' },
      { type: 'text_delta', contentIndex: 0, delta: 'y' },
    ])
    const streamFn = await captureWrappedStream()
    const wrapped: any = await streamFn(undefined, { messages: [] }, {})
    for await (const _ev of wrapped) break
    expect(h.logCalls).toHaveLength(1)
    expect(h.logCalls[0].response.content).toBe('x')
  })

  it('循环中断后继续产出的 delta 不再累积（检测短路）', async () => {
    const deltas = Array.from({ length: 14 }, () => 'ab'.repeat(64))
    h.innerStreamFactory = () => innerStream(deltas.map(d => ({ type: 'text_delta', contentIndex: 0, delta: d })))
    const streamFn = await captureWrappedStream()
    const wrapped: any = await streamFn(undefined, { messages: [] }, {})
    const received: any[] = []
    for await (const ev of wrapped) received.push(ev)
    const res = await wrapped.result()
    // 合成消息内容长度 == 触发检测那一刻的累积量（不含未转发的后续 delta）
    expect(res.content[0].text.length).toBeLessThan(deltas.join('').length)
  })
})
