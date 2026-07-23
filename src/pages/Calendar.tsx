import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { Button, Space, Segmented, Tooltip, theme } from 'antd'
import {
  PlusOutlined,
  SettingOutlined,
  CheckSquareOutlined,
  LeftOutlined,
  RightOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useCalendar } from '../hooks/useCalendar'
import CalendarPanel from '../components/calendar/CalendarPanel'
import TodoPanel from '../components/calendar/TodoPanel'
import EventFormModal, { type EventFormMode } from '../components/calendar/EventFormModal'
import TodoFormModal, { type TodoFormMode } from '../components/calendar/TodoFormModal'
import CalendarSettingsModal from '../components/calendar/CalendarSettingsModal'
import type { CalendarEventInstance, CalendarTodo, CreateEventInput, UpdateEventInput, CreateTodoInput, UpdateTodoInput } from '../types/calendar'

const DEFAULT_CLICK_DURATION_SEC = 30 * 60

const CalendarPage: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const cal = useCalendar()
  const [eventModalOpen, setEventModalOpen] = useState(false)
  const [eventModalMode, setEventModalMode] = useState<EventFormMode>('create')
  const [editingEvent, setEditingEvent] = useState<CalendarEventInstance | null>(null)
  const [defaultStartAt, setDefaultStartAt] = useState<number | undefined>(undefined)
  const [defaultEndAt, setDefaultEndAt] = useState<number | undefined>(undefined)
  // 每次打开日程弹窗递增，强制 EventFormModal 重建以获得全新的 form 实例，避免残留上次数据
  const [eventModalKey, setEventModalKey] = useState(0)

  const [todoModalOpen, setTodoModalOpen] = useState(false)
  const [todoModalMode, setTodoModalMode] = useState<TodoFormMode>('create')
  const [editingTodo, setEditingTodo] = useState<CalendarTodo | null>(null)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const calendarWrapRef = useRef<HTMLDivElement | null>(null)

  // 周/日视图首次进入时滚动到中间位置；周↔日切换时保留滚动位置
  const lastViewRef = useRef<string | null>(null)
  const savedScrollTopRef = useRef(0)
  useEffect(() => {
    const prevView = lastViewRef.current
    lastViewRef.current = cal.view

    // 月视图不处理
    if (cal.view === 'month') return

    const isFirstEnter = prevView === null || prevView === 'month'
    const isWeekDaySwitch = (prevView === 'week' && cal.view === 'day') || (prevView === 'day' && cal.view === 'week')

    if (isWeekDaySwitch) {
      // 周↔日切换：恢复之前的滚动位置
      const restore = () => {
        const target = calendarWrapRef.current
        if (target && target.scrollHeight > target.clientHeight) {
          target.scrollTop = savedScrollTopRef.current
        }
      }
      restore()
      const t1 = setTimeout(restore, 100)
      const t2 = setTimeout(restore, 400)
      return () => { clearTimeout(t1); clearTimeout(t2) }
    }

    if (isFirstEnter) {
      // 首次进入周/日视图：滚动到中间
      const tryScroll = () => {
        const target = calendarWrapRef.current
        if (target && target.scrollHeight > target.clientHeight) {
          target.scrollTop = (target.scrollHeight - target.clientHeight) * 0.6
        }
      }
      tryScroll()
      const t1 = setTimeout(tryScroll, 100)
      const t2 = setTimeout(tryScroll, 400)
      return () => { clearTimeout(t1); clearTimeout(t2) }
    }
  }, [cal.view, cal.loadingEvents])

  // 滚动时记录当前位置，用于视图切换恢复
  useEffect(() => {
    const el = calendarWrapRef.current
    if (!el) return
    const onScroll = () => { savedScrollTopRef.current = el.scrollTop }
    el.addEventListener('scroll', onScroll)
    return () => { el.removeEventListener('scroll', onScroll) }
  }, [])

  const existingTags = useMemo(() => {
    const tagSet = new Set<string>()
    for (const td of cal.todos) {
      if (td.tags) td.tags.forEach(t => tagSet.add(t))
    }
    return Array.from(tagSet).sort()
  }, [cal.todos])

  const openCreateEvent = useCallback((startAt?: number, endAt?: number) => {
    setEditingEvent(null)
    setDefaultStartAt(startAt)
    // 点击创建默认30分钟
    setDefaultEndAt(endAt ?? (startAt != null ? startAt + DEFAULT_CLICK_DURATION_SEC : undefined))
    setEventModalMode('create')
    setEventModalKey(k => k + 1)
    setEventModalOpen(true)
  }, [])

  const openEditEvent = useCallback((event: CalendarEventInstance) => {
    setEditingEvent(event)
    setDefaultStartAt(undefined)
    setDefaultEndAt(undefined)
    setEventModalMode('edit')
    setEventModalKey(k => k + 1)
    setEventModalOpen(true)
  }, [])

  const handleEventSubmit = useCallback(async (input: CreateEventInput | UpdateEventInput) => {
    if (eventModalMode === 'create') {
      return await cal.createEvent(input as CreateEventInput)
    }
    return await cal.updateEvent(input as UpdateEventInput)
  }, [cal, eventModalMode])

  const handleMoveEvent = useCallback(async (input: { id: string; start_at: number; end_at: number }) => {
    return await cal.updateEvent(input as UpdateEventInput)
  }, [cal])

  const handleResizeEvent = useCallback(async (input: { id: string; start_at: number; end_at: number }) => {
    return await cal.updateEvent(input as UpdateEventInput)
  }, [cal])

  const handleDeleteEvent = useCallback(async (id: string) => {
    return await cal.deleteEvent(id)
  }, [cal])

  const openCreateTodo = useCallback(() => {
    setEditingTodo(null)
    setTodoModalMode('create')
    setTodoModalOpen(true)
  }, [])

  const openEditTodo = useCallback((todo: CalendarTodo) => {
    setEditingTodo(todo)
    setTodoModalMode('edit')
    setTodoModalOpen(true)
  }, [])

  const handleTodoSubmit = useCallback(async (input: CreateTodoInput | UpdateTodoInput) => {
    if (todoModalMode === 'create') {
      return await cal.createTodo(input as CreateTodoInput)
    }
    return await cal.updateTodo(input as UpdateTodoInput)
  }, [cal, todoModalMode])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* 顶部工具栏 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexShrink: 0,
      }}>
        <Space size="middle">
          <Space.Compact>
            <Button
              icon={<LeftOutlined />}
              onClick={() => shiftDate(cal.view, cal.currentDate, -1, cal.setCurrentDate)}
            />
            <Button onClick={() => cal.setCurrentDate(Date.now())}>
              {t('calendar.today')}
            </Button>
            <Button
              icon={<RightOutlined />}
              onClick={() => shiftDate(cal.view, cal.currentDate, 1, cal.setCurrentDate)}
            />
          </Space.Compact>
          <Segmented
            value={cal.view}
            onChange={(v) => cal.setView(v as 'month' | 'week' | 'day')}
            options={[
              { label: t('calendar.viewMonth'), value: 'month' },
              { label: t('calendar.viewWeek'), value: 'week' },
              { label: t('calendar.viewDay'), value: 'day' },
            ]}
          />
        </Space>
        <Space>
          <Button icon={<PlusOutlined />} type="primary" onClick={() => openCreateEvent()}>
            {t('calendar.newEvent')}
          </Button>
          <Button icon={<CheckSquareOutlined />} onClick={openCreateTodo}>
            {t('calendar.newTodo')}
          </Button>
          <Tooltip title={t('calendar.settings')}>
            <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} />
          </Tooltip>
        </Space>
      </div>

      {/* 主体：左日历 + 右待办 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div ref={calendarWrapRef} style={{ flex: 1, minWidth: 0, padding: 12, overflow: 'auto' }}>
          <CalendarPanel
            view={cal.view}
            currentDate={cal.currentDate}
            events={cal.events}
            todos={cal.todos}
            loading={cal.loadingEvents}
            onCreateEvent={openCreateEvent}
            onEditEvent={openEditEvent}
            onMoveEvent={handleMoveEvent}
            onResizeEvent={handleResizeEvent}
            onEditTodo={openEditTodo}
          />
        </div>
        <div style={{
          width: 360,
          flexShrink: 0,
          borderLeft: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <TodoPanel
            todos={cal.todos}
            loading={cal.loadingTodos}
            filters={cal.filters}
            onFiltersChange={cal.setFilters}
            onQuickAddTodo={cal.createTodo}
            onEditTodo={openEditTodo}
            onUpdateTodo={cal.updateTodo}
            onCompleteTodo={cal.completeTodo}
            onDeleteTodo={cal.deleteTodo}
          />
        </div>
      </div>

      {/* 弹窗 */}
      <EventFormModal
        key={eventModalKey}
        open={eventModalOpen}
        mode={eventModalMode}
        event={editingEvent}
        defaultStartAt={defaultStartAt}
        defaultEndAt={defaultEndAt}
        settings={cal.settings}
        onClose={() => setEventModalOpen(false)}
        onSubmit={handleEventSubmit}
        onDelete={handleDeleteEvent}
      />
      <TodoFormModal
        open={todoModalOpen}
        mode={todoModalMode}
        todo={editingTodo}
        settings={cal.settings}
        existingTags={existingTags}
        onClose={() => setTodoModalOpen(false)}
        onSubmit={handleTodoSubmit}
      />
      <CalendarSettingsModal
        open={settingsOpen}
        settings={cal.settings}
        onClose={() => setSettingsOpen(false)}
        onSave={cal.saveSettings}
      />
    </div>
  )
}

function shiftDate(view: 'month' | 'week' | 'day', currentMs: number, direction: 1 | -1, setter: (ms: number) => void): void {
  const d = new Date(currentMs)
  if (view === 'day') {
    d.setDate(d.getDate() + direction)
  } else if (view === 'week') {
    d.setDate(d.getDate() + direction * 7)
  } else {
    d.setMonth(d.getMonth() + direction)
  }
  setter(d.getTime())
}

export default CalendarPage
