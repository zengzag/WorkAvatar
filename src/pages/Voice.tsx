import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Drawer } from 'antd'
import { KMSVoiceView, KMSVoiceSettings } from '../components/kms'
import { useVoice } from '../hooks/useVoice'

const VoicePage: React.FC = () => {
  const { t } = useTranslation()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const {
    settings, loadSettings, saveSettings,
    checkLocalModel,
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

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
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
        />
      </Drawer>
    </div>
  )
}

export default VoicePage
