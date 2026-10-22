import React, { useState, useEffect, useCallback } from 'react'
import { Button, Divider, Input, Space, Typography, Tooltip, theme, App } from 'antd'
import {
  FolderOutlined,
  FolderOpenOutlined,
  FileSearchOutlined,
  ReloadOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { formatFileSize } from '../../utils/format'
import SettingsItem from '../common/SettingsItem'
import type {
  StorageCategoryKey,
  StorageCategoryUsage,
  StorageUsageResult,
} from '../../../electron/shared/ipc-channels'

const { Text, Title } = Typography

// 分类键 → i18n 文案键
const CATEGORY_LABEL_KEY: Record<StorageCategoryKey, string> = {
  dataDir: 'settings.dataDir',
  mainDb: 'settings.storageCatMainDb',
  kmsDb: 'settings.storageCatKmsDb',
  attachments: 'settings.storageCatAttachments',
  workspaces: 'settings.storageCatWorkspaces',
  skills: 'settings.storageCatSkills',
  plugins: 'settings.storageCatPlugins',
  pluginData: 'settings.storageCatPluginData',
  logs: 'settings.storageCatLogs',
  other: 'settings.storageCatOther',
}

const StorageSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const [dataDir, setDataDir] = useState<string>('')
  const [usage, setUsage] = useState<StorageUsageResult | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearingLogs, setClearingLogs] = useState(false)

  const loadUsage = useCallback(async () => {
    setUsageLoading(true)
    try {
      const res = await window.electronAPI.app.getStorageUsage()
      setUsage(res?.categories ? res : null)
      setDataDir(res?.dataDir || '')
    } catch {
      setUsage(null)
    } finally {
      setUsageLoading(false)
    }
  }, [])

  useEffect(() => {
    loadUsage()
  }, [loadUsage])

  const handleOpenPath = useCallback(async (key: StorageCategoryKey) => {
    try {
      const res = await window.electronAPI.app.openStoragePath(key)
      if (!res?.success) {
        message.error(res?.error || t('settings.openPathFailed'))
      }
    } catch {
      message.error(t('settings.openPathFailed'))
    }
  }, [message, t])

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
            await loadUsage()
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
  }, [loadUsage, message, modal, t])

  const renderCategory = (category: StorageCategoryUsage) => {
    // 占比以总占用为基准，便于直观看出"谁最占地方"
    const percent = usage && usage.totalBytes > 0
      ? Math.max(1, Math.round((category.bytes / usage.totalBytes) * 100))
      : 0
    return (
      <div key={category.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <Text style={{ flex: 1, minWidth: 0 }} ellipsis={{ tooltip: category.path }}>
              {t(CATEGORY_LABEL_KEY[category.key])}
            </Text>
            <Text strong style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {formatFileSize(category.bytes)}
            </Text>
          </div>
          <div style={{ height: 4, marginTop: 6, borderRadius: 2, background: token.colorFillSecondary, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${percent}%`, borderRadius: 2, background: token.colorPrimary }} />
          </div>
        </div>
        <Space size={2} style={{ flexShrink: 0 }}>
          {category.canOpen && (
            <Tooltip title={category.isFile ? t('settings.revealInExplorer') : t('settings.openDir')}>
              <Button
                size="small"
                type="text"
                icon={category.isFile ? <FileSearchOutlined /> : <FolderOpenOutlined />}
                onClick={() => handleOpenPath(category.key)}
              />
            </Tooltip>
          )}
          {category.cleanable && (
            <Tooltip title={t('settings.clearLogs')}>
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                loading={clearingLogs}
                onClick={handleClearLogs}
              />
            </Tooltip>
          )}
        </Space>
      </div>
    )
  }

  const diskText = usage?.diskFreeBytes != null && usage?.diskTotalBytes != null
    ? t('settings.storageDisk', {
        free: formatFileSize(usage.diskFreeBytes),
        total: formatFileSize(usage.diskTotalBytes),
      })
    : ''

  return (
    <div>
      <Title level={5}>{t('settings.storageTitle')}</Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SettingsItem
          align="start"
          title={t('settings.dataDir')}
          description={t('settings.dataDirDesc')}
          extra={
            <Space size={8}>
              <Button icon={<FolderOpenOutlined />} onClick={() => handleOpenPath('dataDir')}>
                {t('settings.openDir')}
              </Button>
              <Button type="primary" icon={<FolderOutlined />} onClick={handleSelectDir} loading={loading}>
                {t('settings.selectDir')}
              </Button>
            </Space>
          }
        >
          <Input value={dataDir} readOnly />
        </SettingsItem>
        <Divider style={{ margin: 0 }} />
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text strong style={{ display: 'block' }}>{t('settings.storageUsage')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.storageUsageDesc')}</Text>
            </div>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={loadUsage}
              loading={usageLoading}
            >
              {t('common.refresh')}
            </Button>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 12 }}>
            <Text style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {usage ? formatFileSize(usage.totalBytes) : '--'}
            </Text>
            <Text type="secondary">{t('settings.storageTotal')}</Text>
            {diskText && (
              <Text type="secondary" style={{ marginLeft: 'auto', fontSize: 12 }}>{diskText}</Text>
            )}
          </div>
          <div style={{ marginTop: 4 }}>
            {usage?.categories?.length
              ? usage.categories.map(renderCategory)
              : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {usageLoading ? t('common.loading') : t('settings.storageEmpty')}
                </Text>
              )}
          </div>
        </div>
        <Divider style={{ margin: 0 }} />
        <Button danger block loading={clearing} onClick={handleClearAllData}>
          {t('settings.clearAllData')}
        </Button>
      </div>
    </div>
  )
}

export default React.memo(StorageSettings)
