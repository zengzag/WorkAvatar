import { useCallback, useEffect, useState } from 'react'
import { App, Button, Card, List, Popconfirm, Space, Switch, Tag, Tooltip } from 'antd'
import { DeleteOutlined, FolderOpenOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { PluginImportResult, PluginInfo } from '../../../electron/shared/channels/plugin'

const STATUS_COLOR: Record<PluginInfo['status'], string> = {
  active: 'success',
  disabled: 'default',
  invalid: 'error',
  error: 'error',
  pending: 'processing',
}

/**
 * 插件管理：全部插件统一为用户来源（dev 自动安装 / zip 导入 / 手动放入目录），同一套加载器。
 * 启用/禁用/删除/导入/覆盖升级均即时生效（主进程增量激活 + 渲染端增量加载，无需重启应用）。
 */
const PluginsSection: React.FC = () => {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(false)

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
      // 宿主已完成增量激活/下线并广播变更，这里仅刷新列表展示
      message.success(t(enabled ? 'settings.plugins.enabled' : 'settings.plugins.disabled'))
      load()
    } catch (err: any) {
      message.error(err?.message || t('settings.plugins.operateFailed'))
    }
  }

  const handleDelete = async (plugin: PluginInfo) => {
    try {
      await window.electronAPI.plugin.remove(plugin.id)
      message.success(t('settings.plugins.deleted'))
      load()
    } catch (err: any) {
      message.error(err?.message || t('settings.plugins.operateFailed'))
    }
  }

  const afterImport = (r: PluginImportResult, upgraded = false) => {
    if (r.ok) {
      const count = r.count ?? 1
      if (count > 1) {
        message.success(t('settings.plugins.importSuccess_other', { count }))
      } else {
        message.success(t(upgraded ? 'settings.plugins.upgraded' : 'settings.plugins.importSuccess'))
      }
      load()
    } else if (r.message && r.message !== 'cancelled') {
      // 多选导入部分成功时也刷新列表
      if ((r.count ?? 0) > 0) load()
      message.error(r.message || t('settings.plugins.importFailed'))
    }
  }

  const handleImport = async () => {
    const res = await window.electronAPI.plugin.import(false)
    if (res.needsUpgradeConfirm) {
      const { existingVersion, newVersion, count } = res.needsUpgradeConfirm
      modal.confirm({
        title: t('settings.plugins.upgradeTitle'),
        content: `${t('settings.plugins.upgradeConfirm', { count: count ?? 1 })}\n${existingVersion ?? '?'} → ${newVersion ?? '?'}`,
        okText: t('common.confirm'),
        cancelText: t('common.cancel'),
        onOk: async () => {
          afterImport(await window.electronAPI.plugin.import(true), true)
        },
      })
    } else {
      afterImport(res)
    }
  }

  // 手动放入插件目录场景：重新扫描磁盘并增量加载变更（不整页刷新）
  const handleRescan = async () => {
    try {
      await window.electronAPI.app.restart()
      load()
    } catch (err: any) {
      message.error(err?.message || t('settings.plugins.operateFailed'))
    }
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
          <Button size="small" icon={<ReloadOutlined />} onClick={handleRescan} loading={loading}>
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