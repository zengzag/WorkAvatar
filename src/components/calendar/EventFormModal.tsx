import { useEffect, useMemo } from 'react'
import {
  Modal, Form, Input, Checkbox, DatePicker, Select, InputNumber, Row, Col, Button, Popconfirm, message, theme, Space, AutoComplete,
} from 'antd'
import { DeleteOutlined, BellOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type {
  CalendarEventInstance, CalendarSettings, CreateEventInput, UpdateEventInput,
  EventColor, RecurrenceRule,
} from '../../types/calendar'

const MS = 1000

export type EventFormMode = 'create' | 'edit'

interface EventFormModalProps {
  open: boolean
  mode: EventFormMode
  event?: CalendarEventInstance | null
  defaultStartAt?: number
  defaultEndAt?: number
  settings?: CalendarSettings | null
  onClose: () => void
  onSubmit: (input: CreateEventInput | UpdateEventInput) => Promise<any>
  onDelete?: (id: string) => Promise<any>
}

const COLOR_OPTIONS: EventColor[] = ['default', 'blue', 'green', 'orange', 'red', 'purple']
const COLOR_HEX: Record<EventColor, string> = {
  default: '#1677ff', blue: '#1677ff', green: '#52c41a', orange: '#fa8c16', red: '#f5222d', purple: '#722ed1',
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

const EventFormModal: React.FC<EventFormModalProps> = ({
  open, mode, event, defaultStartAt, defaultEndAt, settings, onClose, onSubmit, onDelete,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [form] = Form.useForm()
  const isEdit = mode === 'edit'

  const initialValues = useMemo(() => {
    if (isEdit && event) {
      const startMs = event.instance_start_at * MS
      const endMs = event.instance_end_at * MS
      return {
        title: event.title,
        allDay: event.all_day,
        startDate: dayjs(startMs),
        startTime: event.all_day ? null : dayjs(startMs).format('HH:mm'),
        endDate: dayjs(endMs),
        endTime: event.all_day ? null : dayjs(endMs).format('HH:mm'),
        color: event.color,
        description: event.description || '',
        recurrenceFreq: event.recurrence_rule?.freq || 'none',
        recurrenceInterval: event.recurrence_rule?.interval || 1,
        recurrenceCount: event.recurrence_rule?.count ?? undefined,
        recurrenceUntil: event.recurrence_rule?.until ? dayjs(event.recurrence_rule.until * MS) : undefined,
        reminders: (event.reminders?.length ? event.reminders : (settings?.default_event_reminders || [])).map(toDisplay),
      }
    }
    const startMs = defaultStartAt ? defaultStartAt * MS : Date.now()
    const endMs = defaultEndAt ? defaultEndAt * MS : startMs + 60 * 60 * MS
    return {
      title: '',
      allDay: false,
      startDate: dayjs(startMs),
      startTime: dayjs(startMs).format('HH:mm'),
      endDate: dayjs(endMs),
      endTime: dayjs(endMs).format('HH:mm'),
      color: 'default' as EventColor,
      description: '',
      recurrenceFreq: 'none',
      recurrenceInterval: 1,
      recurrenceCount: undefined,
      recurrenceUntil: undefined,
      reminders: (settings?.default_event_reminders || []).map(toDisplay),
    }
  }, [isEdit, event, defaultStartAt, defaultEndAt, settings])

  useEffect(() => {
    if (open) form.setFieldsValue(initialValues)
  }, [open, form, initialValues])

  const allDay = Form.useWatch('allDay', form)
  const recurrenceFreq = Form.useWatch('recurrenceFreq', form)

  const handleFinish = async (values: any) => {
    const startDate: dayjs.Dayjs = values.startDate
    const endDate: dayjs.Dayjs = values.endDate

    let startMs: number
    let endMs: number
    if (values.allDay) {
      startMs = startDate.startOf('day').valueOf()
      endMs = endDate.endOf('day').valueOf()
    } else {
      const [sh, sm] = (values.startTime || '00:00').split(':').map(Number)
      const [eh, em] = (values.endTime || '23:59').split(':').map(Number)
      startMs = startDate.hour(sh || 0).minute(sm || 0).second(0).millisecond(0).valueOf()
      endMs = endDate.hour(eh || 0).minute(em || 0).second(0).millisecond(0).valueOf()
    }

    let recurrenceRule: RecurrenceRule | null = null
    if (values.recurrenceFreq && values.recurrenceFreq !== 'none') {
      recurrenceRule = {
        freq: values.recurrenceFreq,
        interval: values.recurrenceInterval || 1,
      }
      if (values.recurrenceCount) recurrenceRule.count = values.recurrenceCount
      if (values.recurrenceUntil) recurrenceRule.until = Math.floor(values.recurrenceUntil.valueOf() / MS)
    }

    const payload: CreateEventInput | UpdateEventInput = {
      title: values.title,
      description: values.description || '',
      location: '',
      start_at: Math.floor(startMs / MS),
      end_at: Math.floor(endMs / MS),
      all_day: !!values.allDay,
      color: values.color,
      recurrence_rule: recurrenceRule,
      reminders: (values.reminders || []).map(toStore),
    }
    if (isEdit) (payload as UpdateEventInput).id = event!.id

    try {
      const result = await onSubmit(payload)
      if (result && !result.error) {
        message.success(isEdit ? t('calendar.editEvent') : t('calendar.newEvent'))
        onClose()
      } else if (result?.error) {
        message.error(result.error)
      }
    } catch (err: any) {
      message.error(err?.message || 'Failed to save event')
    }
  }

  const colorStyle = (color: EventColor): React.CSSProperties => ({
    background: COLOR_HEX[color],
    width: 12, height: 12, borderRadius: 2, display: 'inline-block', marginRight: 4, verticalAlign: 'middle',
  })

  const reminderLabel = (m: number): string => {
    if (m === 0) return t('calendar.atStart')
    if (m < 60) return `${m}${t('calendar.minutesBefore')}`
    if (m < 1440) return `${Math.floor(m / 60)}${t('calendar.hoursBefore')}`
    return `${Math.floor(m / 1440)}${t('calendar.daysBefore')}`
  }

  const handleDelete = async () => {
    if (!event || !onDelete) return
    try {
      const result = await onDelete(event.id)
      if (result && !result.error) {
        message.success(t('calendar.deleteEvent'))
        onClose()
      } else if (result?.error) {
        message.error(result.error)
      }
    } catch (err: any) {
      message.error(err?.message || 'Failed to delete event')
    }
  }

  const itemMb: React.CSSProperties = { marginBottom: 8 }
  const inlineLabel: React.CSSProperties = { fontSize: 12, color: token.colorTextTertiary, whiteSpace: 'nowrap', paddingRight: 2 }

  return (
    <Modal
      open={open}
      title={isEdit ? t('calendar.editEvent') : t('calendar.newEvent')}
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
                title={t('calendar.deleteEventConfirm')}
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
        {/* 主题 */}
        <Form.Item name="title" rules={[{ required: true, message: t('calendar.eventTitlePlaceholder') }]} style={itemMb}>
          <Input
            placeholder={t('calendar.eventTitle')}
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

        {/* 时间：开始日期 + 开始时间 → 结束日期 + 结束时间，一行排列 */}
        <Row gutter={8} align="middle" style={{ marginBottom: 8 }}>
          <Col flex="1 1 100px">
            <Form.Item name="startDate" style={{ marginBottom: 0 }}>
              <DatePicker style={{ width: '100%' }} size="middle" placeholder={t('calendar.startDate')} />
            </Form.Item>
          </Col>
          {!allDay && (
            <Col flex="0 0 80px">
              <Form.Item name="startTime" style={{ marginBottom: 0 }}>
                <AutoComplete
                  options={TIME_OPTIONS}
                  style={{ width: '100%' }}
                  size="middle"
                  placeholder={t('calendar.startTime')}
                  filterOption={() => true}
                />
              </Form.Item>
            </Col>
          )}
          <Col flex="0 0 14px" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextTertiary }}>
            →
          </Col>
          <Col flex="1 1 100px">
            <Form.Item name="endDate" style={{ marginBottom: 0 }}>
              <DatePicker style={{ width: '100%' }} size="middle" placeholder={t('calendar.endDate')} />
            </Form.Item>
          </Col>
          {!allDay && (
            <Col flex="0 0 80px">
              <Form.Item name="endTime" style={{ marginBottom: 0 }}>
                <AutoComplete
                  options={TIME_OPTIONS}
                  style={{ width: '100%' }}
                  size="middle"
                  placeholder={t('calendar.endTime')}
                  filterOption={() => true}
                />
              </Form.Item>
            </Col>
          )}
        </Row>

        {/* 全天 / 颜色 / 重复 / 提醒：同一行 */}
        <Row gutter={8} align="middle" style={{ marginBottom: 8 }}>
          <Col flex="0 0 auto">
            <Form.Item name="allDay" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>{t('calendar.allDay')}</Checkbox>
            </Form.Item>
          </Col>
          <Col flex="1 1 0">
            <Form.Item name="color" style={{ marginBottom: 0 }}>
              <Select
                size="middle"
                optionLabelProp="label"
                placeholder={t('calendar.color')}
                options={COLOR_OPTIONS.map((c) => ({
                  value: c,
                  label: (
                    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <span style={colorStyle(c)} />
                      {t(`calendar.color${c.charAt(0).toUpperCase() + c.slice(1)}`)}
                    </span>
                  ),
                }))}
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
          <Col flex="1 1 0">
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

        {/* 重复规则详情：label与输入框同一行 */}
        {recurrenceFreq && recurrenceFreq !== 'none' && (
          <Row gutter={8} align="middle" style={{ marginBottom: 8 }}>
            <Col flex="0 0 auto" style={inlineLabel}>{t('calendar.repeatInterval')}</Col>
            <Col flex="0 0 50px">
              <Form.Item name="recurrenceInterval" style={itemMb}>
                <InputNumber min={1} max={99} style={{ width: '100%' }} size="middle" />
              </Form.Item>
            </Col>
            <Col flex="0 0 auto" style={inlineLabel}>{t('calendar.repeatCount')}</Col>
            <Col flex="0 0 50px">
              <Form.Item name="recurrenceCount" style={itemMb}>
                <InputNumber min={1} max={365} placeholder="∞" style={{ width: '100%' }} size="middle" />
              </Form.Item>
            </Col>
            <Col flex="0 0 auto" style={inlineLabel}>{t('calendar.repeatUntilShort')}</Col>
            <Col flex="1 1 auto">
              <Form.Item name="recurrenceUntil" style={itemMb}>
                <DatePicker style={{ width: '100%' }} size="middle" />
              </Form.Item>
            </Col>
          </Row>
        )}
      </Form>
    </Modal>
  )
}

export default EventFormModal
