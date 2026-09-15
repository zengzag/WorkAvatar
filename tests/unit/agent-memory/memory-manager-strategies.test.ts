import { describe, it, expect, vi } from 'vitest'
import { MemoryManager } from '../../../electron/main/services/agent/memory/memory-manager'
import { DEFAULT_MEMORY_CONFIG } from '../../../electron/main/services/agent/memory/types'
import type { Message } from '../../../electron/main/services/agent/core/types'

const msg = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message =>
  ({ role, content, ...extra })

describe('memory-manager / estimateTokens', () => {
  it('空数组为 0，单条消息按 17 字符结构开销 + role/content 估算', () => {
    const mgr = new MemoryManager()
    expect(mgr.estimateTokens([])).toBe(0)
    // 17(结构) + 6('system') + 1('S') = 24 → ceil(24/3.5) = 7
    expect(mgr.estimateTokens([msg('system', 'S')])).toBe(7)
    // 17 + 4('user') + 1('Q') = 22 → ceil(22/3.5) = 7
    expect(mgr.estimateTokens([msg('user', 'Q')])).toBe(7)
  })

  it('reasoning_content / toolCallId / toolCalls 均计入估算', () => {
    const mgr = new MemoryManager()
    const base = mgr.estimateTokens([msg('assistant', 'A')])
    expect(mgr.estimateTokens([msg('assistant', 'A', { reasoning_content: 'R'.repeat(35) })])).toBe(base + 10)
    // tool_call_id 附加 "tool_call_id":"..." 包装（+20）
    const withId = mgr.estimateTokens([msg('tool', '', { toolCallId: 'c'.repeat(20) })])
    const noId = mgr.estimateTokens([msg('tool', '')])
    expect(withId - noId).toBe(Math.ceil((20 + 20) / 3.5))
    // 工具调用结构开销 60 + id/type/name/arguments
    const withCalls = mgr.estimateTokens([msg('assistant', '', {
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'n', arguments: '{}' } }],
    })])
    const plain = mgr.estimateTokens([msg('assistant', '')])
    expect(withCalls - plain).toBe(Math.ceil((60 + 2 + 8 + 1 + 2) / 3.5))
  })

  it('每张图片按 1500 token 计', () => {
    const mgr = new MemoryManager()
    const one = mgr.estimateTokens([msg('user', 'x', { images: ['u1'] })])
    const two = mgr.estimateTokens([msg('user', 'x', { images: ['u1', 'u2'] })])
    expect(two - one).toBe(1500)
    expect(one).toBeGreaterThan(1499)
  })

  it('Unicode / emoji 按 UTF-16 码元计数（😀 计 2）', () => {
    const mgr = new MemoryManager()
    expect(mgr.estimateTokens([msg('user', '😀'.repeat(10))])).toBe(Math.ceil((17 + 4 + 20) / 3.5))
  })

  it('content 为 undefined / 空字符串时不抛错', () => {
    const mgr = new MemoryManager()
    expect(mgr.estimateTokens([{ role: 'assistant', content: undefined as any }])).toBe(Math.ceil((17 + 9) / 3.5))
    expect(mgr.estimateTokens([msg('user', '')])).toBe(Math.ceil((17 + 4) / 3.5))
  })

  it('默认配置与 DEFAULT_MEMORY_CONFIG 一致（策略/预算透传到 stats）', async () => {
    const mgr = new MemoryManager()
    const { stats } = await mgr.manageContext('S', [], 'Q')
    expect(DEFAULT_MEMORY_CONFIG).toMatchObject({
      maxTokens: 128000, strategy: 'sliding_window', reservedResponseTokens: 4096, recentTurnsToKeep: 10,
    })
    expect(stats.maxTokens).toBe(DEFAULT_MEMORY_CONFIG.maxTokens)
    expect(stats.strategy).toBe(DEFAULT_MEMORY_CONFIG.strategy)
  })
})

