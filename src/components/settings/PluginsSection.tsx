import { useCallback, useEffect, useState } from 'react'
import { App, Button, List, Popconfirm, Switch, Tag, Tooltip } from 'antd'
import { DeleteOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { PluginInfo } from '../../../electron/shared/channels/plugin'

const STATUS_COLOR: Record<PluginInfo['status'], string> = {
  active: 'success',
  disabled: 'default',
  invalid: 'error',
  error: 'error',
}

/**
 * 插件管理：双目录（resources/plugins 内置 + userData/plugins 用户）同一套加载器。
 * 启停重启生效；仅用户插件可删除。
 */
const PluginsSection: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
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

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: 'var(--ant-color-text-secondary, rgba(0,0,0,0.65))', fontSize: 13 }}>
          {t('settings.plugins.hint')}
        </span>
        <div>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => window.electronAPI.plugin.openPluginsDir()} style={{ marginRight: 8 }}>
            {t('settings.plugins.openDir')}
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>
            {t('settings.plugins.refresh')}
          </Button>
        </div>
      </div>
      {restartHint && (
        <div style={{ marginBottom: 12, fontSize: 13 }}>
          <Tag color="warning">{t('settings.plugins.restartHint')}</Tag>
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
              ...(plugin.source === 'user'
                ? [
                    <Popconfirm
                      key="delete"
                      title={t('settings.plugins.deleteConfirm')}
                      onConfirm={() => handleDelete(plugin)}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>,
                  ]
                : []),
            ]}
          >
            <List.Item.Meta
              title={
                <span>
                  {plugin.name}
                  <Tag style={{ marginLeft: 8 }} color={plugin.source === 'builtin' ? 'blue' : 'purple'}>
                    {plugin.source === 'builtin' ? t('settings.plugins.builtin') : t('settings.plugins.user')}
                  </Tag>
                  <Tag color={STATUS_COLOR[plugin.status]}>
                    {t(`settings.plugins.status_${plugin.status}`)}
                  </Tag>
                  <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.6 }}>v{plugin.version}</span>
                </span>
              }
              description={
                <span style={{ fontSize: 12 }}>
                  {plugin.description || plugin.id}
                  {plugin.statusMessage && plugin.status !== 'active' && plugin.status !== 'disabled' && (
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
    </div>
  )
}

export default PluginsSection
