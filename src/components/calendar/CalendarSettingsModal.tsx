import { useEffect, useMemo, useState } from 'react'
import {
  Modal, Form, Switch, Select, message, Divider, theme,
} from 'antd'
import { useTranslation } from 'react-i18next'
import type { CalendarSettings } from '../../types/calendar'

interface CalendarSettingsModalProps {
  open: boolean
  settings?: CalendarSettings | null
  onClose: () => void
  onSave: (partial: Partial<CalendarSettings>) => Promise<any>
}

const REMINDER_OPTIONS = [0, 5, 15, 30, 60, 120, 1440, 2880]
/** 数据库存负偏移（-10 = 提前10分钟），前端 Select 用正数 */
const toDisplay = (v: number) => Math.abs(v)
const toStore = (v: number) => -v

const CalendarSettingsModal: React.FC<CalendarSettingsModalProps> = ({
  open, settings, onClose, onSave,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  const initialValues = useMemo(() => ({
    default_event_reminders: (settings?.default_event_reminders || []).map(toDisplay),
    default_todo_reminders: (settings?.default_todo_reminders || []).map(toDisplay),
    enable_system_notification: settings?.enable_system_notification ?? true,
  }), [settings])

  useEffect(() => {
    if (open) form.resetFields()
  }, [open, form, initialValues])

  const handleFinish = async (values: any) => {
    setSaving(true)
    try {
      const result = await onSave({
        default_event_reminders: (values.default_event_reminders || []).map(toStore),
        default_todo_reminders: (values.default_todo_reminders || []).map(toStore),
        enable_system_notification: !!values.enable_system_notification,
      })
      if (result && !result.error) {
        message.success(t('calendar.saveSettingsSuccess'))
        onClose()
      } else if (result?.error) {
        message.error(result.error)
      }
    } catch (err: any) {
      message.error(err?.message || 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  const reminderLabel = (m: number): string => {
    if (m === 0) return t('calendar.atStart')
    if (m < 60) return `${m} ${t('calendar.minutesBefore')}`
    if (m < 1440) return `${Math.floor(m / 60)} ${t('calendar.hoursBefore')}`
    return `${Math.floor(m / 1440)} ${t('calendar.daysBefore')}`
  }

  return (
    <Modal
      open={open}
      title={t('calendar.settings')}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      onCancel={onClose}
      confirmLoading={saving}
      onOk={() => form.submit()}
      destroyOnClose
      width={480}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={initialValues}
        onFinish={handleFinish}
      >
        <Form.Item
          name="enable_system_notification"
          label={t('calendar.settingsEnableSystemNotification')}
          valuePropName="checked"
          extra={<span style={{ fontSize: 12, color: token.colorTextTertiary }}>{t('calendar.settingsEnableSystemNotificationHint')}</span>}
        >
          <Switch />
        </Form.Item>

        <Divider style={{ margin: '12px 0' }} />

        <Form.Item name="default_event_reminders" label={t('calendar.settingsDefaultEventReminders')}>
          <Select
            mode="multiple"
            placeholder={t('calendar.addReminder')}
            options={REMINDER_OPTIONS.map((m) => ({ value: m, label: reminderLabel(m) }))}
          />
        </Form.Item>

        <Form.Item name="default_todo_reminders" label={t('calendar.settingsDefaultTodoReminders')}>
          <Select
            mode="multiple"
            placeholder={t('calendar.addReminder')}
            options={REMINDER_OPTIONS.map((m) => ({ value: m, label: reminderLabel(m) }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}

export default CalendarSettingsModal