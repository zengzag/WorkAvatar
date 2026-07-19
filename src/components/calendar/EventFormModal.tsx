import { useEffect, useMemo } from 'react'
import {
  Modal, Form, Input, Switch, DatePicker, TimePicker, Select, InputNumber, Row, Col, message,
} from 'antd'
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
  settings?: CalendarSettings | null
  onClose: () => void
  onSubmit: (input: CreateEventInput | UpdateEventInput) => Promise<any>
}

const COLOR_OPTIONS: EventColor[] = ['default', 'blue', 'green', 'orange', 'red', 'purple']
const COLOR_HEX: Record<EventColor, string> = {
  default: '#1677ff', blue: '#1677ff', green: '#52c41a', orange: '#fa8c16', red: '#f5222d', purple: '#722ed1',
}
const REMINDER_OPTIONS = [0, 5, 15, 30, 60, 120, 1440, 2880]
/** 数据库存负偏移（-10 = 提前10分钟），前端 Select 用正数 */
const toDisplay = (v: number) => Math.abs(v)
const toStore = (v: number) => -v

const compactItem: React.CSSProperties = { marginBottom: 12 }

const EventFormModal: React.FC<EventFormModalProps> = ({
  open, mode, event, defaultStartAt, settings, onClose, onSubmit,
}) => {
  const { t } = useTranslation()
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
        startTime: event.all_day ? null : dayjs(startMs),
        endDate: dayjs(endMs),
        endTime: event.all_day ? null : dayjs(endMs),
        color: event.color,
        location: event.location || '',
        description: event.description || '',
        recurrenceFreq: event.recurrence_rule?.freq || 'none',
        recurrenceInterval: event.recurrence_rule?.interval || 1,
        recurrenceCount: event.recurrence_rule?.count ?? undefined,
        recurrenceUntil: event.recurrence_rule?.until ? dayjs(event.recurrence_rule.until * MS) : undefined,
        reminders: (event.reminders?.length ? event.reminders : (settings?.default_event_reminders || [])).map(toDisplay),
      }
    }
    const startMs = defaultStartAt ? defaultStartAt * MS : Date.now()
    const endMs = startMs + 60 * 60 * MS
    return {
      title: '',
      allDay: false,
      startDate: dayjs(startMs),
      startTime: dayjs(startMs),
      endDate: dayjs(endMs),
      endTime: dayjs(endMs),
      color: 'default' as EventColor,
      location: '',
      description: '',
      recurrenceFreq: 'none',
      recurrenceInterval: 1,
      recurrenceCount: undefined,
      recurrenceUntil: undefined,
      reminders: (settings?.default_event_reminders || []).map(toDisplay),
    }
  }, [isEdit, event, defaultStartAt, settings])

  useEffect(() => {
    if (open) form.resetFields()
  }, [open, form, initialValues])

  const allDay = Form.useWatch('allDay', form)
  const recurrenceFreq = Form.useWatch('recurrenceFreq', form)

  const handleFinish = async (values: any) => {
    const startDate: dayjs.Dayjs = values.startDate
    const startTime: dayjs.Dayjs | undefined = values.startTime
    const endDate: dayjs.Dayjs = values.endDate
    const endTime: dayjs.Dayjs | undefined = values.endTime

    const startMs = values.allDay
      ? startDate.startOf('day').valueOf()
      : startDate.hour(startTime!.hour()).minute(startTime!.minute()).second(0).millisecond(0).valueOf()
    const endMs = values.allDay
      ? endDate.endOf('day').valueOf()
      : endDate.hour(endTime!.hour()).minute(endTime!.minute()).second(0).millisecond(0).valueOf()

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
      location: values.location || '',
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
    width: 14, height: 14, borderRadius: 3, display: 'inline-block', marginRight: 5, verticalAlign: 'middle',
  })

  const reminderLabel = (m: number): string => {
    if (m === 0) return t('calendar.atStart')
    if (m < 60) return `${m} ${t('calendar.minutesBefore')}`
    if (m < 1440) return `${Math.floor(m / 60)} ${t('calendar.hoursBefore')}`
    return `${Math.floor(m / 1440)} ${t('calendar.daysBefore')}`
  }

  return (
    <Modal
      open={open}
      title={isEdit ? t('calendar.editEvent') : t('calendar.newEvent')}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      onCancel={onClose}
      onOk={() => form.submit()}
      destroyOnClose
      width={520}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={initialValues}
        onFinish={handleFinish}
        size="small"
      >
        <Form.Item name="title" label={t('calendar.eventTitle')} rules={[{ required: true, message: t('calendar.eventTitlePlaceholder') }]} style={compactItem}>
          <Input placeholder={t('calendar.eventTitlePlaceholder')} autoFocus />
        </Form.Item>

        <Row gutter={8}>
          <Col span={12}>
            <Form.Item name="startDate" label={t('calendar.startDate')} style={compactItem}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="endDate" label={t('calendar.endDate')} style={compactItem}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        {!allDay && (
          <Row gutter={8}>
            <Col span={12}>
              <Form.Item name="startTime" label={t('calendar.startTime')} style={compactItem}>
                <TimePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="endTime" label={t('calendar.endTime')} style={compactItem}>
                <TimePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        )}

        <Row gutter={8}>
          <Col span={8}>
            <Form.Item name="allDay" label={t('calendar.allDay')} valuePropName="checked" style={compactItem}>
              <Switch />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="color" label={t('calendar.color')} style={compactItem}>
              <Select
                optionLabelProp="label"
                options={COLOR_OPTIONS.map((c) => ({
                  value: c,
                  label: (
                    <span>
                      <span style={colorStyle(c)} />
                      {t(`calendar.color${c.charAt(0).toUpperCase() + c.slice(1)}`)}
                    </span>
                  ),
                }))}
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
          <Row gutter={8}>
            <Col span={8}>
              <Form.Item name="recurrenceInterval" label={t('calendar.repeatInterval')} style={compactItem}>
                <InputNumber min={1} max={99} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="recurrenceCount" label={t('calendar.repeatCount')} style={compactItem}>
                <InputNumber min={1} max={365} placeholder="∞" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="recurrenceUntil" label={t('calendar.repeatUntil')} style={compactItem}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
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
            <Form.Item name="location" label={t('calendar.location')} style={compactItem}>
              <Input placeholder={t('calendar.locationPlaceholder')} />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item name="description" label={t('calendar.description')} style={{ marginBottom: 0 }}>
          <Input.TextArea rows={2} placeholder={t('calendar.descriptionPlaceholder')} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

export default EventFormModal
