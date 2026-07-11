import React, { useState, useCallback } from 'react'
import { Button, Space, Divider, Typography, App } from 'antd'
import { ExportOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography

// 由 vite.config.ts 的 define 注入（prebuild 由 scripts/generate-build-info.mjs 生成）
const APP_VERSION = __APP_VERSION__
const APP_COMMIT = __APP_COMMIT__
const APP_BUILD_TIME = __APP_BUILD_TIME__

// 把 ISO 时间格式化为 YYYY-MM-DD HH:mm（本地时区）
function formatBuildTime(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const AboutSection: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [exporting, setExporting] = useState(false)

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
          <Text>
            {APP_VERSION}
            {APP_COMMIT && APP_COMMIT !== 'unknown' ? `(${APP_COMMIT})` : ''}
          </Text>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Text type="secondary">{t('settings.buildTime')}</Text>
          <Text>{formatBuildTime(APP_BUILD_TIME)}</Text>
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
