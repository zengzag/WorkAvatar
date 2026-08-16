import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  Drawer, Tabs, Switch, Select, Card, Divider, theme, App, Button, Space, Tag, Tooltip,
} from 'antd'
import {
  BellOutlined, NotificationOutlined, CloudSyncOutlined, LoginOutlined, LogoutOutlined, SyncOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SettingsItem from '../common/SettingsItem'
import type { CalendarSettings, OutlookSyncStatus } from '../../types/calendar'

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

const formatTime = (unixSec: number): string => {
  const d = new Date(unixSec * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

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

  // Outlook 同步状态
  const [outlook, setOutlook] = useState<OutlookSyncStatus | null>(null)
  const [loginLoading, setLoginLoading] = useState(false)
  const [syncLoading, setSyncLoading] = useState(false)

  useEffect(() => {
    if (open) {
      setEnableSystemNotification(settings?.enable_system_notification ?? true)
      setEventReminders((settings?.default_event_reminders || []).map(toDisplay))
      setTodoReminders((settings?.default_todo_reminders || []).map(toDisplay))
      window.electronAPI.calendar.outlook.status().then(result => {
        if (result && !result.error) setOutlook(result as OutlookSyncStatus)
      }).catch(() => { /* ignore */ })
    }
  }, [open, settings])

  // 同步状态推送（同步开始/结束/登出）
  useEffect(() => {
    const unsubscribe = window.electronAPI.calendar.outlook.onSyncChanged((status) => {
      setOutlook(status)
      setSyncLoading(false)
    })
    return () => { unsubscribe() }
  }, [])

  const handleLogin = useCallback(async () => {
    setLoginLoading(true)
    try {
      const result = await window.electronAPI.calendar.outlook.login()
      if (result?.error) {
        message.error(result.error)
      } else if (result) {
        setOutlook(result as OutlookSyncStatus)
        message.success(t('calendar.outlookLoginSuccess'))
      }
    } catch (err: any) {
      message.error(err?.message || t('calendar.outlookLoginFailed'))
    } finally {
      setLoginLoading(false)
    }
  }, [message, t])

  const handleLogout = useCallback(async () => {
    try {
      const result = await window.electronAPI.calendar.outlook.logout()
      if (result && !result.error) setOutlook(result as OutlookSyncStatus)
    } catch (err: any) {
      message.error(err?.message || 'Failed to log out')
    }
  }, [message])

  const handleConfigChange = useCallback(async (partial: Partial<OutlookSyncStatus['config']>) => {
    try {
      const result = await window.electronAPI.calendar.outlook.setConfig(partial)
      if (result?.error) message.error(result.error)
      else if (result) setOutlook(result as OutlookSyncStatus)
    } catch (err: any) {
      message.error(err?.message || 'Failed to save')
    }
  }, [message])

  const handleSyncNow = useCallback(async () => {
    setSyncLoading(true)
    try {
      const result = await window.electronAPI.calendar.outlook.syncNow()
      if (result?.error) {
        message.error(result.error)
        setSyncLoading(false)
      } else if (result) {
        setOutlook(result as OutlookSyncStatus)
        const r = (result as OutlookSyncStatus).last_result
        if (r) message.success(t('calendar.outlookSyncDone', { created: r.created, updated: r.updated, deleted: r.deleted, failed: r.failed }))
        setSyncLoading(false)
      }
    } catch (err: any) {
      message.error(err?.message || t('calendar.outlookSyncFailed'))
      setSyncLoading(false)
    }
  }, [message, t])

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

  const renderOutlookTab = () => {
    const signedIn = !!outlook?.signed_in
    const cfg = outlook?.config
    const syncing = outlook?.syncing || syncLoading
    const lastResult = outlook?.last_result ?? null

    const statusText = (() => {
      if (syncing) return <Tag color="processing" icon={<SyncOutlined spin />}>{t('calendar.outlookSyncing')}</Tag>
      if (outlook?.last_error) return <Tag color="error">{outlook.last_error}</Tag>
      if (lastResult) return <Tag color={lastResult.failed > 0 ? 'warning' : 'success'}>
        {t('calendar.outlookSyncResult', {
          created: lastResult.created, updated: lastResult.updated,
          deleted: lastResult.deleted, failed: lastResult.failed,
        })}
      </Tag>
      return <Tag>{t('calendar.outlookNeverSynced')}</Tag>
    })()

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card size="small" style={cardStyle}>
          <SettingsItem
            title={t('calendar.outlookAccount')}
            description={signedIn
              ? (outlook?.account?.email || outlook?.account?.display_name || '-')
              : t('calendar.outlookAccountHint')}
            extra={
              signedIn ? (
                <Button size="small" icon={<LogoutOutlined />} onClick={handleLogout}>
                  {t('calendar.outlookSignOut')}
                </Button>
              ) : (
                <Button type="primary" size="small" icon={<LoginOutlined />} loading={loginLoading} onClick={handleLogin}>
                  {t('calendar.outlookSignIn')}
                </Button>
              )
            }
          />
        </Card>

        <Card size="small" style={cardStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SettingsItem
              title={t('calendar.outlookSyncEnable')}
              description={t('calendar.outlookSyncEnableHint')}
              extra={
                <Switch
                  disabled={!signedIn}
                  checked={!!cfg?.enabled}
                  onChange={(checked) => handleConfigChange({ enabled: checked })}
                />
              }
            />
            <Divider style={{ margin: '4px 0' }} />
            <SettingsItem
              title={t('calendar.outlookAutoSync')}
              description={t('calendar.outlookAutoSyncHint')}
              extra={
                <Switch
                  disabled={!signedIn || !cfg?.enabled}
                  checked={!!cfg?.auto_sync}
                  onChange={(checked) => handleConfigChange({ auto_sync: checked })}
                />
              }
            />
            <Divider style={{ margin: '4px 0' }} />
            <SettingsItem
              title={t('calendar.outlookSyncEvents')}
              description={t('calendar.outlookSyncEventsHint')}
              extra={
                <Switch
                  disabled={!signedIn || !cfg?.enabled}
                  checked={!!cfg?.sync_events}
                  onChange={(checked) => handleConfigChange({ sync_events: checked })}
                />
              }
            />
            <Divider style={{ margin: '4px 0' }} />
            <SettingsItem
              title={t('calendar.outlookSyncTodos')}
              description={t('calendar.outlookSyncTodosHint')}
              extra={
                <Switch
                  disabled={!signedIn || !cfg?.enabled}
                  checked={!!cfg?.sync_todos}
                  onChange={(checked) => handleConfigChange({ sync_todos: checked })}
                />
              }
            />
          </div>
        </Card>

        <Card size="small" style={cardStyle}>
          <SettingsItem
            title={t('calendar.outlookSyncNow')}
            description={
              <Space direction="vertical" size={2}>
                <span>{t('calendar.outlookSyncNowHint')}</span>
                {statusText}
                {lastResult && (
                  <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
                    {t('calendar.outlookLastSyncAt')}: {formatTime(lastResult.synced_at)}
                  </span>
                )}
              </Space>
            }
            extra={
              <Tooltip title={!signedIn ? t('calendar.outlookSignInFirst') : ''}>
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<CloudSyncOutlined />}
                  disabled={!signedIn}
                  loading={syncing}
                  onClick={handleSyncNow}
                >
                  {t('calendar.outlookSyncNowButton')}
                </Button>
              </Tooltip>
            }
          />
        </Card>
      </div>
    )
  }

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
    {
      key: 'outlook',
      label: <span><CloudSyncOutlined style={{ marginRight: 4 }} />{t('calendar.settingsTabOutlook')}</span>,
      children: renderOutlookTab(),
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
