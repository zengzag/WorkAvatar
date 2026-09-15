/**
 * 统一交互服务单测（打桩 electron.ipcMain，使用假定时器）：
 * - 无上下文 / 会话未注册 / 窗口已销毁 → 按类型返回"拒绝"语义（confirm=false，其余 cancelled）
 * - 请求下发 → 响应回填；超时 300s 语义（timedOut）
 * - allowAlways 的 source 级授权缓存与 taskHighPermission 任务级高权限登记
 * - unregisterSession 把挂起请求全部按取消收尾
 * - 批量/异常下发路径（webContents.send 抛错）不悬挂
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AsyncLocalStorage } from 'async_hooks'

const mockState = vi.hoisted(() => {
  const ipcHandlers = new Map<string, Function>()
  return { ipcHandlers }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Function) => { mockState.ipcHandlers.set(channel, handler) },
  },
  BrowserWindow: class {},
}))

import UnifiedInteractionService, {
  interactionContext,
  INTERACTION_TIMEOUT_MS,
  type SessionContext,
} from '../../../electron/main/services/unified-interaction.service'
import { IPC_CHANNELS } from '../../../electron/shared/ipc-channels'

function makeWebContents(init: { destroyed?: boolean; throwOnSend?: boolean } = {}) {
  const s = { destroyed: false, throwOnSend: false, ...init }
  return {
    s,
    sent: [] as any[],
    isDestroyed: () => s.destroyed,
    send: vi.fn((channel: string, payload: any) => {
      if (s.throwOnSend) throw new Error('webContents destroyed')
      ;(makeWebContents as any).lastSent = { channel, payload }
      return undefined
    }),
  } as any
}

const service = UnifiedInteractionService.getInstance()

function withCtx<T>(ctx: SessionContext, fn: () => T): T {
  return interactionContext.run(ctx, fn)
}

function lastSent(): { channel: string; payload: any } | undefined {
  return (makeWebContents as any).lastSent
}

function respond(response: Record<string, any>) {
  const handler = mockState.ipcHandlers.get(IPC_CHANNELS.INTERACTION_RESPONSE)!
  return handler({ sender: currentSession?.webContents }, response) as any
}

let currentSession: { webContents: any } | null = null

function register(sessionId: string, init?: { destroyed?: boolean; throwOnSend?: boolean }) {
  const wc = makeWebContents(init)
  service.registerSession(sessionId, wc)
  currentSession = { webContents: wc }
  return wc
}

beforeEach(() => {
  vi.useFakeTimers()
  currentSession = null
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  // 授权/高权限状态挂在单例上，逐个清理避免测试间串味
  for (const key of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11',
    'c1', 'c7', 'c11', 'c12', 'cA', 'cB', 'conv-x', 'sess-x', 'sess-y']) {
    service.clearAllowedSources(key)
  }
})

describe('unified-interaction / 超时与拒绝语义', () => {
  it('默认超时常量为 5 分钟', () => {
    expect(INTERACTION_TIMEOUT_MS).toBe(300000)
  })

  it('无交互上下文：confirm 返回 confirmed=false，select/input 返回 cancelled=true', async () => {
    const confirm = await service.request({ type: 'confirm', title: 'T', message: 'M' })
    expect(confirm).toEqual({ id: '', confirmed: false, cancelled: false })

    const select = await service.request({ type: 'select', title: 'T', message: 'M' })
    expect(select).toEqual({ id: '', cancelled: true })

    const input = await service.request({ type: 'input', title: 'T', message: 'M' })
    expect(input).toEqual({ id: '', cancelled: true })
  })

  it('会话未注册（后台/窗口已关）按拒绝处理，不下发请求', async () => {
    const res = await withCtx({ sessionId: 'unknown', employeeId: 'e1' }, () =>
      service.request({ type: 'confirm', title: 'T', message: 'M' }),
    )
    expect(res.confirmed).toBe(false)
  })

  it('webContents 已销毁按拒绝处理', async () => {
    const wc = register('s-destroyed', { destroyed: true })
    const res = await withCtx({ sessionId: 's-destroyed', employeeId: 'e1' }, () =>
      service.request({ type: 'confirm', title: 'T', message: 'M' }),
    )
    expect(res.confirmed).toBe(false)
    expect(wc.send).not.toHaveBeenCalled()
  })
})

describe('unified-interaction / 请求下发与响应', () => {
  it('下发携带生成的 id 与 conversationId，响应经 IPC 回填', async () => {
    register('s1')
    const promise = withCtx({ sessionId: 's1', employeeId: 'e1', conversationId: 'c1' }, () =>
      service.request({ type: 'confirm', title: 'T', message: 'M', source: 'security:x' }),
    )
    const sent = lastSent()!
    expect(sent.channel).toBe(IPC_CHANNELS.INTERACTION_REQUEST)
    expect(sent.payload.conversationId).toBe('c1')
    expect(sent.payload.id).toBeTruthy()

    const ack = respond({ id: sent.payload.id, confirmed: true, cancelled: false })
    expect(ack).toEqual({ success: true })
    await expect(promise).resolves.toEqual({ id: sent.payload.id, confirmed: true, cancelled: false })
  })

  it('未知请求 id 的响应返回失败', async () => {
    register('s2')
    expect(respond({ id: 'nope', confirmed: true, cancelled: false })).toEqual({
      success: false,
      error: 'Request not found',
    })
  })

  it('超时后按 timedOut 收尾，且迟到响应不再命中', async () => {
    register('s3')
    const promise = withCtx({ sessionId: 's3', employeeId: 'e1' }, () =>
      service.request({ type: 'confirm', title: 'T', message: 'M' }),
    )
    const id = lastSent()!.payload.id

    await vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUT_MS - 1)
    await expect(Promise.race([promise.then(() => 'resolved'), Promise.resolve('pending')])).resolves.toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).resolves.toEqual({ id, cancelled: true, timedOut: true })
    expect(respond({ id, confirmed: true, cancelled: false }).success).toBe(false)
  })

  it('自定义 timeout 生效', async () => {
    register('s4')
    const promise = withCtx({ sessionId: 's4', employeeId: 'e1' }, () =>
      service.request({ type: 'input', title: 'T', message: 'M', timeout: 5000 }),
    )
    await vi.advanceTimersByTimeAsync(4999)
    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).resolves.toMatchObject({ cancelled: true, timedOut: true })
  })

  it('webContents.send 抛错时立即按取消收尾且不悬挂', async () => {
    register('s5', { throwOnSend: true })
    const promise = withCtx({ sessionId: 's5', employeeId: 'e1' }, () =>
      service.request({ type: 'confirm', title: 'T', message: 'M' }),
    )
    await expect(promise).resolves.toEqual({ id: expect.any(String), cancelled: true })
    // 定时器已清理：推进时间不应产生副作用
    await vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUT_MS)
  })

  it('unregisterSession 把挂起请求全部按取消收尾', async () => {
    register('s6')
    const p1 = withCtx({ sessionId: 's6', employeeId: 'e1' }, () =>
      service.request({ type: 'confirm', title: 'A', message: 'M' }),
    )
    const p2 = withCtx({ sessionId: 's6', employeeId: 'e1' }, () =>
      service.request({ type: 'select', title: 'B', message: 'M' }),
    )
    service.unregisterSession('s6')
    await expect(p1).resolves.toMatchObject({ cancelled: true })
    await expect(p2).resolves.toMatchObject({ cancelled: true })
    // 会话已移除：后续请求直接拒绝
    const after = await withCtx({ sessionId: 's6', employeeId: 'e1' }, () =>
      service.request({ type: 'confirm', title: 'C', message: 'M' }),
    )
    expect(after.confirmed).toBe(false)
  })

  it('unregisterSession 对未知会话是空操作', () => {
    expect(() => service.unregisterSession('never-registered')).not.toThrow()
  })
})

describe('unified-interaction / 授权缓存与高权限', () => {
  it('allowAlways 后同一 source 直接放行，不再下发请求', async () => {
    register('s7')
    const first = withCtx({ sessionId: 's7', employeeId: 'e1', conversationId: 'c7' }, () =>
      service.request({ type: 'confirm', title: 'T', message: 'M', source: 'security:fs_outside_workspace:写入' }),
    )
    const id = lastSent()!.payload.id
    respond({ id, confirmed: true, cancelled: false, allowAlways: true })
    await expect(first).resolves.toMatchObject({ confirmed: true })

    const second = await withCtx({ sessionId: 's7', employeeId: 'e1', conversationId: 'c7' }, () =>
      service.request({ type: 'confirm', title: 'T', message: 'M', source: 'security:fs_outside_workspace:写入' }),
    )
    expect(second).toEqual({ id: '', confirmed: true, cancelled: false, allowAlways: true })
  })

  it('未选择 allowAlways 时第二次仍会弹窗', async () => {
    register('s8')
    const sendCount = () => (currentSession!.webContents.send as any).mock.calls.length
    const req = () => withCtx({ sessionId: 's8', employeeId: 'e1' }, () =>
      service.request({ type: 'confirm', title: 'T', message: 'M', source: 'security:x' }),
    )
    const p = req()
    respond({ id: lastSent()!.payload.id, confirmed: true, cancelled: false })
    await p
    const before = sendCount()
    const p2 = req()
    expect(sendCount()).toBe(before + 1)
    respond({ id: lastSent()!.payload.id, confirmed: true, cancelled: false })
    await p2
  })

  it('无 source 的请求不会被 allowAlways 缓存命中，每次都弹窗', async () => {
    register('s9')
    const req = async () => {
      const p = withCtx({ sessionId: 's9', employeeId: 'e1' }, () =>
        service.request({ type: 'confirm', title: 'T', message: 'M' }),
      )
      respond({ id: lastSent()!.payload.id, confirmed: true, cancelled: false, allowAlways: true })
      return p
    }
    await req()
    const wc = currentSession!.webContents
    const before = wc.send.mock.calls.length
    await req()
    expect(wc.send.mock.calls.length).toBe(before + 1)
  })

  it('allowAlways 授权按 conversationId 隔离，不同会话互不影响', async () => {
    register('s10')
    const p = withCtx({ sessionId: 's10', employeeId: 'e1', conversationId: 'cA' }, () =>
      service.request({ type: 'confirm', title: 'T', message: 'M', source: 'src' }),
    )
    respond({ id: lastSent()!.payload.id, confirmed: true, cancelled: false, allowAlways: true })
    await p

    // 同一 sessionId 但不同 conversationId（allowKey 不同）→ 仍需弹窗
    const sendCount = () => currentSession!.webContents.send.mock.calls.length
    const before = sendCount()
    const p2 = withCtx({ sessionId: 's10', employeeId: 'e1', conversationId: 'cB' }, () =>
      service.request({ type: 'confirm', title: 'T', message: 'M', source: 'src' }),
    )
    expect(sendCount()).toBe(before + 1)
    respond({ id: lastSent()!.payload.id, confirmed: true, cancelled: false })
    await p2
  })

  it('taskHighPermission 响应登记会话级高权限，clearAllowedSources 撤销', async () => {
    register('s11')
    const p = withCtx({ sessionId: 's11', employeeId: 'e1', conversationId: 'c11' }, () =>
      service.request({ type: 'confirm', title: 'T', message: 'M' }),
    )
    respond({ id: lastSent()!.payload.id, confirmed: true, cancelled: false, taskHighPermission: true })
    await p
    expect(service.isTaskHighPermission('c11')).toBe(true)
    service.clearAllowedSources('c11')
    expect(service.isTaskHighPermission('c11')).toBe(false)
  })

  it('isTaskHighPermission 无参数时取当前上下文，无上下文返回 false', () => {
    expect(service.isTaskHighPermission()).toBe(false)
    service.setTaskHighPermission('c12', true)
    expect(service.isTaskHighPermission()).toBe(false) // 无上下文
    expect(withCtx({ sessionId: 's', employeeId: 'e', conversationId: 'c12' }, () => service.isTaskHighPermission())).toBe(true)
    service.setTaskHighPermission('c12', false)
  })

  it('setTaskHighPermission 空 key 被忽略', () => {
    service.setTaskHighPermission('', true)
    expect(service.isTaskHighPermission('')).toBe(false)
  })
})

describe('unified-interaction / 渲染端开关 IPC', () => {
  it('INTERACTION_SET_TASK_PERMISSION 缺会话标识返回错误', () => {
    const handler = mockState.ipcHandlers.get(IPC_CHANNELS.INTERACTION_SET_TASK_PERMISSION)!
    expect(handler({}, {})).toEqual({ success: false, error: '缺少会话标识' })
    expect(handler({}, undefined)).toEqual({ success: false, error: '缺少会话标识' })
  })

  it('INTERACTION_SET_TASK_PERMISSION 优先 conversationId，其次 sessionId', () => {
    const handler = mockState.ipcHandlers.get(IPC_CHANNELS.INTERACTION_SET_TASK_PERMISSION)!
    expect(handler({}, { conversationId: 'conv-x', sessionId: 'sess-x', enabled: true })).toEqual({ success: true })
    expect(service.isTaskHighPermission('conv-x')).toBe(true)
    expect(service.isTaskHighPermission('sess-x')).toBe(false)

    handler({}, { sessionId: 'sess-y', enabled: true })
    expect(service.isTaskHighPermission('sess-y')).toBe(true)

    handler({}, { sessionId: 'sess-y', enabled: false })
    expect(service.isTaskHighPermission('sess-y')).toBe(false)
  })
})
