import { describe, it, expect, vi } from 'vitest'
import {
  ToolMiddlewareChain,
  createRetryMiddleware,
  createTimeoutMiddleware,
  createResultSizeMiddleware,
} from '../../../electron/main/services/agent/tools/tool-middleware'
import type { ToolCallResult } from '../../../electron/main/services/agent/tools/types'

/**
 * 回归用例：中间件链在「重试」场景下的重入语义。
 *
 * 现有实现用单个 index 游标推进链；retry 中间件在第二次尝试时再次调用 next()，
 * 此时 index 已到链尾，会直接命中 handler，从而**跳过 timeout / result_size**。
 * 期望：重试的每一次尝试都应完整经过后续中间件（timeout 与 result_size）。
 */
describe('ToolMiddlewareChain 重试重入', () => {
  it('重试期间应再次经过 timeout 中间件（超时保护不丢失）', async () => {
    const chain = new ToolMiddlewareChain()
    const seen: string[] = []

    chain.use({
      name: 'retry',
      fn: async (_t, _a, next) => {
        // 第一次失败，第二次成功
        const first = await next()
        if (first.success) return first
        seen.push('retry-attempt-2')
        return next()
      },
    })
    chain.use({
      name: 'timeout',
      fn: async (_t, _a, next) => {
        seen.push('timeout')
        return next()
      },
    })

    let calls = 0
    await chain.execute('tool-x', {}, async () => {
      calls++
      return calls === 1
        ? { success: false, error: 'transient', toolName: 'tool-x' }
        : { success: true, output: 'ok', toolName: 'tool-x' }
    })

    expect(calls).toBe(2)
    // 第二次尝试也应经过 timeout；若被跳过则 seen 中只有一次 'timeout'
    const timeoutPasses = seen.filter(s => s === 'timeout').length
    expect(timeoutPasses).toBe(2)
  })

  it('重试期间应再次经过 result_size 中间件（结果截断不丢失）', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(1, 0))
    chain.use({ name: 'pass', fn: async (_t, _a, next) => next() })
    chain.use(createResultSizeMiddleware(10))

    let calls = 0
    const res = await chain.execute('tool-x', {}, async () => {
      calls++
      return calls === 1
        ? { success: false, error: 'timed out', toolName: 'tool-x' }
        : { success: true, output: 'X'.repeat(100), toolName: 'tool-x' }
    })

    // 若重试跳过 result_size，则 output 不会被截断为 10 字符
    expect(res.success).toBe(true)
    expect(String(res.output).startsWith('X'.repeat(10))).toBe(true)
    expect(String(res.output).length).toBeLessThan(100)
  })

  it('retry 每次尝试都应重新读取 _timeoutMs（自定义超时不因首次消费而丢失）', async () => {
    const chain = new ToolMiddlewareChain()
    const timeouts: number[] = []
    chain.use(createRetryMiddleware(1, 0))
    chain.use({
      name: 'timeout-spy',
      fn: async (_t, args, next) => {
        // 真实 timeout 中间件不删除 _timeoutMs，这里保持一致以验证重试时可再次读取
        timeouts.push(args._timeoutMs)
        return next()
      },
    })

    let calls = 0
    await chain.execute(
      'tool-x',
      { _timeoutMs: 305000 },
      async () => {
        calls++
        return calls === 1
          ? { success: false, error: 'timed out', toolName: 'tool-x' }
          : { success: true, output: 'ok', toolName: 'tool-x' }
      }
    )

    expect(timeouts.length).toBe(2)
    expect(timeouts[0]).toBe(305000)
    expect(timeouts[1]).toBe(305000)
  })

  it('timeout 中间件在 next 抛错时不残留定时器（不阻塞进程退出）', async () => {
    vi.useFakeTimers()
    try {
      const chain = new ToolMiddlewareChain()
      chain.use(createTimeoutMiddleware(10))
      await expect(
        chain.execute('boom', {}, async () => { throw new Error('boom') })
      ).rejects.toThrow('boom')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * 重试语义回归：
 * 1) 不可重试的错误（参数错误/权限拒绝）不应被反复执行 —— 注释声明的意图是「仅对瞬时故障重试」；
 * 2) 失败结果不应丢失 output / generatedFiles / latencyMs —— invoke_tool 的结构化错误上下文依赖 output。
 */
describe('retry 中间件语义', () => {
  it('不可重试的错误只执行一次（参数错误/不存在类错误不消耗重试配额）', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(2, 0))
    let calls = 0
    let handlerCalls = 0

    const res = await chain.execute('tool-x', {}, async () => {
      handlerCalls++
      return { success: false, error: '参数错误：缺少必填参数 path', toolName: 'tool-x' }
    })
    calls++

    expect(res.success).toBe(false)
    // 非瞬时错误不应重复执行 handler
    expect(handlerCalls).toBe(1)
  })

  it('瞬时错误（超时）仍应重试到上限', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(2, 0))
    let handlerCalls = 0
    const res = await chain.execute('tool-x', {}, async () => {
      handlerCalls++
      return { success: false, error: 'Tool "x" timed out after 100ms', toolName: 'tool-x' }
    })
    expect(res.success).toBe(false)
    expect(handlerCalls).toBe(3)
  })

  it('失败结果保留 output / generatedFiles / latencyMs', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(0, 0))
    const res = await chain.execute('tool-x', {}, async () => ({
      success: false,
      error: 'boom',
      output: '结构化诊断上下文',
      generatedFiles: [{ path: 'a.txt' }],
      rawOutput: { any: 1 },
      latencyMs: 12,
      toolName: 'tool-x',
    }))

    expect(res.success).toBe(false)
    expect(res.error).toBe('boom')
    expect(res.output).toBe('结构化诊断上下文')
    expect(res.generatedFiles).toEqual([{ path: 'a.txt' }])
    expect(res.latencyMs).toBe(12)
  })

  it('noRetry 工具失败时同样保留 output（诊断上下文不丢失）', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(2, 0))
    const res = await chain.execute('interactive', { _noRetry: true }, async () => ({
      success: false,
      error: '用户取消',
      output: '用户取消了写工作区外文件的操作',
      toolName: 'interactive',
    }))
    expect(res.success).toBe(false)
    expect(res.output).toBe('用户取消了写工作区外文件的操作')
  })
})

