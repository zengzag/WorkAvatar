import { describe, it, expect, beforeEach } from 'vitest'

const setCalls: Array<{ conversationId?: string; sessionId?: string; enabled: boolean }> = []
;(globalThis as any).window = {
  electronAPI: {
    interaction: {
      setTaskHighPermission: (params: { conversationId?: string; sessionId?: string; enabled: boolean }) => {
        setCalls.push(params)
        return Promise.resolve({ success: true })
      },
    },
  },
}

const { useTaskPermissionStore } = await import('../../../src/stores/task-permission.store')

describe('stores/task-permission.store', () => {
  beforeEach(() => {
    setCalls.length = 0
    useTaskPermissionStore.setState({ enabledKeys: {} })
  })

  it('enable 标记会话为高权限并同步主进程登记', () => {
    useTaskPermissionStore.getState().enable('conv-1')
    expect(useTaskPermissionStore.getState().enabledKeys['conv-1']).toBe(true)
    expect(setCalls).toEqual([{ conversationId: 'conv-1', enabled: true }])
  })

  it('disable 清除标记并通知主进程撤销登记', () => {
    useTaskPermissionStore.getState().enable('conv-1')
    useTaskPermissionStore.getState().disable('conv-1')
    expect(useTaskPermissionStore.getState().enabledKeys['conv-1']).toBeUndefined()
    expect(setCalls.at(-1)).toEqual({ conversationId: 'conv-1', enabled: false })
  })

  it('会话 id 为空时 no-op（无法定位登记项，避免误标记）', () => {
    useTaskPermissionStore.getState().enable(undefined)
    useTaskPermissionStore.getState().enable(null)
    useTaskPermissionStore.getState().disable(undefined)
    expect(setCalls).toHaveLength(0)
    expect(useTaskPermissionStore.getState().enabledKeys).toEqual({})
  })
})
