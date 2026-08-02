import { useEffect, useMemo, useRef } from 'react'
import { Calendar, Spin, Tooltip, theme } from 'antd'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { CalendarEventInstance, CalendarTodoInstance, EventColor } from '../../types/calendar'
import { useDragInteraction, secToY, RESIZE_HANDLE_HEIGHT } from '../../hooks/useDragInteraction'
import type { DragState } from '../../hooks/useDragInteraction'
import { useAppearanceStore, getEffectiveTheme } from '../../stores/appearance.store'

const MS = 1000
const HOUR_HEIGHT = 56
const HOURS_PER_DAY = 24

const getEventColorMap = (isDark: boolean): Record<EventColor, { bg: string; border: string }> => ({
  default: { bg: `rgba(22,119,255,${isDark ? 0.14 : 0.22})`, border: '#1677ff' },
  blue: { bg: `rgba(22,119,255,${isDark ? 0.14 : 0.22})`, border: '#1677ff' },
  green: { bg: `rgba(82,196,26,${isDark ? 0.14 : 0.22})`, border: '#52c41a' },
  orange: { bg: `rgba(250,140,22,${isDark ? 0.14 : 0.22})`, border: '#fa8c16' },
  red: { bg: `rgba(245,34,45,${isDark ? 0.14 : 0.22})`, border: '#f5222d' },
  purple: { bg: `rgba(114,46,209,${isDark ? 0.14 : 0.22})`, border: '#722ed1' },
})

const TODO_PRIORITY_COLOR: Record<string, string> = {
  high: '#f5222d',
  medium: '#fa8c16',
  low: '#1677ff',
  none: '#8c8c8c',
}

const getTodoBarColorMap = (isDark: boolean): Record<string, { bg: string; border: string }> => ({
  high: { bg: `rgba(245,34,45,${isDark ? 0.14 : 0.22})`, border: '#f5222d' },
  medium: { bg: `rgba(250,140,22,${isDark ? 0.14 : 0.22})`, border: '#fa8c16' },
  low: { bg: `rgba(22,119,255,${isDark ? 0.14 : 0.22})`, border: '#1677ff' },
  none: { bg: `rgba(140,140,140,${isDark ? 0.14 : 0.22})`, border: '#8c8c8c' },
})

interface CalendarPanelProps {
  view: 'month' | 'week' | 'day'
  currentDate: number
  events: CalendarEventInstance[]
  todos: CalendarTodoInstance[]
  loading: boolean
  onCreateEvent: (startAt: number, endAt?: number) => void
  onEditEvent: (event: CalendarEventInstance) => void
  onMoveEvent: (input: { id: string; start_at: number; end_at: number }) => void
  onResizeEvent: (input: { id: string; start_at: number; end_at: number }) => void
  onEditTodo?: (todo: CalendarTodoInstance) => void
  /** 直接完成/取消完成某个 TODO 实例（重复 TODO 支持跳着完成） */
  onCompleteTodo?: (todo: CalendarTodoInstance) => void
}

const startOfDayMs = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const getEventsForDay = (events: CalendarEventInstance[], dayStartMs: number): CalendarEventInstance[] => {
  const dayEnd = dayStartMs + 86400 * MS - 1
  return events.filter(
    e => e.instance_start_at * MS <= dayEnd && e.instance_end_at * MS >= dayStartMs,
  ).sort((a, b) => a.instance_start_at - b.instance_start_at)
}

const getTodosForDay = (todos: CalendarTodoInstance[], dayStartMs: number): CalendarTodoInstance[] => {
  const dayEnd = dayStartMs + 86400 * MS - 1
  return todos.filter(
    td => td.instance_due_at * MS >= dayStartMs && td.instance_due_at * MS <= dayEnd,
  )
}

const formatHour = (h: number): string => `${h.toString().padStart(2, '0')}:00`

