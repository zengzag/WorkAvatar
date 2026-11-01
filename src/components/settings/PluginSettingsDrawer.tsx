import { useCallback, useEffect, useRef, useState } from 'react'
import { App, Drawer, Empty, Input, InputNumber, Select, Spin, Switch, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import type { PluginInfo } from '../../../electron/shared/channels/plugin'
import type { PluginSettingField } from '../../../plugin-sdk/src'
import SettingsItem from '../common/SettingsItem'

interface PluginSettingsDrawerProps {
  plugin: PluginInfo | null
  onClose: () => void
}

/**
 * 插件参数设置抽屉：按 manifest.settings 渲染表单，修改后自动保存并即时通知插件热应用。
 * 无界面插件（无 renderer/nav）的唯一配置入口。
 */
const PluginSettingsDrawer: React.FC<PluginSettingsDrawerProps> = ({ plugin, onClose }) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [fields, setFields] = useState<PluginSettingField[]>([])
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const pluginId = plugin?.id

  const loadedRef = useRef(false)
  const pendingRef = useRef<Record<string, unknown> | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!pluginId) return
    let cancelled = false
    loadedRef.current = false
    pendingRef.current = null
    setStatus('idle')
    setLoading(true)
    window.electronAPI.plugin.getSettings(pluginId)
      .then((info) => {
        if (cancelled) return
        setFields(info.fields)
        setValues(info.values)
        loadedRef.current = true
      })
      .catch(() => {
        if (!cancelled) message.error(t('settings.plugins.settingsLoadFailed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [pluginId, message, t])

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
  }, [])

  const persist = useCallback(async () => {
    const patch = pendingRef.current
    if (!pluginId || !patch) return
    pendingRef.current = null
    setStatus('saving')
    try {
      await window.electronAPI.plugin.setSettings(pluginId, patch)
      setStatus('saved')
    } catch (err: any) {
      setStatus('error')
      message.error(err?.message || t('settings.plugins.settingsSaveFailed'))
    }
  }, [message, pluginId, t])

  const handleChange = (key: string, value: unknown) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value }
      pendingRef.current = next
      if (timerRef.current) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => { void persist() }, 500)
      return next
    })
  }

  // 关闭前立即落盘，避免 500ms 防抖窗口内的修改丢失
  const handleClose = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    void persist()
    onClose()
  }

  const renderControl = (field: PluginSettingField) => {
    const value = values[field.key]
    switch (field.type) {
      case 'boolean':
        return <Switch checked={value === true} onChange={(checked) => handleChange(field.key, checked)} />
      case 'number':
        return (
          <InputNumber
            value={typeof value === 'number' ? value : undefined}
            min={field.min}
            max={field.max}
            step={field.step}
            placeholder={field.placeholder}
            onChange={(next) => { if (next !== null) handleChange(field.key, next) }}
            style={{ width: 220 }}
          />
        )
      case 'select':
        return (
          <Select
            value={typeof value === 'string' ? value : undefined}
            options={(field.options ?? []).map(o => ({ value: o.value, label: o.label }))}
            onChange={(next) => handleChange(field.key, next)}
            style={{ width: '100%' }}
          />
        )
      case 'textarea':
        return (
          <Input.TextArea
            value={typeof value === 'string' ? value : ''}
            placeholder={field.placeholder}
            rows={3}
            onChange={(e) => handleChange(field.key, e.target.value)}
          />
        )
      default:
        return (
          <Input
            value={typeof value === 'string' ? value : ''}
            placeholder={field.placeholder}
            onChange={(e) => handleChange(field.key, e.target.value)}
          />
        )
    }
  }

  return (
    <Drawer
      open={!!plugin}
      onClose={handleClose}
      width={640}
      title={(
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span>{t('settings.plugins.settingsTitle', { name: plugin?.name ?? '' })}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {plugin?.id}
          </Typography.Text>
        </div>
      )}
    >
      {loading ? (
        <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
      ) : fields.length === 0 ? (
        <Empty description={t('settings.plugins.settingsEmpty')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {status === 'saving'
              ? t('settings.plugins.settingsSaving')
              : status === 'saved'
                ? t('settings.plugins.settingsSaved')
                : t('settings.plugins.settingsHint')}
          </Typography.Text>
          {fields.map((field) => (
            <SettingsItem
              key={field.key}
              align="start"
              title={field.label}
              description={field.description}
            >
              {renderControl(field)}
            </SettingsItem>
          ))}
        </div>
      )}
    </Drawer>
  )
}

export default PluginSettingsDrawer
