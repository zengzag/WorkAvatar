import { describe, it, expect, vi, afterEach } from 'vitest'
import { ensureSegments, patchMissingCompletedAt } from '../../../src/components/workbench/types'
import type { MessageSegment, MessageWithThought } from '../../../src/components/workbench/types'

/** src/components/workbench/types 纯函数：ensureSegments / patchMissingCompletedAt */

const msg = (partial: Partial<MessageWithThought>): MessageWithThought =>
  ({ id: 'm1', role: 'user', content: '', ...partial }) as MessageWithThought

afterEach(() => {
  vi.useRealTimers()
})

describe('workbench/types / ensureSegments', () => {
  it('非 assistant 原样返回（同一引用）', () => {
    const m = msg({ role: 'user', content: 'hi' })
    expect(ensureSegments(m)).toBe(m)
  })

  it('已有非空 segments 原样返回', () => {
    const m = msg({ role: 'assistant', segments: [{ type: 'answer', id: 's1', content: 'a' }] })
    expect(ensureSegments(m)).toBe(m)
  })

  it('空 segments 数组视为缺失并重建', () => {
    const m = msg({ role: 'assistant', content: '答', segments: [] })
    const out = ensureSegments(m)
    expect(out.segments).toHaveLength(1)
    expect(out.segments![0]).toMatchObject({ type: 'answer', content: '答', id: 'm1_seg_0' })
  })

  it('thought + content + toolCalls 依次生成段，id 序号连续', () => {
    const m = msg({
      role: 'assistant',
      thought: '思考',
      content: '回答',
      toolCalls: [
        { id: 't1', name: 'file_read', args: { p: 1 }, result: 'ok', isComplete: true },
        { id: 't2', name: 'web_search', args: {} },
      ],
    })
    const segs = ensureSegments(m).segments!
    expect(segs.map(s => s.id)).toEqual(['m1_seg_0', 'm1_seg_1', 'm1_tool_2', 'm1_tool_3'])
    expect(segs.map(s => s.type)).toEqual(['thinking', 'answer', 'tool_call', 'tool_call'])
    expect(segs[0]).toMatchObject({ content: '思考', collapsed: true })
    expect(segs[2]).toMatchObject({ toolName: 'file_read', toolResult: 'ok', isToolComplete: true, collapsed: true })
    expect(segs[3]).toMatchObject({ toolName: 'web_search', isToolComplete: undefined })
  })

  it('thoughtCollapsed=false 时思考段默认展开', () => {
    const m = msg({ role: 'assistant', thought: '思考', thoughtCollapsed: false })
    expect(ensureSegments(m).segments![0].collapsed).toBe(false)
  })

  it('空 thought / 空 content 不生成段', () => {
    const m = msg({ role: 'assistant', thought: '', content: '', toolCalls: [] })
    expect(ensureSegments(m).segments).toEqual([])
  })

  it('纯空白 content 仍生成 answer 段', () => {
    const m = msg({ role: 'assistant', content: '   ' })
    expect(ensureSegments(m).segments).toHaveLength(1)
    expect(ensureSegments(m).segments![0].type).toBe('answer')
  })

  it('返回新对象，不修改入参', () => {
    const m = msg({ role: 'assistant', content: '答' })
    const out = ensureSegments(m)
    expect(out).not.toBe(m)
    expect(m.segments).toBeUndefined()
  })

  it('仅 toolCalls 时生成 tool_call 段（无 thinking/answer）', () => {
    const m = msg({ role: 'assistant', toolCalls: [{ id: 't1', name: 'x', args: {} }] })
    const segs = ensureSegments(m).segments!
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ type: 'tool_call', id: 'm1_tool_0', toolName: 'x' })
  })
})

