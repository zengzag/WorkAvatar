import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../../../electron/main/services/agent/tools/tool-registry'
import type { ToolDefinition } from '../../../electron/main/services/agent/tools/types'

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: 't1',
    name: 't1',
    title: 'T1',
    description: 'desc',
    parameters: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] },
    handler: () => ({ success: true, output: 'ok' }),
    source: 'builtin',
    ...overrides,
  }
}

describe('agent/tools/tool-registry', () => {
  it('注册后可按名查询并生成 OpenAI schema', () => {
    const reg = new ToolRegistry()
    expect(reg.registerTool(makeTool({ name: 'alpha' }))).toBe(true)
    expect(reg.getTool('alpha')?.name).toBe('alpha')
    expect(reg.getTools().map(t => t.name)).toEqual(['alpha'])
    expect(reg.getOpenAISchemas()).toEqual([
      { type: 'function', function: { name: 'alpha', description: 'desc', parameters: makeTool().parameters } },
    ])
  })

  it('getTool 查询不存在的工具返回 undefined，未注册时 getTools 为空', () => {
    const reg = new ToolRegistry()
    expect(reg.getTool('nope')).toBeUndefined()
    expect(reg.getTools()).toEqual([])
    expect(reg.getOpenAISchemas()).toEqual([])
    expect(reg.getOnDemandTools()).toEqual([])
  })

  it('重名注册被拒绝：返回 false 且保留首个注册的实现（不覆盖）', () => {
    const reg = new ToolRegistry()
    const first = makeTool({ name: 'dup', title: '第一个' })
    const second = makeTool({ name: 'dup', title: '第二个' })
    expect(reg.registerTool(first)).toBe(true)
    expect(reg.registerTool(second)).toBe(false)
    expect(reg.getTool('dup')?.title).toBe('第一个')
    expect(reg.getTools()).toHaveLength(1)
    // schema 不会重复追加
    expect(reg.getOpenAISchemas()).toHaveLength(1)
  })

  it('onDemand 三态语义：按需工具不进 LLM tools 数组，但可通过 getTool/getOnDemandTools 取到', () => {
    const reg = new ToolRegistry()
    reg.registerTool(makeTool({ name: 'resident', onDemand: false }))
    reg.registerTool(makeTool({ name: 'lazy', onDemand: true }))
    reg.registerTool(makeTool({ name: 'default' })) // 不传 onDemand → 视为常驻

    expect(reg.getOpenAISchemas().map(s => s.function.name)).toEqual(['resident', 'default'])
    expect(reg.getOnDemandTools().map(t => t.name)).toEqual(['lazy'])
    // 按需工具仍在总表中（invoke_tool 依赖 getTool 查找）
    expect(reg.getTools().map(t => t.name)).toEqual(['resident', 'lazy', 'default'])
    expect(reg.getTool('lazy')).toBeDefined()
  })

  it('registerTools 遇到重名返回 false，但其余工具照常注册', () => {
    const reg = new ToolRegistry()
    reg.registerTool(makeTool({ name: 'existing' }))
    const ok = reg.registerTools([
      makeTool({ name: 'a' }),
      makeTool({ name: 'existing' }),
      makeTool({ name: 'b' }),
    ])
    expect(ok).toBe(false)
    expect(reg.getTools().map(t => t.name)).toEqual(['existing', 'a', 'b'])
  })

  it('unregisterTool：存在返回 true 并同时清理 schema，不存在返回 false', () => {
    const reg = new ToolRegistry()
    reg.registerTool(makeTool({ name: 'gone' }))
    expect(reg.unregisterTool('gone')).toBe(true)
    expect(reg.getTool('gone')).toBeUndefined()
    expect(reg.getOpenAISchemas()).toEqual([])
    // 幂等：重复注销返回 false
    expect(reg.unregisterTool('gone')).toBe(false)
  })

  it('注销按需工具不报错（其本就不在 schema 数组里）', () => {
    const reg = new ToolRegistry()
    reg.registerTool(makeTool({ name: 'lazy', onDemand: true }))
    expect(reg.unregisterTool('lazy')).toBe(true)
    expect(reg.getOnDemandTools()).toEqual([])
  })

  it('getOpenAISchemasByNames 按名过滤，未知名字被忽略，空数组返回空', () => {
    const reg = new ToolRegistry()
    reg.registerTool(makeTool({ name: 'a' }))
    reg.registerTool(makeTool({ name: 'b' }))
    reg.registerTool(makeTool({ name: 'c', onDemand: true }))
    expect(reg.getOpenAISchemasByNames(['a', 'c']).map(s => s.function.name)).toEqual(['a'])
    expect(reg.getOpenAISchemasByNames(['unknown'])).toEqual([])
    expect(reg.getOpenAISchemasByNames([])).toEqual([])
  })

  it('getOpenAISchemas 返回独立副本：push 与就地改 function.name 都不会污染注册表', () => {
    const reg = new ToolRegistry()
    reg.registerTool(makeTool({ name: 'a' }))
    const schemas = reg.getOpenAISchemas()
    schemas.push({ type: 'function', function: { name: 'injected', description: '', parameters: { type: 'object', properties: {} } } })
    expect(reg.getOpenAISchemas().map(s => s.function.name)).toEqual(['a'])
    // function 层已浅拷贝：调用方就地改名不再泄漏进注册表内部
    schemas[0].function.name = 'renamed'
    expect(reg.getOpenAISchemas().map(s => s.function.name)).toEqual(['a'])
  })

  it('注销后重新注册同名工具可成功（状态已彻底清理）', () => {
    const reg = new ToolRegistry()
    reg.registerTool(makeTool({ name: 'cycle', title: 'v1' }))
    reg.unregisterTool('cycle')
    expect(reg.registerTool(makeTool({ name: 'cycle', title: 'v2' }))).toBe(true)
    expect(reg.getTool('cycle')?.title).toBe('v2')
    expect(reg.getOpenAISchemas()).toHaveLength(1)
  })

  it('注册结果与服务端构造出的 schema 保持同一 parameters 引用（未被拷贝破坏）', () => {
    const reg = new ToolRegistry()
    const tool = makeTool({ name: 'param-ref' })
    reg.registerTool(tool)
    expect(reg.getOpenAISchemas()[0].function.parameters).toBe(tool.parameters)
  })
})