describe('memory-manager / manageContext 预算边界', () => {
  it('历史 token 恰好等于可用预算：不压缩（>` 判定，等于不触发）', async () => {
    const mgr = new MemoryManager({ maxTokens: 39, reservedResponseTokens: 0 })
    const history = [msg('assistant', 'x'.repeat(60))] // 17+9+60=86 → 25
    const { messages, stats } = await mgr.manageContext('S', history, 'Q')
    expect(stats.wasCompressed).toBe(false)
    expect(messages.map(m => m.role)).toEqual(['system', 'assistant', 'user'])
  })

  it('历史 token 超出可用预算 1 token 即触发压缩', async () => {
    const mgr = new MemoryManager({ maxTokens: 38, reservedResponseTokens: 0 })
    const { stats } = await mgr.manageContext('S', [msg('assistant', 'x'.repeat(60))], 'Q')
    expect(stats.wasCompressed).toBe(true)
  })

  it('空历史即使 forceCompress 也不标记压缩', async () => {
    const mgr = new MemoryManager({ maxTokens: 39 })
    const { messages, stats } = await mgr.manageContext('S', [], 'Q', { forceCompress: true })
    expect(stats.wasCompressed).toBe(false)
    expect(messages).toHaveLength(2)
  })

  it('reservedResponseTokens 大于 maxTokens 时可用预算为负，历史必然压缩', async () => {
    const mgr = new MemoryManager({ maxTokens: 100, reservedResponseTokens: 4096 })
    const { stats } = await mgr.manageContext('S', [msg('user', 'a'), msg('assistant', 'b')], 'Q')
    expect(stats.wasCompressed).toBe(true)
  })

  it('单条超大消息无法被进一步截断（预算远小于该消息）', async () => {
    const mgr = new MemoryManager({ maxTokens: 200, reservedResponseTokens: 0, strategy: 'sliding_window' })
    const big = msg('user', 'Z'.repeat(4000))
    const { messages } = await mgr.manageContext('S', [big], 'Q')
    const kept = messages.filter(m => m.role === 'user')
    // 段内最后一条 user 为本次 query，历史中的超大消息仍被保留（至少保留一条）
    expect(kept).toHaveLength(2)
    expect(kept[0].content).toBe(big.content)
  })

  it('forceCompress 在预算充足时同样压缩（内容不变但标记 wasCompressed）', async () => {
    const mgr = new MemoryManager({ maxTokens: 100000, strategy: 'sliding_window', recentTurnsToKeep: 10 })
    const history = [msg('user', 'u0'), msg('assistant', 'a0')]
    const normal = await mgr.manageContext('S', history, 'Q')
    expect(normal.stats.wasCompressed).toBe(false)
    const forced = await mgr.manageContext('S', history, 'Q', { forceCompress: true })
    expect(forced.stats.wasCompressed).toBe(true)
    expect(forced.messages.map(m => m.content)).toEqual(normal.messages.map(m => m.content))
  })

  it('stats：totalMessages / utilizationPercent 取整 / strategy / maxTokens 透传', async () => {
    const mgr = new MemoryManager({ maxTokens: 100, strategy: 'summary', reservedResponseTokens: 0 })
    const { messages, stats } = await mgr.manageContext('S', [], 'Q')
    expect(stats.totalMessages).toBe(messages.length)
    expect(stats.estimatedTokens).toBe(mgr.estimateTokens(messages))
    expect(stats.utilizationPercent).toBe(Math.round((stats.estimatedTokens / 100) * 100))
    expect(stats.strategy).toBe('summary')
    expect(stats.maxTokens).toBe(100)
    expect(stats.actualPromptTokens).toBeUndefined()
  })

  it('lastKnownPromptTokens 写入 stats.actualPromptTokens', async () => {
    const mgr = new MemoryManager()
    const { stats } = await mgr.manageContext('S', [], 'Q', { lastKnownPromptTokens: 1234 })
    expect(stats.actualPromptTokens).toBe(1234)
  })

  it('空 systemPrompt / 空 query 不抛错', async () => {
    const mgr = new MemoryManager()
    const { messages } = await mgr.manageContext('', [msg('user', 'hi')], '')
    expect(messages[0]).toEqual({ role: 'system', content: '' })
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '' })
  })

  it('未知 strategy 回退 sliding_window 行为', async () => {
    const mgr = new MemoryManager({ strategy: 'nope' as any, maxTokens: 100, reservedResponseTokens: 0 })
    const history = [msg('user', 'u0'), msg('assistant', 'a0 ' + 'x'.repeat(300))]
    const { stats, messages } = await mgr.manageContext('S', history, 'Q')
    expect(stats.wasCompressed).toBe(true)
    expect(messages.length).toBeGreaterThan(0)
  })
})

