/**
 * 窗口尺寸记忆单测：
 * - 纯函数尺度：resolveWindowState 的显示器收敛规则（换屏/拔屏/分辨率变更/跨屏窗口）
 * - 服务尺度：WindowStateService 的读取容错、防抖落盘、关闭落盘、最小化跳过写入
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { Rectangle } from 'electron'

// ====== 共享 mock 状态（hoisted，供 vi.mock 工厂与断言共用） ======

const mockState = vi.hoisted(() => {
  const settings = new Map<string, string>()
  const fakeDb = {
    prepare: (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return {
          get: (key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined),
        }
      }
      return {
        run: (key: string, value: string) => {
          settings.set(key, value)
          return { changes: 1 }
        },
      }
    },
  }
  const state = {
    settings,
    fakeDb,
    displays: [
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } },
    ] as Array<{ workArea: Rectangle }>,
  }
  return state
})

vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: {
    getAllDisplays: () => mockState.displays,
    getPrimaryDisplay: () => mockState.displays[0],
  },
}))

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => mockState.fakeDb }) },
}))

import WindowStateService, {
  WINDOW_STATE_SETTING_KEY,
  resolveWindowState,
  type PersistedWindowState,
} from '../../../electron/main/services/window-state.service'

const DEFAULTS = { width: 1160, height: 720, minWidth: 1024, minHeight: 640 }
const PRIMARY = mockState.displays[0].workArea
const WORK_AREAS = mockState.displays.map((d) => d.workArea)

function persisted(overrides: Partial<PersistedWindowState> = {}): PersistedWindowState {
  return { x: 100, y: 80, width: 1400, height: 900, maximized: false, ...overrides }
}

// ====== 纯函数：显示器收敛规则 ======

describe('resolveWindowState', () => {
  it('无历史状态时返回默认尺寸并交由 Electron 居中', () => {
    const state = resolveWindowState(null, DEFAULTS, PRIMARY, WORK_AREAS)
    expect(state).toEqual({ width: 1160, height: 720, maximized: false })
    expect(state.x).toBeUndefined()
    expect(state.y).toBeUndefined()
  })

  it('显示器未变化时原样还原位置与尺寸', () => {
    const state = resolveWindowState(persisted(), DEFAULTS, PRIMARY, WORK_AREAS)
    expect(state).toEqual({ x: 100, y: 80, width: 1400, height: 900, maximized: false })
  })

  it('还原最大化状态', () => {
    const state = resolveWindowState(persisted({ maximized: true }), DEFAULTS, PRIMARY, WORK_AREAS)
    expect(state.maximized).toBe(true)
  })

  it('窗口跨两块显示器且尺寸未变时保持原位（不因收敛被挪动）', () => {
    const state = resolveWindowState(
      persisted({ x: 1500, y: 100, width: 1800, height: 900 }),
      DEFAULTS,
      PRIMARY,
      WORK_AREAS
    )
    expect(state).toEqual({ x: 1500, y: 100, width: 1800, height: 900, maximized: false })
  })

  it('位置所在显示器已拔掉时丢弃位置，尺寸按主显示器收敛', () => {
    // x=4000 落在已不存在的第三块显示器上
    const state = resolveWindowState(
      persisted({ x: 4000, y: 100, width: 3000, height: 1800 }),
      DEFAULTS,
      PRIMARY,
      WORK_AREAS
    )
    expect(state.x).toBeUndefined()
    expect(state.y).toBeUndefined()
    expect(state.width).toBe(1920)
    expect(state.height).toBe(1080)
  })

  it('大屏换小屏时收敛尺寸，仍可见的坐标保持不变', () => {
    // 单屏 1920x1080：高度从 1500 收敛到工作区高度，宽度 1600 仍放得下 → x 不变、y 贴到顶
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 }
    const state = resolveWindowState(
      persisted({ x: 300, y: 150, width: 1600, height: 1500 }),
      DEFAULTS,
      workArea,
      [workArea]
    )
    expect(state).toEqual({ x: 300, y: 0, width: 1600, height: 1080, maximized: false })
  })

  it('尺寸收敛后仍保证窗口不越出工作区右下角', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 }
    // 窗口原本位于大屏右下角，收敛后若只改尺寸会整窗跑到屏幕外
    const state = resolveWindowState(
      persisted({ x: 1800, y: 900, width: 3600, height: 2000 }),
      DEFAULTS,
      workArea,
      [workArea]
    )
    expect(state.x).toBe(0)
    expect(state.y).toBe(0)
    expect(state.width).toBe(1920)
    expect(state.height).toBe(1040)
  })

  it('保存尺寸小于窗口下限时抬升到下限', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 }
    const state = resolveWindowState(
      persisted({ x: 10, y: 10, width: 300, height: 200 }),
      DEFAULTS,
      workArea,
      [workArea]
    )
    expect(state.width).toBe(1024)
    expect(state.height).toBe(640)
  })

  it('工作区比窗口下限还小时保留下限尺寸', () => {
    const workArea = { x: 0, y: 0, width: 800, height: 600 }
    const state = resolveWindowState(persisted(), DEFAULTS, workArea, [workArea])
    expect(state.width).toBe(1024)
    expect(state.height).toBe(640)
  })

  it('负坐标副屏（主屏右侧为负）可正常还原', () => {
    const secondary = { x: -1920, y: 0, width: 1920, height: 1080 }
    const state = resolveWindowState(
      persisted({ x: -1800, y: 100, width: 1400, height: 900 }),
      DEFAULTS,
      PRIMARY,
      [PRIMARY, secondary]
    )
    expect(state).toEqual({ x: -1800, y: 100, width: 1400, height: 900, maximized: false })
  })
})

// ====== 服务：读取容错与落盘时机 ======

function makeWindow(init: {
  x: number
  y: number
  width: number
  height: number
  maximized?: boolean
  minimized?: boolean
}) {
  const emitter = new EventEmitter()
  let bounds = { x: init.x, y: init.y, width: init.width, height: init.height }
  const flags = { maximized: !!init.maximized, minimized: !!init.minimized, destroyed: false }
  return Object.assign(emitter, {
    flags,
    setBounds: (next: Rectangle) => {
      bounds = next
    },
    getNormalBounds: () => bounds,
    isMaximized: () => flags.maximized,
    isMinimized: () => flags.minimized,
    isDestroyed: () => flags.destroyed,
  })
}

function readSaved(): PersistedWindowState {
  return JSON.parse(mockState.settings.get(WINDOW_STATE_SETTING_KEY)!)
}

describe('WindowStateService', () => {
  beforeEach(() => {
    mockState.settings.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('无记录时还原默认尺寸', () => {
    const state = WindowStateService.getInstance().restore(DEFAULTS)
    expect(state).toEqual({ width: 1160, height: 720, maximized: false })
  })

  it('记录损坏（非法 JSON / 缺字段）时回退默认尺寸', () => {
    const service = WindowStateService.getInstance()
    mockState.settings.set(WINDOW_STATE_SETTING_KEY, '{ not json')
    expect(service.restore(DEFAULTS).width).toBe(1160)

    mockState.settings.set(WINDOW_STATE_SETTING_KEY, JSON.stringify({ x: 10, y: 10 }))
    expect(service.restore(DEFAULTS).height).toBe(720)
  })

  it('读取上次写入的状态', () => {
    mockState.settings.set(
      WINDOW_STATE_SETTING_KEY,
      JSON.stringify({ x: 200, y: 120, width: 1500, height: 950, maximized: true })
    )
    const state = WindowStateService.getInstance().restore(DEFAULTS)
    expect(state).toEqual({ x: 200, y: 120, width: 1500, height: 950, maximized: true })
  })

  it('resize 防抖落盘：拖拽过程中的高频事件只写最后一次', () => {
    const service = WindowStateService.getInstance()
    const win = makeWindow({ x: 10, y: 10, width: 1200, height: 800 })
    service.track(win)

    win.emit('resize')
    win.emit('resize')
    win.setBounds({ x: 10, y: 10, width: 1500, height: 950 })
    win.emit('resize')

    expect(mockState.settings.has(WINDOW_STATE_SETTING_KEY)).toBe(false)
    vi.advanceTimersByTime(500)
    expect(readSaved()).toEqual({ x: 10, y: 10, width: 1500, height: 950, maximized: false })
  })

  it('窗口关闭时立即落盘（不等防抖计时）', () => {
    const service = WindowStateService.getInstance()
    const win = makeWindow({ x: 30, y: 40, width: 1300, height: 850 })
    service.track(win)

    win.emit('move')
    win.emit('close')
    expect(readSaved()).toEqual({ x: 30, y: 40, width: 1300, height: 850, maximized: false })
  })

  it('最大化写入屏幕尺寸对应的还原尺寸与 maximized 标记', () => {
    const service = WindowStateService.getInstance()
    // 最大化后 getNormalBounds 仍是正常尺寸，isMaximized 为 true
    const win = makeWindow({ x: 0, y: 0, width: 1920, height: 1080, maximized: true })
    service.track(win)

    win.emit('maximize')
    vi.advanceTimersByTime(500)
    expect(readSaved()).toEqual({ x: 0, y: 0, width: 1920, height: 1080, maximized: true })
  })

  it('最小化状态下不写入，避免覆盖掉最大化标记', () => {
    const service = WindowStateService.getInstance()
    const win = makeWindow({ x: 0, y: 0, width: 1920, height: 1080, maximized: true })
    service.track(win)

    win.emit('maximize')
    vi.advanceTimersByTime(500)

    // 最大化后被最小化：此时 isMaximized() 为 false，若不跳过会把 maximized 覆盖成 false
    win.flags.minimized = true
    win.flags.maximized = false
    win.emit('move')
    vi.advanceTimersByTime(500)

    expect(readSaved().maximized).toBe(true)
  })
})
