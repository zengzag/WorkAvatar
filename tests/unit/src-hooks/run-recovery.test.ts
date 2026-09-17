import { describe, it, expect, vi, afterEach } from 'vitest'
import { recoverSubSegmentsFromLog } from '../../../src/hooks/run-recovery'
import type { MessageSegment } from '../../../src/components/workbench/types'

/**
 * src/hooks/run-recovery：从后端事件日志重建子流
 * - thought/chunk 相邻合并（仅合并到 isStreaming 的同类型段）
 * - tool_call / tool_result 配对（按 name 匹配最近未完成项）
 * - done 收尾（停止 streaming + 折叠 thinking）
 */

const asAnswer = (s: MessageSegment) => s.type === 'answer'
const asThinking = (s: MessageSegment) => s.type === 'thinking'

afterEach(() => {
  vi.useRealTimers()
})

describe('run-recovery / 空与无关事件', () => {
  it('空日志返回空数组', () => {
    expect(recoverSubSegmentsFromLog([], 'r1')).toEqual([])
  })

  it('未知事件类型被忽略', () => {
    const segs = recoverSubSegmentsFromLog(
      [{ eventType: 'unknown', data: { x: 1 } }, { eventType: 'error', data: 'boom' }],
      'r1',
    )
    expect(segs).toEqual([])
  })

  it('空 thought / chunk 被跳过（不产生空段）', () => {
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'thought', data: '' },
        { eventType: 'thought', data: {} },
        { eventType: 'chunk', data: '' },
        { eventType: 'chunk', data: { other: 1 } },
      ],
      'r1',
    )
    expect(segs).toEqual([])
  })
})

describe('run-recovery / thought 与 chunk 合并', () => {
  it('相邻 thought 合并到同一流式 thinking 段', () => {
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'thought', data: 'a' },
        { eventType: 'thought', data: { thought: 'b' } },
        { eventType: 'thought', data: 'c' },
      ],
      'r1',
    )
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ type: 'thinking', content: 'abc', isStreaming: true, collapsed: true, id: 'r1_rec_th_0' })
  })

  it('相邻 chunk 合并到同一流式 answer 段', () => {
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'chunk', data: '你' },
        { eventType: 'chunk', data: { chunk: '好' } },
      ],
      'r1',
    )
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ type: 'answer', content: '你好', isStreaming: true, id: 'r1_rec_an_0' })
  })

  it('thinking 与 answer 交替时不互相合并，段 id 按当前段数递增', () => {
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'thought', data: 't1' },
        { eventType: 'chunk', data: 'a1' },
        { eventType: 'thought', data: 't2' },
      ],
      'r1',
    )
    expect(segs.map(s => s.id)).toEqual(['r1_rec_th_0', 'r1_rec_an_1', 'r1_rec_th_2'])
    expect(segs.map(s => s.content)).toEqual(['t1', 'a1', 't2'])
  })

  it('前一段已收尾（非 streaming）时新建同类型段', () => {
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'chunk', data: 'a1' },
        { eventType: 'done' },
        { eventType: 'chunk', data: 'a2' },
      ],
      'r1',
    )
    expect(segs.filter(asAnswer)).toHaveLength(2)
    expect(segs[0].isStreaming).toBe(false)
    expect(segs[1].isStreaming).toBe(true)
  })

  it('runId 作为段 id 前缀', () => {
    const segs = recoverSubSegmentsFromLog([{ eventType: 'chunk', data: 'x' }], 'run/42')
    expect(segs[0].id).toBe('run/42_rec_an_0')
  })
})

