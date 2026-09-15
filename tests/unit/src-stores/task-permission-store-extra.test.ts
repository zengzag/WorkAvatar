import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * src/stores/task-permission.store 补充：同步主进程的异常兜底、重复调用幂等、多会话隔离。
 */

type Mode = 'ok' | 'reject' | 'syncThrow' | 'missing'
let mode: Mode = 'ok'
const setCalls: Array<{ conversationId?: string; enabled: boolean }> = []

;(globalThis as any).window = {
  electronAPI: {
    interaction: {
      setTaskHighPermission: (params: { conversationId?: string; enabled: boolean }) => {
        if (mode === 'syncThrow') throw new Error('bridge missing')
        setCalls.push(params)
        if (mode === 'reject') return Promise.reject(new Error('ipc down'))
        return Promise.resolve({ success: true })
      },
    },
  },
}

const { useTaskPermissionStore } = await import('../../../src/stores/task-permission.store')

beforeEach(() => {
  mode = 'ok'
  setCalls.length = 0
  useTaskPermissionStore.setState({ enabledKeys: {} })
})

describe('task-permission.store / 同步异常兜底', () => {
  it('主进程拒绝时本地状态仍更新且不抛错', async () => {
    mode = 'reject'
    expect(() => useTaskPermissionStore.getState().enable('conv-1')).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(useTaskPermissionStore.getState().enabledKeys['conv-1']).toBe(true)
  })

  it('preload 缺少该 API（同步抛错）时不抛错', () => {
    mode = 'missing'
    const original = (globalThis as any).window.electronAPI.interaction
    delete (globalThis as any).window.electronAPI.interaction
    expect(() => useTaskPermissionStore.getState().enable('conv-1')).not.toThrow()
    expect(() => useTaskPermissionStore.getState().disable('conv-1')).not.toThrow()
    expect(useTaskPermissionStore.getState().enabledKeys).toEqual({})
    ;(globalThis as any).window.electronAPI.interaction = original
  })

  it('API 同步抛错时被吞掉（本地状态不受影响）', () => {
    mode = 'syncThrow'
    expect(() => useTaskPermissionStore.getState().enable('conv-1')).not.toThrow()
    expect(useTaskPermissionStore.getState().enabledKeys['conv-1']).toBe(true)
  })
})

describe('task-permission.store / 幂等与会话隔离', () => {
  it('重复 enable 同一会话：状态不变但仍同步两次', () => {
    const s = useTaskPermissionStore.getState()
    s.enable('conv-1')
    s.enable('conv-1')
    expect(Object.keys(useTaskPermissionStore.getState().enabledKeys)).toEqual(['conv-1'])
    expect(setCalls.filter(c => c.enabled)).toHaveLength(2)
  })

  it('多个会话互不影响', () => {
    const s = useTaskPermissionStore.getState()
    s.enable('conv-1')
    s.enable('conv-2')
    s.disable('conv-1')
    expect(useTaskPermissionStore.getState().enabledKeys).toEqual({ 'conv-2': true })
    expect(setCalls.at(-1)).toEqual({ conversationId: 'conv-1', enabled: false })
  })

  it('disable 未启用的会话仍通知主进程撤销', () => {
    useTaskPermissionStore.getState().disable('conv-9')
    expect(setCalls).toEqual([{ conversationId: 'conv-9', enabled: false }])
    expect(useTaskPermissionStore.getState().enabledKeys).toEqual({})
  })

  it('空串会话 id 视为无效（no-op）', () => {
    const s = useTaskPermissionStore.getState()
    s.enable('')
    s.disable('')
    expect(setCalls).toHaveLength(0)
    expect(useTaskPermissionStore.getState().enabledKeys).toEqual({})
  })

  it('enable → disable 往返后状态清空', () => {
    const s = useTaskPermissionStore.getState()
    s.enable('conv-1')
    s.disable('conv-1')
    expect(useTaskPermissionStore.getState().enabledKeys).toEqual({})
    expect(setCalls).toEqual([
      { conversationId: 'conv-1', enabled: true },
      { conversationId: 'conv-1', enabled: false },
    ])
  })
})