describe('memory-manager / getLastNTurns（私有，白盒）', () => {
  const mgr = new MemoryManager()

  it('保留最后 N 轮 user 起始位置及之后的所有消息', () => {
    const history = [
      msg('user', 'u0'), msg('assistant', 'a0'),
      msg('user', 'u1'), msg('assistant', 'a1'),
      msg('user', 'u2'), msg('assistant', 'a2'),
    ]
    expect((mgr as any).getLastNTurns(history, 1).map(m => m.content)).toEqual(['u2', 'a2'])
    expect((mgr as any).getLastNTurns(history, 2).map(m => m.content)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('user 轮数不足时返回全部；尾部非 user 消息一并保留', () => {
    const history = [msg('user', 'u0'), msg('assistant', 'a0'), msg('tool', 't0')]
    expect((mgr as any).getLastNTurns(history, 5).map(m => m.content)).toEqual(['u0', 'a0', 't0'])
    expect((mgr as any).getLastNTurns([], 5)).toEqual([])
  })

  it('turns 为 0 时仍保留最后一段 user 起始', () => {
    const history = [msg('user', 'u0'), msg('assistant', 'a0'), msg('user', 'u1'), msg('assistant', 'a1')]
    expect((mgr as any).getLastNTurns(history, 0).map(m => m.content)).toEqual(['u1', 'a1'])
  })
})

describe('memory-manager / summary 策略', () => {
  const makeHistory = (n: number) => Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? msg('user', `u${i}`) : msg('assistant', `a${i}`))
  /** 预算充足时走 forceCompress 进入压缩分支，专注验证策略逻辑 */
  const force = { forceCompress: true }

  it('历史 ≤ 4 条时不调用摘要，直接走截断', async () => {
    const summarizeFn = vi.fn(async () => 'SUM')
    const mgr = new MemoryManager({ strategy: 'summary', summarizeFn, maxTokens: 20, reservedResponseTokens: 0 })
    await mgr.manageContext('S', makeHistory(4), 'Q', force)
    expect(summarizeFn).not.toHaveBeenCalled()
  })

  it('历史 > 4 条：摘要消息置顶 + 最近 4 条，摘要输入为更早的消息', async () => {
    const summarizeFn = vi.fn(async () => 'SUM')
    const mgr = new MemoryManager({ strategy: 'summary', summarizeFn, maxTokens: 100000, reservedResponseTokens: 0 })
    const history = makeHistory(10)
    const { messages, stats } = await mgr.manageContext('S', history, 'Q', force)

    expect(stats.wasCompressed).toBe(true)
    expect(messages[0].role).toBe('system')
    const summaryMsg = messages.find(m => m.content.startsWith('[对话历史摘要]'))
    expect(summaryMsg?.content).toBe('[对话历史摘要]\nSUM')
    expect(messages.slice(-5, -1).map(m => m.content)).toEqual(history.slice(-4).map(m => m.content))
    expect(summarizeFn).toHaveBeenCalledTimes(1)
    expect(summarizeFn.mock.calls[0][0]).toHaveLength(6) // 前 6 条（10 - 4）
  })

  it('摘要后仍超预算：丢弃摘要，回退为最近 4 条的截断结果', async () => {
    const summarizeFn = vi.fn(async () => 'X'.repeat(5000))
    const mgr = new MemoryManager({ strategy: 'summary', summarizeFn, maxTokens: 300, reservedResponseTokens: 0 })
    const history = makeHistory(10)
    const { messages } = await mgr.manageContext('S', history, 'Q', force)
    expect(messages.some(m => m.content.startsWith('[对话历史摘要]'))).toBe(false)
    expect(messages.length).toBeGreaterThan(0)
  })

  it('summarizeFn 抛错 → 回退简单摘要', async () => {
    const summarizeFn = vi.fn(async () => { throw new Error('LLM down') })
    const mgr = new MemoryManager({ strategy: 'summary', summarizeFn, maxTokens: 100000, reservedResponseTokens: 0 })
    const { messages } = await mgr.manageContext('S', makeHistory(8), 'Q', force)
    const summaryMsg = messages.find(m => m.content.startsWith('[对话历史摘要]'))
    // 摘要输入为前 4 条（u0/a1/u2/a3）→ 2 条 user、2 条 assistant
    expect(summaryMsg?.content).toContain('共 2 条用户消息，2 条助手回复。')
  })

  it('summarizeFn 返回空串 → 不写缓存，下次仍调用', async () => {
    const summarizeFn = vi.fn(async () => '')
    const mgr = new MemoryManager({ strategy: 'summary', summarizeFn, maxTokens: 100000, reservedResponseTokens: 0 })
    const history = makeHistory(10)
    await mgr.manageContext('S', history, 'Q', force)
    await mgr.manageContext('S', history, 'Q', force)
    expect(summarizeFn).toHaveBeenCalledTimes(2)
  })

  it('同 key 缓存命中；历史首/尾或条数变化则 key 变化重新调用', async () => {
    const summarizeFn = vi.fn(async () => 'SUM')
    const mgr = new MemoryManager({ strategy: 'summary', summarizeFn, maxTokens: 100000, reservedResponseTokens: 0 })
    const history = makeHistory(10)
    await mgr.manageContext('S', history, 'Q', force)
    await mgr.manageContext('S', history, 'Q2', force)
    expect(summarizeFn).toHaveBeenCalledTimes(1)

    await mgr.manageContext('S', makeHistory(12), 'Q', force) // 条数变化
    expect(summarizeFn).toHaveBeenCalledTimes(2)

    const changed = [...history]
    changed[0] = msg('user', '完全不同的话题')
    await mgr.manageContext('S', changed, 'Q', force)
    expect(summarizeFn).toHaveBeenCalledTimes(3)
  })

  it('同 key 并发调用复用进行中的 Promise', async () => {
    let resolveFn!: (v: string) => void
    const summarizeFn = vi.fn(() => new Promise<string>(res => { resolveFn = res }))
    const mgr = new MemoryManager({ strategy: 'summary', summarizeFn, maxTokens: 100000, reservedResponseTokens: 0 })
    const history = makeHistory(10)
    const p1 = mgr.manageContext('S', history, 'Q', force)
    const p2 = mgr.manageContext('S', history, 'Q', force)
    resolveFn('SUM')
    await Promise.all([p1, p2])
    expect(summarizeFn).toHaveBeenCalledTimes(1)
  })

  it('不同 key 交错时不清空仍在进行中的同 key Promise（不重复调 LLM 摘要）', async () => {
    const gates: Array<(v: string) => void> = []
    const summarizeFn = vi.fn(() => new Promise<string>(res => { gates.push(res) }))
    const mgr = new MemoryManager({ strategy: 'summary', summarizeFn, maxTokens: 100000, reservedResponseTokens: 0 })
    const h1 = makeHistory(10)
    const h2 = makeHistory(12)

    const pA = mgr.manageContext('S', h1, 'Q', force)
    const pB = mgr.manageContext('S', h2, 'Q', force)
    expect(summarizeFn).toHaveBeenCalledTimes(2)
    gates[0]('SUM-A') // A 完成：不得清掉仍在进行中的 B 的 Promise 引用
    await pA
    const pC = mgr.manageContext('S', h2, 'Q', force) // 复用 B 进行中的 Promise
    expect(summarizeFn).toHaveBeenCalledTimes(2)
    gates[1]('SUM-B')
    await Promise.all([pB, pC])
  })
})

describe('memory-manager / sliding_window_with_summary 策略', () => {
  const makeHistory = (n: number) => Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? msg('user', `u${i}`) : msg('assistant', `a${i}`))
  const force = { forceCompress: true }

  it('最近 N 轮未超预算且存在更早历史 → 摘要 + 最近 N 轮', async () => {
    const summarizeFn = vi.fn(async () => 'SUM')
    const mgr = new MemoryManager({
      strategy: 'sliding_window_with_summary', summarizeFn,
      maxTokens: 100000, reservedResponseTokens: 0, recentTurnsToKeep: 2,
    })
    const { messages } = await mgr.manageContext('S', makeHistory(10), 'Q', force)
    expect(messages[1].content).toBe('[对话历史摘要]\nSUM') // [system, summary, ...recent]
    expect(summarizeFn).toHaveBeenCalledTimes(1)
    expect(messages.length).toBeGreaterThanOrEqual(3)
  })

  it('历史全部落在最近 N 轮内时不调用摘要', async () => {
    const summarizeFn = vi.fn(async () => 'SUM')
    const mgr = new MemoryManager({
      strategy: 'sliding_window_with_summary', summarizeFn,
      maxTokens: 100000, reservedResponseTokens: 0, recentTurnsToKeep: 10,
    })
    const { messages } = await mgr.manageContext('S', makeHistory(6), 'Q', force)
    expect(summarizeFn).not.toHaveBeenCalled()
    expect(messages.some(m => m.content.startsWith('[对话历史摘要]'))).toBe(false)
  })

  it('最近 N 轮已超预算 → 直接截断，不生成摘要', async () => {
    const summarizeFn = vi.fn(async () => 'SUM')
    const mgr = new MemoryManager({
      strategy: 'sliding_window_with_summary', summarizeFn,
      maxTokens: 200, reservedResponseTokens: 0, recentTurnsToKeep: 3,
    })
    const history = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? msg('user', `u${i}` + 'x'.repeat(200)) : msg('assistant', `a${i}` + 'y'.repeat(200)))
    const { messages } = await mgr.manageContext('S', history, 'Q', force)
    expect(summarizeFn).not.toHaveBeenCalled()
    expect(messages.some(m => m.content.startsWith('[对话历史摘要]'))).toBe(false)
  })
})

