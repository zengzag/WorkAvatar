import { useState, useRef, useEffect, useCallback } from 'react'
import { Input, Tag, Checkbox, Tooltip, Popconfirm, Popover, DatePicker, Button, theme } from 'antd'
import { DeleteOutlined, EditOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { CalendarTodo, TodoPriority, TodoStatus, UpdateTodoInput } from '../../types/calendar'

const MS = 1000

const PRIORITY_BAR_COLOR: Record<TodoPriority, string> = {
  none: 'transparent',
  low: '#1677ff',
  medium: '#fa8c16',
  high: '#f5222d',
}

const STATUS_COLOR: Record<TodoStatus, string> = {
  pending: 'default',
  in_progress: 'processing',
  completed: 'success',
}

const PRIORITY_CYCLE: TodoPriority[] = ['none', 'low', 'medium', 'high']

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
  const isOverdue = !isCompleted && todo.due_at != null && todo.due_at * MS < Date.now()

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

  const cyclePriority = useCallback(async () => {
    const idx = PRIORITY_CYCLE.indexOf(todo.priority)
    const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length]
    await onUpdate({ id: todo.id, priority: next })
  }, [todo.id, todo.priority, onUpdate])

  const showActions = hovered || editingTitle || timePopoverOpen

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '6px 8px 6px 12px',
        borderRadius: 6,
        margin: '1px 0',
        cursor: 'default',
        background: hovered ? token.colorFillQuaternary : 'transparent',
        transition: 'background 0.15s',
      }}
    >
      {/* 优先级色条：左侧细条 */}
      <Tooltip title={t(`calendar.priority${todo.priority.charAt(0).toUpperCase() + todo.priority.slice(1)}`)}>
        <div
          onClick={(e) => { e.stopPropagation(); cyclePriority() }}
          style={{
            position: 'absolute',
            left: 2,
            top: 8,
            bottom: 8,
            width: 3,
            borderRadius: 2,
            cursor: 'pointer',
            background: PRIORITY_BAR_COLOR[todo.priority],
            opacity: todo.priority === 'none' ? 0 : 1,
            transition: 'opacity 0.15s',
          }}
        />
      </Tooltip>

      <Checkbox
        checked={isCompleted}
        onChange={(e) => onComplete(todo.id, e.target.checked)}
        style={{ marginTop: 2, flexShrink: 0 }}
      />

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
          {todo.status === 'in_progress' && (
            <Tag color={STATUS_COLOR.in_progress} style={{ margin: 0, fontSize: 10, lineHeight: '14px', padding: '0 4px', borderRadius: 3 }}>
              {t('calendar.statusInProgress')}
            </Tag>
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
                }}
              >
                {formatDueTime(todo.due_at)}
              </span>
            </Popover>
          )}

          {(todo.tags || []).slice(0, 2).map(tg => (
            <Tag key={tg} style={{ margin: 0, fontSize: 10, lineHeight: '14px', padding: '0 4px', borderRadius: 3 }}>{tg}</Tag>
          ))}
          {(todo.tags || []).length > 2 && (
            <span style={{ fontSize: 10, color: token.colorTextTertiary }}>+{todo.tags.length - 2}</span>
          )}

          {isCompleted && todo.completed_at != null && (
            <span style={{ fontSize: 10, color: token.colorTextQuaternary }}>
              {new Date(todo.completed_at * MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
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
