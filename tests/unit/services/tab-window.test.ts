/**
 * Tab 独立窗口服务单测（打桩 electron.BrowserWindow / PluginHostService）：
 * - DETACHABLE_TABS 白名单：内核 tab 放行、未知 tab 拒绝
 * - 单 tab 单窗口：重复打开聚焦已有窗口而非新建
 * - closed 清理：窗口关闭后从 map 移除并广播 detached 列表
 * - closeAll / focusTabWindow / getDetachedTabs
 * - 插件 tab 的路由命名空间与标题来源
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

const mockState = vi.hoisted(() => {
  const created: any[] = []
  const pluginHost = {
    isDetachable: vi.fn(() => false),
    getPluginName: vi.fn(() => null as string | null),
    addTarget: vi.fn(),
    broadcast: vi.fn(),
  }
  return { created, pluginHost }
})

vi.mock('electron', () => ({
  // 使用开发模式分支（loadURL）：打包分支依赖 __dirname，测试环境按 vite-node 模块包装语义不保证存在
  app: { isPackaged: false },
  shell: { openExternal: vi.fn() },
  BrowserWindow: class extends EventEmitter {
    destroyed = false
    minimized = false
    loadFileCalls: any[] = []
    loadURLCalls: string[] = []
    webContents = {
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    }
    constructor(public options: Record<string, any>) {
      super()
      mockState.created.push(this)
    }
    isDestroyed() { return this.destroyed }
    isMinimized() { return this.minimized }
    restore() { this.minimized = false; return this }
    show() { return this }
    focus() { return this }
    loadFile(p: string, o?: any) { this.loadFileCalls.push([p, o]); return Promise.resolve() }
    loadURL(u: string) { this.loadURLCalls.push(u); return Promise.resolve() }
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
  },
}))

vi.mock('../../../electron/main/services/plugin/plugin-host.service', () => ({
  default: { getInstance: () => mockState.pluginHost },
}))

import TabWindowService, { DETACHABLE_TABS } from '../../../electron/main/services/tab-window.service'
import { IPC_CHANNELS } from '../../../electron/shared/ipc-channels'

function makeMainWindow() {
  return {
    destroyed: false,
    webContents: { send: vi.fn() },
    isDestroyed() { return this.destroyed },
  } as any
}

let service: TabWindowService
let main: any

beforeEach(() => {
  vi.clearAllMocks()
  mockState.created.length = 0
  mockState.pluginHost.isDetachable.mockReturnValue(false)
  mockState.pluginHost.getPluginName.mockReturnValue(null)
  service = TabWindowService.getInstance()
  service.closeAll()
  main = makeMainWindow()
  service.setMainWindow(main)
  mockState.created.length = 0
  main.webContents.send.mockClear()
})

afterEach(() => {
  service.closeAll()
  service.setMainWindow(null)
})

describe('tab-window / 白名单', () => {
  it('DETACHABLE_TABS 仅包含内核 tab', () => {
    expect([...DETACHABLE_TABS]).toEqual(['tasks', 'employees', 'kms'])
  })

  it('未声明的 tab 拒绝打开且不创建窗口', () => {
    expect(service.openTabWindow('settings')).toEqual({
      success: false,
      error: 'Tab "settings" is not detachable',
    })
    expect(mockState.created).toHaveLength(0)
    expect(service.getDetachedTabs()).toEqual([])
  })

  it('空串 / 大小写不同的 tab 名拒绝', () => {
    expect(service.openTabWindow('').success).toBe(false)
    expect(service.openTabWindow('TASKS').success).toBe(false)
    expect(service.openTabWindow('tasks ').success).toBe(false)
  })

  it('插件声明可分离的 tab 走插件路由命名空间', () => {
    mockState.pluginHost.isDetachable.mockImplementation((k: string) => k === 'my-plugin')
    mockState.pluginHost.getPluginName.mockReturnValue('我的插件')
    const r = service.openTabWindow('my-plugin')
    expect(r.success).toBe(true)
    const win = mockState.created[0]
    expect(win.options.title).toBe('我的插件')
    expect(win.loadURLCalls[0]).toContain('/#/window/plugin/my-plugin')
    expect(mockState.pluginHost.addTarget).toHaveBeenCalledWith(win)
  })

  it('插件名缺失时标题回落为 tabKey', () => {
    mockState.pluginHost.isDetachable.mockReturnValue(true)
    mockState.pluginHost.getPluginName.mockReturnValue(null)
    service.openTabWindow('anon-plugin')
    expect(mockState.created[0].options.title).toBe('anon-plugin')
  })

  it('内核 tab 使用内置标题且路由不带 plugin 前缀', () => {
    service.openTabWindow('kms')
    const win = mockState.created[0]
    expect(win.options.title).toBe('资料库')
    expect(win.loadURLCalls[0]).toContain('/#/window/kms')
    expect(win.loadURLCalls[0]).not.toContain('plugin/')
  })
})

describe('tab-window / 单 tab 单窗口', () => {
  it('重复打开同一 tab 时聚焦已有窗口，不新建', () => {
    expect(service.openTabWindow('tasks').success).toBe(true)
    expect(mockState.created).toHaveLength(1)
    const win = mockState.created[0]
    const showSpy = vi.spyOn(win, 'show')
    const focusSpy = vi.spyOn(win, 'focus')

    expect(service.openTabWindow('tasks').success).toBe(true)
    expect(mockState.created).toHaveLength(1)
    expect(showSpy).toHaveBeenCalled()
    expect(focusSpy).toHaveBeenCalled()
  })

  it('已存在的窗口处于最小化时先 restore', () => {
    service.openTabWindow('employees')
    const win = mockState.created[0]
    win.minimized = true
    const restoreSpy = vi.spyOn(win, 'restore')
    service.openTabWindow('employees')
    expect(restoreSpy).toHaveBeenCalled()
  })

  it('窗口已销毁时重新创建', () => {
    service.openTabWindow('tasks')
    mockState.created[0].destroy()
    expect(service.getDetachedTabs()).toEqual([])
    expect(service.openTabWindow('tasks').success).toBe(true)
    expect(mockState.created).toHaveLength(2)
  })

  it('不同 tab 各自独立窗口', () => {
    service.openTabWindow('tasks')
    service.openTabWindow('kms')
    expect(mockState.created).toHaveLength(2)
    expect(service.getDetachedTabs().sort()).toEqual(['kms', 'tasks'])
  })
})

describe('tab-window / detached 状态广播', () => {
  it('打开窗口后把 detached 列表推给主窗口', () => {
    service.openTabWindow('tasks')
    expect(main.webContents.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.TAB_WINDOW_DETACHED_CHANGED,
      ['tasks'],
    )
  })

  it('窗口关闭后从列表移除并再次广播', () => {
    service.openTabWindow('tasks')
    main.webContents.send.mockClear()
    mockState.created[0].destroy()
    expect(service.getDetachedTabs()).toEqual([])
    expect(main.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.TAB_WINDOW_DETACHED_CHANGED, [])
  })

  it('主窗口已销毁时跳过广播且不抛错', () => {
    main.destroyed = true
    expect(() => service.openTabWindow('tasks')).not.toThrow()
    expect(main.webContents.send).not.toHaveBeenCalled()
  })

  it('未设置主窗口时广播静默跳过', () => {
    service.setMainWindow(null)
    expect(() => service.openTabWindow('tasks')).not.toThrow()
  })
})

describe('tab-window / 关闭与聚焦', () => {
  it('closeTabWindow 销毁窗口并清理记录', () => {
    service.openTabWindow('tasks')
    const win = mockState.created[0]
    service.closeTabWindow('tasks')
    expect(win.destroyed).toBe(true)
    expect(service.getDetachedTabs()).toEqual([])
  })

  it('closeTabWindow 对不存在的 tab 是幂等空操作', () => {
    expect(() => service.closeTabWindow('nope')).not.toThrow()
    expect(service.getDetachedTabs()).toEqual([])
  })

  it('closeAll 关闭全部独立窗口并清空列表', () => {
    service.openTabWindow('tasks')
    service.openTabWindow('employees')
    service.openTabWindow('kms')
    const wins = [...mockState.created]
    service.closeAll()
    expect(wins.every(w => w.destroyed)).toBe(true)
    expect(service.getDetachedTabs()).toEqual([])
  })

  it('closeAll 对不存在的窗口幂等', () => {
    expect(() => service.closeAll()).not.toThrow()
    expect(() => service.closeAll()).not.toThrow()
  })

  it('focusTabWindow 命中返回 true，未命中/已销毁返回 false', () => {
    expect(service.focusTabWindow('tasks')).toBe(false)
    service.openTabWindow('tasks')
    const win = mockState.created[0]
    expect(service.focusTabWindow('tasks')).toBe(true)
    win.destroyed = true // 模拟被外部销毁但未触发 closed 的极端场景
    expect(service.focusTabWindow('tasks')).toBe(false)
  })

  it('focusTabWindow 会还原最小化窗口', () => {
    service.openTabWindow('tasks')
    const win = mockState.created[0]
    win.minimized = true
    expect(service.focusTabWindow('tasks')).toBe(true)
    expect(win.minimized).toBe(false)
  })
})