describe('memory-manager / tool 消息配对修复（经 truncateFromStart）', () => {
  const mgr = new MemoryManager()
  const call = (id: string) => ({ id, type: 'function' as const, function: { name: 't', arguments: '{}' } })
  const truncate = (messages: Message[], budget: number) => (mgr as any).truncateFromStart(messages, budget)

  it('空输入返回空数组', () => {
    expect(truncate([], 1)).toEqual([])
  })

  it('段首孤儿 tool 无所属 assistant → 丢弃该 tool', () => {
    const history = [
      msg('tool', 'orphan-result', { toolCallId: 'missing' }),
      msg('user', 'u1'),
      msg('assistant', 'a1'),
    ]
    const out = truncate(history, 1) // 预算极小，只剩最后一条
    expect(out.some(m => m.role === 'tool')).toBe(false)
  })

  it('段首 tool 有所属 assistant 但 owner 已被截断 → 丢弃该孤儿 tool', () => {
    // 截断窗口只能容纳 tool 结果（其所属 assistant 比它更长，被挤出窗口外）
    const history = [
      msg('assistant', '', { toolCalls: [call('c1')] }),
      msg('tool', 'r1', { toolCallId: 'c1' }),
      msg('user', 'u1'),
    ]
    const budget = mgr.estimateTokens(history.slice(1))
    const out = truncate(history, budget)
    expect(out.map(m => m.role)).toEqual(['user'])
  })

  it('段尾孤立 assistant(toolCalls)（tool 结果被切掉）→ 丢弃该 assistant', () => {
    const a = msg('user', 'A'.repeat(1000))
    const b = msg('user', 'B'.repeat(1000))
    const tail = msg('assistant', '', { toolCalls: [call('c3')] }) // 其后无 tool 结果
    const history = [a, b, tail]
    const budget = mgr.estimateTokens([b]) + mgr.estimateTokens([tail]) // 恰好容纳 b + tail，a 被挤出
    const out = truncate(history, budget)
    expect(out.map(m => m.role)).toEqual(['user'])
    expect(out[0].content).toBe(b.content)
  })

  it('预算充足（未发生截断）时不做配对修复，原样返回', () => {
    const history = [
      msg('assistant', '', { toolCalls: [call('c3')] }),
    ]
    expect(truncate(history, 100000)).toBe(history)
  })

  it('配对完整的历史不被改动', () => {
    const history = [
      msg('assistant', '', { toolCalls: [call('c1'), call('c2')] }),
      msg('tool', 'r1', { toolCallId: 'c1' }),
      msg('tool', 'r2', { toolCallId: 'c2' }),
    ]
    expect(truncate(history, 100000)).toEqual(history)
  })
})

