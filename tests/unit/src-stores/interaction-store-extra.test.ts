import { describe, it, expect, beforeEach } from 'vitest'

/**
 * src/stores/interaction.store 补充：请求顺序、响应字段完整透传、按 id 移除、富字段保存。
 */

const respondCalls: any[] = []

;(globalThis as any).window = {
  electronAPI: {
    interaction: {
      respond: (payload: any) => { respondCalls.push(payload) },
    },
  },
}

const { useInteractionStore } = await import('../../../src/stores/interaction.store')

const req = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'confirm' as const, title: `t-${id}`, message: 'm', ...extra })

beforeEach(() => {
  respondCalls.length = 0
  useInteractionStore.setState({ requests: [], suppressedIds: [], taskInlineHost: false })
})

describe('interaction.store / 响应字段透传', () => {
  it('完整响应字段（含 allowAlways/allowAlwaysDir/taskHighPermission）透传主进程', () => {
    useInteractionStore.getState().enqueue(req('1'))
    useInteractionStore.getState().respondById('1', {
      confirmed: true,
      selectedValue: 'a',
      inputValue: 'text',
      cancelled: false,
      allowAlways: true,
      allowAlwaysDir: false,
      taskHighPermission: true,
    })
    expect(respondCalls[0]).toEqual({
      id: '1',
      confirmed: true,
      selectedValue: 'a',
      inputValue: 'text',
      cancelled: false,
      allowAlways: true,
      allowAlwaysDir: false,
      taskHighPermission: true,
    })
  })

  it('请求的富字段（options/dirScope/diff/conversationId）原样保存', () => {
    const rich = req('1', {
      type: 'select',
      options: [{ label: '允许', value: 'yes', danger: true }],
      dirScope: 'C:/data',
      diff: { content: '@@ -1 +1 @@\n-a\n+b', truncated: false },
      conversationId: 'conv-1',
      timeout: 30000,
      source: 'security:fs_outside_workspace:写入',
    })
    useInteractionStore.getState().enqueue(rich)
    expect(useInteractionStore.getState().requests[0]).toEqual(rich)
  })
})

describe('interaction.store / 顺序与按 id 消费', () => {
  it('保持 FIFO，响应中间请求不改变其余顺序', () => {
    const s = useInteractionStore.getState()
    s.enqueue(req('1'))
    s.enqueue(req('2'))
    s.enqueue(req('3'))
    useInteractionStore.getState().respondById('2', { cancelled: true })
    expect(respondCalls[0].id).toBe('2')
    expect(useInteractionStore.getState().requests.map(r => r.id)).toEqual(['1', '3'])
  })

  it('可只清理单个任务的请求，其余任务不受影响', () => {
    const s = useInteractionStore.getState()
    s.enqueue(req('a1', { conversationId: 'a' }))
    s.enqueue(req('b1', { conversationId: 'b' }))
    s.enqueue(req('a2', { conversationId: 'a' }))
    useInteractionStore.getState().respondById('a1', { cancelled: true })
    expect(useInteractionStore.getState().requests.map(r => r.id)).toEqual(['b1', 'a2'])
  })

  it('大量入队保持顺序', () => {
    const s = useInteractionStore.getState()
    for (let i = 0; i < 50; i++) s.enqueue(req(`${i}`))
    expect(useInteractionStore.getState().requests.map(r => r.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => `${i}`),
    )
  })
})
