import { describe, it, expect } from 'vitest'
import { ToolMiddlewareChain } from '../../../electron/main/services/agent/tools/tool-middleware'
import { toToolMiddleware } from '../../../electron/main/services/plugin/middleware-adapter'
import type { ToolCallResult } from '../../../electron/main/services/agent/tools/types'

describe('ToolMiddlewareChain.useFront', () => {
  it('useFront 插入的中间件最先执行，其后是既有链与 handler', async () => {
    const order: string[] = []
    const chain = new ToolMiddlewareChain()
    chain.use({ name: 'tail', fn: async (_t, _a, next) => { order.push('tail'); return next() } })
    chain.useFront({ name: 'head', fn: async (_t, _a, next) => { order.push('head'); return next() } })

    const res = await chain.execute('tool-x', {}, async () => {
      order.push('handler')
      return { success: true, output: 'ok', toolName: 'tool-x' }
    })

    expect(order).toEqual(['head', 'tail', 'handler'])
    expect(res.success).toBe(true)
  })

  it('useFront 的中间件可短路（不调用 next），handler 不被执行', async () => {
    const chain = new ToolMiddlewareChain()
    let handlerHit = false
    chain.useFront({
      name: 'gate',
      fn: async (toolName) => ({ success: false, error: 'blocked', toolName }),
    })

    const res = await chain.execute('tool-x', {}, async () => {
      handlerHit = true
      return { success: true, output: 'should-not', toolName: 'tool-x' }
    })

    expect(handlerHit).toBe(false)
    expect(res.success).toBe(false)
    expect(res.error).toBe('blocked')
  })
})

describe('toToolMiddleware（插件中间件适配）', () => {
  it('透传 result 时保留宿主字段（rawOutput/latencyMs 等）', async () => {
    const mw = toToolMiddleware(
      {
        name: 'audit',
        fn: async (_t, _a, next) => next(),
      },
      'calendar'
    )

    const hostNext = async (): Promise<ToolCallResult> => ({
      success: true,
      output: 'dir',
      toolName: 'ls',
      rawOutput: 'raw',
      latencyMs: 5,
      generatedFiles: [],
    })
    const res = await mw.fn('ls', {}, hostNext)

    expect(mw.name).toBe('plugin:calendar:audit')
    expect(res.success).toBe(true)
    expect(res.output).toBe('dir')
    expect(res.rawOutput).toBe('raw')
    expect(res.latencyMs).toBe(5)
  })

  it('短路返回（不调用 next）时构造错误结果', async () => {
    const mw = toToolMiddleware(
      {
        name: 'gate',
        fn: async (toolName) => ({ success: false, error: 'denied', toolName }),
      },
      'sec'
    )

    const res = await mw.fn('rm', {})
    expect(res.success).toBe(false)
    expect(res.error).toBe('denied')
    expect(res.toolName).toBe('rm')
  })

  it('中间件抛错被收敛为错误结果而非裸 throw', async () => {
    const mw = toToolMiddleware(
      {
        name: 'boom',
        fn: async () => { throw new Error('crash') },
      },
      'demo'
    )

    const res = await mw.fn('ls', {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('crash')
  })

  it('缺省成功/输出有兜底值', async () => {
    const mw = toToolMiddleware(
      {
        name: 'silent',
        fn: async () => ({}),
      },
      'demo'
    )

    const res = await mw.fn('ls', {})
    expect(res.success).toBe(true)
    expect(res.toolName).toBe('ls')
  })

  it('在真实宿主链上透传 next 时保留宿主字段（rawOutput/latencyMs/generatedFiles）', async () => {
    // 模拟宿主内置链（如 result_size 等）在插件中间件之后执行
    const chain = new ToolMiddlewareChain()
    chain.use({ name: 'result_size', fn: async (_t, _a, next) => next() })
    // 插件中间件 useFront 挂到链首
    chain.useFront(toToolMiddleware(
      { name: 'audit', fn: async (_t, _a, next) => next() },
      'calendar'
    ))

    const res = await chain.execute('ls', {}, async () => ({
      success: true,
      output: 'dir',
      toolName: 'ls',
      rawOutput: 'raw',
      latencyMs: 5,
      generatedFiles: [{ name: 'a.txt' }],
    }))

    // name 归一化与宿主字段透传（normalizeResult 还原）
    expect(res.success).toBe(true)
    expect(res.output).toBe('dir')
    expect(res.rawOutput).toBe('raw')
    expect(res.latencyMs).toBe(5)
    expect(res.generatedFiles).toEqual([{ name: 'a.txt' }])
  })

  it('短路时绕过后续宿主链（内置中间件与 handler 均不执行），但 name 归一到宿主', async () => {
    const chain = new ToolMiddlewareChain()
    let handlerHit = false
    let builtinHit = false
    chain.use({ name: 'builtin', fn: async (_t, _a, next) => { builtinHit = true; return next() } })
    chain.useFront(toToolMiddleware(
      { name: 'gate', fn: async (toolName) => ({ success: false, error: 'denied', toolName }) },
      'sec'
    ))

    const res = await chain.execute('rm', {}, async () => {
      handlerHit = true
      return { success: true, output: 'should-not', toolName: 'rm' }
    })

    expect(builtinHit).toBe(false)
    expect(handlerHit).toBe(false)
    expect(res).toMatchObject({ success: false, error: 'denied', toolName: 'rm' })
  })
})