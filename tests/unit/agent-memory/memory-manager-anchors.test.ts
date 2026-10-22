import { describe, it, expect, vi } from 'vitest'
import { MemoryManager } from '../../../electron/main/services/agent/memory/memory-manager'
import { COMPACTED_CHECKPOINT_OPEN } from '../../../electron/main/services/agent/memory/checkpoint'
import type { Message } from '../../../electron/main/services/agent/core/types'

const msg = (role: Message['role'], content: string): Message => ({ role, content })
const anchor = (content: string): Message => ({ role: 'user', content: `ANCHOR:${content}` })

describe('memory-manager / headAnchors 与 requestTailTokens 装配', () => {
  it('无压缩时最终顺序为 system → anchors → history → query（任务上下文不进消息列表）', async () => {
    const mgr = new MemoryManager({ maxTokens: 100000, reservedResponseTokens: 0 })
    const { messages } = await mgr.manageContext(
      'SYS',
      [msg('user', 'h1'), msg('assistant', 'a1')],
      'Q',
      { headAnchors: [anchor('stable')], requestTailTokens: 10 }
    )
    expect(messages.map(m => m.content)).toEqual(['SYS', 'ANCHOR:stable', 'h1', 'a1', 'Q'])
    expect(messages.map(m => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'user'])
  })

  it('anchors/tail 估算均计入 token 预算（挤压历史可用空间）', async () => {
    const mgr = new MemoryManager({ maxTokens: 220, reservedResponseTokens: 0 })
    const bigHistory = [msg('user', 'x'.repeat(120)), msg('assistant', 'y'.repeat(120))]
    const without = await mgr.manageContext('S', bigHistory, 'Q')
    const withAnchor = await mgr.manageContext('S', bigHistory, 'Q', {
      headAnchors: [anchor('s'.repeat(600))],
    })
    const withTail = await mgr.manageContext('S', bigHistory, 'Q', {
      requestTailTokens: 200,
    })
    expect(without.stats.wasCompressed).toBe(false)
    expect(withAnchor.stats.wasCompressed).toBe(true)
    expect(withTail.stats.wasCompressed).toBe(true)
  })

  it('压缩时 anchors 始终位于 checkpoint 之前，query 始终是最后一条', async () => {
    const summarizeFn = vi.fn(async () => 'SUM')
    const mgr = new MemoryManager({
      strategy: 'sliding_window_with_summary', summarizeFn,
      maxTokens: 100000, reservedResponseTokens: 0, recentTurnsToKeep: 1,
    })
    const history = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0 ? msg('user', `u${i}`) : msg('assistant', `a${i}`))
    const { messages } = await mgr.manageContext('SYS', history, 'Q', {
      forceCompress: true,
      headAnchors: [anchor('stable')],
      requestTailTokens: 10,
    })
    expect(messages[0].content).toBe('SYS')
    expect(messages[1].content).toBe('ANCHOR:stable')
    expect(messages[2].content).toContain(COMPACTED_CHECKPOINT_OPEN)
    expect(messages[messages.length - 1].content).toBe('Q')
  })

  it('滑动窗口截断只作用于历史，anchors 永不被截断', async () => {
    const mgr = new MemoryManager({ maxTokens: 300, reservedResponseTokens: 0, recentTurnsToKeep: 10 })
    const history = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? msg('user', `u${i} ` + 'x'.repeat(300)) : msg('assistant', `a${i} ` + 'y'.repeat(300)))
    const { messages } = await mgr.manageContext('SYS', history, 'Q', {
      headAnchors: [anchor('stable')],
      requestTailTokens: 10,
    })
    expect(messages[1].content).toBe('ANCHOR:stable')
    // 历史中的 tool 配对修复仍然有效（此处历史无 tool，但结果必须以真实消息结尾）
    expect(messages[messages.length - 1]).toMatchObject({ role: 'user', content: 'Q' })
  })

  it('压缩结果仍超预算时继续收窄（避免下一轮反复压缩）', async () => {
    const summarizeFn = vi.fn(async () => 'SUM')
    const mgr = new MemoryManager({
      strategy: 'sliding_window_with_summary', summarizeFn,
      maxTokens: 200, reservedResponseTokens: 0, recentTurnsToKeep: 5,
    })
    const history = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? msg('user', `u${i} ` + 'x'.repeat(300)) : msg('assistant', `a${i} ` + 'y'.repeat(300)))
    const { messages } = await mgr.manageContext('S', history, 'Q')
    expect(mgr.estimateTokens(messages)).toBeLessThanOrEqual(200)
  })

  it('summarizeFn 收到主 systemPrompt，用于复用主前缀缓存', async () => {
    const summarizeFn = vi.fn(async () => 'SUM')
    const mgr = new MemoryManager({
      strategy: 'summary', summarizeFn, maxTokens: 100000, reservedResponseTokens: 0,
    })
    const history = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0 ? msg('user', `u${i}`) : msg('assistant', `a${i}`))
    await mgr.manageContext('MAIN-SYS-PROMPT', history, 'Q', { forceCompress: true })
    expect(summarizeFn).toHaveBeenCalledTimes(1)
    expect(summarizeFn.mock.calls[0][1]).toEqual({ systemPrompt: 'MAIN-SYS-PROMPT' })
  })

  it('checkpoint 为 user 角色且包含固定开闭合标签', async () => {
    const summarizeFn = vi.fn(async () => 'SUM')
    const mgr = new MemoryManager({
      strategy: 'summary', summarizeFn, maxTokens: 100000, reservedResponseTokens: 0,
    })
    const history = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0 ? msg('user', `u${i}`) : msg('assistant', `a${i}`))
    const { messages } = await mgr.manageContext('SYS', history, 'Q', { forceCompress: true })
    const checkpoint = messages.find(m => m.content.includes(COMPACTED_CHECKPOINT_OPEN))!
    expect(checkpoint.role).toBe('user')
    expect(checkpoint.content).toContain('</compacted_checkpoint>')
    expect(checkpoint.content).toMatch(/not a user message/)
  })

  it('压缩后冻结切点与摘要：后续轮次追加消息不会重算摘要，checkpoint 字节稳定', async () => {
    const summarizeFn = vi.fn(async () => 'SUM')
    const mgr = new MemoryManager({
      strategy: 'sliding_window_with_summary', summarizeFn,
      maxTokens: 1000, reservedResponseTokens: 0, recentTurnsToKeep: 2,
    })
    const history = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? msg('user', `u${i} ` + 'x'.repeat(200)) : msg('assistant', `a${i} ` + 'y'.repeat(200)))

    const first = await mgr.manageContext('S', history, 'Q1')
    const cp1 = first.messages.find(m => m.content.includes(COMPACTED_CHECKPOINT_OPEN))!
    expect(cp1).toBeTruthy()
    expect(summarizeFn).toHaveBeenCalledTimes(1)

    // 追加一轮：冻结切点不变，摘要不重算，checkpoint 字节一致
    const next = [
      ...history,
      msg('user', 'new question'),
      msg('assistant', 'new answer'),
    ]
    const second = await mgr.manageContext('S', next, 'Q2')
    const cp2 = second.messages.find(m => m.content.includes(COMPACTED_CHECKPOINT_OPEN))!
    expect(cp2.content).toBe(cp1.content)
    expect(summarizeFn).toHaveBeenCalledTimes(1)
    expect(second.messages[second.messages.length - 1]).toMatchObject({ role: 'user', content: 'Q2' })

    // 修改已压缩前缀：指纹失效，必须重新摘要
    const edited = [...next]
    edited[0] = { ...edited[0], content: 'edited-prefix' }
    await mgr.manageContext('S', edited, 'Q3')
    expect(summarizeFn).toHaveBeenCalledTimes(2)
  })

  it('sliding_window 冻结切点：追加消息不会让窗口起点前移', async () => {
    const mgr = new MemoryManager({
      strategy: 'sliding_window',
      maxTokens: 1000, reservedResponseTokens: 0, recentTurnsToKeep: 2,
    })
    const history = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? msg('user', `u${i} ` + 'x'.repeat(200)) : msg('assistant', `a${i} ` + 'y'.repeat(200)))

    const first = await mgr.manageContext('S', history, 'Q1')
    const firstHistoryStart = first.messages[1].content
    expect(first.stats.wasCompressed).toBe(true)

    const next = [
      ...history,
      msg('user', 'new question'),
      msg('assistant', 'new answer'),
    ]
    const second = await mgr.manageContext('S', next, 'Q2')
    // 冻结切点后，起点保持为上一次压缩时的 u26，而不是滑到 u28
    expect(second.messages[1].content).toBe(firstHistoryStart)
    expect(second.messages[1].content).toContain('u26')
  })
})
