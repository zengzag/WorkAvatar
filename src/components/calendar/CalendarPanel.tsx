import { useMemo, useRef } from 'react'
import { Calendar, Spin, Tooltip, theme } from 'antd'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { CalendarEventInstance, CalendarTodo, EventColor } from '../../types/calendar'
import { useDragInteraction, secToY, RESIZE_HANDLE_HEIGHT } from '../../hooks/useDragInteraction'
import type { DragState } from '../../hooks/useDragInteraction'

const MS = 1000
const HOUR_HEIGHT = 56
const HOURS_PER_DAY = 24

const EVENT_COLOR_MAP: Record<EventColor, { bg: string; border: string }> = {
  default: { bg: 'rgba(22,119,255,0.14)', border: '#1677ff' },
  blue: { bg: 'rgba(22,119,255,0.14)', border: '#1677ff' },
  green: { bg: 'rgba(82,196,26,0.14)', border: '#52c41a' },
  orange: { bg: 'rgba(250,140,22,0.14)', border: '#fa8c16' },
  red: { bg: 'rgba(245,34,45,0.14)', border: '#f5222d' },
  purple: { bg: 'rgba(114,46,209,0.14)', border: '#722ed1' },
}

const TODO_PRIORITY_COLOR: Record<string, string> = {
  high: '#f5222d',
  medium: '#fa8c16',
  low: '#1677ff',
  none: '#8c8c8c',
}

interface CalendarPanelProps {
  view: 'month' | 'week' | 'day'
  currentDate: number
  events: CalendarEventInstance[]
  todos: CalendarTodo[]
  loading: boolean
  onCreateEvent: (startAt: number, endAt?: number) => void
  onEditEvent: (event: CalendarEventInstance) => void
  onMoveEvent: (input: { id: string; start_at: number; end_at: number }) => void
  onResizeEvent: (input: { id: string; start_at: number; end_at: number }) => void
  onEditTodo?: (todo: CalendarTodo) => void
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

const getTodosForDay = (todos: CalendarTodo[], dayStartMs: number): CalendarTodo[] => {
  const dayEnd = dayStartMs + 86400 * MS - 1
  return todos.filter(
    td => td.due_at != null && td.due_at * MS >= dayStartMs && td.due_at * MS <= dayEnd,
  )
}

const formatHour = (h: number): string => `${h.toString().padStart(2, '0')}:00`

const formatEventTime = (sec: number): string => {
  const d = new Date(sec * MS)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

/** 渲染拖拽创建的预览块 */
const DragPreviewBlock: React.FC<{ dragState: Extract<DragState, { type: 'creating' }>; dayStartMs: number; token: any }> = ({ dragState, dayStartMs, token }) => {
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
      background: 'rgba(22,119,255,0.08)',
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
const DragMovingBlock: React.FC<{ dragState: Extract<DragState, { type: 'moving' }>; dayStartMs: number; token: any }> = ({ dragState, dayStartMs, token }) => {
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
        background: 'rgba(22,119,255,0.06)', borderLeft: '3px solid rgba(22,119,255,0.3)',
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
      background: 'rgba(22,119,255,0.14)', borderLeft: '3px solid #1677ff',
      borderRadius: 4, padding: '2px 6px', fontSize: 11, overflow: 'hidden',
      color: token.colorText, pointerEvents: 'none', zIndex: 6,
      boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
    }}>
      <div style={{ fontWeight: 500 }}>{formatEventTime(ev.instance_start_at)} - {formatEventTime(ev.instance_end_at)}</div>
    </div>
  )
}

