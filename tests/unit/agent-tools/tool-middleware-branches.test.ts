import { describe, it, expect, vi } from 'vitest'
import {
  ToolMiddlewareChain,
  createLoggingMiddleware,
  createPermissionMiddleware,
  createResultSizeMiddleware,
  createRetryMiddleware,
  createTimeoutMiddleware,
  isRetryableToolError,
} from '../../../electron/main/services/agent/tools/tool-middleware'
import type { ToolCallResult } from '../../../electron/main/services/agent/tools/types'

const ok = (output?: any): ToolCallResult => ({ success: true, output, toolName: 't' })
const fail = (error: string): ToolCallResult => ({ success: false, error, toolName: 't' })

describe('agent/tools/tool-middleware / isRetryableToolError', () => {
  it('空值不可重试', () => {
    expect(isRetryableToolError(null)).toBe(false)
    expect(isRetryableToolError(undefined)).toBe(false)
    expect(isRetryableToolError('')).toBe(false)
  })

  it('超时/网络/限流/服务端错误可重试', () => {
    expect(isRetryableToolError(new Error('Request timeout'))).toBe(true)
    expect(isRetryableToolError(new Error('operation TIMED OUT'))).toBe(true)
    expect(isRetryableToolError(new Error('read ECONNRESET'))).toBe(true)
    expect(isRetryableToolError(new Error('connect ENETUNREACH'))).toBe(true)
    expect(isRetryableToolError(new Error('ECONNREFUSED 127.0.0.1'))).toBe(true)
    expect(isRetryableToolError(new Error('Rate Limit exceeded'))).toBe(true)
    expect(isRetryableToolError(new Error('HTTP 429'))).toBe(true)
    expect(isRetryableToolError(new Error('socket hang up'))).toBe(true)
  })

  it('status/statusCode ≥500 可重试（含数值状态码以外的对象形态）', () => {
    expect(isRetryableToolError({ status: 500 })).toBe(true)
    expect(isRetryableToolError({ status: 503 })).toBe(true)
    expect(isRetryableToolError({ statusCode: 502 })).toBe(true)
    expect(isRetryableToolError({ status: 404 })).toBe(false)
  })

  it('普通业务错误/参数错误不可重试', () => {
    expect(isRetryableToolError(new Error('文件不存在'))).toBe(false)
    expect(isRetryableToolError(new Error('参数错误：缺少 path'))).toBe(false)
    expect(isRetryableToolError({ status: 400 })).toBe(false)
  })
})

describe('agent/tools/tool-middleware / retry', () => {
  it('成功结果直接返回，不重试', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(2, 0))
    let calls = 0
    const res = await chain.execute('t', {}, async () => { calls++; return ok('done') })
    expect(res.success).toBe(true)
    expect(calls).toBe(1)
  })

  it('noRetry 且 next 抛错时收敛为错误结果而非冒泡', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(2, 0))
    let calls = 0
    const res = await chain.execute('t', { _noRetry: true }, async () => {
      calls++
      throw new Error('接口已取消')
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('接口已取消')
    expect(calls).toBe(1)
  })

  it('noRetry 且业务失败时原样返回（保留 output/生成文件）', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(2, 0))
    let calls = 0
    const res = await chain.execute('t', { _noRetry: true }, async () => {
      calls++
      return { success: false, error: '用户取消', output: '诊断上下文', generatedFiles: [{ path: 'a' }], toolName: 't' }
    })
    expect(calls).toBe(1)
    expect(res.output).toBe('诊断上下文')
    expect(res.generatedFiles).toEqual([{ path: 'a' }])
  })

  it('不可重试的异常只执行一次', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(2, 0))
    let calls = 0
    const res = await chain.execute('t', {}, async () => {
      calls++
      throw new Error('参数错误：缺少 path')
    })
    expect(calls).toBe(1)
    expect(res.success).toBe(false)
    expect(res.error).toContain('参数错误')
  })

  it('可重试异常最终耗尽配额后返回最后一次异常信息', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(2, 0))
    let calls = 0
    const res = await chain.execute('t', {}, async () => {
      calls++
      throw new Error(`socket hang up #${calls}`)
    })
    expect(calls).toBe(3)
    expect(res.success).toBe(false)
    expect(res.error).toContain('socket hang up #3')
  })

  it('混合场景：先抛可重试异常、再返回可重试失败结果 → 返回最后一次失败结果', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(1, 0))
    let calls = 0
    const res = await chain.execute('t', {}, async () => {
      calls++
      if (calls === 1) throw new Error('timeout')
      return { success: false, error: 'timed out again', output: 'diag', toolName: 't' }
    })
    expect(calls).toBe(2)
    expect(res.success).toBe(false)
    expect(res.error).toBe('timed out again')
    expect(res.output).toBe('diag')
  })

  it('maxRetries=0 时只执行一次', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(0, 0))
    let calls = 0
    await chain.execute('t', {}, async () => { calls++; return ok('x') })
    expect(calls).toBe(1)
  })

  it('指数退避：baseDelayMs=0 时不应引入额外延迟', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createRetryMiddleware(2, 0))
    const start = Date.now()
    await chain.execute('t', {}, async () => fail('rate limit'))
    expect(Date.now() - start).toBeLessThan(200)
  })
})

