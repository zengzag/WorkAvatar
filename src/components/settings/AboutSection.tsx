import React, { useState, useEffect, useCallback } from 'react'
import { Button, Space, Divider, Typography, App } from 'antd'
import { ExportOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography

const AboutSection: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [version, setVersion] = useState<string>('')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    window.electronAPI.app.getVersion().then((v) => setVersion(v || '')).catch(() => setVersion(''))
  }, [])

  const handleExportLogs = useCallback(async () => {
    setExporting(true)
    try {
      const res = await window.electronAPI.app.openLogDir()
      if (res?.success) {
        message.success(t('settings.exportLogsSuccess'))
      } else {
        message.error(res?.error || t('settings.exportLogsFailed'))
      }
    } catch {
      message.error(t('settings.exportLogsFailed'))
    } finally {
      setExporting(false)
    }
  }, [message, t])

  return (
    <div>
      <Title level={5}>{t('settings.aboutTitle')}</Title>
      <Space orientation="vertical" style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Text type="secondary">{t('settings.version')}</Text>
          <Text>{version || '-'}</Text>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Text type="secondary">{t('settings.buildDate')}</Text>
          <Text>2026-05-06</Text>
        </div>
        <Divider />
        <Button block icon={<ExportOutlined />} loading={exporting} onClick={handleExportLogs}>
          {t('settings.exportLogs')}
        </Button>
      </Space>
    </div>
  )
}

export default React.memo(AboutSection)
