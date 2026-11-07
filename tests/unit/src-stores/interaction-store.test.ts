import { describe, it, expect, beforeEach, vi } from 'vitest'

const respondCalls: any[] = []
;(globalThis as any).window = {
  electronAPI: {
    interaction: {
      respond: (payload: any) => { respondCalls.push(payload) },
    },
  },
}

const { useInteractionStore, selectModalRequest } = await import('../../../src/stores/interaction.store')

const req = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'confirm' as const, title: `t-${id}`, message: 'm', ...extra })

describe('stores/interaction.store', () => {
  beforeEach(() => {
    respondCalls.length = 0
    useInteractionStore.setState({ requests: [], taskInlineHost: false })
  })

  it('按到达顺序保存请求，并按 id 去重', () => {
    const s = useInteractionStore.getState()
    s.enqueue(req('1'))
    s.enqueue(req('2'))
    s.enqueue(req('2'))
    expect(useInteractionStore.getState().requests.map(r => r.id)).toEqual(['1', '2'])
  })

  it('respondById 只响应指定请求并上报 IPC', () => {
    const s = useInteractionStore.getState()
    s.enqueue(req('1'))
    s.enqueue(req('2'))
    useInteractionStore.getState().respondById('1', { confirmed: true, cancelled: false })
    expect(respondCalls).toEqual([{ id: '1', confirmed: true, cancelled: false }])
    expect(useInteractionStore.getState().requests.map(r => r.id)).toEqual(['2'])
  })

  it('响应不存在的 id 是 no-op', () => {
    useInteractionStore.getState().respondById('nope', { cancelled: true })
    expect(respondCalls).toHaveLength(0)
  })

  it('dismiss 移除指定请求且不上报响应', () => {
    const s = useInteractionStore.getState()
    s.enqueue(req('1'))
    s.enqueue(req('2'))
    useInteractionStore.getState().dismiss('1')
    useInteractionStore.getState().dismiss('nope')
    expect(respondCalls).toHaveLength(0)
    expect(useInteractionStore.getState().requests.map(r => r.id)).toEqual(['2'])
  })

  it('任务页作为内联宿主时，全局弹窗跳过带会话归属的请求', () => {
    const s = useInteractionStore.getState()
    s.enqueue(req('task', { conversationId: 'conv-1' }))
    s.setTaskInlineHost(true)
    expect(selectModalRequest(useInteractionStore.getState())).toBeNull()

    // 无会话归属的请求（通用对话）仍走弹窗
    s.enqueue(req('generic'))
    expect(selectModalRequest(useInteractionStore.getState())?.id).toBe('generic')

    // 任务页不可见时回退到全局弹窗，避免确认无人处理
    useInteractionStore.getState().setTaskInlineHost(false)
    expect(selectModalRequest(useInteractionStore.getState())?.id).toBe('task')
  })

  it('响应上报失败（异步 reject）时仍移除请求，不阻塞后续确认', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const originalRespond = (globalThis as any).window.electronAPI.interaction.respond
    ;(globalThis as any).window.electronAPI.interaction.respond = vi.fn(() => Promise.reject(new Error('ipc down')))

    const s = useInteractionStore.getState()
    s.enqueue(req('1'))
    s.enqueue(req('2'))
    s.respondById('1', { confirmed: true, cancelled: false })
    expect(useInteractionStore.getState().requests.map(r => r.id)).toEqual(['2'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(warnSpy).toHaveBeenCalled()
    ;(globalThis as any).window.electronAPI.interaction.respond = originalRespond
    warnSpy.mockRestore()
  })
})
