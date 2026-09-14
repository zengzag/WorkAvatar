import { describe, it, expect } from 'vitest'
import { MemoryManager } from '../../../electron/main/services/agent/memory/memory-manager'
import type { Message } from '../../../electron/main/services/agent/core/types'

const msg = (role: Message['role'], content: string, extra?: Partial<Message>): Message =>
  ({ role, content, ...extra })

describe('agent/memory/memory-manager 修复验证', () => {
  it('estimateTokens 计入图片开销（图片对话更快触发压缩）', () => {
    const mgr = new MemoryManager({ strategy: 'sliding_window' })
    const withoutImage = [msg('user', 'hello')]
    const withImage = [msg('user', 'hello', { images: ['data:image/png;base64,AAAA'] })]
    const t1 = mgr.estimateTokens(withoutImage)
    const t2 = mgr.estimateTokens(withImage)
    expect(t2).toBeGreaterThan(t1 + 500)
  })

  it('truncateFromStart 不产生孤儿 tool 消息（起点回退到所属 assistant）', async () => {
    const mgr = new MemoryManager({ strategy: 'sliding_window', maxTokens: 4000, reservedResponseTokens: 100 })
    // 构造超预算历史：assistant(toolCalls) + tool 结果在前，之后大量 user/assistant 交替
    const history: Message[] = [
      msg('user', 'u0 ' + 'x'.repeat(200)),
      msg('assistant', '', {
        toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'file_read', arguments: '{"p":1}' } }],
      }),
      msg('tool', 'tool result ' + 'y'.repeat(200), { toolCallId: 'call_1' }),
      ...Array.from({ length: 60 }, (_, i) =>
        i % 2 === 0
          ? msg('user', `u${i} ` + 'a'.repeat(300))
          : msg('assistant', `a${i} ` + 'b'.repeat(300))
      ),
    ]
    const { messages } = await mgr.manageContext('system prompt', history, 'latest question')    // 任何 tool 消息之前必须存在引用其 toolCallId 的 assistant
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        const owner = messages.slice(0, i).reverse().find(
          m => m.role === 'assistant' && (m.toolCalls ?? []).some(tc => tc.id === messages[i].toolCallId)
        )
        expect(owner, `tool 消息 index=${i} 存在孤儿`).toBeTruthy()
      }
    }
  })

  it('truncateFromStart 丢弃段尾孤立 assistant(toolCalls)', async () => {
    const mgr = new MemoryManager()
    // 模拟截断产物：最后一条 assistant(toolCalls) 的 tool 结果被截掉
    const truncated: Message[] = [
      msg('user', 'u1'),
      msg('assistant', '', {
        toolCalls: [{ id: 'call_9', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
      }),
      msg('user', 'u2'),
    ]
    // 直接验证 repair 逻辑经私有路径：通过 truncateFromStart 场景验证
    // 这里构造超预算历史使段尾恰好停在 assistant(toolCalls)
    const history: Message[] = [
      msg('user', 'u0 ' + 'x'.repeat(500)),
      msg('assistant', '', {
        toolCalls: [{ id: 'call_1', type: 'function', function: { name: 't1', arguments: '{}' } }],
      }),
      msg('tool', 'r1', { toolCallId: 'call_1' }),
      msg('user', 'u1 ' + 'y'.repeat(5000)),
      msg('assistant', '', {
        toolCalls: [{ id: 'call_2', type: 'function', function: { name: 't2', arguments: '{}' } }],
      }),
      msg('tool', 'r2 result for call_2', { toolCallId: 'call_2' }),
    ]
    const { messages } = await mgr.manageContext('s', history, 'q')
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        const owner = messages.slice(0, i).reverse().find(
          m => m.role === 'assistant' && (m.toolCalls ?? []).some(tc => tc.id === messages[i].toolCallId)
        )
        expect(owner).toBeTruthy()
      }
      if (messages[i].role === 'assistant' && (messages[i].toolCalls?.length ?? 0) > 0) {
        const ids = messages[i].toolCalls!.map(tc => tc.id)
        for (const id of ids) {
          const matched = messages.slice(i + 1).some(m => m.role === 'tool' && m.toolCallId === id)
          expect(matched, `assistant(toolCalls) id=${id} 在段尾成为孤儿`).toBe(true)
        }
      }
    }
  })

  it('同一批历史的摘要只调用一次 summarizeFn（缓存生效）', async () => {
    let calls = 0
    const mgr = new MemoryManager({
      strategy: 'summary',
      maxTokens: 4000,
      reservedResponseTokens: 100,
      summarizeFn: async () => {
        calls++
        return 'cached summary'
      },
    })
    const history = [
      msg('user', 'u0 ' + 'x'.repeat(2000)),
      msg('assistant', 'a0 ' + 'y'.repeat(2000)),
      ...Array.from({ length: 8 }, (_, i) => msg('user', `u${i} ` + 'z'.repeat(100))),
    ]
    await mgr.manageContext('s', history, 'q1')
    const first = calls
    await mgr.manageContext('s', history, 'q2')
    expect(calls).toBe(first)
  })
})
