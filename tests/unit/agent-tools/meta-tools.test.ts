import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRegistry } from '../../../electron/main/services/agent/tools/tool-registry'
import { ToolDispatcher } from '../../../electron/main/services/agent/tools/tool-dispatcher'
import {
  createInvokeToolTool,
  createListAvailableToolsTool,
} from '../../../electron/main/services/agent/tools/meta-tools'
import type { ToolDefinition } from '../../../electron/main/services/agent/tools/types'

function makeTool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    id: overrides.name,
    title: `标题-${overrides.name}`,
    description: `描述-${overrides.name}`,
    parameters: { type: 'object', properties: {} },
    handler: () => ({ success: true, output: `ran-${overrides.name}` }),
    source: 'builtin',
    onDemand: true,
    ...overrides,
  }
}

describe('agent/tools/meta-tools / list_available_tools', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  const list = () => createListAvailableToolsTool(registry)

  it('无按需工具时（含传入 tool_name）统一返回空提示', () => {
    registry.registerTool(makeTool({ name: 'resident', onDemand: false }))
    const handler = list().handler!
    expect(handler({})).toMatchObject({ success: true, output: '当前没有可用的按需工具。' })
    expect(handler({ tool_name: 'resident' })).toMatchObject({ success: true, output: '当前没有可用的按需工具。' })
  })

  it('摘要模式：summary 优先，缺失时回退 title，并附带调用指引', () => {
    registry.registerTool(makeTool({ name: 'a', summary: '一句话A', onDemand: true }))
    registry.registerTool(makeTool({ name: 'b', title: '标题B', onDemand: true }))
    const out = String(list().handler!({}).output)
    expect(out).toContain('可用按需工具（共 2 个）：')
    expect(out).toContain('- a: 一句话A')
    expect(out).toContain('- b: 标题B')
    expect(out).toContain('invoke_tool(tool_name="工具名", args={...})')
    expect(out).toContain('list_available_tools(tool_name="工具名")')
  })

  it('tool_name 为 null/undefined 时仍走摘要模式', () => {
    registry.registerTool(makeTool({ name: 'a', summary: 'S', onDemand: true }))
    const handler = list().handler!
    expect(String(handler({ tool_name: null }).output)).toContain('可用按需工具')
    expect(String(handler({ tool_name: undefined }).output)).toContain('可用按需工具')
  })

  it('详情模式（字符串）：输出标题、描述、参数说明与调用方式', () => {
    registry.registerTool(makeTool({
      name: 'detail',
      title: '详情工具',
      description: '详细描述文本',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '路径', default: '/tmp/x' },
          mode: { type: 'string', enum: ['a', 'b'] },
          count: { type: 'number', minimum: 1, maximum: 10 },
          auto: { type: 'boolean' },
        },
        required: ['path', 'mode'],
      },
    }))
    const out = String(list().handler!({ tool_name: 'detail' }).output)
    expect(out).toContain('## detail — 详情工具')
    expect(out).toContain('详细描述文本')
    expect(out).toContain('参数:')
    expect(out).toContain('path (string, 必填): 路径 [默认: "/tmp/x"]')
    expect(out).toContain('mode (string, 必填) [枚举: a / b]')
    expect(out).toContain('count (number, 可选) [最小: 1] [最大: 10]')
    expect(out).toContain('auto (boolean, 可选)')
    expect(out).toContain('调用方式: invoke_tool(tool_name="detail", args={...})')
  })

  it('无参数工具输出「(无参数)」', () => {
    registry.registerTool(makeTool({ name: 'noargs', parameters: { type: 'object', properties: {} } }))
    expect(String(list().handler!({ tool_name: 'noargs' }).output)).toContain('(无参数)')
  })

  it('详情模式（数组）：多个工具用分隔线拼接，顺序保持传入顺序', () => {
    registry.registerTool(makeTool({ name: 'x', description: 'DX' }))
    registry.registerTool(makeTool({ name: 'y', description: 'DY' }))
    const res = list().handler!({ tool_name: ['y', 'x'] })
    expect(res.success).toBe(true)
    const out = String(res.output)
    expect(out).toContain('## y — 标题-y')
    expect(out).toContain('## x — 标题-x')
    expect(out.indexOf('## y')).toBeLessThan(out.indexOf('## x'))
    expect(out).toContain('\n\n---\n\n')
  })

  it('工具名两侧空格被裁剪，数组中的空项被过滤', () => {
    registry.registerTool(makeTool({ name: 'spacey', description: 'D' }))
    expect(list().handler!({ tool_name: ['  spacey  '] }).success).toBe(true)
    expect(list().handler!({ tool_name: '  spacey  ' }).success).toBe(true)
    expect(list().handler!({ tool_name: ['', ' spacey '] }).success).toBe(true)
  })

  it('数组全为空白时返回参数错误', () => {
    registry.registerTool(makeTool({ name: 'a', onDemand: true }))
    expect(list().handler!({ tool_name: ['', '   '] })).toMatchObject({ success: false, error: 'tool_name 不能为空。' })
  })

  it('空字符串/纯空白工具名（非数组）返回参数错误，不再落入「未找到工具」分支', () => {
    registry.registerTool(makeTool({ name: 'a', onDemand: true }))
    const empty = list().handler!({ tool_name: '' })
    expect(empty).toMatchObject({ success: false, error: 'tool_name 不能为空。' })
    expect(String(empty.output)).not.toContain('未找到工具')
    expect(list().handler!({ tool_name: '   ' })).toMatchObject({ success: false, error: 'tool_name 不能为空。' })
  })

  it('未找到工具：success=false 并列出可用工具名', () => {
    registry.registerTool(makeTool({ name: 'a', onDemand: true }))
    registry.registerTool(makeTool({ name: 'b', onDemand: true }))
    const res = list().handler!({ tool_name: 'ghost' })
    expect(res.success).toBe(false)
    expect(String(res.output)).toContain('未找到工具: ghost。可用工具: a, b')
  })

  it('部分命中：success=true，同时给出详情与未找到提示', () => {
    registry.registerTool(makeTool({ name: 'a', description: 'DA' }))
    const res = list().handler!({ tool_name: ['a', 'ghost'] })
    expect(res.success).toBe(true)
    const out = String(res.output)
    expect(out).toContain('## a — 标题-a')
    expect(out).toContain('未找到工具: ghost')
  })

  it('非字符串工具名被 String() 转换后匹配', () => {
    registry.registerTool(makeTool({ name: '123' }))
    expect(list().handler!({ tool_name: 123 }).success).toBe(true)
  })

  it('仅常驻工具不会被详情模式检索到（只检索按需工具）', () => {
    registry.registerTool(makeTool({ name: 'res', onDemand: false }))
    registry.registerTool(makeTool({ name: 'lazy', onDemand: true }))
    const res = list().handler!({ tool_name: 'res' })
    expect(res.success).toBe(false)
    expect(String(res.output)).toContain('未找到工具: res。可用工具: lazy')
  })
})

