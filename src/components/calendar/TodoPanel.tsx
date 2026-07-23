import { useMemo, useState } from 'react'
import { Spin, Select, Empty, Tooltip, Badge, Button, DatePicker, theme } from 'antd'
import { FilterOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'
import type {
  CalendarTodo, TodoFilters,
  CreateTodoInput, UpdateTodoInput,
} from '../../types/calendar'
import QuickAddBar from './QuickAddBar'
import TodoItem from './TodoItem'

const MS = 1000

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

interface TodoGroup {
  key: string
  label: string
  todos: CalendarTodo[]
}

const groupTodos = (todos: CalendarTodo[], t: (k: string) => string): TodoGroup[] => {
  const now = Date.now()
  const todayStart = startOfDayMs(now)
  const todayEnd = endOfDayMs(now)
  const tomorrowStart = todayStart + 86400 * MS
  const tomorrowEnd = tomorrowStart + 86400 * MS - 1
  const weekStart = startOfWeekMs(now)
  const weekEnd = weekStart + 7 * 86400 * MS - 1

  const groups: Record<string, CalendarTodo[]> = {
    today: [], tomorrow: [], thisWeek: [], later: [], noDue: [], overdue: [], completed: [],
  }

  for (const td of todos) {
    if (td.status === 'completed') {
      if (td.due_at != null) {
        const dueMs = td.due_at * MS
        if (dueMs >= todayStart && dueMs <= todayEnd) {
          groups.today.push(td)
          continue
        }
      }
      groups.completed.push(td)
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
    { key: 'today', label: t('calendar.groupToday'), todos: groups.today },
    { key: 'tomorrow', label: t('calendar.groupTomorrow'), todos: groups.tomorrow },
    { key: 'thisWeek', label: t('calendar.groupThisWeek'), todos: groups.thisWeek },
    { key: 'later', label: t('calendar.groupLater'), todos: groups.later },
    { key: 'noDue', label: t('calendar.groupNoDue'), todos: groups.noDue },
    { key: 'overdue', label: t('calendar.groupOverdue'), todos: groups.overdue },
    { key: 'completed', label: t('calendar.groupCompleted'), todos: groups.completed },
  ].filter(g => g.todos.length > 0)
}

const TodoPanel: React.FC<TodoPanelProps> = ({
  todos, loading, filters, onFiltersChange,
  onQuickAddTodo, onEditTodo, onUpdateTodo, onCompleteTodo, onDeleteTodo,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [filterOpen, setFilterOpen] = useState(false)

  const allTags = useMemo(() => {
    const s = new Set<string>()
    todos.forEach(td => (td.tags || []).forEach(tg => s.add(tg)))
    return Array.from(s)
  }, [todos])

  const filtered = useMemo(() => {
    return todos.filter(td => {
      if (filters.status) {
        const statuses = Array.isArray(filters.status) ? filters.status : [filters.status]
        if (!statuses.includes(td.status)) return false
      }
      if (filters.priority) {
        const prios = Array.isArray(filters.priority) ? filters.priority : [filters.priority]
        if (!prios.includes(td.priority)) return false
      }
      if (filters.tag && !(td.tags || []).includes(filters.tag)) return false
      if (filters.dueFrom != null || filters.dueTo != null) {
        if (td.due_at == null) return false
        const dueMs = td.due_at * MS
        if (filters.dueFrom != null && dueMs < filters.dueFrom) return false
        if (filters.dueTo != null && dueMs > filters.dueTo) return false
      }
      return true
    })
  }, [todos, filters])

  const groups = useMemo(() => groupTodos(filtered, t), [filtered, t])

  const todaySummary = useMemo(() => {
    const now = Date.now()
    const todayStart = startOfDayMs(now)
    const todayEnd = endOfDayMs(now)
    const todayTodos = todos.filter(td => {
      if (td.due_at == null) return false
      const dueMs = td.due_at * MS
      return dueMs >= todayStart && dueMs <= todayEnd
    })
    const done = todayTodos.filter(td => td.status === 'completed').length
    const pending = todayTodos.length - done
    return { total: todayTodos.length, done, pending }
  }, [todos])

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (filters.status) n++
    if (filters.priority) n++
    if (filters.tag) n++
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

      {/* 筛选面板：可折叠 */}
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
            <Select
              size="small"
              placeholder={t('calendar.filterTag')}
              value={filters.tag}
              onChange={(v) => onFiltersChange({ tag: v })}
              allowClear
              style={{ flex: 1 }}
              options={allTags.map(tg => ({ value: tg, label: tg }))}
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
        {groups.length === 0 ? (
          <div style={{ padding: '40px 0' }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('calendar.noTodos')} />
          </div>
        ) : (
          groups.map(g => (
            <div key={g.key} style={{ marginBottom: 4 }}>
              <div style={{
                fontSize: 11,
                color: g.key === 'overdue' ? token.colorError : token.colorTextTertiary,
                fontWeight: 600,
                padding: '8px 4px 4px',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                letterSpacing: 0.3,
                textTransform: 'uppercase',
              }}>
                {g.key === 'overdue' && <span style={{ color: token.colorError, fontSize: 8 }}>●</span>}
                {g.label}
                <span style={{ color: token.colorTextQuaternary, fontWeight: 400 }}>
                  {g.todos.length}
                </span>
              </div>
              <div style={{
                borderRadius: 6,
                padding: '2px 0',
              }}>
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
            </div>
          ))
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