describe('agent/tools/tool-middleware / permission', () => {
  it('允许时透传结果', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createPermissionMiddleware(() => true))
    const res = await chain.execute('allowed', {}, async () => ok('yes'))
    expect(res.success).toBe(true)
    expect(res.output).toBe('yes')
  })

  it('拒绝时不执行 handler，并触发 onDenied 回调', async () => {
    const chain = new ToolMiddlewareChain()
    const denied: string[] = []
    let handlerHit = false
    chain.use(createPermissionMiddleware(() => false, name => denied.push(name)))
    const res = await chain.execute('blocked', {}, async () => { handlerHit = true; return ok() })
    expect(handlerHit).toBe(false)
    expect(denied).toEqual(['blocked'])
    expect(res.success).toBe(false)
    expect(res.error).toBe('Tool "blocked" is not allowed')
    expect(res.toolName).toBe('blocked')
  })

  it('未提供 onDenied 时拒绝不报错', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createPermissionMiddleware(() => false))
    const res = await chain.execute('blocked', {}, async () => ok())
    expect(res.success).toBe(false)
  })
})

describe('agent/tools/tool-middleware / logging', () => {
  it('记录开始与结束，并在结束时带上 success 与耗时', async () => {
    const logger = vi.fn()
    const chain = new ToolMiddlewareChain()
    chain.use(createLoggingMiddleware(logger))
    await chain.execute('t', { a: 1 }, async () => ok('done'))

    expect(logger).toHaveBeenNthCalledWith(1, 'info', 'tool_call_start', { tool: 't', args: { a: 1 } })
    const endCall = logger.mock.calls[1]
    expect(endCall[0]).toBe('info')
    expect(endCall[1]).toBe('tool_call_end')
    expect(endCall[2]).toMatchObject({ tool: 't', success: true })
    expect(typeof endCall[2].latencyMs).toBe('number')
  })

  it('handler 抛错时记录 error 并继续抛出（不吞异常）', async () => {
    const logger = vi.fn()
    const chain = new ToolMiddlewareChain()
    chain.use(createLoggingMiddleware(logger))
    await expect(
      chain.execute('t', {}, async () => { throw new Error('kaboom') })
    ).rejects.toThrow('kaboom')
    expect(logger.mock.calls[1][1]).toBe('tool_call_error')
    expect(logger.mock.calls[1][2]).toMatchObject({ tool: 't', error: 'kaboom' })
  })
})

