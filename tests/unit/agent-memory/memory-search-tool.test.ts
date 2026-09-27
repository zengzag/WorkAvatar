/**
 * search_memories 工具单测（记忆服务打桩）：
 * - 空查询 / 无命中 / 命中的输出与结构化结果
 * - limit 裁剪与 scope 非法值回落
 * - 服务异常降级为 success:false
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockState = vi.hoisted(() => ({ search: vi.fn((..._args: any[]) => [] as any[]) }))

vi.mock('../../../electron/main/services/employee-memory.service', () => ({
  default: { getInstance: () => ({ searchMemoriesForAgent: mockState.search }) },
}))

import { createMemorySearchTool } from '../../../electron/main/services/agent/tools/memory-search.tool'
import { MEMORY_SEARCH_DEFAULT_LIMIT, MEMORY_SEARCH_MAX_LIMIT } from '../../../electron/main/services/employee-memory-types'

function memory(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'm1',
    employee_id: 'e1',
    scope: 'employee',
    key: 'writing_style',
    topic: '用户偏好',
    content: '用户偏好简洁回复',
    is_pinned: 0,
    source: 'auto',
    importance: 'normal',
    created_at: 1,
    updated_at: 2,
    last_referenced_at: null,
    deleted_at: null,
    ...overrides,
  }
}

const tool = createMemorySearchTool('e1')[0]

beforeEach(() => {
  mockState.search.mockReset()
  mockState.search.mockReturnValue([])
})

describe('memory-search tool / 参数处理', () => {
  it('工具元数据：常驻、安全、归属对话记忆分类', () => {
    expect(tool.id).toBe('search_memories')
    expect(tool.onDemand).toBe(false)
    expect(tool.permission).toBe('safe')
  })

  it('空查询直接失败，不调用服务', () => {
    const res: any = tool.handler({ query: '   ' })
    expect(res.success).toBe(false)
    expect(mockState.search).not.toHaveBeenCalled()
  })

  it('缺省 limit 使用默认值', () => {
    tool.handler({ query: '偏好' })
    expect(mockState.search).toHaveBeenCalledWith('e1', '偏好', { limit: MEMORY_SEARCH_DEFAULT_LIMIT, scope: 'all' })
  })

  it('limit 被裁剪到上限', () => {
    tool.handler({ query: '偏好', limit: 999 })
    expect(mockState.search.mock.calls[0][2].limit).toBe(MEMORY_SEARCH_MAX_LIMIT)
  })

  it('limit 无效（0 / 负数 / 非数字）时回落到默认值', () => {
    tool.handler({ query: '偏好', limit: 0 })
    expect(mockState.search.mock.calls[0][2].limit).toBe(MEMORY_SEARCH_DEFAULT_LIMIT)
    tool.handler({ query: '偏好', limit: -3 })
    expect(mockState.search.mock.calls[1][2].limit).toBe(MEMORY_SEARCH_DEFAULT_LIMIT)
    tool.handler({ query: '偏好', limit: 'abc' })
    expect(mockState.search.mock.calls[2][2].limit).toBe(MEMORY_SEARCH_DEFAULT_LIMIT)
  })

  it('非法 scope 回落为 all，合法 scope 透传', () => {
    tool.handler({ query: '偏好', scope: 'bogus' })
    expect(mockState.search.mock.calls[0][2].scope).toBe('all')
    tool.handler({ query: '偏好', scope: 'global' })
    expect(mockState.search.mock.calls[1][2].scope).toBe('global')
  })
})

describe('memory-search tool / 输出', () => {
  it('命中时输出内容与结构化 results', () => {
    mockState.search.mockReturnValue([memory({ is_pinned: 1, importance: 'critical' })])
    const res: any = tool.handler({ query: '偏好' })
    expect(res.success).toBe(true)
    expect(res.count).toBe(1)
    expect(res.output).toContain('用户偏好简洁回复')
    expect(res.output).toContain('置顶')
    expect(res.output).toContain('关键')
    expect(res.results[0]).toMatchObject({ key: 'writing_style', scope: 'employee', isPinned: true })
  })

  it('全局记忆标注为「全局」，手动来源标注为「手动」', () => {
    mockState.search.mockReturnValue([memory({ scope: 'global', source: 'manual', employee_id: null })])
    const res: any = tool.handler({ query: '偏好' })
    expect(res.output).toContain('全局')
    expect(res.output).toContain('手动')
  })

  it('无命中时给出升级检索指引', () => {
    const res: any = tool.handler({ query: '不存在的东西' })
    expect(res.success).toBe(true)
    expect(res.count).toBe(0)
    expect(res.output).toContain('未检索到')
    expect(res.output).toContain('search_conversations')
  })

  it('服务抛错时返回 success:false', () => {
    mockState.search.mockImplementation(() => { throw new Error('boom') })
    const res: any = tool.handler({ query: '偏好' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('boom')
  })
})