describe('memory-manager / stats 与真实 prompt tokens', () => {
  it('未调用 manageContext 时 getStats 为 null', () => {
    const mgr = new MemoryManager()
    expect(mgr.getStats()).toBeNull()
    mgr.setActualPromptTokens(100) // 不应抛错
    expect(mgr.getStats()).toBeNull()
  })

  it('setActualPromptTokens 覆盖利用率，保留估算值', async () => {
    const mgr = new MemoryManager({ maxTokens: 1000 })
    const { stats } = await mgr.manageContext('S', [], 'Q')
    const estimated = stats.estimatedTokens
    mgr.setActualPromptTokens(250)
    const after = mgr.getStats()!
    expect(after.actualPromptTokens).toBe(250)
    expect(after.utilizationPercent).toBe(25)
    expect(after.estimatedTokens).toBe(estimated)
  })

  it('promptTokens 为 0 / 超上限时利用率按原样取整', async () => {
    const mgr = new MemoryManager({ maxTokens: 1000 })
    await mgr.manageContext('S', [], 'Q')
    mgr.setActualPromptTokens(0)
    expect(mgr.getStats()!.utilizationPercent).toBe(0)
    mgr.setActualPromptTokens(1500)
    expect(mgr.getStats()!.utilizationPercent).toBe(150)
  })
})
