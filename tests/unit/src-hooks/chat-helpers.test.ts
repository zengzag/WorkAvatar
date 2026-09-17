import { describe, it, expect } from 'vitest'
import {
  getActiveBranchData,
  extractToolCallsFromSegments,
  buildEnrichedHistory,
  calcTotalOutputChars,
} from '../../../src/hooks/chat-helpers'
import type { MessageWithThought } from '../../../src/components/workbench'

const msg = (partial: Partial<MessageWithThought>): MessageWithThought =>
  ({ id: 'm1', role: 'user', content: '', ...partial }) as MessageWithThought

describe('chat-helpers / getActiveBranchData', () => {
  it('非 assistant 或无分支返回自身数据', () => {
    const m = msg({ role: 'user', content: 'hi' })
    expect(getActiveBranchData(m).content).toBe('hi')
  })

  it('activeBranchIndex 有效时返回分支内容', () => {
    const m = msg({
      role: 'assistant',
      content: '主干',
      branches: [{ content: '分支0' }, { content: '分支1' }],
      activeBranchIndex: 1,
    } as any)
    expect(getActiveBranchData(m).content).toBe('分支1')
  })

  it('activeBranchIndex 越界回落主干', () => {
    const m = msg({
      role: 'assistant',
      content: '主干',
      branches: [{ content: '分支0' }],
      activeBranchIndex: 5,
    } as any)
    expect(getActiveBranchData(m).content).toBe('主干')
  })

  it('activeBranchIndex 缺省按分支长度（=越界）处理', () => {
    const m = msg({ role: 'assistant', content: '主干', branches: [{ content: '分支0' }] } as any)
    expect(getActiveBranchData(m).content).toBe('主干')
  })
})

describe('chat-helpers / extractToolCallsFromSegments', () => {
  it('非 assistant / 无 segments 返回 undefined', () => {
    expect(extractToolCallsFromSegments(msg({ role: 'user' }))).toBeUndefined()
    expect(extractToolCallsFromSegments(msg({ role: 'assistant' }))).toBeUndefined()
  })

  it('提取 tool_call 段', () => {
    const m = msg({
      role: 'assistant',
      segments: [
        { type: 'tool_call', id: 's1', toolCallId: 'tc1', toolName: 'file_read', toolArgs: { p: 1 }, toolResult: 'ok', isToolComplete: true },
      ],
    } as any)
    const calls = extractToolCallsFromSegments(m)!
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ id: 'tc1', name: 'file_read', isComplete: true })
  })

  it('delegation 段映射为 delegate_to_employee 且终态判定', () => {
    const m = msg({
      role: 'assistant',
      segments: [
        { type: 'delegation', id: 'd1', delegationId: 'dg1', targetEmployeeId: 'e1', instruction: '做任务', delegationStatus: 'completed', resultSummary: '完成' },
        { type: 'delegation', id: 'd2', delegationId: 'dg2', delegationStatus: 'streaming' },
      ],
    } as any)
    const calls = extractToolCallsFromSegments(m)!
    expect(calls[0].name).toBe('delegate_to_employee')
    expect(calls[0].isComplete).toBe(true)
    expect(calls[1].isComplete).toBe(false)
  })

  it('混合 segments（answer/thinking）只提取工具段', () => {
    const m = msg({
      role: 'assistant',
      segments: [
        { type: 'thinking', content: '思考' },
        { type: 'answer', content: '回答' },
        { type: 'tool_call', id: 's1', toolName: 'web_search', toolArgs: {} },
      ],
    } as any)
    expect(extractToolCallsFromSegments(m)).toHaveLength(1)
  })
})

describe('chat-helpers / buildEnrichedHistory', () => {
  it('无压缩分隔符：全部消息进入 history', () => {
    const out = buildEnrichedHistory([
      msg({ id: 'a', role: 'user', content: 'q1' }),
      msg({ id: 'b', role: 'assistant', content: 'a1' }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ role: 'user', content: 'q1' })
  })

  it('存在压缩分隔符：摘要前消息被裁剪，摘要以 system 注入', () => {
    const out = buildEnrichedHistory([
      msg({ id: 'old1', role: 'user', content: '被裁剪的问题' }),
      msg({ id: 'sep', role: 'assistant', content: '---以下为压缩后的历史---', isCompactSummary: true } as any),
      msg({ id: 'msg_compact_summary_x', role: 'assistant', content: '这是摘要内容' }),
      msg({ id: 'new1', role: 'user', content: '最新问题' }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0].role).toBe('system')
    expect(out[0].content).toContain('这是摘要内容')
    expect(out[1].content).toBe('最新问题')
    expect(JSON.stringify(out)).not.toContain('被裁剪的问题')
  })

  it('分隔符存在但摘要消息缺失：仅跳过分隔符', () => {
    const out = buildEnrichedHistory([
      msg({ id: 'sep', role: 'assistant', content: '---', isCompactSummary: true } as any),
      msg({ id: 'new1', role: 'user', content: '最新问题' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
  })

  it('assistant 带工具段时按工具轮次拆分多条', () => {
    const out = buildEnrichedHistory([
      msg({
        id: 'a',
        role: 'assistant',
        segments: [
          { type: 'thinking', content: '想' },
          { type: 'tool_call', id: 's1', toolCallId: 'tc1', toolName: 't1', toolArgs: {}, toolResult: 'r1', isToolComplete: true },
          { type: 'answer', content: '答' },
        ],
      } as any),
    ])
    // thinking → assistant(无tool)；tool → flush；answer → flush 后新 assistant
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out.some(m => m.toolCalls?.length === 1)).toBe(true)
    expect(out[out.length - 1].content).toBe('答')
  })

  it('扁平 assistant 消息无 tool_call 段时不带 toolCalls', () => {
    const out = buildEnrichedHistory([msg({ id: 'a', role: 'assistant', content: '纯文本' })])
    expect(out).toHaveLength(1)
    expect(out[0].toolCalls).toBeUndefined()
  })
})

describe('chat-helpers / calcTotalOutputChars', () => {
  it('content 与 answer 段累计', () => {
    expect(calcTotalOutputChars([{ type: 'answer', content: '123' }, { type: 'thinking', content: 'xx' }], 'ab')).toBe(5)
  })

  it('空输入为 0', () => {
    expect(calcTotalOutputChars([])).toBe(0)
    expect(calcTotalOutputChars(undefined as any, '')).toBe(0)
  })
})
