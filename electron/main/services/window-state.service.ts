import { BrowserWindow, Rectangle, screen } from 'electron'
import DatabaseService from './database.service'
import { createLogger } from './logger'

const logger = createLogger('WindowState')

/** settings 表中的窗口状态键（应用级配置，已加入清除数据保留键） */
export const WINDOW_STATE_SETTING_KEY = 'window_state'

const SELECT_SQL = 'SELECT value FROM settings WHERE key = ?'
const UPSERT_SQL =
  'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'

/** resize/move 在拖拽缩放过程中高频触发，落盘做防抖 */
const SAVE_DEBOUNCE_MS = 500

/** 窗口必须落在显示器工作区内的最小可见宽高：低于此值视为位置已失效（显示器被拔掉/分辨率变更） */
const MIN_VISIBLE_PX = 80

export interface WindowStateDefaults {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

/** 持久化的窗口几何（位置一定存在，尺寸已在写入前有效性校验） */
export interface PersistedWindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

/** 交给 BrowserWindow 的窗口几何（x/y 缺省表示交给 Electron 居中） */
export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 找出与矩形重叠面积最大的工作区。
 * 任一轴可见部分不足 MIN_VISIBLE_PX 即视为该显示器不可用，返回 null。
 */
function findWorkArea(rect: Rectangle, workAreas: Rectangle[]): Rectangle | null {
  let best: Rectangle | null = null
  let bestOverlap = 0
  for (const workArea of workAreas) {
    const overlapX =
      Math.min(rect.x + rect.width, workArea.x + workArea.width) - Math.max(rect.x, workArea.x)
    const overlapY =
      Math.min(rect.y + rect.height, workArea.y + workArea.height) - Math.max(rect.y, workArea.y)
    if (overlapX < MIN_VISIBLE_PX || overlapY < MIN_VISIBLE_PX) continue
    const overlap = overlapX * overlapY
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = workArea
    }
  }
  return best
}

/**
 * 把持久化状态收敛为当前显示器下可用的窗口状态（纯函数，便于单测）。
 *
 * - 位置所在显示器已不存在 → 丢弃位置，由 Electron 在主显示器居中
 * - 尺寸超出目标显示器工作区（如 4K 屏换到笔记本屏）→ 收敛尺寸，并把左上角贴回可见区域，
 *   避免收敛后整个窗口跑到屏幕外
 * - 尺寸未变且位置仍有效 → 原样还原（跨屏窗口不因收敛被挪动）
 */
export function resolveWindowState(
  persisted: PersistedWindowState | null,
  defaults: WindowStateDefaults,
  primaryWorkArea: Rectangle,
  workAreas: Rectangle[]
): WindowState {
  const fallback: WindowState = {
    width: defaults.width,
    height: defaults.height,
    maximized: false,
  }
  if (!persisted) return fallback

  const matched = findWorkArea(
    { x: persisted.x, y: persisted.y, width: persisted.width, height: persisted.height },
    workAreas
  )
  const target = matched ?? primaryWorkArea
  const width = clamp(persisted.width, defaults.minWidth, Math.max(defaults.minWidth, target.width))
  const height = clamp(
    persisted.height,
    defaults.minHeight,
    Math.max(defaults.minHeight, target.height)
  )
  const maximized = persisted.maximized

  if (!matched) return { width, height, maximized }

  if (width === persisted.width && height === persisted.height) {
    return { x: persisted.x, y: persisted.y, width, height, maximized }
  }

  return {
    x: clamp(persisted.x, target.x, Math.max(target.x, target.x + target.width - width)),
    y: clamp(persisted.y, target.y, Math.max(target.y, target.y + target.height - height)),
    width,
    height,
    maximized,
  }
}

/**
 * 主窗口尺寸记忆服务：把窗口几何写入 settings 表，下次启动时还原。
 * 同时还原最大化状态——最大化时窗口尺寸是屏幕尺寸，只存尺寸会导致重启后尺寸「跳变」。
 */
class WindowStateService {
  private static instance: WindowStateService
  private saveTimer: NodeJS.Timeout | null = null

  static getInstance(): WindowStateService {
    if (!WindowStateService.instance) {
      WindowStateService.instance = new WindowStateService()
    }
    return WindowStateService.instance
  }

  /** 读取上次退出时的窗口状态；缺失、损坏或显示器变更时回退/收敛 */
  restore(defaults: WindowStateDefaults): WindowState {
    let workAreas: Rectangle[] = []
    let primaryWorkArea: Rectangle
    try {
      workAreas = screen.getAllDisplays().map((display) => display.workArea)
      primaryWorkArea = screen.getPrimaryDisplay().workArea
    } catch (err: any) {
      // screen 不可用（极端环境）时不做位置/尺寸收敛，直接用默认尺寸
      logger.warn('读取显示器信息失败，使用默认窗口尺寸:', err?.message || err)
      return { width: defaults.width, height: defaults.height, maximized: false }
    }

    return resolveWindowState(this.read(), defaults, primaryWorkArea, workAreas)
  }

  /** 监听窗口几何变化并持久化（防抖；窗口关闭时立即落盘） */
  track(win: BrowserWindow): void {
    const schedule = () => {
      if (this.saveTimer) clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(() => this.persist(win), SAVE_DEBOUNCE_MS)
      this.saveTimer.unref?.()
    }

    win.on('resize', schedule)
    win.on('move', schedule)
    win.on('maximize', schedule)
    win.on('unmaximize', schedule)
    // 托盘退出时窗口先收到 close，此时可能仍有防抖中的待写状态，必须立即落盘
    win.on('close', () => this.persist(win))
  }

  private persist(win: BrowserWindow): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (win.isDestroyed()) return
    // 最小化后 isMaximized() 恒为 false（最大化状态丢失）、getNormalBounds 也不代表当前状态，
    // 跳过写入以免把「最大化 + 正常尺寸」覆盖成「普通状态」
    if (win.isMinimized()) return
    // 最大化时 getBounds 返回屏幕尺寸，getNormalBounds 才是还原后的正常尺寸
    const bounds = win.getNormalBounds()
    this.write({ ...bounds, maximized: win.isMaximized() })
  }

  private read(): PersistedWindowState | null {
    try {
      const row = DatabaseService.getInstance()
        .getDb()
        .prepare(SELECT_SQL)
        .get(WINDOW_STATE_SETTING_KEY) as { value?: string } | undefined
      if (!row?.value) return null

      const parsed = JSON.parse(row.value)
      if (
        !isFiniteNumber(parsed?.x) ||
        !isFiniteNumber(parsed?.y) ||
        !isFiniteNumber(parsed?.width) ||
        !isFiniteNumber(parsed?.height)
      ) {
        return null
      }
      return {
        x: parsed.x,
        y: parsed.y,
        width: parsed.width,
        height: parsed.height,
        maximized: parsed.maximized === true,
      }
    } catch (err: any) {
      logger.warn('读取窗口状态失败，使用默认尺寸:', err?.message || err)
      return null
    }
  }

  private write(state: PersistedWindowState): void {
    try {
      DatabaseService.getInstance()
        .getDb()
        .prepare(UPSERT_SQL)
        .run(WINDOW_STATE_SETTING_KEY, JSON.stringify(state))
    } catch (err: any) {
      logger.warn('保存窗口状态失败:', err?.message || err)
    }
  }
}

export default WindowStateService
