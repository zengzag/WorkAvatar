import { describe, it, expect, beforeEach, vi } from 'vitest'

const respondCalls: any[] = []
;(globalThis as any).window = {
  electronAPI: {
    interaction: {
      respond: (payload: any) => { respondCalls.push(payload) },
    },
  },
}

const { useInteractionStore } = await import('../../../src/stores/interaction.store')

const req = (id: string) => ({ id, type: 'confirm' as const, title: `t-${id}`, message: 'm' })

describe('stores/interaction.store', () => {
  beforeEach(() => {
    respondCalls.length = 0
    useInteractionStore.setState({ queue: [], currentRequest: null })
  })

  it('首个请求直接成为 currentRequest', () => {
    useInteractionStore.getState().enqueue(req('1'))
    expect(useInteractionStore.getState().currentRequest?.id).toBe('1')
    expect(useInteractionStore.getState().queue).toHaveLength(0)
  })

  it('后续请求进入队列', () => {
    useInteractionStore.getState().enqueue(req('1'))
    useInteractionStore.getState().enqueue(req('2'))
    useInteractionStore.getState().enqueue(req('3'))
    expect(useInteractionStore.getState().currentRequest?.id).toBe('1')
    expect(useInteractionStore.getState().queue.map(q => q.id)).toEqual(['2', '3'])
  })

  it('respond 上报 IPC 并弹出下一个请求', () => {
    const s = useInteractionStore.getState()
    s.enqueue(req('1'))
    s.enqueue(req('2'))
    s.respond({ confirmed: true, cancelled: false })
    expect(respondCalls).toEqual([{ id: '1', confirmed: true, cancelled: false }])
    expect(useInteractionStore.getState().currentRequest?.id).toBe('2')
  })

  it('respond 后队列清空则 currentRequest 为 null', () => {
    useInteractionStore.getState().enqueue(req('1'))
    useInteractionStore.getState().respond({ cancelled: true })
    expect(useInteractionStore.getState().currentRequest).toBeNull()
  })

  it('无 currentRequest 时 respond/cancelCurrent 是 no-op', () => {
    useInteractionStore.getState().respond({ cancelled: true })
    useInteractionStore.getState().cancelCurrent()
    expect(respondCalls).toHaveLength(0)
  })

  it('cancelCurrent 上报 cancelled 并弹出下一个', () => {
    const s = useInteractionStore.getState()
    s.enqueue(req('1'))
    s.enqueue(req('2'))
    s.cancelCurrent()
    expect(respondCalls).toEqual([{ id: '1', cancelled: true }])
    expect(useInteractionStore.getState().currentRequest?.id).toBe('2')
  })
})