describe('workbench/types / patchMissingCompletedAt', () => {
  it('非 assistant / 无 segments 与 branches 原样返回', () => {
    const user = msg({ role: 'user', content: 'hi' })
    expect(patchMissingCompletedAt(user)).toBe(user)
    const assistant = msg({ role: 'assistant', content: 'hi' })
    expect(patchMissingCompletedAt(assistant)).toBe(assistant)
  })

  it('已完成的 answer 段补 completedAt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0))
    const m = msg({
      role: 'assistant',
      segments: [{ type: 'answer', id: 's1', content: 'a', timestamp: 1, isStreaming: false }],
    })
    const out = patchMissingCompletedAt(m)
    expect(out).not.toBe(m)
    expect(out.segments![0].completedAt).toBe(Date.now())
  })

  it('流式中 / 无 timestamp / 已有 completedAt 的段不补', () => {
    const streaming = msg({
      role: 'assistant',
      segments: [{ type: 'answer', id: 's1', content: 'a', timestamp: 1, isStreaming: true }],
    })
    expect(patchMissingCompletedAt(streaming)).toBe(streaming)

    const noTs = msg({ role: 'assistant', segments: [{ type: 'answer', id: 's1', content: 'a', isStreaming: false }] })
    expect(patchMissingCompletedAt(noTs)).toBe(noTs)

    const done = msg({
      role: 'assistant',
      segments: [{ type: 'answer', id: 's1', content: 'a', timestamp: 1, isStreaming: false, completedAt: 5 }],
    })
    expect(patchMissingCompletedAt(done)).toBe(done)
  })

  it('tool_call 段按 isToolComplete 判定完成', () => {
    const complete = msg({
      role: 'assistant',
      segments: [{ type: 'tool_call', id: 's1', toolName: 'x', timestamp: 1, isToolComplete: true }],
    })
    expect(patchMissingCompletedAt(complete).segments![0].completedAt).toBeTypeOf('number')

    const running = msg({
      role: 'assistant',
      segments: [{ type: 'tool_call', id: 's1', toolName: 'x', timestamp: 1, isToolComplete: false }],
    })
    expect(patchMissingCompletedAt(running)).toBe(running)
  })

  it('delegation 段按终态（completed/failed/timed_out/cancelled）判定', () => {
    for (const status of ['completed', 'failed', 'timed_out', 'cancelled'] as const) {
      const m = msg({
        role: 'assistant',
        segments: [{ type: 'delegation', id: 'd1', timestamp: 1, delegationStatus: status }],
      })
      expect(patchMissingCompletedAt(m).segments![0].completedAt).toBeTypeOf('number')
    }
    for (const status of ['queued', 'streaming'] as const) {
      const m = msg({
        role: 'assistant',
        segments: [{ type: 'delegation', id: 'd1', timestamp: 1, delegationStatus: status }],
      })
      expect(patchMissingCompletedAt(m)).toBe(m)
    }
  })

  it('thinking 段 isStreaming 未定义时不补（仅显式 false 视为完成）', () => {
    const m = msg({ role: 'assistant', segments: [{ type: 'thinking', id: 's1', content: 't', timestamp: 1 }] })
    expect(patchMissingCompletedAt(m)).toBe(m)
    const ended = msg({
      role: 'assistant',
      segments: [{ type: 'thinking', id: 's1', content: 't', timestamp: 1, isStreaming: false }],
    })
    expect(patchMissingCompletedAt(ended).segments![0].completedAt).toBeTypeOf('number')
  })

  it('分支中的段同样被补全，且只替换命中的分支对象', () => {
    const otherBranch = { content: 'other', segments: [{ type: 'answer', id: 'b2s1', content: 'x', timestamp: 1, isStreaming: false }] }
    const doneBranch = {
      content: 'done',
      segments: [{ type: 'answer', id: 'b1s1', content: 'x', timestamp: 1, isStreaming: false, completedAt: 3 }] as MessageSegment[],
    }
    const m = msg({ role: 'assistant', branches: [doneBranch, otherBranch] })
    const out = patchMissingCompletedAt(m)
    expect(out).not.toBe(m)
    expect(out.branches![0]).toBe(doneBranch) // 未变更的分支保持引用
    expect(out.branches![1]).not.toBe(otherBranch)
    expect(out.branches![1].segments![0].completedAt).toBeTypeOf('number')
    expect(out.segments).toBeUndefined()
  })

  it('segments 与 branches 同时存在时都处理', () => {
    const m = msg({
      role: 'assistant',
      segments: [{ type: 'answer', id: 's1', content: 'a', timestamp: 1, isStreaming: false }],
      branches: [{ content: 'b', segments: [{ type: 'answer', id: 'b1', content: 'b', timestamp: 1, isStreaming: false }] }],
    })
    const out = patchMissingCompletedAt(m)
    expect(out.segments![0].completedAt).toBeTypeOf('number')
    expect(out.branches![0].segments![0].completedAt).toBeTypeOf('number')
  })
})
