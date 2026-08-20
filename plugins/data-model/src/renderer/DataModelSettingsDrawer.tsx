// 数据模型设置面板

import { Drawer, Select, Button, Divider, Typography, Space } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { useDataModelStore } from './data-model.store'
import { hostT } from './store'

interface Props {
  open: boolean
  onClose: () => void
}

export function DataModelSettingsDrawer({ open, onClose }: Props) {
  const providers = useDataModelStore((s) => s.providers)
  const settings = useDataModelStore((s) => s.settings)
  const dataDir = useDataModelStore((s) => s.dataDir)
  const { saveSettings, openDataDir } = useDataModelStore.getState()

  const selectedProvider = providers.find((p) => p.id === settings.defaultProviderId)
  const models = selectedProvider?.models_json
    ? (() => {
        try { return JSON.parse(selectedProvider.models_json) as Array<{ id: string; model: string; name?: string }> } catch { return [] }
      })()
    : []

  return (
    <Drawer
      title={hostT('page.settings')}
      open={open}
      onClose={onClose}
      width={420}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{hostT('settings.defaultModel')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Select
              style={{ width: '100%' }}
              placeholder={hostT('settings.selectProvider')}
              value={settings.defaultProviderId}
              onChange={(v) => void saveSettings({ defaultProviderId: v, defaultModelId: undefined })}
              options={providers.map((p) => ({ value: p.id, label: p.name }))}
              allowClear
            />
            {selectedProvider && (
              <Select
                style={{ width: '100%' }}
                placeholder={hostT('settings.selectModel')}
                value={settings.defaultModelId}
                onChange={(v) => void saveSettings({ defaultModelId: v })}
                options={models.map((m) => ({ value: m.id, label: m.name ?? m.model }))}
                allowClear
              />
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--dm-muted)', marginTop: 4 }}>{hostT('settings.defaultModelDesc')}</div>
        </div>

        <Divider style={{ margin: '4px 0' }} />

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{hostT('settings.dataDir')}</div>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              {dataDir || '—'}
            </Typography.Text>
            <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void openDataDir()}>
              {hostT('settings.openDataDir')}
            </Button>
          </Space>
          <div style={{ fontSize: 12, color: 'var(--dm-muted)', marginTop: 4 }}>{hostT('settings.dataDirDesc')}</div>
        </div>
      </div>
    </Drawer>
  )
}
