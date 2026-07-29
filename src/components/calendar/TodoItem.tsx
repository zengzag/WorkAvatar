import { useState, useRef, useEffect, useCallback } from 'react'
import { Input, Tag, Checkbox, Tooltip, Popconfirm, Popover, DatePicker, Button, ConfigProvider, theme } from 'antd'
import { DeleteOutlined, EditOutlined, ClockCircleOutlined, WarningFilled } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { CalendarTodo, TodoPriority, TodoStatus, UpdateTodoInput } from '../../types/calendar'

const MS = 1000

/** 优先级对应的复选框颜色（饱和度略低，弱化视觉干扰）；none 使用主题默认色 */
const PRIORITY_CHECKBOX_COLOR: Record<TodoPriority, string | undefined> = {
  none: undefined,
  low: '#5b8def',
  medium: '#e8a04b',
  high: '#e57373',
}

const STATUS_COLOR: Record<TodoStatus, string> = {
  pending: 'default',
  in_progress: 'processing',
  completed: 'success',
}

/** 状态循环顺序：pending → in_progress → completed → pending */
const STATUS_CYCLE: TodoStatus[] = ['pending', 'in_progress', 'completed']

const nextStatus = (current: TodoStatus): TodoStatus => {
  const idx = STATUS_CYCLE.indexOf(current)
  return STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]
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

