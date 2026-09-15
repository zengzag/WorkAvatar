import { describe, it, expect, vi } from 'vitest'
import { ToolDispatcher } from '../../../electron/main/services/agent/tools/tool-dispatcher'
import { ToolRegistry } from '../../../electron/main/services/agent/tools/tool-registry'
import { createTimeoutMiddleware } from '../../../electron/main/services/agent/tools/tool-middleware'
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

describe('agent/tools/tool-dispatcher / 工具查找', () => {
  it('未注册的工具返回 not found，且不带 latencyMs', async () => {
    const { dispatcher } = setup(makeTool())
    const res = await dispatcher.dispatch('missing', {})
    expect(res).toMatchObject({ success: false, toolName: 'missing' })
    expect(res.error).toBe('Tool "missing" not found')
    expect(res.latencyMs).toBeUndefined()
  })

  it('构造 dispatcher 时可省略 registry（内部自建空注册表）', async () => {
    const res = await new ToolDispatcher().dispatch('anything', {})
    expect(res.success).toBe(false)
  })
})

describe('agent/tools/tool-dispatcher / 结果归一化', () => {
  it('handler 返回 undefined → 视为成功并给出占位 output', async () => {
    const { dispatcher } = setup(makeTool({ handler: () => undefined }))
    const res = await dispatcher.dispatch('x', {})
    expect(res.success).toBe(true)
    expect(res.output).toBe('(工具执行成功，无输出)')
    expect(res.rawOutput).toBeUndefined()
  })

  it('handler 返回 null → 视为成功并给出占位 output', async () => {
    const { dispatcher } = setup(makeTool({ handler: () => null }))
    const res = await dispatcher.dispatch('x', {})
    expect(res.success).toBe(true)
    expect(res.output).toBe('(工具执行成功，无输出)')
  })

  it('handler 返回裸对象（无 success/output）→ JSON 序列化后作为 output', async () => {
    const { dispatcher } = setup(makeTool({ handler: () => ({ foo: 1, bar: 'baz' }) }))
    const res = await dispatcher.dispatch('x', {})
    expect(res.success).toBe(true)
    expect(JSON.parse(String(res.output))).toEqual({ foo: 1, bar: 'baz' })
  })

  it('handler 仅返回 { success: true } → output 为占位文案', async () => {
    const { dispatcher } = setup(makeTool({ handler: () => ({ success: true }) }))
    const res = await dispatcher.dispatch('x', {})
    expect(res.success).toBe(true)
    expect(res.output).toBe('(工具执行成功，无输出)')
  })

  it('handler 返回字符串 → 原样作为 output', async () => {
    const { dispatcher } = setup(makeTool({ handler: () => 'plain text' as never }))
    const res = await dispatcher.dispatch('x', {})
    expect(res.success).toBe(true)
    expect(res.output).toBe('plain text')
  })

  it('handler 返回数字/布尔 → 转字符串', async () => {
    const numCase = setup(makeTool({ handler: () => 42 as never }))
    expect((await numCase.dispatcher.dispatch('x', {})).output).toBe('42')
    const boolCase = setup(makeTool({ handler: () => false as never }))
    expect((await boolCase.dispatcher.dispatch('x', {})).output).toBe('false')
  })

  it('success:false 时保留 output 与 generatedFiles（诊断上下文）', async () => {
    const { dispatcher } = setup(makeTool({
      handler: () => ({
        success: false,
        error: '失败原因',
        output: '调试上下文',
        generatedFiles: [{ path: 'a.txt' }],
      }),
    }))
    const res = await dispatcher.dispatch('x', {})
    expect(res.success).toBe(false)
    expect(res.error).toBe('失败原因')
    expect(res.output).toBe('调试上下文')
    expect(res.generatedFiles).toEqual([{ path: 'a.txt' }])
    expect(res.rawOutput).toMatchObject({ success: false })
    expect(typeof res.latencyMs).toBe('number')
  })

  it('循环引用对象在序列化失败时回退 String()，不影响成功判定', async () => {
    const circular: any = { a: 1 }
    circular.self = circular
    const { dispatcher } = setup(makeTool({ handler: () => circular }))
    const res = await dispatcher.dispatch('x', {})
    expect(res.success).toBe(true)
    expect(res.output).toBe('[object Object]')
  })
})

describe('agent/tools/tool-dispatcher / 参数隔离', () => {
  it('handler 收到的参数不含中间件注入的 _timeoutMs / _noRetry', async () => {
    const seen: Record<string, any>[] = []
    const { dispatcher } = setup(makeTool({
      timeoutMs: 1234,
      noRetry: true,
      handler: (args) => { seen.push({ ...args }); return { success: true, output: 'ok' } },
    }))
    const spy = vi.fn()
    dispatcher.getMiddlewareChain().use({
      name: 'spy',
      fn: async (_t, args, next) => { spy(); seen.push({ ...args }); return next() },
    })

    await dispatcher.dispatch('x', { p: 'v' })
    expect(spy).toHaveBeenCalled()
    // 中间件可见内部字段
    expect(seen[0]).toMatchObject({ p: 'v', _timeoutMs: 1234, _noRetry: true })
    // handler 只拿到原始参数
    expect(seen[1]).toEqual({ p: 'v' })
  })

  it('未声明 timeoutMs/noRetry 时不注入内部字段（除非 timeout 中间件补默认值）', async () => {
    const middlewareArgs: Record<string, any>[] = []
    const { dispatcher } = setup(makeTool({ handler: () => ({ success: true, output: 'ok' }) }))
    dispatcher.getMiddlewareChain().use({
      name: 'capture',
      fn: async (_t, args, next) => { middlewareArgs.push({ ...args }); return next() },
    })
    await dispatcher.dispatch('x', { a: 1 })
    expect(middlewareArgs[0]).toEqual({ a: 1 })
  })

  it('context 透传给 handler', async () => {
    const onProgress = vi.fn()
    const { dispatcher } = setup(makeTool({
      handler: (_args, ctx) => { ctx?.onProgress?.('p'); return { success: true, output: 'ok' } },
    }))
    await dispatcher.dispatch('x', {}, { onProgress })
    expect(onProgress).toHaveBeenCalledWith('p')
  })
})

