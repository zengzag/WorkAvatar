import { useEffect, useMemo } from 'react'
import {
  Modal, Form, Input, DatePicker, Select, InputNumber, Row, Col, Button, Popconfirm, message, theme, Space, Checkbox, AutoComplete,
} from 'antd'
import { DeleteOutlined, BellOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type {
  CalendarTodo, CalendarSettings, CreateTodoInput, UpdateTodoInput,
  TodoPriority, TodoStatus, RecurrenceRule,
} from '../../types/calendar'

const MS = 1000

export type TodoFormMode = 'create' | 'edit'

interface TodoFormModalProps {
  open: boolean
  mode: TodoFormMode
  todo?: CalendarTodo | null
  settings?: CalendarSettings | null
  onClose: () => void
  onSubmit: (input: CreateTodoInput | UpdateTodoInput) => Promise<any>
  onDelete?: (id: string) => Promise<any>
}

const REMINDER_OPTIONS = [0, 5, 15, 30, 60, 120, 1440, 2880]
const toDisplay = (v: number) => Math.abs(v)
const toStore = (v: number) => -v

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2)
  const m = i % 2 === 0 ? '00' : '30'
  const value = `${String(h).padStart(2, '0')}:${m}`
  return { value, label: value }
})

const TodoFormModal: React.FC<TodoFormModalProps> = ({
  open, mode, todo, settings, onClose, onSubmit, onDelete,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [form] = Form.useForm()
  const isEdit = mode === 'edit'

  const initialValues = useMemo(() => {
    if (isEdit && todo) {
      const dueMs = todo.due_at ? todo.due_at * MS : null
      return {
        title: todo.title,
        description: todo.description || '',
        dueDate: dueMs ? dayjs(dueMs) : null,
        dueTime: dueMs ? dayjs(dueMs).format('HH:mm') : null,
        hasDue: todo.due_at != null,
        priority: todo.priority,
        status: todo.status,
        recurrenceFreq: todo.recurrence_rule?.freq || 'none',
        recurrenceInterval: todo.recurrence_rule?.interval || 1,
        reminders: (todo.reminders?.length ? todo.reminders : (settings?.default_todo_reminders || [])).map(toDisplay),
      }
    }
    const now = new Date()
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0, 0)
    const endOfTodayMs = endOfToday.getTime()
    return {
      title: '',
      description: '',
      dueDate: dayjs(endOfTodayMs),
      dueTime: dayjs(endOfTodayMs).format('HH:mm'),
      hasDue: true,
      priority: 'none' as TodoPriority,
      status: 'pending' as TodoStatus,
      recurrenceFreq: 'none',
      recurrenceInterval: 1,
      reminders: [],
    }
  }, [isEdit, todo, settings])

  useEffect(() => {
    if (open) form.setFieldsValue(initialValues)
  }, [open, form, initialValues])

  const hasDue = Form.useWatch('hasDue', form)
  const recurrenceFreq = Form.useWatch('recurrenceFreq', form)

  const handleFinish = async (values: any) => {
    let dueAt: number | null = null
    if (values.hasDue && values.dueDate) {
      const [th, tm] = (values.dueTime || '23:59').split(':').map(Number)
      const dueMs = values.dueDate.hour(th || 23).minute(tm || 59).second(0).millisecond(0).valueOf()
      dueAt = Math.floor(dueMs / MS)
    }

    let recurrenceRule: RecurrenceRule | null = null
    if (values.recurrenceFreq && values.recurrenceFreq !== 'none') {
      recurrenceRule = {
        freq: values.recurrenceFreq,
        interval: values.recurrenceInterval || 1,
      }
    }

    const payload: CreateTodoInput | UpdateTodoInput = {
      title: values.title,
      description: values.description || '',
      due_at: dueAt,
      priority: values.priority,
      status: values.status,
      recurrence_rule: recurrenceRule,
      reminders: (values.reminders || []).map(toStore),
    }
    if (isEdit) (payload as UpdateTodoInput).id = todo!.id

    try {
      const result = await onSubmit(payload)
      if (result && !result.error) {
        message.success(isEdit ? t('calendar.editTodo') : t('calendar.newTodo'))
        onClose()
      } else if (result?.error) {
        message.error(result.error)
      }
    } catch (err: any) {
      message.error(err?.message || 'Failed to save todo')
    }
  }

  const reminderLabel = (m: number): string => {
    if (m === 0) return t('calendar.atStart')
    if (m < 60) return `${m}${t('calendar.minutesBefore')}`
    if (m < 1440) return `${Math.floor(m / 60)}${t('calendar.hoursBefore')}`
    return `${Math.floor(m / 1440)}${t('calendar.daysBefore')}`
  }

  const handleDelete = async () => {
    if (!todo || !onDelete) return
    try {
      const result = await onDelete(todo.id)
      if (result && !result.error) {
        message.success(t('calendar.deleteTodo'))
        onClose()
      } else if (result?.error) {
        message.error(result.error)
      }
    } catch (err: any) {
      message.error(err?.message || 'Failed to delete todo')
    }
  }

  const itemMb: React.CSSProperties = { marginBottom: 8 }

  return (
    <Modal
      open={open}
      title={isEdit ? t('calendar.editTodo') : t('calendar.newTodo')}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      onCancel={onClose}
      onOk={() => form.submit()}
      destroyOnHidden
      centered
      width={520}
      styles={{
        header: { paddingLeft: 16, paddingRight: 16, paddingBottom: 2, paddingTop: 12 },
        body: { padding: '4px 16px' },
        footer: { paddingLeft: 16, paddingRight: 16, paddingBottom: 10, paddingTop: 0, marginTop: 0 },
      }}
      footer={(_, { OkBtn, CancelBtn }) => (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            {isEdit && onDelete && (
              <Popconfirm
                title={t('calendar.deleteTodoConfirm')}
                onConfirm={handleDelete}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
                okButtonProps={{ danger: true }}
              >
                <Button danger icon={<DeleteOutlined />} size="small">{t('common.delete')}</Button>
              </Popconfirm>
            )}
          </div>
          <Space size={8}>
            <CancelBtn />
            <OkBtn />
          </Space>
        </div>
      )}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={initialValues}
        onFinish={handleFinish}
        size="small"
      >
        {/* 标题 */}
        <Form.Item name="title" rules={[{ required: true, message: t('calendar.todoTitlePlaceholder') }]} style={itemMb}>
          <Input
            placeholder={t('calendar.todoTitle')}
            autoFocus
            size="middle"
            style={{ fontSize: 15, fontWeight: 500 }}
          />
        </Form.Item>

        {/* 描述 */}
        <Form.Item name="description" style={itemMb}>
          <Input.TextArea
            size="middle"
            placeholder={t('calendar.description')}
            autoSize={{ minRows: 3, maxRows: 6 }}
          />
        </Form.Item>

        {/* 截止时间 + 提醒：同一行 */}
        <Row gutter={8} align="middle" style={{ marginBottom: 8 }}>
          <Col flex="0 0 auto">
            <Form.Item name="hasDue" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>{t('calendar.dueDate')}</Checkbox>
            </Form.Item>
          </Col>
          {hasDue && (
            <>
              <Col flex="1 1 80px">
                <Form.Item name="dueDate" style={{ marginBottom: 0 }}>
                  <DatePicker style={{ width: '100%' }} size="middle" placeholder={t('calendar.dueDate')} />
                </Form.Item>
              </Col>
              <Col flex="0 0 80px">
                <Form.Item name="dueTime" style={{ marginBottom: 0 }}>
                  <AutoComplete
                    options={TIME_OPTIONS}
                    style={{ width: '100%' }}
                    size="middle"
                    placeholder={t('calendar.dueTime')}
                    filterOption={() => true}
                  />
                </Form.Item>
              </Col>
            </>
          )}
          <Col flex="1 1 80px">
            <Form.Item name="reminders" style={{ marginBottom: 0 }}>
              <Select
                mode="multiple"
                size="middle"
                maxTagCount="responsive"
                placeholder={t('calendar.addReminder')}
                suffixIcon={<BellOutlined style={{ color: token.colorTextTertiary }} />}
                options={REMINDER_OPTIONS.map((m) => ({ value: m, label: reminderLabel(m) }))}
              />
            </Form.Item>
          </Col>
        </Row>

        {/* 优先级 / 状态 / 重复 / 间隔（选重复时） */}
        <Row gutter={8} align="middle" style={{ marginBottom: 8 }}>
          <Col flex="0 0 110px">
            <Form.Item name="priority" style={{ marginBottom: 0 }}>
              <Select
                size="middle"
                placeholder={t('calendar.priority')}
                optionLabelProp="label"
                options={[
                  { value: 'none', label: <span style={{ display: 'inline-flex', alignItems: 'center' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: token.colorTextQuaternary, display: 'inline-block', marginRight: 4 }} />{t('calendar.priorityNone')}</span> },
                  { value: 'low', label: <span style={{ display: 'inline-flex', alignItems: 'center' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#1677ff', display: 'inline-block', marginRight: 4 }} />{t('calendar.priorityLow')}</span> },
                  { value: 'medium', label: <span style={{ display: 'inline-flex', alignItems: 'center' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#fa8c16', display: 'inline-block', marginRight: 4 }} />{t('calendar.priorityMedium')}</span> },
                  { value: 'high', label: <span style={{ display: 'inline-flex', alignItems: 'center' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f5222d', display: 'inline-block', marginRight: 4 }} />{t('calendar.priorityHigh')}</span> },
                ]}
              />
            </Form.Item>
          </Col>
          <Col flex="0 0 110px">
            <Form.Item name="status" style={{ marginBottom: 0 }}>
              <Select
                size="middle"
                placeholder={t('calendar.status')}
                options={[
                  { value: 'pending', label: t('calendar.statusPending') },
                  { value: 'in_progress', label: t('calendar.statusInProgress') },
                  { value: 'completed', label: t('calendar.statusCompleted') },
                ]}
              />
            </Form.Item>
          </Col>
          <Col flex="1 1 0">
            <Form.Item name="recurrenceFreq" style={{ marginBottom: 0 }}>
              <Select
                size="middle"
                placeholder={t('calendar.repeat')}
                options={[
                  { value: 'none', label: t('calendar.repeatNone') },
                  { value: 'daily', label: t('calendar.repeatDaily') },
                  { value: 'weekdays', label: t('calendar.repeatWeekdays') },
                  { value: 'weekly', label: t('calendar.repeatWeekly') },
                  { value: 'monthly', label: t('calendar.repeatMonthly') },
                  { value: 'yearly', label: t('calendar.repeatYearly') },
                ]}
              />
            </Form.Item>
          </Col>
          {recurrenceFreq && recurrenceFreq !== 'none' && (
            <Col flex="0 0 60px">
              <Form.Item name="recurrenceInterval" style={{ marginBottom: 0 }}>
                <InputNumber min={1} max={99} style={{ width: '100%' }} size="middle" placeholder={t('calendar.repeatInterval')} />
              </Form.Item>
            </Col>
          )}
        </Row>

        {/* 时间追踪 */}
        {isEdit && (todo?.started_at || todo?.completed_at) && (
          <div style={{
            fontSize: 12,
            color: token.colorTextTertiary,
            marginTop: 4,
            paddingTop: 8,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            gap: 16
          }}>
            {todo?.started_at && (
              <span>{t('calendar.startedAt')}: {dayjs(todo.started_at * MS).format('YYYY-MM-DD HH:mm')}</span>
            )}
            {todo?.completed_at && (
              <span>{t('calendar.completedAt')}: {dayjs(todo.completed_at * MS).format('YYYY-MM-DD HH:mm')}</span>
            )}
          </div>
        )}
      </Form>
    </Modal>
  )
}

export default TodoFormModal