const DragResizingBlock: React.FC<{ dragState: Extract<DragState, { type: 'resizing' }>; dayStartMs: number; token: any }> = ({ dragState, dayStartMs, token }) => {
  if (dragState.dayStartMs !== dayStartMs) return null
  const top = secToY(dragState.newStartSec, dayStartMs)
  const bottom = secToY(dragState.newEndSec, dayStartMs)
  return (
    <div style={{
      position: 'absolute', left: 2, right: 2, top, height: bottom - top,
      background: 'rgba(22,119,255,0.14)', borderLeft: '3px solid #1677ff',
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
  onCreateEvent, onEditEvent, onMoveEvent, onResizeEvent, onEditTodo,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

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
                  const c = EVENT_COLOR_MAP[ev.color] || EVENT_COLOR_MAP.default
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
                          background: c.bg,
                          borderLeft: `3px solid ${c.border}`,
                          padding: '1px 4px',
                          margin: '2px 0',
                          fontSize: 11,
                          borderRadius: 3,
                          color: token.colorText,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
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
                    {dayTodos.slice(0, 5).map((td) => (
                      <Tooltip
                        key={td.id}
                        title={`${t('calendar.todos')}: ${td.title}${td.due_at ? ' · ' + formatEventTime(td.due_at) : ''}`}
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
                            background: TODO_PRIORITY_COLOR[td.priority] || TODO_PRIORITY_COLOR.none,
                            cursor: 'pointer',
                          }}
                        />
                      </Tooltip>
                    ))}
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
        {/* 表头 */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: `56px repeat(${dayColumns.length}, 1fr)`,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          flexShrink: 0,
          position: 'sticky',
          top: 0,
          zIndex: 10,
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
                  borderLeft: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <div style={{ fontSize: 11, color: token.colorTextTertiary }}>
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

        {/* 时间网格 */}
        <div ref={scrollContainerRef} style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
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
                  borderTop: `1px dashed ${token.colorBorderSecondary}`,
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
                    color: token.colorTextTertiary,
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
              const dayEvents = getEventsForDay(events, dms)
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
                    borderLeft: `1px solid ${token.colorBorderSecondary}`,
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
                    const c = EVENT_COLOR_MAP[ev.color] || EVENT_COLOR_MAP.default
                    const isAllDay = ev.all_day
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
                            background: c.bg,
                            borderLeft: `3px solid ${c.border}`,
                            borderRadius: 4,
                            padding: '2px 6px',
                            fontSize: 11,
                            overflow: 'hidden',
                            cursor: isAllDay ? 'pointer' : 'grab',
                            color: token.colorText,
                            userSelect: 'none',
                          }}
                        >
                          {/* 顶部 resize 手柄 */}
                          {!isAllDay && (
                            <div style={{
                              position: 'absolute', left: 0, right: 0, top: 0,
                              height: RESIZE_HANDLE_HEIGHT,
                              cursor: 'ns-resize', zIndex: 2,
                            }} />
                          )}
                          <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {isAllDay ? '🕐 ' : ''}{ev.title}
                          </div>
                          {!isAllDay && height > 32 && (
                            <div style={{ fontSize: 10, color: token.colorTextSecondary }}>
                              {formatEventTime(ev.instance_start_at)} - {formatEventTime(ev.instance_end_at)}
                            </div>
                          )}
                          {/* 底部 resize 手柄 */}
                          {!isAllDay && (
                            <div style={{
                              position: 'absolute', left: 0, right: 0, bottom: 0,
                              height: RESIZE_HANDLE_HEIGHT,
                              cursor: 'ns-resize', zIndex: 2,
                            }} />
                          )}
                        </div>
                      </Tooltip>
                    )
                  })}

                  {/* TODO 到期点（同时间段横向排列） */}
                  {(() => {
                    const SNAP_H = 14
                    const groups: { baseTop: number; todos: CalendarTodo[] }[] = []
                    dayTodos.forEach((td) => {
                      if (!td.due_at) return
                      const mins = (td.due_at * MS - dms) / MS / 60
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
                          right: 3,
                          top: Math.max(0, group.baseTop - 3),
                          display: 'flex',
                          gap: 3,
                          zIndex: 4,
                        }}
                      >
                        {group.todos.map((td) => (
                          <Tooltip
                            key={td.id}
                            title={`${t('calendar.todos')}: ${td.title} · ${formatEventTime(td.due_at!)}`}
                          >
                            <div
                              onClick={(e) => {
                                e.stopPropagation()
                                onEditTodo?.(td)
                              }}
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: '50%',
                                background: TODO_PRIORITY_COLOR[td.priority] || TODO_PRIORITY_COLOR.none,
                                cursor: 'pointer',
                              }}
                            />
                          </Tooltip>
                        ))}
                      </div>
                    ))
                  })()}

                  {/* 拖拽预览块 */}
                  {dragState.type === 'creating' && (
                    <DragPreviewBlock dragState={dragState} dayStartMs={dms} token={token} />
                  )}
                  {dragState.type === 'moving' && (
                    <DragMovingBlock dragState={dragState} dayStartMs={dms} token={token} />
                  )}
                  {dragState.type === 'resizing' && (
                    <DragResizingBlock dragState={dragState} dayStartMs={dms} token={token} />
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