describe('run-recovery / tool_call 与 tool_result', () => {
  it('tool_call 前会收尾流式 answer 段并追加工具段', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0))
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'chunk', data: '答案' },
        { eventType: 'tool_call', data: { name: 'file_read', args: { p: 1 }, id: 'tc1' } },
      ],
      'r1',
    )
    expect(segs[0]).toMatchObject({ type: 'answer', isStreaming: false, completedAt: Date.now() })
    expect(segs[1]).toMatchObject({
      type: 'tool_call',
      toolName: 'file_read',
      toolArgs: { p: 1 },
      toolCallId: 'tc1',
      isToolComplete: false,
      collapsed: true,
    })
  })

  it('tool_call 数据缺失时工具名为空串', () => {
    const segs = recoverSubSegmentsFromLog([{ eventType: 'tool_call', data: undefined }], 'r1')
    expect(segs[0]).toMatchObject({ type: 'tool_call', toolName: '', isToolComplete: false })
  })

  it('tool_result 按 name 匹配最近未完成工具段并写入结果', () => {
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'tool_call', data: { name: 'file_read', id: 'tc1' } },
        { eventType: 'tool_result', data: { name: 'file_read', result: 'ok' } },
      ],
      'r1',
    )
    expect(segs[0]).toMatchObject({ toolResult: 'ok', isToolComplete: true, collapsed: true })
    expect(segs[0].completedAt).toBeTypeOf('number')
  })

  it('同名工具多次调用时只回填最近一个未完成项', () => {
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'tool_call', data: { name: 'file_read', id: 'tc1' } },
        { eventType: 'tool_result', data: { name: 'file_read', result: 'r1' } },
        { eventType: 'tool_call', data: { name: 'file_read', id: 'tc2' } },
        { eventType: 'tool_result', data: { name: 'file_read', result: 'r2' } },
      ],
      'r1',
    )
    expect(segs[0].toolResult).toBe('r1')
    expect(segs[1].toolResult).toBe('r2')
  })

  it('无匹配工具段 / 名称缺失时 tool_result 为 no-op', () => {
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'tool_call', data: { name: 'a' } },
        { eventType: 'tool_result', data: { name: 'b', result: 'x' } },
        { eventType: 'tool_result', data: undefined },
      ],
      'r1',
    )
    expect(segs).toHaveLength(1)
    expect(segs[0].isToolComplete).toBe(false)
    expect(segs[0].toolResult).toBeUndefined()
  })

  it('tool_result 不修改段数（原位替换）', () => {
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'tool_call', data: { name: 'a' } },
        { eventType: 'tool_result', data: { name: 'a', result: 1 } },
        { eventType: 'chunk', data: 'after' },
      ],
      'r1',
    )
    expect(segs.map(s => s.type)).toEqual(['tool_call', 'answer'])
  })
})

describe('run-recovery / done 收尾', () => {
  it('停止所有 streaming 段并折叠 thinking，answer 不折叠', () => {
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'thought', data: 't' },
        { eventType: 'chunk', data: 'a' },
        { eventType: 'done' },
      ],
      'r1',
    )
    const thinking = segs.find(asThinking)!
    const answer = segs.find(asAnswer)!
    expect(thinking.isStreaming).toBe(false)
    expect(thinking.collapsed).toBe(true)
    expect(thinking.completedAt).toBeTypeOf('number')
    expect(answer.isStreaming).toBe(false)
    expect(answer.completedAt).toBeTypeOf('number')
    expect(answer.collapsed).toBeUndefined()
  })

  it('done 不覆盖已有的 completedAt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0))
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'chunk', data: 'a' },
        { eventType: 'tool_call', data: { name: 'x' } },
        { eventType: 'done' },
      ],
      'r1',
    )
    expect(segs[0].completedAt).toBe(Date.now())
    expect(segs[1].isToolComplete).toBe(false) // done 不改变工具完成态
  })

  it('done 后的 chunk 会新建流式段（不会自动收尾）', () => {
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'done' },
        { eventType: 'chunk', data: 'late' },
      ],
      'r1',
    )
    expect(segs).toHaveLength(1)
    expect(segs[0].isStreaming).toBe(true)
  })

  it('完整事件序列（thought→chunk→tool→result→chunk→done）顺序稳定', () => {
    const segs = recoverSubSegmentsFromLog(
      [
        { eventType: 'thought', data: '想' },
        { eventType: 'chunk', data: '答1' },
        { eventType: 'tool_call', data: { name: 'search', args: { q: 'x' }, id: 't1' } },
        { eventType: 'tool_result', data: { name: 'search', result: ['r'] } },
        { eventType: 'chunk', data: '答2' },
        { eventType: 'done' },
      ],
      'r9',
    )
    expect(segs.map(s => s.type)).toEqual(['thinking', 'answer', 'tool_call', 'answer'])
    expect(segs.map(s => s.content)).toEqual(['想', '答1', undefined, '答2'])
    expect(segs.every(s => !s.isStreaming)).toBe(true)
    expect(segs[2].toolResult).toEqual(['r'])
  })
})