describe('agent/tools/meta-tools / invoke_tool', () => {
  let registry: ToolRegistry
  let dispatcher: ToolDispatcher
  let receivedArgs: Record<string, any>[]

  beforeEach(() => {
    receivedArgs = []
    registry = new ToolRegistry()
    dispatcher = new ToolDispatcher(registry)
    registry.registerTool({
      id: 'ok_tool',
      name: 'ok_tool',
      title: 'OK',
      description: 'D',
      parameters: { type: 'object', properties: {} },
      onDemand: true,
      handler: (args) => { receivedArgs.push(args); return { success: true, output: 'OK-OUT', generatedFiles: [{ path: 'a.docx' }] } },
      source: 'builtin',
    })
    registry.registerTool(createInvokeToolTool(dispatcher, registry))
  })

  const invoke = () => registry.getTool('invoke_tool')!.handler!

  it('缺少 tool_name 时给出参数错误与结构化上下文', async () => {
    const res = await invoke()({}, undefined)
    expect(res.success).toBe(false)
    expect(res.error).toBe('参数错误：缺少 tool_name。')
    expect(String(res.output)).toContain('# 工具调用失败')
    expect(String(res.output)).toContain('invoke_tool 必填参数 tool_name 缺失')
    expect(String(res.output)).toContain('错误类型: param_error')
    expect(String(res.output)).toContain('参数: (空)')
    // 无 output 时省略「工具输出（调试上下文）」段
    expect(String(res.output)).not.toContain('--- 工具输出')
  })

  it('tool_name 为空白时同样报缺少参数', async () => {
    expect((await invoke()({ tool_name: '   ' })).error).toBe('参数错误：缺少 tool_name。')
    expect((await invoke()({ tool_name: null })).error).toBe('参数错误：缺少 tool_name。')
  })

  it('成功调用：透传 output 与 generatedFiles', async () => {
    const res = await invoke()({ tool_name: 'ok_tool', args: { a: 1 } })
    expect(res).toMatchObject({ success: true, output: 'OK-OUT' })
    expect(res.generatedFiles).toEqual([{ path: 'a.docx' }])
    expect(receivedArgs[0]).toEqual({ a: 1 })
  })

  it('args 为字符串/数组等非对象时返回参数错误，不再透传给目标工具', async () => {
    const str = await invoke()({ tool_name: 'ok_tool', args: 'not-an-object' })
    expect(str).toMatchObject({ success: false, error: 'args 必须是对象' })
    expect(String(str.output)).toContain('# 工具调用失败')

    const arr = await invoke()({ tool_name: 'ok_tool', args: [1, 2] })
    expect(arr).toMatchObject({ success: false, error: 'args 必须是对象' })

    // 目标工具未被调用
    expect(receivedArgs).toEqual([])
  })

  it('args 为 null/undefined 时视为未传，回退空对象', async () => {
    await invoke()({ tool_name: 'ok_tool', args: null })
    await invoke()({ tool_name: 'ok_tool' })
    expect(receivedArgs).toEqual([{}, {}])
  })

  it('目标工具不存在：error 与 output 均列出可用按需工具', async () => {
    const res = await invoke()({ tool_name: 'ghost', args: { x: 1 } })
    expect(res.success).toBe(false)
    expect(res.error).toBe('工具 "ghost" 不存在。可用工具: ok_tool')
    expect(String(res.output)).toContain('# 工具调用失败')
    expect(String(res.output)).toContain('工具: ghost')
    expect(String(res.output)).toContain('x=1')
    expect(String(res.output)).toContain('错误类型: not_found')
  })

  it('目标工具不存在且无按需工具时提示 (无)', async () => {
    const emptyRegistry = new ToolRegistry()
    const emptyDispatcher = new ToolDispatcher(emptyRegistry)
    const tool = createInvokeToolTool(emptyDispatcher, emptyRegistry)
    const res = await tool.handler({ tool_name: 'ghost' }, undefined)
    expect(res.error).toBe('工具 "ghost" 不存在。可用工具: (无)')
  })

  it('目标工具失败：保留简短 error，output 为结构化诊断上下文', async () => {
    registry.registerTool(makeTool({
      name: 'fail_tool',
      handler: () => ({
        success: false,
        error: '文件不存在: a.txt',
        output: '工具内部日志',
        generatedFiles: [{ path: 'partial.docx' }],
      }),
    }))
    const res = await invoke()({ tool_name: 'fail_tool', args: { path: 'a.txt' } })
    expect(res.success).toBe(false)
    expect(res.error).toBe('文件不存在: a.txt')
    const out = String(res.output)
    expect(out).toContain('错误类型: not_found')
    expect(out).toContain('文件不存在: a.txt')
    expect(out).toContain('修复建议: 检查参数是否正确')
    expect(out).toContain('--- 工具输出（调试上下文）---')
    expect(out).toContain('工具内部日志')
    expect(out).toContain('错误前已生成文件')
    expect(out).toContain('partial.docx')
    expect(res.generatedFiles).toEqual([{ path: 'partial.docx' }])
  })

  it('失败但无 error 字段时给出兜底 error；dispatcher 兜底的 output 仍被作为调试上下文保留', async () => {
    registry.registerTool(makeTool({
      name: 'silent_fail',
      handler: () => ({ success: false }),
    }))
    const res = await invoke()({ tool_name: 'silent_fail' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('工具 "silent_fail" 执行失败')
    expect(String(res.output)).toContain('错误信息: (无错误信息)')
    expect(String(res.output)).toContain('--- 工具输出（调试上下文）---')
    expect(String(res.output)).toContain('(工具执行成功，无输出)')
  })

  it('错误类型诊断：超时/权限/参数/解析/内部 各分支', async () => {
    const cases: Array<[string, string, string]> = [
      ['timeout_tool', '请求超时（timed out）', 'timeout'],
      ['perm_tool', '权限被拒绝：denied', 'permission_denied'],
      ['param_tool', '缺少必填参数 path', 'param_error'],
      ['parse_tool', 'Unexpected token in JSON', 'parse_error'],
      ['internal_tool', '数据库连接池耗尽', 'internal'],
    ]
    for (const [name, error, expected] of cases) {
      registry.registerTool(makeTool({ name, handler: () => ({ success: false, error }) }))
      const res = await invoke()({ tool_name: name })
      expect(String(res.output), name).toContain(`错误类型: ${expected}`)
    }
  })

  it('参数摘要超长被截断并标注字符数；空参数显示 (空)', async () => {
    registry.registerTool(makeTool({ name: 'boom', handler: () => ({ success: false, error: '崩溃' }) }))
    const long = await invoke()({ tool_name: 'boom', args: { content: 'y'.repeat(300) } })
    expect(String(long.output)).toContain('…(300字符)')

    const empty = await invoke()({ tool_name: 'boom' })
    expect(String(empty.output)).toContain('参数: (空)')
  })

  it('参数值含对象/数组/undefined/null 时摘要可读', async () => {
    registry.registerTool(makeTool({ name: 'boom2', handler: () => ({ success: false, error: '崩溃' }) }))
    const res = await invoke()({ tool_name: 'boom2', args: { obj: { k: 1 }, arr: [1, 2], u: undefined, n: null } })
    const out = String(res.output)
    expect(out).toContain('obj={"k":1}')
    expect(out).toContain('arr=[1,2]')
    expect(out).toContain('u=undefined')
    expect(out).toContain('n=null')
  })

  it('生成的错误上下文包含已生成文件的 name 兜底显示', async () => {
    registry.registerTool(makeTool({
      name: 'files_fail',
      handler: () => ({ success: false, error: '失败', generatedFiles: [{ name: 'only-name.txt' }] }),
    }))
    const res = await invoke()({ tool_name: 'files_fail' })
    expect(String(res.output)).toContain('- only-name.txt')
  })

  it('目标工具抛异常时经 dispatcher 收敛为失败上下文（不穿透 invoke_tool）', async () => {
    registry.registerTool(makeTool({ name: 'explodes', handler: () => { throw new Error('kaboom') } }))
    const res = await invoke()({ tool_name: 'explodes' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('kaboom')
    expect(String(res.output)).toContain('错误类型:')
  })

  it('元工具自身元信息：必填 tool_name/args，声明超时且不重试', () => {
    const tool = registry.getTool('invoke_tool')!
    expect(tool.parameters.required).toEqual(['tool_name', 'args'])
    expect(tool.timeoutMs).toBeGreaterThanOrEqual(310_000)
    expect(tool.noRetry).toBe(true)
    expect(tool.permission).toBe('safe')
  })
})
