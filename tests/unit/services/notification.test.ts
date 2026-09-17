/**
 * 应用通知服务单测（打桩 electron.Notification / ipcMain / PluginHostService）：
 * - 主窗口失焦/最小化/隐藏/销毁 → 走系统通知；激活 → 走 IPC
 * - source 路由：`plugin:<id>` 走插件桥广播，其余（含非法 `plugin:`）走宿主 IPC
 * - 系统通知失败回落 IPC；通知点击聚焦主窗口并下发 click 事件
 * - 参数校验与 IPC 处理器幂等注册
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const mockState = vi.hoisted(() => {
  const notifications: any[] = []
  const ipcHandlers = new Map<string, Function>()
  const pluginHost = { broadcast: vi.fn() }
  const flags = { supported: true, throwOnConstruct: false }
  return { notifications, ipcHandlers, pluginHost, flags }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Function) => { mockState.ipcHandlers.set(channel, handler) },
  },
  Notification: class extends EventEmitter {
    static isSupported() { return mockState.flags.supported }
    show = vi.fn()
    constructor(public options: Record<string, any>) {
      super()
      if (mockState.flags.throwOnConstruct) throw new Error('notification backend down')
      mockState.notifications.push(this)
    }
  },
  BrowserWindow: class {},
}))

vi.mock('../../../electron/main/services/plugin/plugin-host.service', () => ({
  default: { getInstance: () => mockState.pluginHost },
}))

import NotificationService from '../../../electron/main/services/notification.service'
import { IPC_CHANNELS } from '../../../electron/shared/ipc-channels'

function makeWindow(state: { visible?: boolean; minimized?: boolean; focused?: boolean; destroyed?: boolean } = {}) {
  const s = { visible: true, minimized: false, focused: true, destroyed: false, ...state }
  return {
    state: s,
    webContents: { send: vi.fn() },
    isDestroyed: () => s.destroyed,
    isVisible: () => s.visible,
    isMinimized: () => s.minimized,
    isFocused: () => s.focused,
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
  } as any
}

const service = NotificationService.getInstance()

beforeEach(() => {
  vi.clearAllMocks()
  mockState.notifications.length = 0
  mockState.flags.supported = true
  mockState.flags.throwOnConstruct = false
  service.setMainWindow(null)
})

describe('notification / 主窗口激活判定', () => {
  it('未设置主窗口视为 inactive', () => {
    expect(service.isMainWindowInactive()).toBe(true)
  })

  it('窗口销毁 / 隐藏 / 最小化 / 失焦均视为 inactive', () => {
    const win = makeWindow()
    service.setMainWindow(win)
    expect(service.isMainWindowInactive()).toBe(false)

    win.state.destroyed = true
    expect(service.isMainWindowInactive()).toBe(true)

    const win2 = makeWindow({ visible: false })
    service.setMainWindow(win2)
    expect(service.isMainWindowInactive()).toBe(true)

    const win3 = makeWindow({ minimized: true })
    service.setMainWindow(win3)
    expect(service.isMainWindowInactive()).toBe(true)

    const win4 = makeWindow({ focused: false })
    service.setMainWindow(win4)
    expect(service.isMainWindowInactive()).toBe(true)
  })
})

describe('notification / notify 参数校验', () => {
  it('空 payload 或缺 title 返回 false 且不弹通知', () => {
    expect(service.notify(null as any)).toBe(false)
    expect(service.notify({ title: '', body: 'x' })).toBe(false)
    expect(service.notify({ title: undefined as any, body: 'x' })).toBe(false)
    expect(mockState.notifications).toHaveLength(0)
  })

  it('注册 NOTIFY_SEND IPC 处理器且幂等（多次 notify 只注册一次）', () => {
    service.notify({ title: 'a', body: 'b' })
    service.notify({ title: 'c', body: 'd' })
    expect(mockState.ipcHandlers.has(IPC_CHANNELS.NOTIFY_SEND)).toBe(true)
    expect([...mockState.ipcHandlers.keys()].filter(k => k === IPC_CHANNELS.NOTIFY_SEND)).toHaveLength(1)
  })

  it('IPC 处理器返回 { ok } 并透传 payload', () => {
    service.notify({ title: 'first', body: 'b' })
    const handler = mockState.ipcHandlers.get(IPC_CHANNELS.NOTIFY_SEND)!
    const win = makeWindow({ focused: true })
    service.setMainWindow(win)
    const r = handler({}, { title: 'ipc', body: 'body' }) as any
    expect(r.ok).toBe(true)
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.CALENDAR_NOTIFY,
      expect.objectContaining({ title: 'ipc' }),
    )
  })
})

describe('notification / source 路由', () => {
  it('主窗口激活时宿主通知走 CALENDAR_NOTIFY，不弹系统通知', () => {
    const win = makeWindow({ focused: true })
    service.setMainWindow(win)
    expect(service.notify({ title: 'T', body: 'B' })).toBe(true)
    expect(mockState.notifications).toHaveLength(0)
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.CALENDAR_NOTIFY,
      expect.objectContaining({ title: 'T', body: 'B' }),
    )
    expect(mockState.pluginHost.broadcast).not.toHaveBeenCalled()
  })

  it('plugin:<id> 来源走插件桥广播且不推宿主 IPC', () => {
    const win = makeWindow({ focused: true })
    service.setMainWindow(win)
    const payload = { title: 'T', body: 'B', source: 'plugin:demo', i18nKey: 'k', i18nParams: { a: 1 } }
    expect(service.notify(payload)).toBe(true)
    expect(mockState.pluginHost.broadcast).toHaveBeenCalledWith('demo', 'notify', payload)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('plugin:（空 id）与 plugin:xxx:yyy 中截取整段作为 id', () => {
    const win = makeWindow({ focused: true })
    service.setMainWindow(win)
    service.notify({ title: 'T', body: 'B', source: 'plugin:' })
    expect(mockState.pluginHost.broadcast).not.toHaveBeenCalled()
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.CALENDAR_NOTIFY, expect.anything())

    service.notify({ title: 'T', body: 'B', source: 'plugin:a:b' })
    expect(mockState.pluginHost.broadcast).toHaveBeenCalledWith('a:b', 'notify', expect.anything())
  })

  it('非 plugin 前缀的 source 视为宿主通知', () => {
    const win = makeWindow({ focused: true })
    service.setMainWindow(win)
    service.notify({ title: 'T', body: 'B', source: 'ask_user' })
    expect(mockState.pluginHost.broadcast).not.toHaveBeenCalled()
    expect(win.webContents.send).toHaveBeenCalled()
  })

  it('主窗口不存在（inactive）时插件通知也走系统通知，不发插件桥广播（当前实现的优先级）', () => {
    service.setMainWindow(null)
    expect(service.notify({ title: 'T', body: 'B', source: 'plugin:x' })).toBe(true)
    // 系统通知分支先于 source 路由返回，插件桥不会被调用
    expect(mockState.notifications).toHaveLength(1)
    expect(mockState.pluginHost.broadcast).not.toHaveBeenCalled()
  })

  it('系统通知不可用时插件通知仍走插件桥广播', () => {
    mockState.flags.supported = false
    service.setMainWindow(null)
    expect(service.notify({ title: 'T', body: 'B', source: 'plugin:x' })).toBe(true)
    expect(mockState.pluginHost.broadcast).toHaveBeenCalledWith('x', 'notify', expect.anything())
  })

  it('主窗口不存在时宿主通知静默丢弃但仍返回 true', () => {
    service.setMainWindow(null)
    expect(service.notify({ title: 'T', body: 'B' })).toBe(true)
  })
})

describe('notification / 系统通知路径', () => {
  it('主窗口失焦且有系统支持时弹系统通知（含 silent 透传）', () => {
    const win = makeWindow({ focused: false })
    service.setMainWindow(win)
    expect(service.notify({ title: 'T', body: 'B', silent: true })).toBe(true)
    expect(mockState.notifications).toHaveLength(1)
    expect(mockState.notifications[0].options).toEqual({ title: 'T', body: 'B', silent: true })
    expect(mockState.notifications[0].show).toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('silent 缺省为 false', () => {
    const win = makeWindow({ focused: false })
    service.setMainWindow(win)
    service.notify({ title: 'T', body: 'B' })
    expect(mockState.notifications[0].options.silent).toBe(false)
  })

  it('系统通知不可用时回落 IPC', () => {
    mockState.flags.supported = false
    const win = makeWindow({ focused: false })
    service.setMainWindow(win)
    service.notify({ title: 'T', body: 'B' })
    expect(mockState.notifications).toHaveLength(0)
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.CALENDAR_NOTIFY, expect.anything())
  })

  it('系统通知构造抛错时回落 IPC', () => {
    mockState.flags.throwOnConstruct = true
    const win = makeWindow({ focused: false })
    service.setMainWindow(win)
    expect(service.notify({ title: 'T', body: 'B' })).toBe(true)
    expect(mockState.notifications).toHaveLength(0)
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.CALENDAR_NOTIFY, expect.anything())
  })

  it('点击系统通知：聚焦主窗口并下发 plugin 点击事件', () => {
    const win = makeWindow({ focused: false, minimized: true })
    service.setMainWindow(win)
    service.notify({ title: 'T', body: 'B', source: 'plugin:demo', clickTarget: 'automation', clickId: '42' })
    const n = mockState.notifications[0]
    n.emit('click')
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(mockState.pluginHost.broadcast).toHaveBeenCalledWith('demo', 'notify-click', {
      target: 'automation',
      id: '42',
    })
  })

  it('点击系统通知：宿主通知下发 CALENDAR_NOTIFY_CLICK', () => {
    const win = makeWindow({ focused: false })
    service.setMainWindow(win)
    service.notify({ title: 'T', body: 'B', clickTarget: 'calendar', clickId: '7' })
    mockState.notifications[0].emit('click')
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.CALENDAR_NOTIFY_CLICK, {
      target: 'calendar',
      id: '7',
    })
  })
})

describe('notification / focusMainWindow', () => {
  it('主窗口不存在或已销毁时安全空操作', () => {
    service.setMainWindow(null)
    expect(() => service.focusMainWindow()).not.toThrow()
    service.setMainWindow(makeWindow({ destroyed: true }))
    expect(() => service.focusMainWindow()).not.toThrow()
  })

  it('非最小化窗口只 show + focus', () => {
    const win = makeWindow({ minimized: false })
    service.setMainWindow(win)
    service.focusMainWindow()
    expect(win.restore).not.toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })

  it('IPC 发送抛错时不冒泡（notify 仍返回 true）', () => {
    const win = makeWindow({ focused: true })
    win.webContents.send.mockImplementation(() => { throw new Error('channel closed') })
    service.setMainWindow(win)
    expect(service.notify({ title: 'T', body: 'B' })).toBe(true)
  })
})