describe('agent/tools/tool-dispatcher / 中间件链', () => {
  it('中间件可在 handler 前短路，且返回结果被补上 latencyMs', async () => {
    const handler = vi.fn(() => ({ success: true, output: 'should-not-run' }))
    const { dispatcher } = setup(makeTool({ handler }))
    dispatcher.getMiddlewareChain().useFront({
      name: 'gate',
      fn: async (toolName) => ({ success: false, error: 'blocked', toolName }),
    })
    const res = await dispatcher.dispatch('x', {})
    expect(handler).not.toHaveBeenCalled()
    expect(res.success).toBe(false)
    expect(res.error).toBe('blocked')
    expect(typeof res.latencyMs).toBe('number')
  })

  it('中间件抛错被上层 try/catch 包成「未捕获异常」结果', async () => {
    const { dispatcher } = setup(makeTool())
    dispatcher.getMiddlewareChain().use({
      name: 'boom',
      fn: async () => { throw new Error('middleware exploded') },
    })
    const res = await dispatcher.dispatch('x', {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('middleware exploded')
  })

  it('工具超时：timeout 中间件按工具声明的 _timeoutMs 触发并收敛为错误结果', async () => {
    const { dispatcher } = setup(makeTool({
      timeoutMs: 30,
      handler: async () => { await new Promise(r => setTimeout(r, 300)); return { success: true, output: 'late' } },
    }))
    dispatcher.getMiddlewareChain().use(createTimeoutMiddleware(5000))
    const res = await dispatcher.dispatch('x', {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('timed out after 30ms')
    expect(typeof res.latencyMs).toBe('number')
  }, 10000)

  it('工具未声明 timeoutMs 时回退到中间件默认值', async () => {
    const { dispatcher } = setup(makeTool({
      handler: async () => { await new Promise(r => setTimeout(r, 300)); return { success: true, output: 'late' } },
    }))
    dispatcher.getMiddlewareChain().use(createTimeoutMiddleware(30))
    const res = await dispatcher.dispatch('x', {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('timed out after 30ms')
  }, 10000)
})

describe('agent/tools/tool-dispatcher / 未捕获异常格式化', () => {
  it('包含工具名、参数摘要（跳过 _ 前缀字段）与堆栈', async () => {
    const { dispatcher } = setup(makeTool({
      handler: () => { throw new RangeError('参数越界') },
    }))
    const res = await dispatcher.dispatch('x', { path: 'a.txt', _timeoutMs: 1 })
    expect(res.success).toBe(false)
    expect(res.error).toContain('工具 "x" 抛出未捕获异常: 参数越界')
    expect(res.error).toContain('参数: path=a.txt')
    expect(res.error).not.toContain('_timeoutMs')
    expect(res.error).toContain('错误类型: RangeError')
    expect(res.error).toContain('堆栈:')
    expect(res.error).toContain('建议：检查参数是否符合工具 schema')
  })

  it('超长参数值被截断并标注原始长度', async () => {
    const long = 'z'.repeat(300)
    const { dispatcher } = setup(makeTool({
      handler: () => { throw new Error('boom') },
    }))
    const res = await dispatcher.dispatch('x', { content: long })
    expect(res.error).toContain('…(300字符)')
    expect(res.error).not.toContain('z'.repeat(201))
  })

  it('null/undefined 与对象参数有可读的描述', async () => {
    const { dispatcher } = setup(makeTool({
      handler: () => { throw new Error('boom') },
    }))
    const res = await dispatcher.dispatch('x', { a: null, b: undefined, c: { k: 1 } })
    expect(res.error).toContain('a=null')
    expect(res.error).toContain('b=undefined')
    expect(res.error).toContain('c={"k":1}')
  })

  it('抛出的非 Error 值（字符串）也能格式化', async () => {
    const { dispatcher } = setup(makeTool({
      handler: () => { throw 'plain-string-error' },
    }))
    const res = await dispatcher.dispatch('x', {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('plain-string-error')
    expect(res.error).toContain('错误类型: String')
  })

  it('参数为空对象时省略参数摘要行', async () => {
    const { dispatcher } = setup(makeTool({
      handler: () => { throw new Error('boom') },
    }))
    const res = await dispatcher.dispatch('x', {})
    expect(res.error).not.toContain('参数:')
    expect(res.error).toContain('工具 "x" 抛出未捕获异常: boom')
  })
})