/** 计算逾期时长的人类可读描述 */
const formatOverdueDuration = (dueSec: number): string => {
  const diffMs = Date.now() - dueSec * MS
  if (diffMs < 0) return ''
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d`
}

/** 格式化时间戳为 MM-DD HH:mm 或 HH:mm */
const formatTimestamp = (sec: number): string => {
  const d = new Date(sec * MS)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  if (sameDay) return hm
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

interface TodoItemProps {
  todo: CalendarTodo
  onEdit: (todo: CalendarTodo) => void
  onComplete: (id: string, completed: boolean) => void
  onDelete: (id: string) => void
  onUpdate: (input: UpdateTodoInput) => Promise<any>
}

const TodoItem: React.FC<TodoItemProps> = ({ todo, onEdit, onComplete, onDelete, onUpdate }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(todo.title)
  const [timePopoverOpen, setTimePopoverOpen] = useState(false)
  const [timeDraft, setTimeDraft] = useState<dayjs.Dayjs | null>(todo.due_at ? dayjs(todo.due_at * MS) : null)
  const titleInputRef = useRef<any>(null)

  useEffect(() => {
    setTitleDraft(todo.title)
    setTimeDraft(todo.due_at ? dayjs(todo.due_at * MS) : null)
  }, [todo.title, todo.due_at])

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }
  }, [editingTitle])

  const isCompleted = todo.status === 'completed'
  const isInProgress = todo.status === 'in_progress'
  const isOverdue = !isCompleted && todo.due_at != null && todo.due_at * MS < Date.now()
  const overdueDuration = isOverdue ? formatOverdueDuration(todo.due_at!) : ''

  const commitTitle = useCallback(async () => {
    const trimmed = titleDraft.trim()
    if (trimmed && trimmed !== todo.title) {
      await onUpdate({ id: todo.id, title: trimmed })
    } else {
      setTitleDraft(todo.title)
    }
    setEditingTitle(false)
  }, [titleDraft, todo.id, todo.title, onUpdate])

  const commitTime = useCallback(async (value: dayjs.Dayjs | null) => {
    const newDueAt = value ? Math.floor(value.valueOf() / MS) : null
    if (newDueAt !== todo.due_at) {
      await onUpdate({ id: todo.id, due_at: newDueAt })
    }
    setTimePopoverOpen(false)
  }, [todo.id, todo.due_at, onUpdate])

  /** 三态循环：pending → in_progress → completed → pending
   *  - pending → in_progress：直接 updateTodo
   *  - in_progress → completed：走 completeTodo（处理重复 TODO 推进）
   *  - completed → pending：走 completeTodo(false) */
  const cycleStatus = useCallback(async () => {
    const next = nextStatus(todo.status)
    if (next === 'in_progress') {
      await onUpdate({ id: todo.id, status: 'in_progress' })
    } else if (next === 'completed') {
      onComplete(todo.id, true)
    } else {
      onComplete(todo.id, false)
    }
  }, [todo.id, todo.status, onUpdate, onComplete])

  const showActions = hovered || editingTitle || timePopoverOpen

  // 未完成时：复选框边框按优先级着色（饱和度略低）；完成后统一使用主题默认色
  const priorityColor = isCompleted ? undefined : PRIORITY_CHECKBOX_COLOR[todo.priority]

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 6,
        margin: '1px 0',
        cursor: 'default',
        // 逾期项：左侧红色细条 + 极淡红底色
        background: isOverdue
          ? `linear-gradient(90deg, ${token.colorErrorBg} 0%, transparent 30%)`
          : hovered ? token.colorFillQuaternary : 'transparent',
        transition: 'background 0.15s',
      }}
    >
      {/* 三态复选框：pending（空）→ in_progress（indeterminate 横线）→ completed（对勾）
          未完成时边框颜色由优先级决定；完成后统一主题色 */}
      <ConfigProvider theme={priorityColor ? {
        components: {
          Checkbox: {
            colorPrimary: priorityColor,
            colorBorder: priorityColor,
          },
        },
      } : undefined}>
        <Tooltip title={t('calendar.clickToCycleStatus')} mouseEnterDelay={0.8}>
          <Checkbox
            checked={isCompleted}
            indeterminate={isInProgress}
            onChange={cycleStatus}
            style={{ marginTop: 2, flexShrink: 0 }}
          />
        </Tooltip>
      </ConfigProvider>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* 标题：点击行内编辑 */}
        {editingTitle ? (
          <Input
            ref={titleInputRef}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onPressEnter={commitTitle}
            onKeyDown={(e) => { if (e.key === 'Escape') { setTitleDraft(todo.title); setEditingTitle(false) } }}
            onBlur={commitTitle}
            size="small"
            style={{ padding: '0 6px', fontSize: 13 }}
          />
        ) : (
          <div
            onClick={() => setEditingTitle(true)}
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              textDecoration: isCompleted ? 'line-through' : 'none',
              color: isCompleted ? token.colorTextTertiary : token.colorText,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              cursor: 'text',
            }}
          >
            {todo.title}
          </div>
        )}

        {/* 元信息行 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
          {isInProgress && (
            <Tag color={STATUS_COLOR.in_progress} style={{ margin: 0, fontSize: 10, lineHeight: '14px', padding: '0 4px', borderRadius: 3 }}>
              {t('calendar.statusInProgress')}
            </Tag>
          )}

          {/* 逾期标记：红色警告图标 + 逾期时长 */}
          {isOverdue && (
            <Tooltip title={t('calendar.overdueHint')}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                fontSize: 10,
                lineHeight: '14px',
                color: token.colorError,
                fontWeight: 500,
                background: token.colorErrorBg,
                padding: '0 4px',
                borderRadius: 3,
              }}>
                <WarningFilled style={{ fontSize: 9 }} />
                {t('calendar.overdue')} {overdueDuration}
              </span>
            </Tooltip>
          )}

          {/* 截止时间：点击行内编辑 */}
          {todo.due_at != null && (
            <Popover
              open={timePopoverOpen}
              onOpenChange={setTimePopoverOpen}
              trigger="click"
              placement="bottomLeft"
              content={
                <DatePicker
                  showTime={{ format: 'HH:mm', minuteStep: 5 }}
                  format="YYYY-MM-DD HH:mm"
                  value={timeDraft}
                  onChange={(v) => setTimeDraft(v)}
                  onOk={(v) => commitTime(v as dayjs.Dayjs)}
                  allowClear
                  size="small"
                  style={{ width: '100%' }}
                />
              }
            >
              <span
                onClick={(e) => e.stopPropagation()}
                style={{
                  fontSize: 11,
                  color: isOverdue ? token.colorError : token.colorTextTertiary,
                  cursor: 'pointer',
                  lineHeight: '14px',
                  fontWeight: isOverdue ? 500 : 400,
                }}
              >
                {formatDueTime(todo.due_at)}
              </span>
            </Popover>
          )}

          {/* 进行中：显示进入时间 */}
          {isInProgress && todo.started_at != null && (
            <Tooltip title={t('calendar.startedAtHint')}>
              <span style={{ fontSize: 10, color: token.colorTextQuaternary, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <ClockCircleOutlined style={{ fontSize: 9 }} />
                {formatTimestamp(todo.started_at)}
              </span>
            </Tooltip>
          )}

          {/* 已完成：显示完成时间 */}
          {isCompleted && todo.completed_at != null && (
            <Tooltip title={t('calendar.completedAtHint')}>
              <span style={{ fontSize: 10, color: token.colorTextQuaternary, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <ClockCircleOutlined style={{ fontSize: 9 }} />
                {formatTimestamp(todo.completed_at)}
              </span>
            </Tooltip>
          )}
        </div>
      </div>

      {/* 操作按钮：hover 时显示 */}
      <div style={{
        display: 'flex',
        gap: 2,
        flexShrink: 0,
        opacity: showActions ? 1 : 0,
        transition: 'opacity 0.15s',
        pointerEvents: showActions ? 'auto' : 'none',
      }}>
        <Tooltip title={t('calendar.editDetail')}>
          <Button size="small" type="text" icon={<EditOutlined style={{ fontSize: 12 }} />} onClick={() => onEdit(todo)} />
        </Tooltip>
        <Popconfirm
          title={t('calendar.confirmDeleteTodo')}
          onConfirm={() => onDelete(todo.id)}
          okText={t('common.confirm')}
          cancelText={t('common.cancel')}
        >
          <Tooltip title={t('common.delete')}>
            <Button size="small" type="text" danger icon={<DeleteOutlined style={{ fontSize: 12 }} />} />
          </Tooltip>
        </Popconfirm>
      </div>
    </div>
  )
}

export default TodoItem
