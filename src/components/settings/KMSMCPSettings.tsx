import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Typography, Switch, InputNumber, Input, Button, Divider, Space, Tag, App, theme, Descriptions, Alert, Tooltip, Empty,
} from 'antd'
import {
  PlayCircleOutlined, StopOutlined, CopyOutlined, ApiOutlined, ReloadOutlined,
  DatabaseOutlined, CalendarOutlined,
  BulbOutlined, GlobalOutlined, MessageOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Title, Text, Paragraph } = Typography

interface KMSMCPConfig {
  enabled: boolean
  port: number
  apiKey: string
  tool_categories?: string[]
}

interface KMSMCPStatus {
  running: boolean
  port: number
  url: string
}

interface MCPToolCategoryInfo {
  id: string
  toolIds: string[]
  defaultEnabled: boolean
  toolCount: number
}

interface MCPExposedTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
  category: string
  toolId: string
}

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  kms: <DatabaseOutlined />,
  calendar: <CalendarOutlined />,
  general: <BulbOutlined />,
  web: <GlobalOutlined />,
  conversation: <MessageOutlined />,
}

const KMSMCPSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  const [config, setConfig] = useState<KMSMCPConfig>({
    enabled: false,
    port: 3101,
    apiKey: '',
    tool_categories: [],
  })
  const [status, setStatus] = useState<KMSMCPStatus>({ running: false, port: 3101, url: '' })
  const [loading, setLoading] = useState(false)
  const [switchLoading, setSwitchLoading] = useState(false)
  const [categories, setCategories] = useState<MCPToolCategoryInfo[]>([])
  const [exposedTools, setExposedTools] = useState<MCPExposedTool[]>([])
  const [loadingCategories, setLoadingCategories] = useState(false)
  const [loadingTools, setLoadingTools] = useState(false)
  const [savingCategory, setSavingCategory] = useState(false)

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

  const loadCategories = useCallback(async () => {
    setLoadingCategories(true)
    try {
      const res = await window.electronAPI.kmsMcp.listCategories()
      setCategories((res || []) as unknown as MCPToolCategoryInfo[])
    } catch {
      // ignore
    } finally {
      setLoadingCategories(false)
    }
  }, [])

  const loadExposedTools = useCallback(async (toolCategories?: string[]) => {
    setLoadingTools(true)
    try {
      const res = await window.electronAPI.kmsMcp.listExposedTools(
        toolCategories ? { tool_categories: toolCategories } : undefined,
      )
      setExposedTools((res || []) as unknown as MCPExposedTool[])
    } catch {
      // ignore
    } finally {
      setLoadingTools(false)
    }
  }, [])

  useEffect(() => {
    loadConfig()
    loadCategories()
  }, [loadConfig, loadCategories])

  useEffect(() => {
    if (config?.tool_categories?.length) {
      loadExposedTools(config.tool_categories)
    } else {
      loadExposedTools()
    }
  }, [loadExposedTools, config?.tool_categories])

  const enabledCategoriesSet = useMemo(() => {
    if (config?.tool_categories?.length) return new Set(config.tool_categories)
    return new Set(categories.filter((c) => c.defaultEnabled).map((c) => c.id))
  }, [config, categories])

  const isCategoryEnabled = useCallback(
    (catId: string): boolean => enabledCategoriesSet.has(catId),
    [enabledCategoriesSet],
  )

  const handleToggleCategory = useCallback(
    async (catId: string, checked: boolean) => {
      setSavingCategory(true)
      try {
        const current: string[] = Array.from(enabledCategoriesSet)
        const next = checked ? [...current, catId] : current.filter((id) => id !== catId)
        await window.electronAPI.kmsMcp.setConfig({ tool_categories: next } as any)
        setConfig((prev) => ({ ...prev, tool_categories: next }))
        message.success(t('settings.mcpCategorySaved'))
      } catch {
        message.error(t('settings.mcpCategorySaveFailed'))
      } finally {
        setSavingCategory(false)
      }
    },
    [enabledCategoriesSet, message, t],
  )

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
      navigator.clipboard.writeText(status.url).catch(() => {})
      message.success(t('settings.kmsMcpUrlCopied'))
    }
  }, [status.url, message, t])

  const handleRefresh = useCallback(async () => {
    setLoading(true)
    try {
      await Promise.all([
        (async () => {
          const st = await window.electronAPI.kmsMcp.getStatus()
          setStatus(st)
        })(),
        loadExposedTools(config.tool_categories),
      ])
    } finally {
      setLoading(false)
    }
  }, [loadExposedTools, config.tool_categories])

  const mcpUrl = status.running ? status.url : `http://localhost:${config.port}/mcp`

  const renderCategoryTitle = (cat: MCPToolCategoryInfo) => {
    const key = `settings.mcpCategory_${cat.id}` as any
    const labeled = t(key, { defaultValue: cat.id })
    return (
      <Space size={6}>
        {CATEGORY_ICON[cat.id] || <BulbOutlined />}
        <Text strong>{labeled}</Text>
        <Tag color="blue" style={{ marginLeft: 4 }}>
          {cat.toolCount}
        </Tag>
      </Space>
    )
  }

  const renderCategoryDesc = (cat: MCPToolCategoryInfo) => {
    const key = `settings.mcpCategory_${cat.id}Desc` as any
    return t(key, { defaultValue: '' })
  }

  return (
    <div>
      <Title level={5}>{t('settings.kmsMcpTitle')}</Title>
      <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 20 }}>
        {t('settings.kmsMcpDesc')}
      </Paragraph>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* 启用开关 */}
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

        {/* 端口 */}
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

        {/* API Key */}
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

        {/* 工具类别细分 */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text strong>{t('settings.mcpCategoryTitle')}</Text>
            {loadingCategories && <Text type="secondary" style={{ fontSize: 12 }}>…</Text>}
          </div>
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            {t('settings.mcpCategoryDesc')}
          </Paragraph>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={<Text style={{ fontSize: 12 }}>{t('settings.mcpCategoryHint')}</Text>}
          />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
              gap: 12,
            }}
          >
            {categories.map((cat) => {
              const checked = isCategoryEnabled(cat.id)
              return (
                <div
                  key={cat.id}
                  style={{
                    padding: 12,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: token.borderRadius,
                    background: token.colorBgContainer,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, marginRight: 12 }}>
                      {renderCategoryTitle(cat)}
                      <div style={{ marginTop: 6 }}>
                        <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
                          {renderCategoryDesc(cat)}
                        </Text>
                      </div>
                    </div>
                    <Switch
                      size="small"
                      checked={checked}
                      loading={savingCategory}
                      onChange={(v) => handleToggleCategory(cat.id, v)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <Divider style={{ margin: '4px 0' }} />

        {/* 连接信息与暴露工具 */}
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
              label: { width: 160, background: token.colorBgContainer },
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
            <Descriptions.Item
              label={
                <Space>
                  <span>{t('settings.kmsMcpTools')}</span>
                  <Tag color="blue">
                    {t('settings.mcpExposedToolCount', { count: exposedTools.length })}
                  </Tag>
                </Space>
              }
            >
              {loadingTools ? (
                <Text type="secondary" style={{ fontSize: 12 }}>…</Text>
              ) : exposedTools.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={null}
                  style={{ margin: '8px 0', padding: 0 }}
                />
              ) : (
                <Space wrap size={[4, 4]}>
                  {exposedTools.map((tool) => (
                    <Tooltip key={tool.toolId || tool.name} title={tool.description || tool.name}>
                      <Tag>{tool.name}</Tag>
                    </Tooltip>
                  ))}
                </Space>
              )}
            </Descriptions.Item>
          </Descriptions>
        </div>

        <Divider style={{ margin: '4px 0' }} />

        {/* 客户端配置示例 */}
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
    "workavatar-mcp": {
      "type": "streamableHttp",
      "url": "${mcpUrl}"${config.apiKey ? `,
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }` : ''}
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