describe('agent/tools/tool-middleware / result_size', () => {
  it('超长字符串结果被截断并标注原始大小', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createResultSizeMiddleware(100))
    const res = await chain.execute('t', {}, async () => ok('A'.repeat(500)))
    expect(String(res.output)).toContain('[结果已截断，原始大小: 500 字符]')
    expect(String(res.output).length).toBeLessThan(500)
  })

  it('未超限时不改动结果', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createResultSizeMiddleware(100))
    const res = await chain.execute('t', {}, async () => ok('short'))
    expect(res.output).toBe('short')
  })

  it('失败结果不做截断（保留原始诊断信息）', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createResultSizeMiddleware(10))
    const res = await chain.execute('t', {}, async () => fail('X'.repeat(100)))
    expect(res.error).toBe('X'.repeat(100))
  })

  it('对象 output 会按 JSON 序列化长度判断并截断为字符串', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createResultSizeMiddleware(20))
    const res = await chain.execute('t', {}, async () => ok({ data: 'y'.repeat(100) }))
    expect(typeof res.output).toBe('string')
    expect(String(res.output)).toContain('结果已截断')
    expect(res.success).toBe(true)
  })

  it('循环引用对象序列化失败时回退 String() 并原样返回对象', async () => {
    const circular: any = { a: 1 }
    circular.self = circular
    const chain = new ToolMiddlewareChain()
    chain.use(createResultSizeMiddleware(20))
    const res = await chain.execute('t', {}, async () => ok(circular))
    expect(res.output).toBe(circular)
  })

  it('空 output / 空字符串不做处理', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createResultSizeMiddleware(5))
    expect((await chain.execute('t', {}, async () => ok())).output).toBeUndefined()
    expect((await chain.execute('t', {}, async () => ok(''))).output).toBe('')
  })
})

describe('agent/tools/tool-middleware / timeout', () => {
  it('未超时时正常返回并清理定时器', async () => {
    vi.useFakeTimers()
    try {
      const chain = new ToolMiddlewareChain()
      chain.use(createTimeoutMiddleware(1000))
      const p = chain.execute('t', {}, async () => ok('fast'))
      const res = await p
      expect(res.output).toBe('fast')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('超时错误信息包含工具名与超时值', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createTimeoutMiddleware(20))
    await expect(
      chain.execute('slow', {}, async () => {
        await new Promise(r => setTimeout(r, 200))
        return ok()
      })
    ).rejects.toThrow('Tool "slow" timed out after 20ms')
  }, 10000)

  it('_timeoutMs 覆盖默认超时', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createTimeoutMiddleware(5000))
    await expect(
      chain.execute('slow', { _timeoutMs: 20 }, async () => {
        await new Promise(r => setTimeout(r, 200))
        return ok()
      })
    ).rejects.toThrow('timed out after 20ms')
  }, 10000)

  it('多次执行共用同一中间件实例互不影响', async () => {
    const chain = new ToolMiddlewareChain()
    chain.use(createTimeoutMiddleware(200))
    for (let i = 0; i < 3; i++) {
      const res = await chain.execute('t', {}, async () => ok(`run-${i}`))
      expect(res.output).toBe(`run-${i}`)
    }
  })
})

describe('agent/tools/tool-middleware / 链组合', () => {
  it('useFront 多次插入按后插先执行；use 多次追加按插入顺序执行', async () => {
    const order: string[] = []
    const chain = new ToolMiddlewareChain()
    chain.use({ name: 'a', fn: async (_t, _a, next) => { order.push('a'); return next() } })
    chain.use({ name: 'b', fn: async (_t, _a, next) => { order.push('b'); return next() } })
    chain.useFront({ name: 'f1', fn: async (_t, _a, next) => { order.push('f1'); return next() } })
    chain.useFront({ name: 'f2', fn: async (_t, _a, next) => { order.push('f2'); return next() } })
    await chain.execute('t', {}, async () => { order.push('handler'); return ok() })
    expect(order).toEqual(['f2', 'f1', 'a', 'b', 'handler'])
  })

  it('中间件链可声明式复用（use 返回自身）', () => {
    const chain = new ToolMiddlewareChain()
    const returned = chain.use({ name: 'x', fn: async (_t, _a, next) => next() }).useFront({ name: 'y', fn: async (_t, _a, next) => next() })
    expect(returned).toBe(chain)
  })

  it('空链直接调用 handler', async () => {
    const chain = new ToolMiddlewareChain()
    const res = await chain.execute('t', {}, async () => ok('direct'))
    expect(res.output).toBe('direct')
  })
})
