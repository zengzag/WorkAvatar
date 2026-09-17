import { describe, it, expect } from 'vitest'
import {
  getActiveBranchData,
  extractToolCallsFromSegments,
  buildEnrichedHistory,
  calcTotalOutputChars,
  MESSAGES_CACHE_MAX_SIZE,
  MIN_LOADING_DISPLAY_MS,
  CONVERSATION_PAGE_SIZE,
  SCROLL_BOTTOM_THRESHOLD_PX,
  DEFAULT_TEMPERATURE,
  createPersistentMessagesCache,
} from '../../../src/hooks/chat-helpers'
import type { MessageWithThought } from '../../../src/components/workbench'

const msg = (partial: Partial<MessageWithThought>): MessageWithThought =>
  ({ id: 'm1', role: 'user', content: '', ...partial }) as MessageWithThought

describe('chat-helpers / 常量与缓存工厂', () => {
  it('常量取值稳定（缓存上限 60）', () => {
    expect(MESSAGES_CACHE_MAX_SIZE).toBe(60)
    expect(MIN_LOADING_DISPLAY_MS).toBe(120)
    expect(CONVERSATION_PAGE_SIZE).toBe(20)
    expect(SCROLL_BOTTOM_THRESHOLD_PX).toBe(10)
    expect(DEFAULT_TEMPERATURE).toBe(0.7)
  })

  it('createPersistentMessagesCache 支持容量淘汰', () => {
    const cache = createPersistentMessagesCache()
    for (let i = 0; i < MESSAGES_CACHE_MAX_SIZE; i++) cache.set(`c${i}`, [])
    expect(cache.size).toBe(MESSAGES_CACHE_MAX_SIZE)
    cache.set('overflow', [])
    expect(cache.size).toBe(MESSAGES_CACHE_MAX_SIZE)
    expect(cache.has('c0')).toBe(false)
    expect(cache.has('overflow')).toBe(true)
  })
})

describe('chat-helpers / getActiveBranchData 边界', () => {
  it('assistant 无 branches 字段时返回主干', () => {
    const m = msg({ role: 'assistant', content: '主干', thought: 't', segments: [] })
    expect(getActiveBranchData(m)).toMatchObject({ content: '主干', thought: 't', segments: [] })
  })

  it('branches 为空数组时返回主干', () => {
    const m = msg({ role: 'assistant', content: '主干', branches: [] })
    expect(getActiveBranchData(m).content).toBe('主干')
  })

  it('activeBranchIndex 指向的分支带 segments 时按分支返回', () => {
    const m = msg({
      role: 'assistant',
      content: '主干',
      branches: [{ content: 'b0', segments: [{ type: 'answer', id: 's', content: 'x' }] }],
      activeBranchIndex: 0,
    } as any)
    expect(getActiveBranchData(m).segments).toHaveLength(1)
  })

  it('用户消息即使带 branches 也走主干', () => {
    const m = msg({ role: 'user', content: 'hi', branches: [{ content: 'b0' }] } as any)
    expect(getActiveBranchData(m).content).toBe('hi')
  })

  it('负数 activeBranchIndex 有下限保护 → 回退主干，不抛错', () => {
    const m = msg({
      role: 'assistant',
      content: '主干',
      branches: [{ content: 'b0' }],
      activeBranchIndex: -1,
    } as any)
    // branches[-1] 为 undefined，必须回退默认分支而不是读取 undefined.content
    expect(() => getActiveBranchData(m)).not.toThrow()
    expect(getActiveBranchData(m).content).toBe('主干')
  })
})

describe('chat-helpers / extractToolCallsFromSegments 边界', () => {
  it('tool_call 段缺少 toolName 时被过滤', () => {
    const m = msg({
      role: 'assistant',
      segments: [
        { type: 'tool_call', id: 's1', toolArgs: {} },
        { type: 'tool_call', id: 's2', toolName: 'ok' },
      ],
    } as any)
    const calls = extractToolCallsFromSegments(m)!
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('ok')
  })

  it('仅有 thinking/answer 段时返回 undefined', () => {
    const m = msg({
      role: 'assistant',
      segments: [{ type: 'thinking', content: 't' }, { type: 'answer', content: 'a' }],
    } as any)
    expect(extractToolCallsFromSegments(m)).toBeUndefined()
  })

  it('tool_call 段缺少 toolCallId 时回退段 id；args 为 undefined 时原样返回', () => {
    const m = msg({ role: 'assistant', segments: [{ type: 'tool_call', id: 's1', toolName: 'x' }] } as any)
    const calls = extractToolCallsFromSegments(m)!
    expect(calls[0]).toMatchObject({ id: 's1', args: undefined, result: undefined, isComplete: undefined })
  })

  it('delegation 段 id 回退链：delegationId → 段 id（不取 runId）；instruction 缺省为空串', () => {
    const m = msg({
      role: 'assistant',
      segments: [
        { type: 'delegation', id: 'd1', runId: 'r1', targetEmployeeId: 'e1' },
        { type: 'delegation', id: 'd2', targetEmployeeId: 'e2' },
      ],
    } as any)
    const calls = extractToolCallsFromSegments(m)!
    // 此函数只按 delegationId || 段 id 取值（runId 回退仅存在于 buildEnrichedHistory 的段循环分支）
    expect(calls[0].id).toBe('d1')
    expect(calls[1].id).toBe('d2')
    expect(calls[0].args).toEqual({ target_employee_id: 'e1', instruction: '' })
    expect(calls[0].isComplete).toBe(false)
  })
})

