import { describe, it, expect } from 'vitest'
import {
  compactMessagesJson,
  mergeOmittedSubSegments,
  findSegmentSubSegments,
  getCompactMessagesJson,
  invalidateCompactViewCache,
  COMPACT_MIN_MESSAGES_BYTES,
  SUB_SEGMENTS_OMITTED,
  SUB_SEGMENT_COUNT,
} from '../../../electron/main/services/conversation-messages.compact'

const bigText = (size: number): string => 'x'.repeat(size)

function makeConversation(options: { fillerBytes?: number; subCount?: number } = {}) {
  const subCount = options.subCount ?? 40
  const subSegments = Array.from({ length: subCount }, (_, i) => ({
    id: `sub_${i}`,
    type: 'tool_call',
    toolName: 'file_write',
    toolResult: bigText(400),
    isToolComplete: true,
    timestamp: 1,
    completedAt: 2,
  }))
  return [
    { id: 'msg_user', role: 'user', content: '请执行任务' },
    {
      id: 'msg_assistant',
      role: 'assistant',
      content: '',
      segments: [
        { id: 'seg_answer', type: 'answer', content: bigText(options.fillerBytes ?? 1_100_000) },
        {
          id: 'seg_del',
          type: 'delegation',
          delegationStatus: 'completed',
          targetEmployeeName: '子员工',
          resultSummary: '已完成',
          subSegments,
        },
      ],
    },
  ]
}

describe('conversation-messages.compact', () => {
  it('小会话保持原样（不解析、不改写）', () => {
    const raw = JSON.stringify([{ id: 'm1', role: 'user', content: 'hi' }])
    expect(raw.length).toBeLessThan(COMPACT_MIN_MESSAGES_BYTES)
    expect(compactMessagesJson(raw)).toBe(raw)
  })

  it('大会话外置已完成委托的子过程，并保留数量标记', () => {
    const raw = JSON.stringify(makeConversation())
    expect(raw.length).toBeGreaterThan(COMPACT_MIN_MESSAGES_BYTES)
    const compacted = JSON.parse(compactMessagesJson(raw))
    const delegation = compacted[1].segments.find((s: any) => s.id === 'seg_del')
    expect(delegation.subSegments).toBeUndefined()
    expect(delegation[SUB_SEGMENTS_OMITTED]).toBe(true)
    expect(delegation[SUB_SEGMENT_COUNT]).toBe(40)
    // 正文段不受影响
    expect(compacted[1].segments[0].content.length).toBeGreaterThan(1_000_000)
  })

  it('未完成的委托不裁剪，仍可接收流式事件', () => {
    const msgs = makeConversation()
    msgs[1].segments[1].delegationStatus = 'streaming'
    const compacted = JSON.parse(compactMessagesJson(JSON.stringify(msgs)))
    expect(compacted[1].segments[1].subSegments).toHaveLength(40)
  })

  it('分支消息里的委托同样裁剪并可还原', () => {
    const msgs = makeConversation()
    const branchMsgs = JSON.parse(JSON.stringify(msgs))
    ;(msgs[1] as any).branches = [{ id: 'br1', segments: branchMsgs[1].segments }]
    const raw = JSON.stringify(msgs)
    const compactedJson = compactMessagesJson(raw)
    const compacted = JSON.parse(compactedJson)
    expect(compacted[1].branches[0].segments[1][SUB_SEGMENTS_OMITTED]).toBe(true)

    const restored = JSON.parse(mergeOmittedSubSegments(compactedJson, raw))
    expect(restored[1].branches[0].segments[1].subSegments).toHaveLength(40)
    expect(restored[1].branches[0].segments[1][SUB_SEGMENTS_OMITTED]).toBeUndefined()
  })

  it('回写时从数据库原值还原外置子过程，数据不丢失', () => {
    const raw = JSON.stringify(makeConversation())
    const compactedJson = compactMessagesJson(raw)
    const mergedJson = mergeOmittedSubSegments(compactedJson, raw)
    const merged = JSON.parse(mergedJson)
    const delegation = merged[1].segments.find((s: any) => s.id === 'seg_del')
    expect(delegation.subSegments).toHaveLength(40)
    expect(delegation.subSegments[0].toolResult.length).toBe(400)
    expect(delegation[SUB_SEGMENTS_OMITTED]).toBeUndefined()
    expect(delegation[SUB_SEGMENT_COUNT]).toBeUndefined()
  })

  it('分支复制（groupKey 变化）按段 id 兜底还原', () => {
    const raw = JSON.stringify(makeConversation())
    const compactedJson = compactMessagesJson(raw)
    const compacted = JSON.parse(compactedJson)
    const original = compacted[1].segments
    // 模拟 branch 操作：把裁剪后的段复制到新分支（新分支 id，原消息段保留）
    ;(compacted[1] as any).branches = [{ id: 'new_branch', segments: JSON.parse(JSON.stringify(original)) }]
    const merged = JSON.parse(mergeOmittedSubSegments(JSON.stringify(compacted), raw))
    const branchDel = merged[1].branches[0].segments.find((s: any) => s.id === 'seg_del')
    expect(branchDel.subSegments).toHaveLength(40)
    expect(branchDel[SUB_SEGMENTS_OMITTED]).toBeUndefined()
  })

  it('无裁剪标记的写入路径不解析 JSON', () => {
    const raw = JSON.stringify(makeConversation())
    expect(mergeOmittedSubSegments(raw, '[]')).toBe(raw)
  })

  it('按需查找指定委托段的子过程', () => {
    const msgs = makeConversation()
    const sub = findSegmentSubSegments(msgs as any, 'msg_assistant', 'seg_del')
    expect(sub).toHaveLength(40)
    expect(findSegmentSubSegments(msgs as any, 'msg_assistant', 'missing')).toBeNull()
  })

  it('裁剪视图缓存命中后返回同一内容，失效后重新计算', () => {
    const raw = JSON.stringify(makeConversation())
    const first = getCompactMessagesJson('conv-cache', raw)
    expect(getCompactMessagesJson('conv-cache', raw)).toBe(first)
    invalidateCompactViewCache('conv-cache')
    expect(getCompactMessagesJson('conv-cache', raw)).toBe(first)
  })
})
