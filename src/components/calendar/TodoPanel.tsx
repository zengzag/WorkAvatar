import { useMemo, useState, useCallback } from 'react'
import { Spin, Select, Empty, Tooltip, Badge, Button, DatePicker, Segmented, Switch, theme } from 'antd'
import { FilterOutlined, CaretRightOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'
import type {
  CalendarTodo, TodoFilters,
  CreateTodoInput, UpdateTodoInput,
} from '../../types/calendar'
import QuickAddBar from './QuickAddBar'
import TodoItem from './TodoItem'

const MS = 1000

type QuickFilter = 'all' | 'today' | 'overdue' | 'completed'

interface TodoPanelProps {
  todos: CalendarTodo[]
  loading: boolean
  filters: TodoFilters
  onFiltersChange: (filters: Partial<TodoFilters>) => void
  onQuickAddTodo: (input: CreateTodoInput) => Promise<any>
  onEditTodo: (todo: CalendarTodo) => void
  onUpdateTodo: (input: UpdateTodoInput) => Promise<any>
  onCompleteTodo: (id: string, completed: boolean) => void
  onDeleteTodo: (id: string) => void
}

const startOfDayMs = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const endOfDayMs = (ms: number): number => startOfDayMs(ms) + 86400 * MS - 1

const startOfWeekMs = (ms: number): number => {
  const d = new Date(ms)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  return startOfDayMs(new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff).getTime())
}

const PRIORITY_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1, none: 0 }

/** 组内排序：截止时间升序(null 最后) → 优先级降序 → 进行中优先 → 创建时间倒序 */
const sortTodos = (todos: CalendarTodo[]): CalendarTodo[] => {
  return [...todos].sort((a, b) => {
    if (a.due_at == null && b.due_at != null) return 1
    if (a.due_at != null && b.due_at == null) return -1
    if (a.due_at != null && b.due_at != null && a.due_at !== b.due_at) return a.due_at - b.due_at
    const pa = PRIORITY_WEIGHT[a.priority] ?? 0
    const pb = PRIORITY_WEIGHT[b.priority] ?? 0
    if (pa !== pb) return pb - pa
    const sa = a.status === 'in_progress' ? 1 : 0
    const sb = b.status === 'in_progress' ? 1 : 0
    if (sa !== sb) return sb - sa
    return b.created_at - a.created_at
  })
}

type GroupVariant = 'overdue' | 'todayDone' | 'completed'

interface TodoGroup {
  key: string
  label: string
  todos: CalendarTodo[]
  collapsible?: boolean
  defaultCollapsed?: boolean
  variant?: GroupVariant
}

/** 分组顺序：逾期 → 今日 → 今日已完成(折叠) → 明日 → 本周 → 以后 → 无截止 → 历史已完成(默认隐藏) */
const groupTodos = (todos: CalendarTodo[], t: (k: string) => string): TodoGroup[] => {
  const now = Date.now()
  const todayStart = startOfDayMs(now)
  const todayEnd = endOfDayMs(now)
  const tomorrowStart = todayStart + 86400 * MS
  const tomorrowEnd = tomorrowStart + 86400 * MS - 1
  const weekStart = startOfWeekMs(now)
  const weekEnd = weekStart + 7 * 86400 * MS - 1

  const groups: Record<string, CalendarTodo[]> = {
    overdue: [], today: [], todayDone: [], tomorrow: [], thisWeek: [], later: [], noDue: [], completed: [],
  }

  for (const td of todos) {
    if (td.status === 'completed') {
      // 用 completed_at 判断今日完成，更符合用户感知（今日做完的事，无论原截止何时）
      const completedMs = td.completed_at != null ? td.completed_at * MS : null
      if (completedMs != null && completedMs >= todayStart && completedMs <= todayEnd) {
        groups.todayDone.push(td)
      } else {
        groups.completed.push(td)
      }
      continue
    }
    if (!td.due_at) {
      groups.noDue.push(td)
      continue
    }
    const dueMs = td.due_at * MS
    if (dueMs < todayStart) groups.overdue.push(td)
    else if (dueMs <= todayEnd) groups.today.push(td)
    else if (dueMs <= tomorrowEnd) groups.tomorrow.push(td)
    else if (dueMs <= weekEnd) groups.thisWeek.push(td)
    else groups.later.push(td)
  }

  return [
    { key: 'overdue', label: t('calendar.groupOverdue'), todos: sortTodos(groups.overdue), variant: 'overdue' as const },
    { key: 'today', label: t('calendar.groupToday'), todos: sortTodos(groups.today) },
    { key: 'todayDone', label: t('calendar.groupTodayDone'), todos: sortTodos(groups.todayDone), collapsible: true, defaultCollapsed: true, variant: 'todayDone' as const },
    { key: 'tomorrow', label: t('calendar.groupTomorrow'), todos: sortTodos(groups.tomorrow) },
    { key: 'thisWeek', label: t('calendar.groupThisWeek'), todos: sortTodos(groups.thisWeek) },
    { key: 'later', label: t('calendar.groupLater'), todos: sortTodos(groups.later) },
    { key: 'noDue', label: t('calendar.groupNoDue'), todos: sortTodos(groups.noDue) },
    { key: 'completed', label: t('calendar.groupCompleted'), todos: sortTodos(groups.completed), collapsible: true, defaultCollapsed: true, variant: 'completed' as const },
  ].filter(g => g.todos.length > 0)
}