describe('chat-helpers / buildEnrichedHistory 分支与压缩边界', () => {
  it('assistant 分支激活时使用分支内容与段', () => {
    const out = buildEnrichedHistory([
      msg({
        id: 'a',
        role: 'assistant',
        content: '主干',
        branches: [{ content: '分支答', thought: '分支思考' }],
        activeBranchIndex: 0,
      } as any),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ content: '分支答', reasoning_content: '分支思考' })
  })

  it('压缩分隔符位于末尾（无摘要、无后续消息）时结果为空', () => {
    const out = buildEnrichedHistory([
      msg({ id: 'sep', role: 'assistant', content: '---', isCompactSummary: true } as any),
    ])
    expect(out).toEqual([])
  })

  it('摘要内容为空串时只跳过分隔符，摘要消息本身进入 history', () => {
    const out = buildEnrichedHistory([
      msg({ id: 'sep', role: 'assistant', content: '---', isCompactSummary: true } as any),
      msg({ id: 'msg_compact_summary_x', role: 'assistant', content: '   ' }),
      msg({ id: 'u1', role: 'user', content: 'q' }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0].role).toBe('assistant')
    expect(out.some(m => m.role === 'system')).toBe(false)
  })

  it('同名分隔符只取最后一个（更早的压缩被再次压缩覆盖）', () => {
    const out = buildEnrichedHistory([
      msg({ id: 'old', role: 'user', content: '很旧的问题' }),
      msg({ id: 'sep1', role: 'assistant', content: '---', isCompactSummary: true } as any),
      msg({ id: 'msg_compact_summary_1', role: 'assistant', content: '第一次摘要' }),
      msg({ id: 'mid', role: 'user', content: '中间问题' }),
      msg({ id: 'sep2', role: 'assistant', content: '---', isCompactSummary: true } as any),
      msg({ id: 'msg_compact_summary_2', role: 'assistant', content: '第二次摘要' }),
      msg({ id: 'new', role: 'user', content: '最新问题' }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0].content).toContain('第二次摘要')
    expect(out[1].content).toBe('最新问题')
    expect(JSON.stringify(out)).not.toContain('很旧的问题')
    expect(JSON.stringify(out)).not.toContain('中间问题')
  })

  it('用户消息 images 与 thought 透传', () => {
    const out = buildEnrichedHistory([
      msg({ role: 'user', content: '看图', images: ['a.png'], thought: '图片说明' } as any),
    ])
    expect(out[0]).toMatchObject({ role: 'user', content: '看图', images: ['a.png'], reasoning_content: '图片说明' })
  })

  it('仅含 delegation 段（无 tool_call）走扁平分支：结果与段循环分支一致，含产物文件清单', () => {
    const out = buildEnrichedHistory([
      msg({
        id: 'a',
        role: 'assistant',
        segments: [
          {
            type: 'delegation',
            id: 'd1',
            delegationId: 'dg1',
            targetEmployeeId: 'e1',
            instruction: '写报告',
            delegationStatus: 'completed',
            resultSummary: '已完成',
            runResult: {
              generatedFiles: [{ path: 'C:/out/a.docx' }],
              autoDetectedFiles: [{ path: 'C:/out/b.xlsx' }],
            },
          },
        ],
      } as any),
    ])
    const call = out[0].toolCalls![0]
    expect(call.name).toBe('delegate_to_employee')
    expect(call.args).toEqual({ target_employee_id: 'e1', instruction: '写报告' })
    expect(call.isComplete).toBe(true)
    // 两条路径统一：摘要 + 生成文件清单
    expect(String(call.result)).toContain('已完成')
    expect(String(call.result)).toContain('- C:/out/a.docx')
    expect(String(call.result)).toContain('- C:/out/b.xlsx')
  })

  it('存在 tool_call 段时 delegation 走段循环分支：结果附带产物文件清单', () => {
    const out = buildEnrichedHistory([
      msg({
        id: 'a',
        role: 'assistant',
        segments: [
          { type: 'tool_call', id: 's1', toolName: 'file_read', toolArgs: {} },
          {
            type: 'delegation',
            id: 'd1',
            delegationId: 'dg1',
            targetEmployeeId: 'e1',
            instruction: '写报告',
            delegationStatus: 'completed',
            resultSummary: '已完成',
            runResult: {
              generatedFiles: [{ path: 'C:/out/a.docx' }],
              autoDetectedFiles: [{ path: 'C:/out/b.xlsx' }],
            },
          },
        ],
      } as any),
    ])
    const call = out[1].toolCalls![0]
    expect(call.name).toBe('delegate_to_employee')
    expect(call.isComplete).toBe(true)
    expect(String(call.result)).toContain('已完成')
    expect(String(call.result)).toContain('- C:/out/a.docx')
    expect(String(call.result)).toContain('- C:/out/b.xlsx')
  })

  it('delegation 无结果摘要时两条路径都兜底为 (子员工已完成)', () => {
    const flat = buildEnrichedHistory([
      msg({
        id: 'a',
        role: 'assistant',
        segments: [{ type: 'delegation', id: 'd1', delegationId: 'dg1', delegationStatus: 'streaming' }],
      } as any),
    ])
    expect(flat[0].toolCalls![0].result).toBe('(子员工已完成)')
    expect(flat[0].toolCalls![0].isComplete).toBe(false)

    const loop = buildEnrichedHistory([
      msg({
        id: 'a',
        role: 'assistant',
        segments: [
          { type: 'tool_call', id: 's1', toolName: 'file_read', toolArgs: {} },
          { type: 'delegation', id: 'd1', delegationId: 'dg1', delegationStatus: 'streaming' },
        ],
      } as any),
    ])
    expect(loop[1].toolCalls![0].result).toBe('(子员工已完成)')
  })

  it('连续多个 tool_call 段归入同一条 assistant 消息', () => {
    const out = buildEnrichedHistory([
      msg({
        id: 'a',
        role: 'assistant',
        segments: [
          { type: 'tool_call', id: 's1', toolName: 't1', toolArgs: {} },
          { type: 'tool_call', id: 's2', toolName: 't2', toolArgs: {} },
        ],
      } as any),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].toolCalls!.map(c => c.name)).toEqual(['t1', 't2'])
  })

  it('工具调用后的 answer 会开启新一轮（工具轮次边界）', () => {
    const out = buildEnrichedHistory([
      msg({
        id: 'a',
        role: 'assistant',
        segments: [
          { type: 'answer', content: '前' },
          { type: 'tool_call', id: 's1', toolName: 't1', toolArgs: {} },
          { type: 'answer', content: '后' },
        ],
      } as any),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ content: '前', toolCalls: [{ name: 't1' }] })
    expect(out[1]).toMatchObject({ content: '后', toolCalls: undefined })
  })

  it('缺少 toolName 的 tool_call 段不产生工具、也不打断当前轮次', () => {
    const out = buildEnrichedHistory([
      msg({
        id: 'a',
        role: 'assistant',
        segments: [
          { type: 'answer', content: '前' },
          { type: 'tool_call', id: 's1' },
          { type: 'answer', content: '后' },
        ],
      } as any),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ content: '前后', toolCalls: undefined })
  })

  it('空消息数组返回空', () => {
    expect(buildEnrichedHistory([])).toEqual([])
  })
})

describe('chat-helpers / calcTotalOutputChars 边界', () => {
  it('非字符串 answer content 不计入（按 0 处理）', () => {
    expect(calcTotalOutputChars([{ type: 'answer', content: 123 as any }], 'ab')).toBe(2)
    expect(calcTotalOutputChars([{ type: 'answer', content: { a: 1 } as any }])).toBe(0)
  })

  it('空 content / answer 无内容不计入', () => {
    expect(calcTotalOutputChars([{ type: 'answer', content: '' }], '')).toBe(0)
    expect(calcTotalOutputChars([{ type: 'answer' }], 'abc')).toBe(3)
  })

  it('tool_call / delegation 段的 content 不计入', () => {
    expect(calcTotalOutputChars([{ type: 'tool_call', content: 'x'.repeat(10) }], 'ab')).toBe(2)
  })

  it('Unicode（代理对）按 UTF-16 长度统计', () => {
    expect(calcTotalOutputChars([], '😀')).toBe(2)
  })
})
