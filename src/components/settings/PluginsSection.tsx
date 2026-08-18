import { useCallback, useEffect, useState } from 'react'
import { App, Button, Card, List, Popconfirm, Space, Switch, Tag, Tooltip } from 'antd'
import { DeleteOutlined, FolderOpenOutlined, PoweroffOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { PluginInfo } from '../../../electron/shared/channels/plugin'

const STATUS_COLOR: Record<PluginInfo['status'], string> = {
  active: 'success',
  disabled: 'default',
  invalid: 'error',
  error: 'error',
  pending: 'processing',
}

/**
 * 插件管理：全部插件统一为用户来源（dev 自动安装 / zip 导入 / 手动放入目录），同一套加载器。
 * 启停、删除、覆盖升级均重启生效。
 */
const PluginsSection: React.FC = () => {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [restartHint, setRestartHint] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { plugins: list } = await window.electronAPI.plugin.list()
      setPlugins(list)
    } catch {
      message.error(t('settings.plugins.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [message, t])

  useEffect(() => { load() }, [load])

  const handleToggle = async (plugin: PluginInfo, enabled: boolean) => {
    try {
      await window.electronAPI.plugin.setEnabled(plugin.id, enabled)
      setRestartHint(true)
      // 乐观更新列表状态
      setPlugins(prev => prev.map(p =>
        p.id === plugin.id
          ? { ...p, enabled, status: enabled ? p.status : 'disabled' }
          : p
      ))
      message.success(t('settings.plugins.restartRequired'))
    } catch (err: any) {
      message.error(err?.message || t('settings.plugins.operateFailed'))
    }
  }

  const handleDelete = async (plugin: PluginInfo) => {
    try {
      await window.electronAPI.plugin.remove(plugin.id)
      setRestartHint(true)
      setPlugins(prev => prev.filter(p => p.id !== plugin.id))
      message.success(t('settings.plugins.deleted'))
    } catch (err: any) {
      message.error(err?.message || t('settings.plugins.operateFailed'))
    }
  }

  const afterImport = (r: { ok: boolean; id?: string; version?: string; message?: string }) => {
    if (r.ok) {
      setRestartHint(true)
      message.success(t('settings.plugins.importSuccess'))
      load()
    } else if (r.message && r.message !== 'cancelled') {
      message.error(r.message || t('settings.plugins.importFailed'))
    }
  }

  const handleImport = async () => {
    const res = await window.electronAPI.plugin.import(false)
    if (res.needsUpgradeConfirm) {
      const { existingVersion, newVersion } = res.needsUpgradeConfirm
      modal.confirm({
        title: t('settings.plugins.upgradeTitle'),
        content: `${t('settings.plugins.upgradeConfirm')}\n${existingVersion ?? '?'} → ${newVersion ?? '?'}`,
        okText: t('common.confirm'),
        cancelText: t('common.cancel'),
        onOk: async () => {
          const res2 = await window.electronAPI.plugin.import(true)
          if (res2.ok) {
            setRestartHint(true)
            message.success(t('settings.plugins.upgraded'))
            load()
          } else if (res2.message && res2.message !== 'cancelled') {
            message.error(res2.message || t('settings.plugins.importFailed'))
          }
        },
      })
    } else {
      afterImport(res)
    }
  }

  const handleRestart = () => {
    modal.confirm({
      title: t('settings.plugins.restartTitle'),
      content: t('settings.plugins.restartConfirm'),
      okText: t('settings.plugins.restartNow'),
      cancelText: t('common.cancel'),
      onOk: () => window.electronAPI.app.restart(),
    })
  }

  return (
    <Card
      style={{ maxWidth: 760 }}
      title={t('settings.tabPlugins')}
      extra={
        <Space>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => window.electronAPI.plugin.openPluginsDir()}>
            {t('settings.plugins.openDir')}
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>
            {t('settings.plugins.refresh')}
          </Button>
          <Button size="small" type="primary" icon={<UploadOutlined />} onClick={() => handleImport()}>
            {t('settings.plugins.import')}
          </Button>
        </Space>
      }
    >
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: 'var(--ant-color-text-secondary, rgba(0,0,0,0.65))', fontSize: 13 }}>
          {t('settings.plugins.hint')}
        </span>
      </div>
      {restartHint && (
        <div style={{ marginBottom: 12, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tag color="warning">{t('settings.plugins.restartHint')}</Tag>
          <Button size="small" type="primary" icon={<PoweroffOutlined />} onClick={handleRestart}>
            {t('settings.plugins.restartNow')}
          </Button>
        </div>
      )}
      <List
        loading={loading}
        dataSource={plugins}
        locale={{ emptyText: t('settings.plugins.empty') }}
        renderItem={(plugin) => (
          <List.Item
            actions={[
              <Switch
                key="switch"
                size="small"
                checked={plugin.enabled}
                onChange={(checked) => handleToggle(plugin, checked)}
              />,
              <Popconfirm
                key="delete"
                title={t('settings.plugins.deleteConfirm')}
                onConfirm={() => handleDelete(plugin)}
              >
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta
              title={
                <span>
                  {plugin.name}
                  <Tag style={{ marginLeft: 8 }} color={STATUS_COLOR[plugin.status]}>
                    {t(`settings.plugins.status_${plugin.status}`)}
                  </Tag>
                  <Tag style={{ marginLeft: 4 }}>{`v${plugin.version}`}</Tag>
                </span>
              }
              description={
                <span style={{ fontSize: 12 }}>
                  <span style={{ opacity: 0.6 }}>{plugin.id}</span>
                  {plugin.description ? ` · ${plugin.description}` : ''}
                  {plugin.statusMessage && plugin.status === 'error' && (
                    <Tooltip title={plugin.statusMessage}>
                      <span style={{ marginLeft: 8, color: 'var(--ant-color-error, #ff4d4f)' }}>
                        {plugin.statusMessage.slice(0, 60)}
                        {plugin.statusMessage.length > 60 ? '…' : ''}
                      </span>
                    </Tooltip>
                  )}
                </span>
              }
            />
          </List.Item>
        )}
      />
    </Card>
  )
}

export default PluginsSection