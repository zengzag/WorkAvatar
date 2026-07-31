import { useCallback, useRef, useState } from 'react'
import type { CalendarEventInstance } from '../types/calendar'

const MS = 1000
export const HOUR_HEIGHT = 56
const SNAP_MINUTES = 15
const SNAP_HEIGHT = (SNAP_MINUTES / 60) * HOUR_HEIGHT
const DRAG_THRESHOLD = 5
const MIN_DURATION_SEC = 15 * 60
const DEFAULT_CLICK_DURATION_SEC = 30 * 60
const RESIZE_HANDLE_HEIGHT = 6

/** Y 坐标 → 吸附后的 unix 秒 */
function yToSnappedSec(y: number, dayStartMs: number): number {
  const rawMinutes = (y / HOUR_HEIGHT) * 60
  const snapped = Math.round(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES
  const clamped = Math.max(0, Math.min(1440, snapped))
  return Math.floor((dayStartMs + clamped * 60 * MS) / MS)
}

/** unix 秒 → Y 坐标 */
function secToY(sec: number, dayStartMs: number): number {
  const minutes = (sec * MS - dayStartMs) / MS / 60
  return (minutes / 60) * HOUR_HEIGHT
}

// ─── 拖拽状态 ───

export type DragState =
  | { type: 'idle' }
  | { type: 'creating'; startSec: number; endSec: number; dayStartMs: number }
  | { type: 'moving'; eventId: string; originalStart: number; originalEnd: number; newStartSec: number; newEndSec: number; originalDayStartMs: number; targetDayStartMs: number }
  | { type: 'resizing'; eventId: string; edge: 'top' | 'bottom'; originalStart: number; originalEnd: number; newStartSec: number; newEndSec: number; dayStartMs: number }

// ─── 内部 pending 状态（不触发渲染，仅存于 ref） ───

type PendingAction =
  | { mode: 'create'; startY: number; startSec: number; dayStartMs: number; colIdx: number }
  | { mode: 'move'; startY: number; startX: number; event: CalendarEventInstance; dayStartMs: number; colIdx: number }
  | { mode: 'resize'; startY: number; startX: number; event: CalendarEventInstance; dayStartMs: number; edge: 'top' | 'bottom'; colIdx: number }

// ─── Hook 选项 ───

export interface UseDragInteractionOptions {
  dayColumns: number[]
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  onCreateEvent: (startAt: number, endAt?: number) => void
  onMoveEvent: (input: { id: string; start_at: number; end_at: number }) => void
  onResizeEvent: (input: { id: string; start_at: number; end_at: number }) => void
  onEditEvent: (event: CalendarEventInstance) => void
}

export interface UseDragInteractionReturn {
  dragState: DragState
  handleGridMouseDown: (e: React.MouseEvent, dayStartMs: number, colIdx: number) => void
  handleEventMouseDown: (e: React.MouseEvent, ev: CalendarEventInstance, dayStartMs: number) => void
}

export function useDragInteraction(options: UseDragInteractionOptions): UseDragInteractionReturn {
  const {
    dayColumns, scrollContainerRef,
    onCreateEvent, onMoveEvent, onResizeEvent, onEditEvent,
  } = options

  const [dragState, setDragState] = useState<DragState>({ type: 'idle' })
  // 用 ref 镜像最新 dragState，确保 mouseup 闭包能读到最新值
  const dragStateRef = useRef<DragState>({ type: 'idle' })
  const pendingRef = useRef<PendingAction | null>(null)
  const activeRef = useRef(false)

  // 同步更新 ref
  const updateDragState = useCallback((state: DragState) => {
    dragStateRef.current = state
    setDragState(state)
  }, [])

  // 清理
  const cleanup = useCallback(() => {
    pendingRef.current = null
    activeRef.current = false
    updateDragState({ type: 'idle' })
  }, [updateDragState])

  // 根据 X 坐标确定列索引
  const getColIdxFromX = useCallback((clientX: number): number => {
    const container = scrollContainerRef.current?.querySelector('[data-day-cols]') as HTMLElement | null
    if (!container) return 0
    const cols = container.querySelectorAll('[data-col-idx]')
    for (let i = 0; i < cols.length; i++) {
      const rect = cols[i].getBoundingClientRect()
      if (clientX >= rect.left && clientX < rect.right) return i
    }
    return 0
  }, [scrollContainerRef])

  // 全局 mousemove
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const pending = pendingRef.current
    if (!pending) return

    const dx = e.clientX - (pending.mode === 'create' ? 0 : pending.startX)
    const dy = e.clientY - (pending.startY)
    if (!activeRef.current && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return

    // 进入 active 模式
    activeRef.current = true

    if (pending.mode === 'create') {
      const container = scrollContainerRef.current
      if (!container) return
      const gridInner = container.querySelector('[data-day-cols]') as HTMLElement | null
      if (!gridInner) return
      const colEls = gridInner.querySelectorAll('[data-col-idx]')
      if (pending.colIdx >= colEls.length) return
      const colRect = colEls[pending.colIdx].getBoundingClientRect()
      const relY = e.clientY - colRect.top + (container.scrollTop)
      const endSec = yToSnappedSec(relY, pending.dayStartMs)
      const startSec = pending.startSec
      updateDragState({
        type: 'creating',
        startSec: Math.min(startSec, endSec),
        endSec: Math.max(startSec, endSec),
        dayStartMs: pending.dayStartMs,
      })
    } else if (pending.mode === 'move') {
      const container = scrollContainerRef.current
      if (!container) return
      const colEls = (container.querySelector('[data-day-cols]') as HTMLElement | null)?.querySelectorAll('[data-col-idx]')
      if (!colEls || pending.colIdx >= colEls.length) return
      const origColRect = colEls[pending.colIdx].getBoundingClientRect()
      const relYOrig = pending.startY - origColRect.top + container.scrollTop
      const origSec = yToSnappedSec(relYOrig, pending.dayStartMs)

      const currentColIdx = getColIdxFromX(e.clientX)
      const targetDayStartMs = dayColumns[currentColIdx] ?? pending.dayStartMs
      const curColRect = colEls[Math.min(currentColIdx, colEls.length - 1)].getBoundingClientRect()
      const relYCur = e.clientY - curColRect.top + container.scrollTop
      const curSec = yToSnappedSec(relYCur, targetDayStartMs)

      const deltaSec = curSec - origSec
      const durationSec = pending.event.instance_end_at - pending.event.instance_start_at
      let newStartSec = pending.event.instance_start_at + deltaSec
      let newEndSec = newStartSec + durationSec

      // clamp 到当天范围
      const dayStartSec = Math.floor(targetDayStartMs / MS)
      const dayEndSec = dayStartSec + 86400
      if (newStartSec < dayStartSec) {
        newEndSec += dayStartSec - newStartSec
        newStartSec = dayStartSec
      }
      if (newEndSec > dayEndSec) {
        newStartSec -= newEndSec - dayEndSec
        newEndSec = dayEndSec
      }

      updateDragState({
        type: 'moving',
        eventId: pending.event.id,
        originalStart: pending.event.instance_start_at,
        originalEnd: pending.event.instance_end_at,
        newStartSec,
        newEndSec,
        originalDayStartMs: pending.dayStartMs,
        targetDayStartMs,
      })
    } else if (pending.mode === 'resize') {
      const container = scrollContainerRef.current
      if (!container) return
      const colEls = (container.querySelector('[data-day-cols]') as HTMLElement | null)?.querySelectorAll('[data-col-idx]')
      if (!colEls || pending.colIdx >= colEls.length) return
      const colRect = colEls[pending.colIdx].getBoundingClientRect()
      const relY = e.clientY - colRect.top + container.scrollTop
      const newSec = yToSnappedSec(relY, pending.dayStartMs)

      let newStartSec = pending.event.instance_start_at
      let newEndSec = pending.event.instance_end_at

      if (pending.edge === 'top') {
        newStartSec = Math.min(newSec, newEndSec - MIN_DURATION_SEC)
      } else {
        newEndSec = Math.max(newSec, newStartSec + MIN_DURATION_SEC)
      }

      updateDragState({
        type: 'resizing',
        eventId: pending.event.id,
        edge: pending.edge,
        originalStart: pending.event.instance_start_at,
        originalEnd: pending.event.instance_end_at,
        newStartSec,
        newEndSec,
        dayStartMs: pending.dayStartMs,
      })
    }
  }, [dayColumns, getColIdxFromX, scrollContainerRef, updateDragState])

  // 全局 mouseup — 从 dragStateRef 读取最新拖拽结果
  const handleMouseUp = useCallback(() => {
    const pending = pendingRef.current
    if (!pending) { cleanup(); return }

    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
    document.removeEventListener('keydown', handleKeyDown)

    if (!activeRef.current) {
      // 未超过阈值 → 视为点击
      if (pending.mode === 'create') {
        onCreateEvent(pending.startSec, pending.startSec + DEFAULT_CLICK_DURATION_SEC)
      } else {
        onEditEvent(pending.event)
      }
      cleanup()
      return
    }

    // 从 ref 读取最新拖拽状态
    const ds = dragStateRef.current

    if (pending.mode === 'create') {
      if (ds.type === 'creating') {
        const duration = ds.endSec - ds.startSec
        if (duration < MIN_DURATION_SEC) {
          onCreateEvent(ds.startSec, ds.startSec + DEFAULT_CLICK_DURATION_SEC)
        } else {
          onCreateEvent(ds.startSec, ds.endSec)
        }
      }
    } else if (pending.mode === 'move') {
      if (ds.type === 'moving') {
        onMoveEvent({ id: ds.eventId, start_at: ds.newStartSec, end_at: ds.newEndSec })
      }
    } else if (pending.mode === 'resize') {
      if (ds.type === 'resizing') {
        onResizeEvent({ id: ds.eventId, start_at: ds.newStartSec, end_at: ds.newEndSec })
      }
    }
    cleanup()
  }, [cleanup, onCreateEvent, onEditEvent, onMoveEvent, onResizeEvent, handleMouseMove])

  // ESC 取消
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('keydown', handleKeyDown)
      cleanup()
    }
  }, [cleanup, handleMouseMove, handleMouseUp])

  // 日列 mousedown（空白区域）
  const handleGridMouseDown = useCallback((e: React.MouseEvent, dayStartMs: number, colIdx: number) => {
    e.preventDefault()
    const container = scrollContainerRef.current
    if (!container) return
    const colEls = (container.querySelector('[data-day-cols]') as HTMLElement | null)?.querySelectorAll('[data-col-idx]')
    if (!colEls || colIdx >= colEls.length) return
    const colRect = colEls[colIdx].getBoundingClientRect()
    const relY = e.clientY - colRect.top + container.scrollTop
    const startSec = yToSnappedSec(relY, dayStartMs)

    pendingRef.current = { mode: 'create', startY: e.clientY, startSec, dayStartMs, colIdx }
    activeRef.current = false

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('keydown', handleKeyDown)
  }, [scrollContainerRef, handleMouseMove, handleMouseUp, handleKeyDown])

  // 事件块 mousedown
  const handleEventMouseDown = useCallback((e: React.MouseEvent, ev: CalendarEventInstance, dayStartMs: number) => {
    e.preventDefault()
    e.stopPropagation()

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const relY = e.clientY - rect.top
    const height = rect.height

    let mode: 'move' | 'resize'
    let edge: 'top' | 'bottom' = 'bottom'

    if (relY <= RESIZE_HANDLE_HEIGHT) {
      mode = 'resize'
      edge = 'top'
    } else if (relY >= height - RESIZE_HANDLE_HEIGHT) {
      mode = 'resize'
      edge = 'bottom'
    } else {
      mode = 'move'
    }

    const container = scrollContainerRef.current
    if (!container) return
    const colEls = (container.querySelector('[data-day-cols]') as HTMLElement | null)?.querySelectorAll('[data-col-idx]')
    let colIdx = 0
    if (colEls) {
      for (let i = 0; i < colEls.length; i++) {
        const cr = colEls[i].getBoundingClientRect()
        if (e.clientX >= cr.left && e.clientX < cr.right) { colIdx = i; break }
      }
    }

    if (mode === 'resize') {
      pendingRef.current = { mode: 'resize', startY: e.clientY, startX: e.clientX, event: ev, dayStartMs, edge, colIdx }
    } else {
      pendingRef.current = { mode: 'move', startY: e.clientY, startX: e.clientX, event: ev, dayStartMs, colIdx }
    }
    activeRef.current = false

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('keydown', handleKeyDown)
  }, [onEditEvent, scrollContainerRef, handleMouseMove, handleMouseUp, handleKeyDown])

  return { dragState, handleGridMouseDown, handleEventMouseDown }
}

// 导出辅助函数供 CalendarPanel 使用
export { yToSnappedSec, secToY, HOUR_HEIGHT as DRAG_HOUR_HEIGHT, SNAP_MINUTES, SNAP_HEIGHT, RESIZE_HANDLE_HEIGHT }