const TodoPanel: React.FC<TodoPanelProps> = ({
  todos, loading, filters, onFiltersChange,
  onQuickAddTodo, onEditTodo, onUpdateTodo, onCompleteTodo, onDeleteTodo,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [filterOpen, setFilterOpen] = useState(false)
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')
  const [hideCompleted, setHideCompleted] = useState(true)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  const isGroupCollapsed = useCallback((key: string, defaultCollapsed?: boolean) => {
    if (key in collapsedGroups) return collapsedGroups[key]
    return !!defaultCollapsed
  }, [collapsedGroups])

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups(prev => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // 快速筛选与高级筛选叠加生效
  const filtered = useMemo(() => {
    const now = Date.now()
    const todayStart = startOfDayMs(now)
    const todayEnd = endOfDayMs(now)
    return todos.filter(td => {
      if (quickFilter === 'today') {
        const dueInToday = td.due_at != null && td.due_at * MS >= todayStart && td.due_at * MS <= todayEnd
        const completedToday = td.status === 'completed' && td.completed_at != null
          && td.completed_at * MS >= todayStart && td.completed_at * MS <= todayEnd
        if (!dueInToday && !completedToday) return false
      } else if (quickFilter === 'overdue') {
        if (td.status === 'completed') return false
        if (td.due_at == null || td.due_at * MS >= todayStart) return false
      } else if (quickFilter === 'completed') {
        if (td.status !== 'completed') return false
      }

      if (filters.status) {
        const statuses = Array.isArray(filters.status) ? filters.status : [filters.status]
        if (!statuses.includes(td.status)) return false
      }
      if (filters.priority) {
        const prios = Array.isArray(filters.priority) ? filters.priority : [filters.priority]
        if (!prios.includes(td.priority)) return false
      }
      if (filters.dueFrom != null || filters.dueTo != null) {
        if (td.due_at == null) return false
        const dueMs = td.due_at * MS
        if (filters.dueFrom != null && dueMs < filters.dueFrom) return false
        if (filters.dueTo != null && dueMs > filters.dueTo) return false
      }
      return true
    })
  }, [todos, filters, quickFilter])

  const groups = useMemo(() => groupTodos(filtered, t), [filtered, t])

  // 隐藏已完成时移除历史已完成组；今日已完成折叠组保留（提供今日成就感）
  const visibleGroups = useMemo(() => {
    if (hideCompleted) return groups.filter(g => g.key !== 'completed')
    return groups
  }, [groups, hideCompleted])

  const todaySummary = useMemo(() => {
    const now = Date.now()
    const todayStart = startOfDayMs(now)
    const todayEnd = endOfDayMs(now)
    const todayTodos = todos.filter(td => {
      const dueInToday = td.due_at != null && td.due_at * MS >= todayStart && td.due_at * MS <= todayEnd
      const completedToday = td.status === 'completed' && td.completed_at != null
        && td.completed_at * MS >= todayStart && td.completed_at * MS <= todayEnd
      return dueInToday || completedToday
    })
    const done = todayTodos.filter(td => td.status === 'completed').length
    const pending = todayTodos.length - done
    return { total: todayTodos.length, done, pending }
  }, [todos])

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (filters.status) n++
    if (filters.priority) n++
    if (filters.dueFrom != null || filters.dueTo != null) n++
    return n
  }, [filters])

  const dueRangeValue = useMemo<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(() => {
    if (filters.dueFrom == null && filters.dueTo == null) return null
    return [
      filters.dueFrom != null ? dayjs(filters.dueFrom) : null,
      filters.dueTo != null ? dayjs(filters.dueTo) : null,
    ]
  }, [filters.dueFrom, filters.dueTo])

  const handleDueRangeChange = (vals: [dayjs.Dayjs | null, dayjs.Dayjs | null] | null) => {
    const [from, to] = vals || [null, null]
    onFiltersChange({
      dueFrom: from ? from.startOf('day').valueOf() : undefined,
      dueTo: to ? to.endOf('day').valueOf() : undefined,
    })
  }

  const renderGroup = (g: TodoGroup) => {
    const collapsed = isGroupCollapsed(g.key, g.defaultCollapsed)
    const isOverdue = g.variant === 'overdue'
    return (
      <div key={g.key} style={{ marginBottom: 4 }}>
        <div
          onClick={g.collapsible ? () => toggleGroup(g.key) : undefined}
          style={{
            fontSize: 11,
            color: isOverdue ? token.colorError : token.colorTextTertiary,
            fontWeight: 600,
            padding: '8px 4px 4px',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
            cursor: g.collapsible ? 'pointer' : 'default',
            userSelect: 'none',
          }}
        >
          {g.collapsible && (
            <CaretRightOutlined style={{
              fontSize: 9,
              transition: 'transform 0.15s',
              transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
              color: token.colorTextQuaternary,
            }} />
          )}
          {isOverdue && <span style={{ color: token.colorError, fontSize: 8 }}>●</span>}
          {g.label}
          <span style={{ color: token.colorTextQuaternary, fontWeight: 400 }}>
            {g.todos.length}
          </span>
        </div>
        {!collapsed && (
          <div style={{ borderRadius: 6, padding: '2px 0' }}>
            {g.todos.map(td => (
              <TodoItem
                key={td.id}
                todo={td}
                onEdit={onEditTodo}
                onComplete={onCompleteTodo}
                onDelete={onDeleteTodo}
                onUpdate={onUpdateTodo}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 顶部标题栏：今日摘要 + 筛选图标 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 12px 6px',
        flexShrink: 0,
      }}>
        <div style={{
          fontSize: 12,
          color: token.colorTextSecondary,
          fontWeight: 500,
        }}>
          {t('calendar.todaySummary', { total: todaySummary.total, done: todaySummary.done, pending: todaySummary.pending })}
        </div>
        <Badge count={activeFilterCount} size="small" offset={[-2, 2]} color={token.colorPrimary}>
          <Tooltip title={t('calendar.filter')}>
            <Button
              size="small"
              type="text"
              icon={<FilterOutlined style={{ fontSize: 14, color: activeFilterCount > 0 ? token.colorPrimary : token.colorTextTertiary }} />}
              onClick={() => setFilterOpen(v => !v)}
            />
          </Tooltip>
        </Badge>
      </div>

      {/* 快速筛选 chips + 隐藏已完成开关 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '0 12px 6px',
        flexShrink: 0,
      }}>
        <Segmented
          size="small"
          value={quickFilter}
          onChange={(v) => setQuickFilter(v as QuickFilter)}
          options={[
            { value: 'all', label: t('calendar.filterAll') },
            { value: 'today', label: t('calendar.quickFilterToday') },
            { value: 'overdue', label: t('calendar.quickFilterOverdue') },
            { value: 'completed', label: t('calendar.quickFilterCompleted') },
          ]}
        />
        <Tooltip title={hideCompleted ? t('calendar.showCompletedHint') : t('calendar.hideCompletedHint')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: token.colorTextTertiary, whiteSpace: 'nowrap' }}>
              {t('calendar.hideCompleted')}
            </span>
            <Switch
              size="small"
              checked={hideCompleted}
              onChange={(v) => setHideCompleted(v)}
            />
          </div>
        </Tooltip>
      </div>

      {/* 高级筛选面板：可折叠 */}
      {filterOpen && (
        <div style={{
          padding: '0 12px 8px',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <Select
              size="small"
              placeholder={t('calendar.filterStatus')}
              value={filters.status}
              onChange={(v) => onFiltersChange({ status: v })}
              allowClear
              style={{ flex: 1 }}
              options={[
                { value: 'pending', label: t('calendar.statusPending') },
                { value: 'in_progress', label: t('calendar.statusInProgress') },
                { value: 'completed', label: t('calendar.statusCompleted') },
              ]}
            />
            <Select
              size="small"
              placeholder={t('calendar.filterPriority')}
              value={filters.priority}
              onChange={(v) => onFiltersChange({ priority: v })}
              allowClear
              style={{ flex: 1 }}
              options={[
                { value: 'none', label: t('calendar.priorityNone') },
                { value: 'low', label: t('calendar.priorityLow') },
                { value: 'medium', label: t('calendar.priorityMedium') },
                { value: 'high', label: t('calendar.priorityHigh') },
              ]}
            />
          </div>
          <DatePicker.RangePicker
            size="small"
            value={dueRangeValue}
            onChange={(vals) => handleDueRangeChange(vals as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null)}
            style={{ width: '100%' }}
            placeholder={[t('calendar.filterDueFrom'), t('calendar.filterDueTo')]}
          />
        </div>
      )}

      {/* 中间列表：可滚动 */}
      <div style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '0 12px',
        position: 'relative',
      }}>
        <Spin spinning={loading} size="small" style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 2 }} />
        {visibleGroups.length === 0 ? (
          <div style={{ padding: '40px 0' }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('calendar.noTodos')} />
          </div>
        ) : (
          visibleGroups.map(renderGroup)
        )}
      </div>

      {/* 底部固定快速创建栏 */}
      <div style={{
        flexShrink: 0,
        padding: '8px 12px 12px',
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgLayout,
      }}>
        <QuickAddBar onSubmit={onQuickAddTodo} />
      </div>
    </div>
  )
}

export default TodoPanel
