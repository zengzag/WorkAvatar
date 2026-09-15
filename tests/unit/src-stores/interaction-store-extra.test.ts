import { describe, it, expect, beforeEach } from 'vitest'

/**
 * src/stores/interaction.store 补充：队列 FIFO 顺序、响应字段完整透传、连续弹出至清空、重复 id 入队。
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
  useInteractionStore.setState({ queue: [], currentRequest: null })
})

describe('interaction.store / 响应字段透传', () => {
  it('完整响应字段（含 allowAlways/allowAlwaysDir/taskHighPermission）透传主进程', () => {
    useInteractionStore.getState().enqueue(req('1'))
    useInteractionStore.getState().respond({
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

  it('请求的富字段（options/script/dirScope/conversationId）原样保存', () => {
    const rich = req('1', {
      type: 'select',
      options: [{ label: '允许', value: 'yes', danger: true }],
      dirScope: 'C:/data',
      script: { language: 'powershell', content: 'Get-Item', truncated: false },
      conversationId: 'conv-1',
      timeout: 30000,
      source: 'file_permission',
    })
    useInteractionStore.getState().enqueue(rich)
    expect(useInteractionStore.getState().currentRequest).toEqual(rich)
  })
})

describe('interaction.store / 队列顺序与弹出', () => {
  it('FIFO：多次 respond 依次弹出', () => {
    const s = useInteractionStore.getState()
    s.enqueue(req('1'))
    s.enqueue(req('2'))
    s.enqueue(req('3'))
    useInteractionStore.getState().respond({ cancelled: true })
    expect(respondCalls[0].id).toBe('1')
    expect(useInteractionStore.getState().currentRequest?.id).toBe('2')
    useInteractionStore.getState().respond({ confirmed: true, cancelled: false })
    expect(respondCalls[1].id).toBe('2')
    expect(useInteractionStore.getState().currentRequest?.id).toBe('3')
    useInteractionStore.getState().respond({ cancelled: false })
    expect(respondCalls[2].id).toBe('3')
    expect(useInteractionStore.getState().currentRequest).toBeNull()
    expect(useInteractionStore.getState().queue).toHaveLength(0)
  })

  it('连续 cancelCurrent 逐个弹出直至清空', () => {
    const s = useInteractionStore.getState()
    s.enqueue(req('1'))
    s.enqueue(req('2'))
    useInteractionStore.getState().cancelCurrent()
    useInteractionStore.getState().cancelCurrent()
    useInteractionStore.getState().cancelCurrent() // 队列已空 → no-op
    expect(respondCalls).toEqual([
      { id: '1', cancelled: true },
      { id: '2', cancelled: true },
    ])
    expect(useInteractionStore.getState().currentRequest).toBeNull()
  })

  it('相同 id 重复入队两次都会保留（不做去重）', () => {
    const s = useInteractionStore.getState()
    s.enqueue(req('dup'))
    s.enqueue(req('dup'))
    expect(useInteractionStore.getState().queue.map(q => q.id)).toEqual(['dup'])
    useInteractionStore.getState().respond({ cancelled: true })
    useInteractionStore.getState().respond({ cancelled: true })
    expect(respondCalls.map(c => c.id)).toEqual(['dup', 'dup'])
  })

  it('大量入队保持顺序', () => {
    const s = useInteractionStore.getState()
    for (let i = 0; i < 50; i++) s.enqueue(req(`${i}`))
    expect(useInteractionStore.getState().currentRequest?.id).toBe('0')
    expect(useInteractionStore.getState().queue.map(q => q.id)).toEqual(
      Array.from({ length: 49 }, (_, i) => `${i + 1}`),
    )
  })

  it('respond 后紧接 enqueue 追加到队尾', () => {
    const s = useInteractionStore.getState()
    s.enqueue(req('1'))
    s.enqueue(req('2'))
    useInteractionStore.getState().respond({ cancelled: true })
    useInteractionStore.getState().enqueue(req('3'))
    expect(useInteractionStore.getState().currentRequest?.id).toBe('2')
    expect(useInteractionStore.getState().queue.map(q => q.id)).toEqual(['3'])
  })
})
