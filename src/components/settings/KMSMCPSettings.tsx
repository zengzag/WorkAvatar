import React, { useState, useEffect, useCallback } from 'react'
import {
  Typography, Switch, InputNumber, Input, Button, Divider, Space, Tag, App, theme, Descriptions, Alert
} from 'antd'
import {
  PlayCircleOutlined, StopOutlined, CopyOutlined, ApiOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Title, Text, Paragraph } = Typography

interface KMSMCPConfig {
  enabled: boolean
  port: number
  apiKey: string
}

interface KMSMCPStatus {
  running: boolean
  port: number
  url: string
}

const KMSMCPSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  const [config, setConfig] = useState<KMSMCPConfig>({
    enabled: false,
    port: 3101,
    apiKey: '',
  })
  const [status, setStatus] = useState<KMSMCPStatus>({ running: false, port: 3101, url: '' })
  const [loading, setLoading] = useState(false)
  const [switchLoading, setSwitchLoading] = useState(false)

  const loadConfig = useCallback(async () => {
    try {
      const [cfg, st] = await Promise.all([
        window.electronAPI.kmsMcp.getConfig(),
        window.electronAPI.kmsMcp.getStatus(),
      ])
      setConfig(cfg)
      setStatus(st)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  const handleToggle = useCallback(async (checked: boolean) => {
    setSwitchLoading(true)
    try {
      if (checked) {
        await window.electronAPI.kmsMcp.setConfig({ enabled: true })
        const result = await window.electronAPI.kmsMcp.start()
        if (!result.success) {
          message.error(result.error || t('common.failed'))
          return
        }
        message.success(t('settings.kmsMcpStarted'))
      } else {
        await window.electronAPI.kmsMcp.stop()
        await window.electronAPI.kmsMcp.setConfig({ enabled: false })
        message.success(t('settings.kmsMcpStopped'))
      }
      const st = await window.electronAPI.kmsMcp.getStatus()
      setStatus(st)
      setConfig((prev) => ({ ...prev, enabled: checked }))
    } catch {
      message.error(t('common.failed'))
    } finally {
      setSwitchLoading(false)
    }
  }, [message, t])

  const handlePortChange = useCallback(async (value: number | null) => {
    const port = value || 3101
    setConfig((prev) => ({ ...prev, port }))
  }, [])

  const handlePortSave = useCallback(async () => {
    if (status.running) {
      message.warning(t('settings.kmsMcpStopFirst'))
      return
    }
    try {
      await window.electronAPI.kmsMcp.setConfig({ port: config.port })
      message.success(t('settings.saved'))
    } catch {
      message.error(t('common.saveFailed'))
    }
  }, [status.running, config.port, message, t])

  const handleApiKeyChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const apiKey = e.target.value
    setConfig((prev) => ({ ...prev, apiKey }))
  }, [])

  const handleApiKeySave = useCallback(async () => {
    try {
      await window.electronAPI.kmsMcp.setConfig({ apiKey: config.apiKey })
      message.success(t('settings.saved'))
    } catch {
      message.error(t('common.saveFailed'))
    }
  }, [config.apiKey, message, t])

  const handleCopyUrl = useCallback(() => {
    if (status.url) {
      // clipboard API 在某些环境下可能被拒绝，吞掉错误避免未处理的 Promise 拒绝
      navigator.clipboard.writeText(status.url).catch(() => {})
      message.success(t('settings.kmsMcpUrlCopied'))
    }
  }, [status.url, message, t])

  const handleRefresh = useCallback(async () => {
    setLoading(true)
    try {
      const st = await window.electronAPI.kmsMcp.getStatus()
      setStatus(st)
    } finally {
      setLoading(false)
    }
  }, [])

  const mcpUrl = status.running ? status.url : `http://localhost:${config.port}/mcp`

  return (
    <div>
      <Title level={5}>{t('settings.kmsMcpTitle')}</Title>
      <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 20 }}>
        {t('settings.kmsMcpDesc')}
      </Paragraph>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Text strong>{t('settings.kmsMcpEnable')}</Text>
            <br />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('settings.kmsMcpEnableDesc')}
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
            <Text strong>{t('settings.kmsMcpPort')}</Text>
            <br />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('settings.kmsMcpPortDesc')}
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
            {t('settings.kmsMcpApiKey')}
          </Text>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            {t('settings.kmsMcpApiKeyDesc')}
          </Text>
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password
              value={config.apiKey}
              onChange={handleApiKeyChange}
              placeholder={t('settings.kmsMcpApiKeyPlaceholder')}
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
              {t('settings.kmsMcpConnectionInfo')}
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
              title={t('settings.kmsMcpRunning')}
              style={{ marginBottom: 12 }}
            />
          )}

          {!status.running && (
            <Alert
              type="warning"
              showIcon
              icon={<StopOutlined />}
              title={t('settings.kmsMcpStopped')}
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
            <Descriptions.Item label={t('settings.kmsMcpEndpoint')}>
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
            <Descriptions.Item label={t('settings.kmsMcpProtocol')}>
              MCP Streamable HTTP
            </Descriptions.Item>
            <Descriptions.Item label={t('settings.kmsMcpAuth')}>
              {config.apiKey ? (
                <Tag color="green">{t('settings.kmsMcpAuthEnabled')}</Tag>
              ) : (
                <Tag color="orange">{t('settings.kmsMcpAuthDisabled')}</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label={t('settings.kmsMcpTools')}>
              <Space wrap size={[4, 4]}>
                <Tag>kms_list_dirs</Tag>
                <Tag>kms_stats</Tag>
                <Tag>kms_search</Tag>
                <Tag>kms_get_content</Tag>
                <Tag>kms_get_summary</Tag>
                <Tag>kms_list_collections</Tag>
                <Tag>kms_list_files_in_collection</Tag>
                <Tag>kms_get_collection_summary</Tag>
              </Space>
            </Descriptions.Item>
          </Descriptions>
        </div>

        <Divider style={{ margin: '4px 0' }} />

        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            {t('settings.kmsMcpUsageTitle')}
          </Text>
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            {t('settings.kmsMcpUsageDesc')}
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
    "workavatar-kms": {
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

export default React.memo(KMSMCPSettings)
