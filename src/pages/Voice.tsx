import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Drawer, Button, Typography, Space, theme } from 'antd'
import { SettingOutlined, AudioOutlined } from '@ant-design/icons'
import { KMSVoiceView, KMSVoiceSettings } from '../components/kms'
import { useVoice } from '../hooks/useVoice'

const { Title, Text } = Typography

const VoicePage: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const {
    settings, loadSettings, saveSettings,
    checkLocalModel, selectDirectory,
  } = useVoice()

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const handleSaveSettings = useCallback(async (s: any) => {
    return saveSettings(s)
  }, [saveSettings])

  const handleCheckLocalModel = useCallback(async () => {
    return checkLocalModel()
  }, [checkLocalModel])

  const handleSelectDirectory = useCallback(async () => {
    return selectDirectory()
  }, [selectDirectory])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Space>
          <AudioOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
          <div>
            <Title level={5} style={{ margin: 0 }}>{t('voice.title')}</Title>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('voice.subtitle')}</Text>
          </div>
        </Space>
        <Button
          icon={<SettingOutlined />}
          onClick={() => setSettingsOpen(true)}
        >
          {t('voice.settings')}
        </Button>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <KMSVoiceView onOpenSettings={() => setSettingsOpen(true)} />
      </div>

      {/* Settings Drawer */}
      <Drawer
        title={t('voice.settings')}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        size={520}
        destroyOnHidden
      >
        <KMSVoiceSettings
          settings={settings}
          onSaveSettings={handleSaveSettings}
          onCheckLocalModel={handleCheckLocalModel}
          onSelectDirectory={handleSelectDirectory}
        />
      </Drawer>
    </div>
  )
}

export default VoicePage
