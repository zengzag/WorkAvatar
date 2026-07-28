import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  Drawer, Tabs, Switch, Select, Card, Divider, theme, App,
} from 'antd'
import {
  BellOutlined, NotificationOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SettingsItem from '../common/SettingsItem'
import type { CalendarSettings } from '../../types/calendar'

interface CalendarSettingsDrawerProps {
  open: boolean
  settings?: CalendarSettings | null
  onClose: () => void
  onSave: (partial: Partial<CalendarSettings>) => Promise<any>
}

const REMINDER_OPTIONS = [0, 5, 15, 30, 60, 120, 1440, 2880]
/** 数据库存负偏移（-10 = 提前10分钟），前端 Select 用正数 */
const toDisplay = (v: number) => Math.abs(v)
const toStore = (v: number) => -v

const CalendarSettingsDrawer: React.FC<CalendarSettingsDrawerProps> = ({
  open, settings, onClose, onSave,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()

  const [enableSystemNotification, setEnableSystemNotification] = useState<boolean>(settings?.enable_system_notification ?? true)
  const [eventReminders, setEventReminders] = useState<number[]>(() => (settings?.default_event_reminders || []).map(toDisplay))
  const [todoReminders, setTodoReminders] = useState<number[]>(() => (settings?.default_todo_reminders || []).map(toDisplay))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setEnableSystemNotification(settings?.enable_system_notification ?? true)
      setEventReminders((settings?.default_event_reminders || []).map(toDisplay))
      setTodoReminders((settings?.default_todo_reminders || []).map(toDisplay))
    }
  }, [open, settings])

  const reminderLabel = useCallback((m: number): string => {
    if (m === 0) return t('calendar.atStart')
    if (m < 60) return `${m} ${t('calendar.minutesBefore')}`
    if (m < 1440) return `${Math.floor(m / 60)} ${t('calendar.hoursBefore')}`
    return `${Math.floor(m / 1440)} ${t('calendar.daysBefore')}`
  }, [t])

  const cardStyle: React.CSSProperties = { borderColor: token.colorBorderSecondary }

  // 保存单个字段，避免多字段聚合失败
  const savePartial = useCallback(async (partial: Partial<CalendarSettings>) => {
    setSaving(true)
    try {
      const result = await onSave(partial)
      if (result && !result.error) {
        // 静默保存，不弹消息
      } else if (result?.error) {
        message.error(result.error)
      }
      return result
    } catch (err: any) {
      message.error(err?.message || 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }, [onSave, message])

  const handleSystemNotificationChange = useCallback((checked: boolean) => {
    setEnableSystemNotification(checked)
    savePartial({ enable_system_notification: checked })
  }, [savePartial])

  const handleEventRemindersChange = useCallback((values: number[]) => {
    setEventReminders(values)
    savePartial({ default_event_reminders: (values || []).map(toStore) })
  }, [savePartial])

  const handleTodoRemindersChange = useCallback((values: number[]) => {
    setTodoReminders(values)
    savePartial({ default_todo_reminders: (values || []).map(toStore) })
  }, [savePartial])

  const reminderOptions = useMemo(() => REMINDER_OPTIONS.map((m) => ({
    value: m, label: reminderLabel(m),
  })), [reminderLabel])

  const renderNotificationTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" style={cardStyle}>
        <SettingsItem
          title={t('calendar.settingsEnableSystemNotification')}
          description={t('calendar.settingsEnableSystemNotificationHint')}
          extra={
            <Switch
              checked={enableSystemNotification}
              onChange={handleSystemNotificationChange}
              loading={saving}
            />
          }
        />
      </Card>
    </div>
  )

  const renderRemindersTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" style={cardStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SettingsItem
            title={t('calendar.settingsDefaultEventReminders')}
            description={t('calendar.settingsDefaultEventRemindersHint')}
            extra={
              <Select
                mode="multiple"
                placeholder={t('calendar.addReminder')}
                value={eventReminders}
                onChange={handleEventRemindersChange}
                options={reminderOptions}
                style={{ minWidth: 220, maxWidth: 280 }}
              />
            }
          />
          <Divider style={{ margin: '4px 0' }} />
          <SettingsItem
            title={t('calendar.settingsDefaultTodoReminders')}
            description={t('calendar.settingsDefaultTodoRemindersHint')}
            extra={
              <Select
                mode="multiple"
                placeholder={t('calendar.addReminder')}
                value={todoReminders}
                onChange={handleTodoRemindersChange}
                options={reminderOptions}
                style={{ minWidth: 220, maxWidth: 280 }}
              />
            }
          />
        </div>
      </Card>
    </div>
  )

  const tabItems = [
    {
      key: 'notification',
      label: <span><NotificationOutlined style={{ marginRight: 4 }} />{t('calendar.settingsTabNotification')}</span>,
      children: renderNotificationTab(),
    },
    {
      key: 'reminders',
      label: <span><BellOutlined style={{ marginRight: 4 }} />{t('calendar.settingsTabReminders')}</span>,
      children: renderRemindersTab(),
    },
  ]

  return (
    <Drawer
      title={t('calendar.settings')}
      open={open}
      onClose={onClose}
      size={640}
      styles={{ body: { padding: 16, overflow: 'auto' } }}
      destroyOnHidden
    >
      <Tabs
        defaultActiveKey="notification"
        items={tabItems}
        size="small"
        style={{ height: '100%' }}
        tabBarStyle={{ marginBottom: 16 }}
      />
    </Drawer>
  )
}

export default CalendarSettingsDrawer
