import { useMemo } from 'react'
import {
  Spin, Statistic, Row, Col, Select, Button, Tag, Checkbox, Tooltip, Empty, Popconfirm, theme,
} from 'antd'
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type {
  CalendarTodo, CalendarTodoStats, TodoPriority, TodoStatus, TodoFilters,
} from '../../types/calendar'

const MS = 1000

const PRIORITY_COLOR: Record<TodoPriority, string> = {
  none: 'default',
  low: 'blue',
  medium: 'orange',
  high: 'red',
}

const STATUS_COLOR: Record<TodoStatus, string> = {
  pending: 'default',
  in_progress: 'processing',
  completed: 'success',
}

interface TodoPanelProps {
  todos: CalendarTodo[]
  stats: CalendarTodoStats | null
  loading: boolean
  filters: TodoFilters
  onFiltersChange: (filters: Partial<TodoFilters>) => void
  onCreateTodo: () => void
  onEditTodo: (todo: CalendarTodo) => void
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

const formatDueTime = (sec: number): string => {
  const d = new Date(sec * MS)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  if (sameDay) return hm
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `${hm} +1d`
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
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
    overdue: [], today: [], tomorrow: [], thisWeek: [], later: [], noDue: [], completed: [],
  }

  for (const td of todos) {
    if (td.status === 'completed') {
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
    { key: 'overdue', label: t('calendar.groupOverdue'), todos: groups.overdue },
    { key: 'today', label: t('calendar.groupToday'), todos: groups.today },
    { key: 'tomorrow', label: t('calendar.groupTomorrow'), todos: groups.tomorrow },
    { key: 'thisWeek', label: t('calendar.groupThisWeek'), todos: groups.thisWeek },
    { key: 'later', label: t('calendar.groupLater'), todos: groups.later },
    { key: 'noDue', label: t('calendar.groupNoDue'), todos: groups.noDue },
    { key: 'completed', label: t('calendar.groupCompleted'), todos: groups.completed },
  ].filter(g => g.todos.length > 0)
}

const TodoPanel: React.FC<TodoPanelProps> = ({
  todos, stats, loading, filters, onFiltersChange, onCreateTodo, onEditTodo, onCompleteTodo, onDeleteTodo,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

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
      return true
    })
  }, [todos, filters])

  const groups = useMemo(() => groupTodos(filtered, t), [filtered, t])

  return (
    <Spin spinning={loading}>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 顶部新建按钮 */}
        <Button type="primary" icon={<PlusOutlined />} block onClick={onCreateTodo}>
          {t('calendar.newTodo')}
        </Button>

        {/* 统计卡片 */}
        {stats && (
          <Row gutter={[8, 8]}>
            <Col span={8}>
              <Statistic title={t('calendar.statsTotal')} value={stats.total} valueStyle={{ fontSize: 16 }} />
            </Col>
            <Col span={8}>
              <Statistic title={t('calendar.statsPending')} value={stats.pending} valueStyle={{ fontSize: 16, color: token.colorTextSecondary }} />
            </Col>
            <Col span={8}>
              <Statistic title={t('calendar.statsCompleted')} value={stats.completed} valueStyle={{ fontSize: 16, color: token.colorSuccess }} />
            </Col>
            <Col span={8}>
              <Statistic title={t('calendar.statsOverdue')} value={stats.overdue} valueStyle={{ fontSize: 16, color: stats.overdue > 0 ? token.colorError : token.colorTextSecondary }} />
            </Col>
            <Col span={8}>
              <Statistic title={t('calendar.statsDueToday')} value={stats.due_today} valueStyle={{ fontSize: 16, color: stats.due_today > 0 ? token.colorWarning : token.colorTextSecondary }} />
            </Col>
            <Col span={8}>
              <Statistic title={t('calendar.statsCompletionRate')} value={stats.completion_rate} suffix="%" valueStyle={{ fontSize: 16 }} />
            </Col>
          </Row>
        )}

        {/* 筛选 */}
        <Row gutter={4}>
          <Col span={8}>
            <Select
              size="small"
              placeholder={t('calendar.filterStatus')}
              value={filters.status}
              onChange={(v) => onFiltersChange({ status: v })}
              allowClear
              style={{ width: '100%' }}
              options={[
                { value: 'pending', label: t('calendar.statusPending') },
                { value: 'in_progress', label: t('calendar.statusInProgress') },
                { value: 'completed', label: t('calendar.statusCompleted') },
              ]}
            />
          </Col>
          <Col span={8}>
            <Select
              size="small"
              placeholder={t('calendar.filterPriority')}
              value={filters.priority}
              onChange={(v) => onFiltersChange({ priority: v })}
              allowClear
              style={{ width: '100%' }}
              options={[
                { value: 'none', label: t('calendar.priorityNone') },
                { value: 'low', label: t('calendar.priorityLow') },
                { value: 'medium', label: t('calendar.priorityMedium') },
                { value: 'high', label: t('calendar.priorityHigh') },
              ]}
            />
          </Col>
          <Col span={8}>
            <Select
              size="small"
              placeholder={t('calendar.filterTag')}
              value={filters.tag}
              onChange={(v) => onFiltersChange({ tag: v })}
              allowClear
              style={{ width: '100%' }}
              options={allTags.map(tg => ({ value: tg, label: tg }))}
            />
          </Col>
        </Row>

        {/* 列表 */}
        {groups.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('calendar.noTodos')} />
        ) : (
          groups.map(g => (
            <div key={g.key}>
              <div style={{
                fontSize: 11,
                color: token.colorTextTertiary,
                fontWeight: 500,
                padding: '6px 0',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                marginBottom: 4,
              }}>
                {g.label} ({g.todos.length})
              </div>
              {g.todos.map(td => {
                const isCompleted = td.status === 'completed'
                const isOverdue = !isCompleted && td.due_at != null && td.due_at * MS < Date.now()
                return (
                  <div
                    key={td.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '6px 4px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      opacity: isCompleted ? 0.6 : 1,
                    }}
                    onClick={() => onEditTodo(td)}
                  >
                    <Checkbox
                      checked={isCompleted}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onCompleteTodo(td.id, e.target.checked)}
                      style={{ marginTop: 2 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13,
                        textDecoration: isCompleted ? 'line-through' : 'none',
                        color: token.colorText,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {td.title}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
                        {td.priority !== 'none' && (
                          <Tag color={PRIORITY_COLOR[td.priority]} style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                            {t(`calendar.priority${td.priority.charAt(0).toUpperCase() + td.priority.slice(1)}`)}
                          </Tag>
                        )}
                        {td.status !== 'pending' && (
                          <Tag color={STATUS_COLOR[td.status]} style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                            {t(`calendar.status${td.status === 'in_progress' ? 'InProgress' : td.status === 'completed' ? 'Completed' : 'Pending'}`)}
                          </Tag>
                        )}
                        {td.due_at != null && (
                          <span style={{ fontSize: 11, color: isOverdue ? token.colorError : token.colorTextTertiary }}>
                            {formatDueTime(td.due_at)}
                          </span>
                        )}
                        {(td.tags || []).slice(0, 2).map(tg => (
                          <Tag key={tg} style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>{tg}</Tag>
                        ))}
                        {(td.tags || []).length > 2 && (
                          <span style={{ fontSize: 10, color: token.colorTextTertiary }}>+{td.tags.length - 2}</span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 2, opacity: 0.6 }} onClick={(e) => e.stopPropagation()}>
                      <Tooltip title={t('common.edit')}>
                        <Button size="small" type="text" icon={<EditOutlined />} onClick={() => onEditTodo(td)} />
                      </Tooltip>
                      <Popconfirm
                        title={t('calendar.confirmDeleteTodo')}
                        onConfirm={() => onDeleteTodo(td.id)}
                        okText={t('common.confirm')}
                        cancelText={t('common.cancel')}
                      >
                        <Tooltip title={t('common.delete')}>
                          <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                        </Tooltip>
                      </Popconfirm>
                    </div>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </Spin>
  )
}

export default TodoPanel
