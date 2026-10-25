import { useCallback, useEffect, useState } from 'react'
import { App, Button, Card, Empty, Popconfirm, Space, Spin, Switch, Tag, Tooltip, Typography } from 'antd'
import {
  DeleteOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  SettingOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { PluginImportResult, PluginInfo } from '../../../electron/shared/channels/plugin'
import PluginSettingsDrawer from './PluginSettingsDrawer'

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
 * 卡片列表同时覆盖有界面插件与纯后台插件（无 renderer/nav），后者通过「插件设置」配置参数。
 */
const PluginsSection: React.FC = () => {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [settingsPlugin, setSettingsPlugin] = useState<PluginInfo | null>(null)

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
      style={{ maxWidth: 1080 }}
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
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {t('settings.plugins.hint')}
      </Typography.Text>

      <Spin spinning={loading}>
        {plugins.length === 0 ? (
          <Empty style={{ padding: '40px 0' }} description={t('settings.plugins.empty')} />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: 12,
              marginTop: 16,
            }}
          >
            {plugins.map((plugin) => (
              <Card
                key={plugin.id}
                size="small"
                style={{ height: '100%', borderColor: 'var(--wa-line)', background: 'var(--wa-panel)' }}
                styles={{ body: { display: 'flex', flexDirection: 'column', gap: 10, height: '100%', padding: 14 } }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{plugin.name}</span>
                      <Tag color={STATUS_COLOR[plugin.status]} style={{ marginInlineEnd: 0 }}>
                        {t(`settings.plugins.status_${plugin.status}`)}
                      </Tag>
                      {!plugin.hasRenderer && (
                        <Tooltip title={t('settings.plugins.headlessHint')}>
                          <Tag style={{ marginInlineEnd: 0 }}>{t('settings.plugins.headless')}</Tag>
                        </Tooltip>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--wa-ink-3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {plugin.id} · v{plugin.version}
                    </div>
                  </div>
                  <Switch
                    size="small"
                    checked={plugin.enabled}
                    onChange={(checked) => handleToggle(plugin, checked)}
                  />
                </div>

                <Typography.Paragraph
                  type="secondary"
                  style={{
                    fontSize: 12.5,
                    marginBottom: 0,
                    minHeight: 36,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {plugin.description || t('settings.plugins.noDescription')}
                </Typography.Paragraph>

                {plugin.statusMessage && (plugin.status === 'error' || plugin.status === 'invalid') && (
                  <Tooltip title={plugin.statusMessage}>
                    <Typography.Text
                      type="danger"
                      style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {plugin.statusMessage}
                    </Typography.Text>
                  </Tooltip>
                )}

                <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
                  <Button
                    size="small"
                    icon={<SettingOutlined />}
                    disabled={!plugin.hasSettings}
                    onClick={() => setSettingsPlugin(plugin)}
                  >
                    {t('settings.plugins.settingsAction')}
                  </Button>
                  <Popconfirm
                    title={t('settings.plugins.deleteConfirm')}
                    onConfirm={() => handleDelete(plugin)}
                  >
                    <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                  </Popconfirm>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Spin>

      <PluginSettingsDrawer
        plugin={settingsPlugin}
        onClose={() => setSettingsPlugin(null)}
      />
    </Card>
  )
}

export default PluginsSection
