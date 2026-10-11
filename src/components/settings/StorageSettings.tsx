import React, { useState, useEffect, useCallback } from 'react'
import { Button, Divider, Input, Space, Typography, App } from 'antd'
import { FolderOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { formatFileSize } from '../../utils/format'

const { Text, Title } = Typography

const StorageSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const [dataDir, setDataDir] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [logSize, setLogSize] = useState<number>(0)
  const [logSizeLoading, setLogSizeLoading] = useState(false)
  const [clearingLogs, setClearingLogs] = useState(false)

  const loadDataDir = useCallback(async () => {
    try {
      const dir = await window.electronAPI.app.getDataDir()
      setDataDir(dir || '')
    } catch {
      setDataDir('')
    }
  }, [])

  const loadLogSize = useCallback(async () => {
    setLogSizeLoading(true)
    try {
      const res = await window.electronAPI.app.getLogSize()
      setLogSize(res?.size || 0)
    } catch {
      setLogSize(0)
    } finally {
      setLogSizeLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDataDir()
    loadLogSize()
  }, [loadDataDir, loadLogSize])

  const handleSelectDir = useCallback(async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: t('settings.selectDir'),
        defaultPath: dataDir,
        properties: ['openDirectory'],
      })
      if (result.canceled || !result.filePaths?.[0]) return

      const newDir = result.filePaths[0]
      modal.confirm({
        title: t('settings.changeDataDir'),
        content: t('settings.changeDataDirConfirm', { newDir }),
        onOk: async () => {
          setLoading(true)
          try {
            const res = await window.electronAPI.app.setDataDir(newDir)
            if (res.success) {
              setDataDir(newDir)
              message.success(t('settings.changeDataDirSuccess'))
            } else {
              message.error(res.error || t('settings.changeDataDirFailed'))
            }
          } catch {
            message.error(t('settings.changeDataDirFailed'))
          } finally {
            setLoading(false)
          }
        },
      })
    } catch {
      message.error(t('settings.changeDataDirFailed'))
    }
  }, [dataDir, message, modal, t])

  const handleClearAllData = useCallback(() => {
    modal.confirm({
      title: t('settings.clearAllData'),
      content: t('settings.clearAllDataConfirm'),
      okText: t('settings.clearAllData'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        setClearing(true)
        try {
          const res = await window.electronAPI.app.clearAllData()
          if (res?.success) {
            message.success(t('settings.clearAllDataSuccess'))
          } else {
            message.error(res?.error || t('settings.clearAllDataFailed'))
          }
        } catch {
          message.error(t('settings.clearAllDataFailed'))
        } finally {
          setClearing(false)
        }
      },
    })
  }, [message, modal, t])

  const handleClearLogs = useCallback(() => {
    modal.confirm({
      title: t('settings.clearLogs'),
      content: t('settings.clearLogsConfirm'),
      okText: t('settings.clearLogs'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        setClearingLogs(true)
        try {
          const res = await window.electronAPI.app.clearLogs()
          if (res?.success) {
            message.success(t('settings.clearLogsSuccess'))
            await loadLogSize()
          } else {
            message.error(res?.error || t('settings.clearLogsFailed'))
          }
        } catch {
          message.error(t('settings.clearLogsFailed'))
        } finally {
          setClearingLogs(false)
        }
      },
    })
  }, [loadLogSize, message, modal, t])

  return (
    <div>
      <Title level={5}>{t('settings.storageTitle')}</Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ flex: 1, marginRight: 16 }}>
            <Text strong>{t('settings.dataDir')}</Text>
            <br />
            <Text type="secondary">{t('settings.dataDirDesc')}</Text>
            <Space.Compact style={{ marginTop: 8, width: '100%' }}>
              <Input
                value={dataDir}
                readOnly
              />
              <Button
                icon={<ReloadOutlined />}
                onClick={loadDataDir}
                loading={loading}
              />
            </Space.Compact>
          </div>
          <Button
            icon={<FolderOutlined />}
            onClick={handleSelectDir}
            loading={loading}
          >
            {t('settings.selectDir')}
          </Button>
        </div>
        <Divider />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ flex: 1, marginRight: 16 }}>
            <Text strong>{t('settings.logStorage')}</Text>
            <br />
            <Text type="secondary">
              {t('settings.logStorageDesc', { size: formatFileSize(logSize) })}
            </Text>
          </div>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={loadLogSize}
              loading={logSizeLoading}
            />
            <Button
              icon={<DeleteOutlined />}
              danger
              onClick={handleClearLogs}
              loading={clearingLogs}
            >
              {t('settings.clearLogs')}
            </Button>
          </Space>
        </div>
        <Divider />
        <Button danger loading={clearing} onClick={handleClearAllData}>
          {t('settings.clearAllData')}
        </Button>
      </div>
    </div>
  )
}

export default React.memo(StorageSettings)
