import { useState, useEffect, useCallback } from 'react'
import {
  Typography, Switch, InputNumber, Input, Select, Button, Divider, Space, Tag, App, theme, Descriptions, Alert
} from 'antd'
import {
  PlayCircleOutlined, StopOutlined, CopyOutlined, ApiOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Title, Text, Paragraph } = Typography

interface MCPConfig {
  enabled: boolean
  port: number
  allowedKbIds: string[]
  apiKey: string
}

interface MCPStatus {
  running: boolean
  port: number
  url: string
}

interface KBInfo {
  id: string
  name: string
  doc_count?: number
}

const KBMCPSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  const [config, setConfig] = useState<MCPConfig>({
    enabled: false,
    port: 3100,
    allowedKbIds: [],
    apiKey: '',
  })
  const [status, setStatus] = useState<MCPStatus>({ running: false, port: 3100, url: '' })
  const [kbList, setKbList] = useState<KBInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [switchLoading, setSwitchLoading] = useState(false)

  const loadConfig = useCallback(async () => {
    try {
      const [cfg, st, kbs] = await Promise.all([
        window.electronAPI.kbMcp.getConfig(),
        window.electronAPI.kbMcp.getStatus(),
        window.electronAPI.kb.list(),
      ])
      setConfig(cfg)
      setStatus(st)
      setKbList(
        (kbs || []).map((kb: any) => ({
          id: kb.id,
          name: kb.name,
          doc_count: kb.doc_count,
        }))
      )
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  const handleToggle = async (checked: boolean) => {
    setSwitchLoading(true)
    try {
      if (checked) {
        await window.electronAPI.kbMcp.setConfig({ enabled: true })
        const result = await window.electronAPI.kbMcp.start()
        if (!result.success) {
          message.error(result.error || t('common.failed'))
          return
        }
        message.success(t('settings.kbMcpStarted'))
      } else {
        await window.electronAPI.kbMcp.stop()
        await window.electronAPI.kbMcp.setConfig({ enabled: false })
        message.success(t('settings.kbMcpStopped'))
      }
      const st = await window.electronAPI.kbMcp.getStatus()
      setStatus(st)
      setConfig((prev) => ({ ...prev, enabled: checked }))
    } catch {
      message.error(t('common.failed'))
    } finally {
      setSwitchLoading(false)
    }
  }

  const handlePortChange = async (value: number | null) => {
    const port = value || 3100
    setConfig((prev) => ({ ...prev, port }))
  }

  const handlePortSave = async () => {
    if (status.running) {
      message.warning(t('settings.kbMcpStopFirst'))
      return
    }
    try {
      await window.electronAPI.kbMcp.setConfig({ port: config.port })
      message.success(t('settings.saved'))
    } catch {
      message.error(t('common.saveFailed'))
    }
  }

  const handleKbIdsChange = async (values: string[]) => {
    setConfig((prev) => ({ ...prev, allowedKbIds: values }))
    try {
      await window.electronAPI.kbMcp.setConfig({ allowedKbIds: values })
    } catch {
      // save silently
    }
  }

  const handleApiKeyChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const apiKey = e.target.value
    setConfig((prev) => ({ ...prev, apiKey }))
  }

  const handleApiKeySave = async () => {
    try {
      await window.electronAPI.kbMcp.setConfig({ apiKey: config.apiKey })
      message.success(t('settings.saved'))
    } catch {
      message.error(t('common.saveFailed'))
    }
  }

  const handleCopyUrl = () => {
    if (status.url) {
      navigator.clipboard.writeText(status.url)
      message.success(t('settings.kbMcpUrlCopied'))
    }
  }

  const handleRefresh = async () => {
    setLoading(true)
    try {
      const st = await window.electronAPI.kbMcp.getStatus()
      setStatus(st)
    } finally {
      setLoading(false)
    }
  }

  const mcpUrl = status.running ? status.url : `http://localhost:${config.port}/mcp`

  return (
    <div>
      <Title level={5}>{t('settings.kbMcpTitle')}</Title>
      <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 20 }}>
        {t('settings.kbMcpDesc')}
      </Paragraph>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Text strong>{t('settings.kbMcpEnable')}</Text>
            <br />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('settings.kbMcpEnableDesc')}
            </Text>
          </div>
          <Switch
            checked={status.running}
            onChange={handleToggle}
            loading={switchLoading}
            checkedChildren={t('common.on')}
            unCheckedChildren={t('common.off')}
          />
        </div>

        <Divider style={{ margin: '4px 0' }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Text strong>{t('settings.kbMcpPort')}</Text>
            <br />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('settings.kbMcpPortDesc')}
            </Text>
          </div>
          <Space>
            <InputNumber
              min={1024}
              max={65535}
              value={config.port}
              onChange={handlePortChange}
              disabled={status.running}
              style={{ width: 120 }}
            />
            <Button
              size="small"
              type="primary"
              onClick={handlePortSave}
              disabled={status.running}
            >
              {t('common.save')}
            </Button>
          </Space>
        </div>

        <Divider style={{ margin: '4px 0' }} />

        <div>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>
            {t('settings.kbMcpAllowedKbs')}
          </Text>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            {t('settings.kbMcpAllowedKbsDesc')}
          </Text>
          <Select
            mode="multiple"
            value={config.allowedKbIds}
            onChange={handleKbIdsChange}
            style={{ width: '100%' }}
            placeholder={t('settings.kbMcpAllowedKbsPlaceholder')}
            options={kbList.map((kb) => ({
              label: `${kb.name}${kb.doc_count ? ` (${kb.doc_count} docs)` : ''}`,
              value: kb.id,
            }))}
            allowClear
          />
        </div>

        <Divider style={{ margin: '4px 0' }} />

        <div>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>
            {t('settings.kbMcpApiKey')}
          </Text>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            {t('settings.kbMcpApiKeyDesc')}
          </Text>
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password
              value={config.apiKey}
              onChange={handleApiKeyChange}
              placeholder={t('settings.kbMcpApiKeyPlaceholder')}
              style={{ flex: 1 }}
            />
            <Button type="primary" onClick={handleApiKeySave}>
              {t('common.save')}
            </Button>
          </Space.Compact>
        </div>

        <Divider style={{ margin: '4px 0' }} />

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text strong>
              <ApiOutlined style={{ marginRight: 6 }} />
              {t('settings.kbMcpConnectionInfo')}
            </Text>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={handleRefresh}
              loading={loading}
            >
              {t('common.refresh')}
            </Button>
          </div>

          {status.running && (
            <Alert
              type="success"
              showIcon
              icon={<PlayCircleOutlined />}
              message={t('settings.kbMcpRunning')}
              style={{ marginBottom: 12 }}
            />
          )}

          {!status.running && (
            <Alert
              type="warning"
              showIcon
              icon={<StopOutlined />}
              message={t('settings.kbMcpStopped')}
              style={{ marginBottom: 12 }}
            />
          )}

          <Descriptions
            column={1}
            size="small"
            bordered
            styles={{
              label: { width: 140, background: token.colorBgContainer },
              content: { background: token.colorBgContainer },
            }}
          >
            <Descriptions.Item label={t('settings.kbMcpEndpoint')}>
              <Space>
                <Tag color={status.running ? 'green' : 'default'}>{mcpUrl}</Tag>
                {status.running && (
                  <Button
                    type="link"
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={handleCopyUrl}
                  />
                )}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label={t('settings.kbMcpProtocol')}>
              MCP Streamable HTTP
            </Descriptions.Item>
            <Descriptions.Item label={t('settings.kbMcpAuth')}>
              {config.apiKey ? (
                <Tag color="green">{t('settings.kbMcpAuthEnabled')}</Tag>
              ) : (
                <Tag color="orange">{t('settings.kbMcpAuthDisabled')}</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label={t('settings.kbMcpTools')}>
              <Space wrap size={[4, 4]}>
                <Tag>kb_list</Tag>
                <Tag>kb_overview</Tag>
                <Tag>kb_get_toc</Tag>
                <Tag>kb_get_paragraphs</Tag>
                <Tag>kb_search</Tag>
                <Tag>kb_get_content</Tag>
              </Space>
            </Descriptions.Item>
          </Descriptions>
        </div>

        <Divider style={{ margin: '4px 0' }} />

        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            {t('settings.kbMcpUsageTitle')}
          </Text>
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            {t('settings.kbMcpUsageDesc')}
          </Paragraph>
          <pre
            style={{
              background: token.colorBgContainer,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadius,
              padding: 12,
              fontSize: 12,
              overflow: 'auto',
              margin: 0,
            }}
          >
{`{
  "mcpServers": {
    "workavatar-kb": {
      "type": "streamableHttp",
      "url": "${mcpUrl}"${config.apiKey ? `,\\n      "headers": {\\n        "Authorization": "Bearer YOUR_API_KEY"\\n      }` : ''}
    }
  }
}`}
          </pre>
        </div>
      </div>
    </div>
  )
}

export default KBMCPSettings
