/**
 * 窗口防休眠服务单测（打桩 electron powerSaveBlocker / BrowserWindow / DatabaseService）：
 * - 开关持久化与默认值（未配置时默认开启）
 * - blocker 只在「开关开启且有可见窗口」时存在，避免阻塞与漏放
 * - 窗口 show/hide/minimize/restore/closed 事件驱动重新评估
 * - shutdown 释放、重复调用幂等
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockState = vi.hoisted(() => {
  const settings = new Map<string, string>()
  const windows: any[] = []
  const appListeners = new Map<string, Function[]>()
  const blocker = {
    nextId: 1,
    active: new Set<number>(),
    start: vi.fn((type: string) => {
      const id = blocker.nextId++
      blocker.active.add(id)
      blocker.lastType = type
      return id
    }),
    stop: vi.fn((id: number) => { blocker.active.delete(id) }),
    lastType: '' as string,
  }
  const db = {
    prepare: (sql: string) => {
      if (sql.includes('SELECT value FROM settings')) {
        return { get: (key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined) }
      }
      if (sql.includes('INSERT INTO settings')) {
        return { run: (key: string, value: string) => { settings.set(key, value); return { changes: 1 } } }
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
  }
  return { settings, windows, appListeners, blocker, db }
})

vi.mock('electron', () => ({
  app: {
    on: (event: string, cb: Function) => {
      const list = mockState.appListeners.get(event) || []
      list.push(cb)
      mockState.appListeners.set(event, list)
    },
  },
  BrowserWindow: { getAllWindows: () => mockState.windows },
  powerSaveBlocker: mockState.blocker,
}))

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => mockState.db }) },
}))

import PowerSaveService, { PREVENT_SLEEP_SETTING_KEY } from '../../../electron/main/services/power-save.service'

function makeWindow(init: { visible?: boolean; destroyed?: boolean } = {}) {
  const s = { visible: true, destroyed: false, ...init }
  const listeners = new Map<string, Function[]>()
  return {
    s,
    on: vi.fn((event: string, cb: Function) => {
      listeners.set(event, [...(listeners.get(event) || []), cb])
    }),
    emit: (event: string) => { for (const cb of listeners.get(event) || []) cb() },
    isVisible: () => s.visible,
    isDestroyed: () => s.destroyed,
  }
}

function emitApp(event: string, ...args: any[]) {
  for (const cb of mockState.appListeners.get(event) || []) cb(...args)
}

function reset() {
  const service = PowerSaveService.getInstance()
  service.shutdown()
  service.setEnabled(true)
  service.shutdown()
  // 单例跨用例复用：清掉 init 幂等标记，让每个用例都能重新 init
  ;(service as any).initialized = false
  mockState.settings.clear()
  mockState.windows.length = 0
  mockState.appListeners.clear()
  mockState.blocker.active.clear()
  mockState.blocker.start.mockClear()
  mockState.blocker.stop.mockClear()
  mockState.blocker.nextId = 1
}

beforeEach(reset)

describe('power-save / 开关与持久化', () => {
  it('未配置过时默认开启', () => {
    const service = PowerSaveService.getInstance()
    expect(service.getEnabled()).toBe(true)
  })

  it('setEnabled 写入 settings 且重复设置同值不写库', () => {
    const service = PowerSaveService.getInstance()
    service.setEnabled(false)
    expect(mockState.settings.get(PREVENT_SLEEP_SETTING_KEY)).toBe('0')
    mockState.settings.clear()
    service.setEnabled(false)
    expect(mockState.settings.size).toBe(0)

    service.setEnabled(true)
    expect(mockState.settings.get(PREVENT_SLEEP_SETTING_KEY)).toBe('1')
  })

  it('持久化为 0 时 init 后不启用', () => {
    mockState.settings.set(PREVENT_SLEEP_SETTING_KEY, '0')
    const service = PowerSaveService.getInstance()
    service.init()
    expect(service.getEnabled()).toBe(false)
    expect(mockState.blocker.start).not.toHaveBeenCalled()
  })

  it('DB 读取失败时按开启处理（保守：不误关防休眠）', () => {
    const spy = vi.spyOn(mockState.db, 'prepare').mockImplementation(() => { throw new Error('db down') })
    const service = PowerSaveService.getInstance()
    service.init()
    expect(service.getEnabled()).toBe(true)
    spy.mockRestore()
  })
})

describe('power-save / blocker 生命周期', () => {
  it('有可见窗口时启动 prevent-display-sleep', () => {
    mockState.windows.push(makeWindow({ visible: true }))
    const service = PowerSaveService.getInstance()
    service.init()
    expect(mockState.blocker.start).toHaveBeenCalledWith('prevent-display-sleep')
    expect(mockState.blocker.active.size).toBe(1)
  })

  it('重复 refresh 不重复启动（幂等）', () => {
    mockState.windows.push(makeWindow({ visible: true }))
    const service = PowerSaveService.getInstance()
    service.init()
    emitApp('browser-window-created', {}, mockState.windows[0])
    mockState.windows[0].emit('show')
    mockState.windows[0].emit('show')
    expect(mockState.blocker.start).toHaveBeenCalledTimes(1)
  })

  it('无可见窗口时不启动', () => {
    mockState.windows.push(makeWindow({ visible: false }))
    const service = PowerSaveService.getInstance()
    service.init()
    expect(mockState.blocker.start).not.toHaveBeenCalled()
  })

  it('全部窗口已销毁视为无窗口', () => {
    mockState.windows.push(makeWindow({ visible: true, destroyed: true }))
    const service = PowerSaveService.getInstance()
    service.init()
    expect(mockState.blocker.start).not.toHaveBeenCalled()
  })

  it('窗口全部隐藏后释放 blocker', () => {
    const win = makeWindow({ visible: true })
    mockState.windows.push(win)
    const service = PowerSaveService.getInstance()
    service.init()
    emitApp('browser-window-created', {}, win)
    expect(mockState.blocker.active.size).toBe(1)

    win.s.visible = false
    win.emit('hide')
    expect(mockState.blocker.active.size).toBe(0)
  })

  it('最小化不释放 blocker（窗口仍算开启）', () => {
    const win = makeWindow({ visible: true })
    mockState.windows.push(win)
    const service = PowerSaveService.getInstance()
    service.init()
    emitApp('browser-window-created', {}, win)
    win.emit('minimize')
    expect(mockState.blocker.active.size).toBe(1)
    win.emit('restore')
    expect(mockState.blocker.start).toHaveBeenCalledTimes(1)
  })

  it('关闭开关后立即释放 blocker', () => {
    mockState.windows.push(makeWindow({ visible: true }))
    const service = PowerSaveService.getInstance()
    service.init()
    expect(mockState.blocker.active.size).toBe(1)
    service.setEnabled(false)
    expect(mockState.blocker.active.size).toBe(0)
  })

  it('窗口 closed 后若还有其他可见窗口则保持 blocker', () => {
    const a = makeWindow({ visible: true })
    const b = makeWindow({ visible: true })
    mockState.windows.push(a, b)
    const service = PowerSaveService.getInstance()
    service.init()
    emitApp('browser-window-created', {}, a)
    a.s.destroyed = true
    a.s.visible = false
    a.emit('closed')
    expect(mockState.blocker.active.size).toBe(1)
  })

  it('shutdown 释放 blocker，重复调用安全', () => {
    mockState.windows.push(makeWindow({ visible: true }))
    const service = PowerSaveService.getInstance()
    service.init()
    service.shutdown()
    expect(mockState.blocker.active.size).toBe(0)
    expect(() => service.shutdown()).not.toThrow()
  })

  it('init 幂等：重复调用只注册一份浏览器窗口监听', () => {
    const service = PowerSaveService.getInstance()
    service.init()
    service.init()
    service.init()
    expect(mockState.appListeners.get('browser-window-created')!.length).toBe(1)
  })
})
