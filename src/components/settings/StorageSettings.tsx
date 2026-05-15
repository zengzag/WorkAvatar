import { useState, useEffect, useCallback } from 'react'
import { Button, Divider, Input, message, Typography, Modal } from 'antd'
import { FolderOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography

const StorageSettings: React.FC = () => {
  const { t } = useTranslation()
  const [dataDir, setDataDir] = useState<string>('')
  const [loading, setLoading] = useState(false)

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

  const handleSelectDir = async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: t('settings.selectDir'),
        defaultPath: dataDir,
        properties: ['openDirectory'],
      })
      if (result.canceled || !result.filePaths?.[0]) return

      const newDir = result.filePaths[0]
      Modal.confirm({
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
  }

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
        <Button danger>{t('settings.clearAllData')}</Button>
      </div>
    </div>
  )
}

export default StorageSettings
