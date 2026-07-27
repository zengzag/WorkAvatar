import { useEffect, useMemo, useState } from 'react'
import {
  Modal, Form, Input, DatePicker, TimePicker, Select, Switch, InputNumber, Row, Col, Button, Popconfirm, message, theme,
} from 'antd'
import { DeleteOutlined, DownOutlined, RightOutlined } from '@ant-design/icons'
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
  existingTags?: string[]
  onClose: () => void
  onSubmit: (input: CreateTodoInput | UpdateTodoInput) => Promise<any>
  onDelete?: (id: string) => Promise<any>
}

const REMINDER_OPTIONS = [0, 5, 15, 30, 60, 120, 1440, 2880]
const toDisplay = (v: number) => Math.abs(v)
const toStore = (v: number) => -v

const compactItem: React.CSSProperties = { marginBottom: 12 }

const TodoFormModal: React.FC<TodoFormModalProps> = ({
  open, mode, todo, settings, existingTags = [], onClose, onSubmit, onDelete,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [form] = Form.useForm()
  const isEdit = mode === 'edit'
  // 创建与编辑均默认折叠非主题/描述字段，展开内容置于底部
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (open) setExpanded(false)
  }, [open])

  const initialValues = useMemo(() => {
    if (isEdit && todo) {
      const dueMs = todo.due_at ? todo.due_at * MS : null
      return {
        title: todo.title,
        description: todo.description || '',
        dueDate: dueMs ? dayjs(dueMs) : null,
        dueTime: dueMs ? dayjs(dueMs) : null,
        hasDue: todo.due_at != null,
        priority: todo.priority,
        status: todo.status,
        tags: todo.tags || [],
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
      dueTime: dayjs(endOfTodayMs),
      hasDue: true,
      priority: 'none' as TodoPriority,
      status: 'pending' as TodoStatus,
      tags: [],
      recurrenceFreq: 'none',
      recurrenceInterval: 1,
      reminders: [],
    }
  }, [isEdit, todo, settings])

  useEffect(() => {
    // 显式 setFieldsValue 而非 resetFields：后者会回到 Form 挂载时捕获的 initialValues，
    // 在 destroyOnHidden 动画期间切换不同 TODO 时会显示上一次的内容。
    if (open) form.setFieldsValue(initialValues)
  }, [open, form, initialValues])

  const hasDue = Form.useWatch('hasDue', form)
  const recurrenceFreq = Form.useWatch('recurrenceFreq', form)

  const handleFinish = async (values: any) => {
    let dueAt: number | null = null
    if (values.hasDue && values.dueDate) {
      const timePart = values.dueTime ? { hour: values.dueTime.hour(), minute: values.dueTime.minute() } : { hour: 23, minute: 59 }
      const dueMs = values.dueDate.hour(timePart.hour).minute(timePart.minute).second(0).millisecond(0).valueOf()
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
      tags: values.tags || [],
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
    if (m < 60) return `${m} ${t('calendar.minutesBefore')}`
    if (m < 1440) return `${Math.floor(m / 60)} ${t('calendar.hoursBefore')}`
    return `${Math.floor(m / 1440)} ${t('calendar.daysBefore')}`
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
      width={480}
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
                <Button danger icon={<DeleteOutlined />}>{t('common.delete')}</Button>
              </Popconfirm>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <CancelBtn />
            <OkBtn />
          </div>
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
        <Form.Item name="title" label={t('calendar.todoTitle')} rules={[{ required: true, message: t('calendar.todoTitlePlaceholder') }]} style={compactItem}>
          <Input placeholder={t('calendar.todoTitlePlaceholder')} autoFocus size="middle" />
        </Form.Item>

        <Form.Item name="description" label={t('calendar.description')} style={compactItem}>
          <Input.TextArea rows={4} size="middle" placeholder={t('calendar.descriptionPlaceholder')} />
        </Form.Item>

        {!expanded && (
          <Button
            type="link"
            size="small"
            onClick={() => setExpanded(true)}
            icon={<RightOutlined style={{ fontSize: 10 }} />}
            style={{ padding: '0 0 12px', height: 'auto', color: token.colorTextTertiary, fontSize: 12 }}
          >
            {t('calendar.moreOptions')}
          </Button>
        )}

        {expanded && (
          <>
            <Button
              type="link"
              size="small"
              onClick={() => setExpanded(false)}
              icon={<DownOutlined style={{ fontSize: 10 }} />}
              style={{ padding: '0 0 12px', height: 'auto', color: token.colorTextTertiary, fontSize: 12 }}
            >
              {t('calendar.lessOptions')}
            </Button>

            <Row gutter={8}>
              <Col>
                <Form.Item name="hasDue" label={t('calendar.dueDate')} valuePropName="checked" style={compactItem}>
                  <Switch />
                </Form.Item>
              </Col>
            </Row>

            {hasDue && (
              <Row gutter={8}>
                <Col span={12}>
                  <Form.Item name="dueDate" label={t('calendar.dueDate')} style={compactItem}>
                    <DatePicker style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="dueTime" label={t('calendar.dueTime')} style={compactItem}>
                    <TimePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
            )}

            <Row gutter={8}>
              <Col span={8}>
                <Form.Item name="priority" label={t('calendar.priority')} style={compactItem}>
                  <Select
                    options={[
                      { value: 'none', label: t('calendar.priorityNone') },
                      { value: 'low', label: t('calendar.priorityLow') },
                      { value: 'medium', label: t('calendar.priorityMedium') },
                      { value: 'high', label: t('calendar.priorityHigh') },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="status" label={t('calendar.status')} style={compactItem}>
                  <Select
                    options={[
                      { value: 'pending', label: t('calendar.statusPending') },
                      { value: 'in_progress', label: t('calendar.statusInProgress') },
                      { value: 'completed', label: t('calendar.statusCompleted') },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="recurrenceFreq" label={t('calendar.repeat')} style={compactItem}>
                  <Select
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
            </Row>

            {recurrenceFreq && recurrenceFreq !== 'none' && (
              <Form.Item name="recurrenceInterval" label={t('calendar.repeatInterval')} style={compactItem}>
                <InputNumber min={1} max={99} style={{ width: '100%' }} />
              </Form.Item>
            )}

            <Row gutter={8}>
              <Col span={12}>
                <Form.Item name="reminders" label={t('calendar.reminders')} style={compactItem}>
                  <Select
                    mode="multiple"
                    placeholder={t('calendar.addReminder')}
                    options={REMINDER_OPTIONS.map((m) => ({ value: m, label: reminderLabel(m) }))}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="tags" label={t('calendar.tags')} style={compactItem}>
                  <Select
                    mode="tags"
                    placeholder={t('calendar.tagsPlaceholder')}
                    tokenSeparators={[',', ' ']}
                    options={existingTags.map(tag => ({ value: tag, label: tag }))}
                  />
                </Form.Item>
              </Col>
            </Row>
          </>
        )}
      </Form>
    </Modal>
  )
}

export default TodoFormModal