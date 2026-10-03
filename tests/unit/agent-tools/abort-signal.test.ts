import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolDispatcher } from '../../../electron/main/services/agent/tools/tool-dispatcher'
import { ToolRegistry } from '../../../electron/main/services/agent/tools/tool-registry'
import { ToolMiddlewareChain, createTimeoutMiddleware } from '../../../electron/main/services/agent/tools/tool-middleware'
import type { ToolDefinition } from '../../../electron/main/services/agent/tools/types'

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: 'x',
    name: 'x',
    title: 'X',
    description: 'desc',
    parameters: { type: 'object', properties: {} },
    handler: () => ({ success: true, output: 'ok' }),
    source: 'builtin',
    ...overrides,
  }
}

function setup(tool: ToolDefinition) {
  const registry = new ToolRegistry()
  const dispatcher = new ToolDispatcher(registry)
  registry.registerTool(tool)
  return { registry, dispatcher }
}

describe('agent/tools/tool-dispatcher / signal 中止预检', () => {
  it('signal 已 aborted 时拒绝执行 handler，错误说明已被中止', async () => {
    const handler = vi.fn()
    const { dispatcher } = setup(makeTool({ handler }))
    const ctrl = new AbortController()
    ctrl.abort()
    const res = await dispatcher.dispatch('x', {}, { signal: ctrl.signal })
    expect(handler).not.toHaveBeenCalled()
    expect(res.success).toBe(false)
    expect(res.error).toContain('已被中止')
    expect(res.toolName).toBe('x')
    expect(typeof res.latencyMs).toBe('number')
  })

  it('signal 未中止时正常执行，signal 经 ctx 透传给 handler', async () => {
    let seenSignal: AbortSignal | undefined
    const { dispatcher } = setup(makeTool({
      handler: (_args, ctx) => { seenSignal = ctx?.signal; return { success: true, output: 'ok' } },
    }))
    const ctrl = new AbortController()
    const res = await dispatcher.dispatch('x', {}, { signal: ctrl.signal })
    expect(res.success).toBe(true)
    expect(seenSignal).toBe(ctrl.signal)
  })
})

describe('agent/tools/tool-middleware / timeout 接入 signal', () => {
  it('signal 已 aborted 时立即失败且不触发 next', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createTimeoutMiddleware(5000))
    const next = vi.fn(async () => ({ success: true as const, output: 'never', toolName: 't' }))
    const ctrl = new AbortController()
    ctrl.abort()
    const res = await chain.execute('t', { _signal: ctrl.signal }, next)
    expect(next).not.toHaveBeenCalled()
    expect(res).toMatchObject({ success: false, toolName: 't' })
    expect(res.error).toContain('已被中止')
  })

  it('等待期间被中止 → 立即收敛为中止错误，不等 handler/超时', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createTimeoutMiddleware(5000))
    const ctrl = new AbortController()
    const start = Date.now()
    const p = chain.execute('t', { _signal: ctrl.signal }, async () => {
      await new Promise(r => setTimeout(r, 500))
      return { success: true as const, output: 'late', toolName: 't' }
    })
    setTimeout(() => ctrl.abort(), 20)
    const res = await p
    expect(res.success).toBe(false)
    expect(res.error).toContain('已被中止')
    expect(Date.now() - start).toBeLessThan(400)
  }, 10000)

  it('handler 结束后配对移除 abort 监听（不向 signal 堆积监听器）', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createTimeoutMiddleware(5000))
    const ctrl = new AbortController()
    const spy = vi.spyOn(ctrl.signal, 'removeEventListener')
    await chain.execute('t', { _signal: ctrl.signal }, async () => ({ success: true as const, output: 'done', toolName: 't' }))
    expect(spy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('未注入 signal 时行为不变（正常返回 handler 结果）', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createTimeoutMiddleware(200))
    const res = await chain.execute('t', {}, async () => ({ success: true as const, output: 'fast', toolName: 't' }))
    expect(res.output).toBe('fast')
  })

  it('dispatcher 整链：等待期间中止立即返回中止错误（_signal 注入生效）', async () => {
    const { dispatcher } = setup(makeTool({
      handler: async () => { await new Promise(r => setTimeout(r, 500)); return { success: true, output: 'late' } },
    }))
    dispatcher.getMiddlewareChain().use(createTimeoutMiddleware(5000))
    const ctrl = new AbortController()
    const p = dispatcher.dispatch('x', {}, { signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 20)
    const res = await p
    expect(res.success).toBe(false)
    expect(res.error).toContain('已被中止')
  }, 10000)
})

/** 通过 mock 交互服务验证 ask_user 对 signal 的响应（参照 ask-user.tool.test.ts 的 mock 方式） */
const interactionState = vi.hoisted(() => ({
  // 每次调用手动控制的 pending promise，resolve 函数按序存入 pendingResolves
  pendingResolves: [] as any[],
}))

vi.mock('../../../electron/main/services/unified-interaction.service', () => ({
  default: {
    getInstance: () => ({
      request: async () => new Promise((resolve) => { interactionState.pendingResolves.push(resolve) }),
    }),
  },
  INTERACTION_TIMEOUT_MS: 300000,
}))

const { askUserTool } = await import('../../../electron/main/services/agent/tools/ask-user.tool')

describe('agent/tools/ask-user.tool / signal 中止', () => {
  beforeEach(() => {
    interactionState.pendingResolves = []
  })

  it('signal 已 aborted → 立即返回取消，不发起交互', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const res = await askUserTool.handler!({ type: 'confirm', message: 'M' }, { signal: ctrl.signal })
    expect(res).toMatchObject({ success: false, cancelled: true })
    expect(res.error).toContain('取消')
    expect(interactionState.pendingResolves).toHaveLength(0)
  })

  it('等待期间被中止 → 立即返回取消，不等交互响应', async () => {
    const ctrl = new AbortController()
    const start = Date.now()
    const p = askUserTool.handler!({ type: 'confirm', message: 'M' }, { signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 20)
    const res = await p
    expect(Date.now() - start).toBeLessThan(400)
    expect(res).toMatchObject({ success: false, cancelled: true })
    expect(interactionState.pendingResolves).toHaveLength(1)
  }, 10000)

  it('有 signal 但正常响应时行为不变，交互完成后移除 abort 监听', async () => {
    const ctrl = new AbortController()
    const spy = vi.spyOn(ctrl.signal, 'removeEventListener')
    const p = askUserTool.handler!({ type: 'confirm', message: 'M' }, { signal: ctrl.signal })
    interactionState.pendingResolves[0]({ id: 'i', cancelled: false, confirmed: true })
    const res = await p
    expect(res).toMatchObject({ success: true, confirmed: true, output: '用户确认了操作' })
    expect(spy).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(ctrl.signal.aborted).toBe(false)
  })
})