/**
 * 元工具嵌套分发的超时语义：
 * invoke_tool 自身未声明 timeoutMs，外层 timeout 中间件按默认 30s 兜底，
 * 而内层被调用工具的 timeoutMs 可能远大于 30s（javascript_exec 120s、shell_exec 310s）。
 * 期望：外层不应以更短的默认超时截断内层工具的长超时。
 */
describe('invoke_tool 嵌套超时', () => {
  it('外层默认超时不应截断内层工具（元工具须声明足额 timeoutMs）', async () => {
    const { ToolDispatcher } = await import('../../../electron/main/services/agent/tools/tool-dispatcher')
    const { ToolRegistry } = await import('../../../electron/main/services/agent/tools/tool-registry')
    const registry = new ToolRegistry()
    const dispatcher = new ToolDispatcher(registry)

    const chain = dispatcher.getMiddlewareChain()
    chain.use(createTimeoutMiddleware(50)) // 模拟 base-agent 的默认 30s（此处缩比）

    // 内层工具：声明 5s 超时，实际耗时 200ms
    registry.registerTool({
      id: 'slow_tool',
      name: 'slow_tool',
      title: '慢工具',
      description: 'simulate long running tool',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 5000,
      handler: async () => {
        await new Promise(r => setTimeout(r, 200))
        return { success: true, output: 'done' }
      },
      source: 'builtin',
      onDemand: true,
    })

    const { createInvokeToolTool } = await import('../../../electron/main/services/agent/tools/meta-tools')
    registry.registerTool(createInvokeToolTool(dispatcher, registry))

    const res = await dispatcher.dispatch('invoke_tool', { tool_name: 'slow_tool', args: {} })
    // 元工具自身须声明足额 timeoutMs，否则外层默认超时会先触发
    expect(res.success).toBe(true)
    expect(res.output).toBe('done')
  }, 20000)

  it('invoke_tool 声明的 timeoutMs 不小于内置按需工具的最大超时', async () => {
    const { ToolDispatcher } = await import('../../../electron/main/services/agent/tools/tool-dispatcher')
    const { ToolRegistry } = await import('../../../electron/main/services/agent/tools/tool-registry')
    const { createInvokeToolTool } = await import('../../../electron/main/services/agent/tools/meta-tools')

    const registry = new ToolRegistry()
    const dispatcher = new ToolDispatcher(registry)
    const invokeTool = createInvokeToolTool(dispatcher, registry)

    // shell_exec 声明 310s，交互类工具（file_write/file_edit/ask_user）声明 305s，
    // 元工具外层超时必须不小于这两者，否则被默认 30s 截断
    expect(invokeTool.timeoutMs).toBeGreaterThanOrEqual(310_000)
    // 内层已套用目标工具自身的重试链，外层不应再重试
    expect(invokeTool.noRetry).toBe(true)
  })
})