const formatEventTime = (sec: number): string => {
  const d = new Date(sec * MS)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

const isEventPast = (ev: CalendarEventInstance): boolean => {
  return ev.instance_end_at * MS < Date.now()
}

/** 渲染拖拽创建的预览块 */
const DragPreviewBlock: React.FC<{ dragState: Extract<DragState, { type: 'creating' }>; dayStartMs: number; token: any; isDark: boolean }> = ({ dragState, dayStartMs, token, isDark }) => {
  if (dragState.dayStartMs !== dayStartMs) return null
  const top = secToY(dragState.startSec, dayStartMs)
  const bottom = secToY(dragState.endSec, dayStartMs)
  return (
    <div style={{
      position: 'absolute',
      left: 2,
      right: 2,
      top,
      height: bottom - top,
      background: `rgba(22,119,255,${isDark ? 0.08 : 0.12})`,
      border: '1px dashed #1677ff',
      borderRadius: 4,
      pointerEvents: 'none',
      zIndex: 6,
    }}>
      <div style={{ fontSize: 10, color: token.colorPrimary, padding: '2px 4px' }}>
        {formatEventTime(dragState.startSec)} - {formatEventTime(dragState.endSec)}
      </div>
    </div>
  )
}

/** 渲染拖拽移动/调整大小中的事件块 */
const DragMovingBlock: React.FC<{ dragState: Extract<DragState, { type: 'moving' }>; dayStartMs: number; token: any; isDark: boolean }> = ({ dragState, dayStartMs, token, isDark }) => {
  const isTarget = dragState.targetDayStartMs === dayStartMs
  const isOriginal = dragState.originalDayStartMs === dayStartMs
  if (!isTarget && !isOriginal) return null

  const ev = { instance_start_at: dragState.newStartSec, instance_end_at: dragState.newEndSec }

  if (isOriginal && !isTarget) {
    // 原位置半透明占位
    const top = secToY(dragState.originalStart, dayStartMs)
    const bottom = secToY(dragState.originalEnd, dayStartMs)
    return (
      <div style={{
        position: 'absolute', left: 2, right: 2, top, height: bottom - top,
        background: `rgba(22,119,255,${isDark ? 0.06 : 0.10})`, borderLeft: `3px solid rgba(22,119,255,${isDark ? 0.3 : 0.4})`,
        borderRadius: 4, pointerEvents: 'none', opacity: 0.5, zIndex: 6,
      }} />
    )
  }

  // 目标位置
  const top = secToY(ev.instance_start_at, dayStartMs)
  const bottom = secToY(ev.instance_end_at, dayStartMs)
  return (
    <div style={{
      position: 'absolute', left: 2, right: 2, top, height: bottom - top,
      background: `rgba(22,119,255,${isDark ? 0.14 : 0.20})`, borderLeft: '3px solid #1677ff',
      borderRadius: 4, padding: '2px 6px', fontSize: 11, overflow: 'hidden',
      color: token.colorText, pointerEvents: 'none', zIndex: 6,
      boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
    }}>
      <div style={{ fontWeight: 500 }}>{formatEventTime(ev.instance_start_at)} - {formatEventTime(ev.instance_end_at)}</div>
    </div>
  )
}

const DragResizingBlock: React.FC<{ dragState: Extract<DragState, { type: 'resizing' }>; dayStartMs: number; token: any; isDark: boolean }> = ({ dragState, dayStartMs, token, isDark }) => {
  if (dragState.dayStartMs !== dayStartMs) return null
  const top = secToY(dragState.newStartSec, dayStartMs)
  const bottom = secToY(dragState.newEndSec, dayStartMs)
  return (
    <div style={{
      position: 'absolute', left: 2, right: 2, top, height: bottom - top,
      background: `rgba(22,119,255,${isDark ? 0.14 : 0.20})`, borderLeft: '3px solid #1677ff',
      borderRadius: 4, padding: '2px 6px', fontSize: 11, overflow: 'hidden',
      color: token.colorText, pointerEvents: 'none', zIndex: 6,
      outline: '2px solid #1677ff',
    }}>
      <div style={{ fontSize: 10 }}>{formatEventTime(dragState.newStartSec)} - {formatEventTime(dragState.newEndSec)}</div>
    </div>
  )
}

const CalendarPanel: React.FC<CalendarPanelProps> = ({
  view, currentDate, events, todos, loading,
  onCreateEvent, onEditEvent, onMoveEvent, onResizeEvent, onEditTodo, onCompleteTodo,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const effectiveTheme = useMemo(() => getEffectiveTheme(themeMode), [themeMode])
  const isDark = effectiveTheme === 'dark'
  const eventColorMap = useMemo(() => getEventColorMap(isDark), [isDark])
  const todoBarColorMap = useMemo(() => getTodoBarColorMap(isDark), [isDark])
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  // 周/日视图进入时滚动到一半位置
  const hasScrolledRef = useRef(false)
  useEffect(() => {
    if (view === 'month') { hasScrolledRef.current = false; return }
    hasScrolledRef.current = false
    const tryScroll = () => {
      const el = scrollContainerRef.current
      if (el && el.scrollHeight > el.clientHeight) {
        el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.6
        hasScrolledRef.current = true
      }
    }
    tryScroll()
    const t1 = setTimeout(tryScroll, 100)
    const t2 = setTimeout(tryScroll, 400)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [view])

  const hours = useMemo(
    () => Array.from({ length: HOURS_PER_DAY }, (_, i) => i),
    [],
  )

  const dayColumns = useMemo(() => {
    const base = startOfDayMs(currentDate)
    if (view === 'day') return [base]
    const d = new Date(base)
    const dayOfWeek = d.getDay()
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
    const monday = base + diff * 86400 * MS
    return Array.from({ length: 7 }, (_, i) => monday + i * 86400 * MS)
  }, [view, currentDate])

  // 每日全天事件（独立于时间网格渲染，固定在顶部）
  const allDayEventsByDay = useMemo(
    () => dayColumns.map(dms => getEventsForDay(events, dms).filter(e => e.all_day)),
    [dayColumns, events],
  )
  const hasAllDayEvents = allDayEventsByDay.some(arr => arr.length > 0)

  const weekdayLabels = [
    t('calendar.viewSunday'), t('calendar.viewMonday'), t('calendar.viewTuesday'),
    t('calendar.viewWednesday'), t('calendar.viewThursday'), t('calendar.viewFriday'),
    t('calendar.viewSaturday'),
  ]

  const { dragState, handleGridMouseDown, handleEventMouseDown } = useDragInteraction({
    dayColumns,
    scrollContainerRef,
    onCreateEvent,
    onMoveEvent,
    onResizeEvent,
    onEditEvent,
  })

  // 判断事件是否正在被拖拽（原位置需隐藏或半透明）
  const draggingEventId = dragState.type === 'moving' ? dragState.eventId
    : dragState.type === 'resizing' ? dragState.eventId : null

  if (view === 'month') {
    return (
      <Spin spinning={loading}>
        <Calendar
          value={dayjs(currentDate)}
          cellRender={(date: Dayjs, info) => {
            if (info.type !== 'date') return info.originNode
            const dayStart = startOfDayMs(date.valueOf())
            const dayEvents = getEventsForDay(events, dayStart)
            const dayTodos = getTodosForDay(todos, dayStart)
            return (
              <div
                style={{ minHeight: 56, padding: '2px 4px', cursor: 'pointer' }}
                onClick={(e) => {
                  e.stopPropagation()
                  const ts = date.hour(9).minute(0).second(0).millisecond(0).valueOf()
                  onCreateEvent(Math.floor(ts / MS))
                }}
              >
                {dayEvents.slice(0, 3).map((ev) => {
                  const c = eventColorMap[ev.color] || eventColorMap.default
                  const past = isEventPast(ev)
                  return (
                    <Tooltip
                      key={`${ev.id}-${ev.instance_start_at}`}
                      title={`${formatEventTime(ev.instance_start_at)} ${ev.title}`}
                    >
                      <div
                        onClick={(e) => {
                          e.stopPropagation()
                          onEditEvent(ev)
                        }}
                        style={{
                          background: past
                            ? c.bg.replace(/rgba\(([^)]+),\s*[\d.]+\)/, 'rgba($1, 0.08)')
                            : c.bg,
                          borderLeft: `3px solid ${past ? c.border + '99' : c.border}`,
                          padding: '1px 4px',
                          margin: '2px 0',
                          fontSize: 11,
                          borderRadius: 3,
                          color: past ? token.colorTextSecondary : token.colorText,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          opacity: past ? 0.85 : 1,
                        }}
                      >
                        {ev.all_day ? '🕐 ' : ''}{ev.title}
                      </div>
                    </Tooltip>
                  )
                })}
                {dayEvents.length > 3 && (
                  <div style={{ fontSize: 10, color: token.colorTextTertiary, padding: '0 4px' }}>
                    +{dayEvents.length - 3} {t('calendar.events')}
                  </div>
                )}
                {dayTodos.length > 0 && (
                  <div style={{ display: 'flex', gap: 2, marginTop: 2, flexWrap: 'wrap' }}>
                    {dayTodos.slice(0, 5).map((td) => {
                      const isDone = td.status === 'completed'
                      const priorityColor = TODO_PRIORITY_COLOR[td.priority] || TODO_PRIORITY_COLOR.none
                      return (
                        <Tooltip
                          key={`${td.id}-${td.instance_due_at}`}
                          title={`${t('calendar.todos')}: ${td.title} · ${formatEventTime(td.instance_due_at)}`}
                        >
                          <div
                            onClick={(e) => {
                              e.stopPropagation()
                              onEditTodo?.(td)
                            }}
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background: isDone
                                ? token.colorTextQuaternary
                                : priorityColor,
                              cursor: 'pointer',
                              opacity: isDone ? 0.5 : 1,
                            }}
                          />
                        </Tooltip>
                      )
                    })}
                    {dayTodos.length > 5 && (
                      <span style={{ fontSize: 10, color: token.colorTextTertiary }}>+{dayTodos.length - 5}</span>
                    )}
                  </div>
                )}
              </div>
            )
          }}
        />
      </Spin>
    )
  }

  // 日 / 周视图
  return (
    <Spin spinning={loading}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* sticky 容器：表头 + 全天事件区作为整体固定在顶部，不随滚动消失 */}
        <div style={{ position: 'sticky', top: 0, zIndex: 10 }}>
          {/* 表头 */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: `56px repeat(${dayColumns.length}, 1fr)`,
            borderBottom: `1px solid ${token.colorBorder}`,
            background: token.colorBgContainer,
          }}>
            <div />
            {dayColumns.map((dms) => {
              const d = new Date(dms)
              const isToday = startOfDayMs(Date.now()) === dms
              return (
                <div
                  key={dms}
                  style={{
                    textAlign: 'center',
                    padding: '8px 4px',
                    borderLeft: `1px solid ${token.colorBorder}`,
                  }}
                >
                  <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
                    {view === 'week' ? weekdayLabels[d.getDay()] : t('calendar.today')}
                  </div>
                  <div style={{
                    fontSize: 18,
                    fontWeight: 500,
                    color: isToday ? token.colorPrimary : token.colorText,
                    background: isToday ? token.colorPrimaryBg : 'transparent',
                    borderRadius: 999,
                    display: 'inline-block',
                    minWidth: 28,
                    padding: '0 6px',
                  }}>
                    {d.getDate()}
                  </div>
                </div>
              )
            })}
          </div>

          {/* 全天事件区（紧贴表头下方固定） */}
          {hasAllDayEvents && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: `56px repeat(${dayColumns.length}, 1fr)`,
              borderBottom: `1px solid ${token.colorBorder}`,
              background: token.colorBgLayout,
            }}>
              <div style={{
                fontSize: 11,
                color: token.colorTextSecondary,
                padding: '4px 6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                {t('calendar.allDay')}
              </div>
              {allDayEventsByDay.map((dayAllDayEvents, idx) => (
                <div key={idx} style={{
                  borderLeft: `1px solid ${token.colorBorder}`,
                  padding: '3px 4px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  minHeight: 28,
                }}>
                  {dayAllDayEvents.slice(0, 3).map((ev) => {
                    const c = eventColorMap[ev.color] || eventColorMap.default
                    const past = isEventPast(ev)
                    return (
                      <Tooltip
                        key={`${ev.id}-${ev.instance_start_at}`}
                        title={ev.title}
                      >
                        <div
                          onClick={(e) => {
                            e.stopPropagation()
                            onEditEvent(ev)
                          }}
                          style={{
                            background: past
                              ? c.bg.replace(/rgba\(([^)]+),\s*[\d.]+\)/, 'rgba($1, 0.08)')
                              : c.bg,
                            borderLeft: `3px solid ${past ? c.border + '99' : c.border}`,
                            padding: '1px 6px',
                            fontSize: 11,
                            borderRadius: 3,
                            color: past ? token.colorTextSecondary : token.colorText,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            cursor: 'pointer',
                            lineHeight: '20px',
                            opacity: past ? 0.85 : 1,
                          }}
                        >
                          {ev.title}
                        </div>
                      </Tooltip>
                    )
                  })}
                  {dayAllDayEvents.length > 3 && (
                    <div style={{ fontSize: 10, color: token.colorTextTertiary, padding: '0 4px' }}>
                      +{dayAllDayEvents.length - 3} {t('calendar.events')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 时间网格（滚动容器） */}
        <div ref={scrollContainerRef} style={{ flex: 1, overflow: 'auto', position: 'relative', background: token.colorBgContainer }}>
          <div data-day-cols style={{
            position: 'relative',
            height: hours.length * HOUR_HEIGHT,
            marginLeft: 56,
          }}>
            {/* 横向网格线 */}
            {hours.map((h) => (
              <div
                key={`line-${h}`}
                style={{
                  position: 'absolute',
                  top: h * HOUR_HEIGHT,
                  left: 0,
                  right: 0,
                  height: 0,
                  borderTop: `1px dashed ${token.colorBorder}`,
                  pointerEvents: 'none',
                }}
              />
            ))}

            {/* 时间标签 */}
            {hours.map((h) => (
              h === 0 ? null : (
                <div
                  key={`label-${h}`}
                  style={{
                    position: 'absolute',
                    top: h * HOUR_HEIGHT,
                    left: -52,
                    width: 48,
                    fontSize: 10,
                    color: token.colorTextSecondary,
                    textAlign: 'right',
                    transform: 'translateY(-7px)',
                    pointerEvents: 'none',
                  }}
                >
                  {formatHour(h)}
                </div>
              )
            ))}

            {/* 每日列 */}
            {dayColumns.map((dms, colIdx) => {
              // 全天事件已移至顶部独立区域，时间网格仅渲染非全天事件
              const dayEvents = getEventsForDay(events, dms).filter(e => !e.all_day)
              const dayTodos = getTodosForDay(todos, dms)
              return (
                <div
                  key={dms}
                  data-col-idx={colIdx}
                  style={{
                    position: 'absolute',
                    left: `${(colIdx / dayColumns.length) * 100}%`,
                    width: `${100 / dayColumns.length}%`,
                    top: 0,
                    bottom: 0,
                    borderLeft: `1px solid ${token.colorBorder}`,
                    cursor: dragState.type !== 'idle' ? 'default' : undefined,
                  }}
                  onMouseDown={(e) => handleGridMouseDown(e, dms, colIdx)}
                >
                  {/* 当前时间指示线 */}
                  {startOfDayMs(Date.now()) === dms && (() => {
                    const now = new Date()
                    const top = (now.getHours() * 60 + now.getMinutes()) / 60 * HOUR_HEIGHT
                    return (
                      <div style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top,
                        height: 0,
                        borderTop: `2px solid ${token.colorError}`,
                        zIndex: 5,
                        pointerEvents: 'none',
                      }}>
                        <div style={{
                          position: 'absolute',
                          left: -4,
                          top: -4,
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: token.colorError,
                        }} />
                      </div>
                    )
                  })()}

                  {/* 事件块 */}
                  {dayEvents.map((ev) => {
                    // 被拖拽的事件在原列隐藏（移动/调整大小时渲染拖拽块代替）
                    if (ev.id === draggingEventId) return null

                    const startMs = Math.max(ev.instance_start_at * MS, dms)
                    const endMs = Math.min(ev.instance_end_at * MS, dms + 86400 * MS - 1)
                    const startMins = (startMs - dms) / MS / 60
                    const durationMins = Math.max(15, (endMs - startMs) / MS / 60)
                    const top = (startMins / 60) * HOUR_HEIGHT
                    const height = Math.max(20, (durationMins / 60) * HOUR_HEIGHT - 2)
                    const c = eventColorMap[ev.color] || eventColorMap.default
                    const past = isEventPast(ev)
                    return (
                      <Tooltip
                        key={`${ev.id}-${ev.instance_start_at}`}
                        title={`${ev.title}\n${formatEventTime(ev.instance_start_at)} - ${formatEventTime(ev.instance_end_at)}${ev.location ? '\n' + ev.location : ''}`}
                      >
                        <div
                          onMouseDown={(e) => handleEventMouseDown(e, ev, dms)}
                          style={{
                            position: 'absolute',
                            left: 2,
                            right: 2,
                            top,
                            height,
                            background: past
                              ? c.bg.replace(/rgba\(([^)]+),\s*[\d.]+\)/, 'rgba($1, 0.08)')
                              : c.bg,
                            borderLeft: `3px solid ${past ? c.border + '99' : c.border}`,
                            borderRadius: 4,
                            padding: '2px 6px',
                            fontSize: 11,
                            overflow: 'hidden',
                            cursor: 'grab',
                            color: past ? token.colorTextSecondary : token.colorText,
                            userSelect: 'none',
                            opacity: past ? 0.85 : 1,
                          }}
                        >
                          {/* 顶部 resize 手柄 */}
                          <div style={{
                            position: 'absolute', left: 0, right: 0, top: 0,
                            height: RESIZE_HANDLE_HEIGHT,
                            cursor: 'ns-resize', zIndex: 2,
                          }} />
                          <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {ev.title}
                          </div>
                          {height > 32 && (
                            <div style={{ fontSize: 10, color: past ? token.colorTextTertiary : token.colorTextSecondary }}>
                              {formatEventTime(ev.instance_start_at)} - {formatEventTime(ev.instance_end_at)}
                            </div>
                          )}
                          {/* 底部 resize 手柄 */}
                          <div style={{
                            position: 'absolute', left: 0, right: 0, bottom: 0,
                            height: RESIZE_HANDLE_HEIGHT,
                            cursor: 'ns-resize', zIndex: 2,
                          }} />
                        </div>
                      </Tooltip>
                    )
                  })}

                  {/* TODO 到期长条（同时间段横向平分宽度） */}
                  {(() => {
                    const BAR_HEIGHT = 16
                    const SNAP_H = BAR_HEIGHT
                    const groups: { baseTop: number; todos: CalendarTodoInstance[] }[] = []
                    dayTodos.forEach((td) => {
                      const mins = (td.instance_due_at * MS - dms) / MS / 60
                      if (mins < 0 || mins >= 1440) return
                      const baseTop = (mins / 60) * HOUR_HEIGHT
                      const existing = groups.find(g => Math.abs(g.baseTop - baseTop) < SNAP_H)
                      if (existing) {
                        existing.todos.push(td)
                      } else {
                        groups.push({ baseTop, todos: [td] })
                      }
                    })
                    return groups.map((group) => (
                      <div
                        key={`tg-${group.baseTop}`}
                        style={{
                          position: 'absolute',
                          left: 2,
                          right: 2,
                          top: group.baseTop,
                          display: 'flex',
                          gap: 2,
                          zIndex: 4,
                        }}
                      >
                        {group.todos.map((td) => {
                          const c = todoBarColorMap[td.priority] || todoBarColorMap.none
                          const isDone = td.status === 'completed'
                          return (
                            <Tooltip
                              key={`${td.id}-${td.instance_due_at}`}
                              title={`${t('calendar.todos')}: ${td.title} · ${formatEventTime(td.instance_due_at)}${onCompleteTodo ? ' · ' + t('calendar.toggleComplete') : ''}`}
                            >
                              <div
                                onMouseDown={(e) => {
                                  e.stopPropagation()
                                  e.preventDefault()
                                }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onEditTodo?.(td)
                                }}
                                style={{
                                  flex: 1,
                                  height: BAR_HEIGHT,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 3,
                                  background: isDone ? token.colorFillQuaternary : c.bg,
                                  borderLeft: `3px solid ${isDone ? token.colorBorderSecondary : c.border}`,
                                  borderRadius: 3,
                                  padding: '0 6px',
                                  fontSize: 10,
                                  overflow: 'hidden',
                                  color: isDone ? token.colorTextTertiary : token.colorText,
                                  cursor: 'pointer',
                                  userSelect: 'none',
                                  opacity: isDone ? 0.6 : 1,
                                }}
                              >
                                {onCompleteTodo && (
                                  <span
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      onCompleteTodo(td)
                                    }}
                                    style={{
                                      flexShrink: 0,
                                      width: 12,
                                      height: 12,
                                      borderRadius: 3,
                                      border: `1px solid ${isDone ? token.colorPrimary : c.border}`,
                                      background: isDone ? token.colorPrimary : 'transparent',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      cursor: 'pointer',
                                      fontSize: 9,
                                      lineHeight: '10px',
                                      color: '#fff',
                                    }}
                                  >
                                    {isDone ? '✓' : ''}
                                  </span>
                                )}
                                <span style={{
                                  flex: 1,
                                  minWidth: 0,
                                  overflow: 'hidden',
                                  whiteSpace: 'nowrap',
                                  textOverflow: 'ellipsis',
                                  textDecoration: isDone ? 'line-through' : 'none',
                                }}>
                                  {td.title}
                                </span>
                              </div>
                            </Tooltip>
                          )
                        })}
                      </div>
                    ))
                  })()}

                  {/* 拖拽预览块 */}
                  {dragState.type === 'creating' && (
                    <DragPreviewBlock dragState={dragState} dayStartMs={dms} token={token} isDark={isDark} />
                  )}
                  {dragState.type === 'moving' && (
                    <DragMovingBlock dragState={dragState} dayStartMs={dms} token={token} isDark={isDark} />
                  )}
                  {dragState.type === 'resizing' && (
                    <DragResizingBlock dragState={dragState} dayStartMs={dms} token={token} isDark={isDark} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </Spin>
  )
}

export default CalendarPanel
