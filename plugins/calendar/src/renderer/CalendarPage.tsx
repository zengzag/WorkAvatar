import { useState, useCallback, useRef, useEffect } from 'react'
import { Button, Space, Segmented, Tooltip, theme, Modal, message } from 'antd'
import {
  PlusOutlined,
  SettingOutlined,
  CheckSquareOutlined,
  LeftOutlined,
  RightOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useCalendar } from './useCalendar'
import CalendarPanel from './components/CalendarPanel'
import TodoPanel from './components/TodoPanel'
import EventFormModal, { type EventFormMode } from './components/EventFormModal'
import TodoFormModal, { type TodoFormMode } from './components/TodoFormModal'
import CalendarSettingsDrawer from './components/CalendarSettingsDrawer'
import type { DeleteInstanceMode, CalendarEventInstance, CalendarTodo, CalendarTodoInstance, CreateEventInput, UpdateEventInput, CreateTodoInput, UpdateTodoInput } from './types'

const DEFAULT_CLICK_DURATION_SEC = 30 * 60

const CalendarPage: React.FC = () => {
  const { t } = useTranslation('calendar')
  const { token } = theme.useToken()
  const cal = useCalendar()
  const { refreshAll } = cal
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
  const [recurringDeleteOpen, setRecurringDeleteOpen] = useState(false)
  const [recurringDeleteArgs, setRecurringDeleteArgs] = useState<{
    title: string
    onMode: (mode: DeleteInstanceMode) => Promise<any> | any
  } | null>(null)
  const calendarWrapRef = useRef<HTMLDivElement | null>(null)
  const pageRef = useRef<HTMLDivElement | null>(null)

  // 页面被 KeepAlive 缓存（display:none 隐藏）后重新可见时，立即刷新数据，避免进入时数据陈旧
  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    const parent = el.parentElement
    if (!parent) return
    const observer = new MutationObserver(() => {
      if (parent.style.display !== 'none') refreshAll()
    })
    observer.observe(parent, { attributes: true, attributeFilter: ['style'] })
    return () => observer.disconnect()
  }, [refreshAll])

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

  const showRecurringDeleteModal = useCallback((args: {
    title: string
    onMode: (mode: DeleteInstanceMode) => Promise<any> | any
  }) => {
    setRecurringDeleteArgs(args)
    setRecurringDeleteOpen(true)
  }, [])

  const closeRecurringDeleteModal = useCallback(() => {
    setRecurringDeleteOpen(false)
    setTimeout(() => setRecurringDeleteArgs(null), 300)
  }, [])

  const handleRecurringDeleteMode = useCallback(async (mode: DeleteInstanceMode) => {
    if (!recurringDeleteArgs) return
    closeRecurringDeleteModal()
    await recurringDeleteArgs.onMode(mode)
  }, [recurringDeleteArgs, closeRecurringDeleteModal])

  const handleDeleteEvent = useCallback(async (ev: CalendarEventInstance) => {
    if (!ev.recurrence_rule) {
      return await cal.deleteEvent(ev.id)
    }
    const anchorAt = ev.instance_start_at
    showRecurringDeleteModal({
      title: ev.title,
      onMode: async (mode) => {
        const r = await cal.deleteEventInstance({ id: ev.id, anchor_at: anchorAt, mode })
        if (r && !r.error) {
          message.success(t('calendar.deleteEvent'))
          setEventModalOpen(false)
        } else if (r?.error) {
          message.error(r.error)
        }
      },
    })
  }, [cal, t, showRecurringDeleteModal])

  const handleDeleteTodo = useCallback(async (td: CalendarTodo | CalendarTodoInstance) => {
    if (!td.recurrence_rule) {
      return await cal.deleteTodo(td.id)
    }
    const inst = td as CalendarTodoInstance & CalendarTodo
    const anchorAt = inst.instance_due_at ?? (inst.due_at as number)
    showRecurringDeleteModal({
      title: td.title,
      onMode: async (mode) => {
        const r = await cal.deleteTodoInstance({ id: td.id, anchor_at: anchorAt, mode })
        if (r && !r.error) {
          message.success(t('calendar.deleteTodo'))
          setTodoModalOpen(false)
        } else if (r?.error) {
          message.error(r.error)
        }
      },
    })
  }, [cal, t, showRecurringDeleteModal])

  const openCreateTodo = useCallback(() => {
    setEditingTodo(null)
    setTodoModalMode('create')
    setTodoModalOpen(true)
  }, [])

  const openEditTodo = useCallback((todo: CalendarTodo | CalendarTodoInstance) => {
    setEditingTodo(todo as CalendarTodo)
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
    <div ref={pageRef} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
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
            todos={cal.todoInstances}
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
            onDeleteTodo={handleDeleteTodo}
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
        onClose={() => setTodoModalOpen(false)}
        onSubmit={handleTodoSubmit}
        onDelete={handleDeleteTodo}
      />
      <CalendarSettingsDrawer
        open={settingsOpen}
        settings={cal.settings}
        onClose={() => setSettingsOpen(false)}
        onSave={cal.saveSettings}
      />

      <Modal
        open={recurringDeleteOpen}
        title={recurringDeleteArgs ? t('calendar.recurringDeleteTitle', { title: recurringDeleteArgs.title }) : ''}
        onCancel={closeRecurringDeleteModal}
        footer={null}
        destroyOnHidden
        centered
        width={400}
        styles={{
          body: { paddingTop: token.paddingMD },
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Button
            block
            size="large"
            onClick={() => handleRecurringDeleteMode('this')}
          >
            {t('calendar.recurringDeleteThis')}
          </Button>
          <Button
            block
            size="large"
            onClick={() => handleRecurringDeleteMode('future')}
          >
            {t('calendar.recurringDeleteFuture')}
          </Button>
          <Button
            block
            size="large"
            danger
            onClick={() => handleRecurringDeleteMode('all')}
          >
            {t('calendar.recurringDeleteAll')}
          </Button>
        </Space>
      </Modal>
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
