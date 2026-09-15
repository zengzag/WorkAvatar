/**
 * 窗口尺寸记忆服务未覆盖分支补充（与 tests/unit/window-state 互补，不重复已有用例）：
 * - resolveWindowState：非法/极端数值、空显示器列表、工作区小于最小尺寸
 * - read() 的持久化数据校验（null / 字符串 / 缺字段 / 损坏 JSON）
 * - persist 的跳过条件（已销毁 / 最小化）与写库失败容错
 * - track 监听的事件集合与 unmaximize 语义
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { Rectangle } from 'electron'

const mockState = vi.hoisted(() => {
  const settings = new Map<string, string>()
  const state = {
    settings,
    failInsert: false,
    db: {
      prepare: (sql: string) => {
        if (sql.startsWith('SELECT')) {
          return { get: (key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined) }
        }
        if (sql.startsWith('INSERT')) {
          return {
            run: (key: string, value: string) => {
              if (state.failInsert) throw new Error('disk full')
              settings.set(key, value)
              return { changes: 1 }
            },
          }
        }
        throw new Error(`unexpected sql: ${sql}`)
      },
    },
  }
  return state
})

vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: {
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}))

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => mockState.db }) },
}))

import WindowStateService, {
  WINDOW_STATE_SETTING_KEY,
  resolveWindowState,
  type PersistedWindowState,
} from '../../../electron/main/services/window-state.service'

const DEFAULTS = { width: 1160, height: 720, minWidth: 1024, minHeight: 640 }
const PRIMARY: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 }

function persisted(overrides: Partial<PersistedWindowState> = {}): PersistedWindowState {
  return { x: 100, y: 80, width: 1400, height: 900, maximized: false, ...overrides }
}

function makeWindow(init: {
  x?: number
  y?: number
  width?: number
  height?: number
  maximized?: boolean
  minimized?: boolean
  destroyed?: boolean
} = {}) {
  const bounds = { x: init.x ?? 10, y: init.y ?? 10, width: init.width ?? 1200, height: init.height ?? 800 }
  const flags = {
    maximized: !!init.maximized,
    minimized: !!init.minimized,
    destroyed: !!init.destroyed,
  }
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    flags,
    getNormalBounds: () => bounds,
    isMaximized: () => flags.maximized,
    isMinimized: () => flags.minimized,
    isDestroyed: () => flags.destroyed,
  })
}

beforeEach(() => {
  mockState.settings.clear()
  mockState.failInsert = false
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('window-state 补充 / resolveWindowState 极端输入', () => {
  it('尺寸为 0 或负数时抬升到最小尺寸', () => {
    const state = resolveWindowState(persisted({ width: 0, height: -100 }), DEFAULTS, PRIMARY, [PRIMARY])
    expect(state.width).toBe(DEFAULTS.minWidth)
    expect(state.height).toBe(DEFAULTS.minHeight)
  })

  it('显示器列表为空时丢弃位置并收敛到主显示器', () => {
    const state = resolveWindowState(persisted({ width: 4000, height: 3000 }), DEFAULTS, PRIMARY, [])
    expect(state.x).toBeUndefined()
    expect(state.y).toBeUndefined()
    expect(state.width).toBe(PRIMARY.width)
    expect(state.height).toBe(PRIMARY.height)
  })

  it('显示器列表为空且保留最大化标记', () => {
    const state = resolveWindowState(persisted({ maximized: true }), DEFAULTS, PRIMARY, [])
    expect(state.maximized).toBe(true)
    expect(state.x).toBeUndefined()
  })

  it('工作区小于最小尺寸时保留下限，位置夹回工作区起点', () => {
    const tiny: Rectangle = { x: 0, y: 0, width: 300, height: 200 }
    const state = resolveWindowState(persisted({ x: 10, y: 10, width: 1400, height: 900 }), DEFAULTS, tiny, [tiny])
    expect(state.width).toBe(DEFAULTS.minWidth)
    expect(state.height).toBe(DEFAULTS.minHeight)
    // 工作区比窗口下限还小 → 位置夹取上限不高于起点
    expect(state.x).toBe(0)
    expect(state.y).toBe(0)
  })

  it('窗口完全落在工作区外（右下方）时视为显示器失效，丢弃位置', () => {
    const tiny: Rectangle = { x: 0, y: 0, width: 300, height: 200 }
    const state = resolveWindowState(persisted({ x: 500, y: 500 }), DEFAULTS, PRIMARY, [tiny])
    expect(state.x).toBeUndefined()
    expect(state.y).toBeUndefined()
    // 尺寸按主显示器（mock 中为 1920x1080）收敛
    expect(state.width).toBe(1400)
    expect(state.height).toBe(900)
  })

  it('尺寸未变时不移动位置（即使坐标为负的副屏）', () => {
    const secondary: Rectangle = { x: -1920, y: 0, width: 1920, height: 1080 }
    const state = resolveWindowState(
      persisted({ x: -1800, y: 100, width: 1400, height: 900 }),
      DEFAULTS,
      PRIMARY,
      [PRIMARY, secondary],
    )
    expect(state).toEqual({ x: -1800, y: 100, width: 1400, height: 900, maximized: false })
  })

  it('仅一处尺寸越界时位置也一并夹回可见区', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1280, height: 800 }
    const state = resolveWindowState(
      persisted({ x: 1200, y: 700, width: 1400, height: 900 }),
      DEFAULTS,
      workArea,
      [workArea],
    )
    expect(state).toEqual({ x: 0, y: 0, width: 1280, height: 800, maximized: false })
  })
})

describe('window-state 补充 / 持久化数据校验', () => {
  function restore() {
    return WindowStateService.getInstance().restore(DEFAULTS)
  }

  it('记录为 JSON null 时回落默认', () => {
    mockState.settings.set(WINDOW_STATE_SETTING_KEY, 'null')
    expect(restore()).toEqual({ width: 1160, height: 720, maximized: false })
  })

  it('字段类型错误（字符串 / null / 布尔）时回落默认', () => {
    for (const bad of [
      { x: '10', y: 0, width: 1400, height: 900 },
      { x: null, y: 0, width: 1400, height: 900 },
      { x: 0, y: 0, width: true, height: 900 },
      { x: 0, y: 0, width: 1400 },
    ]) {
      mockState.settings.set(WINDOW_STATE_SETTING_KEY, JSON.stringify(bad))
      expect(restore()).toEqual({ width: 1160, height: 720, maximized: false })
    }
  })

  it('maximized 非布尔值时按 false 处理', () => {
    mockState.settings.set(
      WINDOW_STATE_SETTING_KEY,
      JSON.stringify({ x: 10, y: 10, width: 1400, height: 900, maximized: 'yes' }),
    )
    expect(restore().maximized).toBe(false)
  })

  it('DB 读取抛错时回落默认且不抛异常', () => {
    const spy = vi.spyOn(mockState.db, 'prepare').mockImplementation(() => {
      throw new Error('db down')
    })
    expect(restore()).toEqual({ width: 1160, height: 720, maximized: false })
    spy.mockRestore()
  })
})

describe('window-state 补充 / persist 跳过与容错', () => {
  it('窗口已销毁时不写入', () => {
    const win = makeWindow({ destroyed: true })
    WindowStateService.getInstance().track(win as any)
    win.emit('close')
    expect(mockState.settings.has(WINDOW_STATE_SETTING_KEY)).toBe(false)
  })

  it('窗口最小化时 move/resize 不写入', () => {
    const win = makeWindow({ minimized: true })
    WindowStateService.getInstance().track(win as any)
    win.emit('close')
    expect(mockState.settings.has(WINDOW_STATE_SETTING_KEY)).toBe(false)
  })

  it('写库失败不抛出（仅在日志中告警）', () => {
    mockState.failInsert = true
    const win = makeWindow()
    WindowStateService.getInstance().track(win as any)
    expect(() => win.emit('close')).not.toThrow()
  })

  it('track 监听 resize/move/maximize/unmaximize/close 五类事件', () => {
    const win = makeWindow()
    const spy = vi.spyOn(win, 'on')
    WindowStateService.getInstance().track(win as any)
    expect(spy.mock.calls.map(c => c[0]).sort()).toEqual(
      ['close', 'maximize', 'move', 'resize', 'unmaximize'],
    )
  })

  it('unmaximize 后落盘 maximized=false', () => {
    vi.useFakeTimers()
    try {
      const win = makeWindow({ maximized: false })
      WindowStateService.getInstance().track(win as any)
      win.emit('unmaximize')
      vi.advanceTimersByTime(500)
      expect(JSON.parse(mockState.settings.get(WINDOW_STATE_SETTING_KEY)!).maximized).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
