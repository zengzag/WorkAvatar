import { describe, it, expect, vi } from 'vitest'
import { MemoryManager } from '../../../electron/main/services/agent/memory/memory-manager'
import { COMPACTED_CHECKPOINT_OPEN } from '../../../electron/main/services/agent/memory/checkpoint'
import type { Message } from '../../../electron/main/services/agent/core/types'

const msg = (role: Message['role'], content: string): Message => ({ role, content })
const anchor = (content: string): Message => ({ role: 'user', content: `ANCHOR:${content}` })
const tail = (content: string): Message => ({ role: 'user', content: `TAIL:${content}` })

describe('memory-manager / headAnchors 与 tailContext 装配', () => {
  it('无压缩时最终顺序为 system → anchors → history → tails → query', async () => {
    const mgr = new MemoryManager({ maxTokens: 100000, reservedResponseTokens: 0 })
    const { messages } = await mgr.manageContext(
      'SYS',
      [msg('user', 'h1'), msg('assistant', 'a1')],
      'Q',
      { headAnchors: [anchor('stable')], tailContext: [tail('task')] }
    )
    expect(messages.map(m => m.content)).toEqual(['SYS', 'ANCHOR:stable', 'h1', 'a1', 'TAIL:task', 'Q'])
    expect(messages.map(m => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'user', 'user'])
  })

  it('anchors/tails 计入 token 预算（挤压历史可用空间）', async () => {
    const mgr = new MemoryManager({ maxTokens: 220, reservedResponseTokens: 0 })
    const bigHistory = [msg('user', 'x'.repeat(120)), msg('assistant', 'y'.repeat(120))]
    const without = await mgr.manageContext('S', bigHistory, 'Q')
    const withCtx = await mgr.manageContext('S', bigHistory, 'Q', {
      headAnchors: [anchor('s'.repeat(200))],
      tailContext: [tail('t'.repeat(200))],
    })
    expect(without.stats.wasCompressed).toBe(false)
    expect(withCtx.stats.wasCompressed).toBe(true)
  })

  it('压缩时 anchors 始终位于 checkpoint 之前，tails 始终位于 query 之前', async () => {
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
      tailContext: [tail('task')],
    })
    expect(messages[0].content).toBe('SYS')
    expect(messages[1].content).toBe('ANCHOR:stable')
    expect(messages[2].content).toContain(COMPACTED_CHECKPOINT_OPEN)
    expect(messages[messages.length - 2].content).toBe('TAIL:task')
    expect(messages[messages.length - 1].content).toBe('Q')
  })

  it('滑动窗口截断只作用于历史，anchors/tails 永不被截断', async () => {
    const mgr = new MemoryManager({ maxTokens: 300, reservedResponseTokens: 0, recentTurnsToKeep: 10 })
    const history = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? msg('user', `u${i} ` + 'x'.repeat(300)) : msg('assistant', `a${i} ` + 'y'.repeat(300)))
    const { messages } = await mgr.manageContext('SYS', history, 'Q', {
      headAnchors: [anchor('stable')],
      tailContext: [tail('task')],
    })
    expect(messages[1].content).toBe('ANCHOR:stable')
    expect(messages[messages.length - 2].content).toBe('TAIL:task')
    // 历史中的 tool 配对修复仍然有效（此处历史无 tool，但结果必须以真实消息结尾）
    expect(messages[messages.length - 1]).toMatchObject({ role: 'user', content: 'Q' })
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
})
