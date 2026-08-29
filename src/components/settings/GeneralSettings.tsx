import React, { useState, useEffect, useCallback } from 'react'
import { Typography, Switch, App } from 'antd'
import { useTranslation } from 'react-i18next'

const { Title, Text } = Typography

const GeneralSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [preventSleep, setPreventSleep] = useState(true)
  const [loading, setLoading] = useState(true)

  const loadSettings = useCallback(async () => {
    try {
      const enabled = await window.electronAPI.app.getPreventSleep()
      setPreventSleep(!!enabled)
    } catch {
      // 加载失败保持默认值
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const handlePreventSleepChange = useCallback(async (checked: boolean) => {
    setPreventSleep(checked)
    try {
      await window.electronAPI.app.setPreventSleep(checked)
      message.success(t('settings.saved'))
    } catch {
      setPreventSleep(!checked)
      message.error(t('common.saveFailed'))
    }
  }, [message, t])

  return (
    <div>
      <Title level={5}>{t('settings.generalTitle')}</Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ flex: 1, marginRight: 16 }}>
            <Text strong>{t('settings.preventSleep')}</Text>
            <br />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('settings.preventSleepDesc')}
            </Text>
          </div>
          <Switch checked={preventSleep} loading={loading} onChange={handlePreventSleepChange} />
        </div>
      </div>
    </div>
  )
}

export default React.memo(GeneralSettings)
