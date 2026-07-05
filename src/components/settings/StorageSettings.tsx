import React, { useState, useEffect, useCallback } from 'react'
import { Button, Divider, Input, Typography, App } from 'antd'
import { FolderOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography

const StorageSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const [dataDir, setDataDir] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)

  const loadDataDir = useCallback(async () => {
    try {
      const dir = await window.electronAPI.app.getDataDir()
      setDataDir(dir || '')
    } catch {
      setDataDir('')
    }
  }, [])

  useEffect(() => {
    loadDataDir()
  }, [loadDataDir])

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

  return (
    <div>
      <Title level={5}>{t('settings.storageTitle')}</Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ flex: 1, marginRight: 16 }}>
            <Text strong>{t('settings.dataDir')}</Text>
            <br />
            <Text type="secondary">{t('settings.dataDirDesc')}</Text>
            <Input
              value={dataDir}
              readOnly
              style={{ marginTop: 8 }}
              addonAfter={
                <ReloadOutlined onClick={loadDataDir} style={{ cursor: 'pointer' }} />
              }
            />
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
        <Button danger loading={clearing} onClick={handleClearAllData}>
          {t('settings.clearAllData')}
        </Button>
      </div>
    </div>
  )
}

export default React.memo(StorageSettings)
