import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Button,
  Switch,
  Space,
  Tag,
  Empty,
  Typography,
  Modal,
  Input,
  Tooltip,
  Popconfirm,
  App,
  theme,
  Collapse,
} from 'antd'
import {
  ApiOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  CheckCircleFilled,
  ExclamationCircleFilled,
  ThunderboltOutlined,
  CodeOutlined,
  LinkOutlined,
} from '@ant-design/icons'
import type {
  McpServerInfo,
  McpServerConfig,
  McpTransportType,
  McpTestResult,
} from '../../../electron/shared/ipc-channels'

const { Text, Paragraph } = Typography

interface McpSectionProps {
  employeeId: string
}

/** 新增 Modal 的默认 JSON 模板（标准 mcpServers 格式） */
const DEFAULT_JSON_TEMPLATE = `{
  "mcpServers": {
    "server-name": {
      "type": "streamableHttp",
      "url": "http://localhost:3000/mcp"
    }
  }
}`

/** JSON 解析结果 */
interface ParsedMcpJson {
  servers: McpServerConfig[]
  error?: string
}

/** 从任意对象中提取值为 string 的键值对，构造为 Record<string, string> */
function pickStringEntries(obj: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') result[k] = v
  }
  return result
}

/**
 * 将已存在的 server 转换为标准 MCP JSON 配置格式（用于编辑回填）。
 * 输出形如：{ "mcpServers": { "<name>": { "type": "...", ... } } }
 */
function serverToJson(server: McpServerInfo): string {
  const config: Record<string, any> = { type: server.transport_type }
  if (server.transport_type === 'stdio') {
    if (server.command) config.command = server.command
    if (server.args && server.args.length > 0) config.args = server.args
    if (server.env && Object.keys(server.env).length > 0) config.env = server.env
  } else {
    if (server.url) config.url = server.url
    if (server.headers && Object.keys(server.headers).length > 0) config.headers = server.headers
  }
  return JSON.stringify({
    mcpServers: {
      [server.name]: config,
    },
  }, null, 2)
}

/**
 * 解析 MCP JSON 配置。
 *
 * 支持标准格式：{ "mcpServers": { "<name>": { "type": "...", ... } } }
 * 也兼容直接 { "<name>": { ... } } 的简写格式。
 *
 * type 字段标准化：
 *   - "stdio" 或 (省略 type 但提供 command) → stdio
 *   - "streamableHttp" 或 "http"            → streamableHttp
 *   - "sse"                                 → sse
 */
function parseMcpJson(text: string): ParsedMcpJson {
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch (err: any) {
    return { servers: [], error: `JSON 解析失败: ${err.message}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { servers: [], error: '配置必须是 JSON 对象' }
  }
  // 兼容 { mcpServers: {...} } 和直接 {...} 两种格式
  const serversObj = parsed.mcpServers || parsed
  if (!serversObj || typeof serversObj !== 'object' || Array.isArray(serversObj)) {
    return { servers: [], error: '缺少 mcpServers 字段或格式不正确' }
  }
  const serverNames = Object.keys(serversObj)
  if (serverNames.length === 0) {
    return { servers: [], error: 'mcpServers 不能为空' }
  }
  const servers: McpServerConfig[] = []
  for (const name of serverNames) {
    if (!name.trim()) {
      return { servers: [], error: '服务器名称不能为空' }
    }
    const raw = serversObj[name]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { servers: [], error: `服务器 "${name}" 的配置必须是对象` }
    }
    // 标准化 type 字段
    let transportType: McpTransportType
    const rawType = raw.type
    if (rawType === 'stdio' || (!rawType && raw.command)) {
      transportType = 'stdio'
    } else if (rawType === 'streamableHttp' || rawType === 'http') {
      transportType = 'streamableHttp'
    } else if (rawType === 'sse') {
      transportType = 'sse'
    } else {
      return {
        servers: [],
        error: `服务器 "${name}" 的 type 字段无效（应为 stdio / streamableHttp / sse）`,
      }
    }
    const config: McpServerConfig = {
      name: name.trim(),
      transport_type: transportType,
      is_enabled: true,
    }
    if (transportType === 'stdio') {
      if (!raw.command || typeof raw.command !== 'string') {
        return { servers: [], error: `服务器 "${name}" 缺少 command 字段` }
      }
      config.command = raw.command
      config.args = Array.isArray(raw.args)
        ? raw.args.filter((a: any) => typeof a === 'string')
        : []
      config.env = (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env))
        ? pickStringEntries(raw.env as Record<string, any>)
        : {}
    } else {
      if (!raw.url || typeof raw.url !== 'string') {
        return { servers: [], error: `服务器 "${name}" 缺少 url 字段` }
      }
      config.url = raw.url
      config.headers = (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers))
        ? pickStringEntries(raw.headers as Record<string, any>)
        : {}
    }
    servers.push(config)
  }
  return { servers }
}

const McpSection: React.FC<McpSectionProps> = ({ employeeId }) => {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()

  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [jsonText, setJsonText] = useState(DEFAULT_JSON_TEMPLATE)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testingForm, setTestingForm] = useState(false)

  const loadServers = useCallback(async () => {
    if (!employeeId) {
      setServers([])
      return
    }
    setLoading(true)
    try {
      const result = await window.electronAPI.mcp.list(employeeId)
      setServers(Array.isArray(result) ? result : [])
    } catch (err: any) {
      message.error(t('employeeSettings.mcpLoadFailed') + (err?.message ? `: ${err.message}` : ''))
      setServers([])
    } finally {
      setLoading(false)
    }
  }, [employeeId, message, t])

  useEffect(() => {
    loadServers()
  }, [loadServers])

  // ============================================================
  // 新增 / 编辑
  // ============================================================

  const openAddModal = useCallback(() => {
    setEditingId(null)
    setJsonText(DEFAULT_JSON_TEMPLATE)
    setModalOpen(true)
  }, [])

  const openEditModal = useCallback((server: McpServerInfo) => {
    setEditingId(server.id)
    setJsonText(serverToJson(server))
    setModalOpen(true)
  }, [])

  const handleSave = useCallback(async () => {
    const { servers: parsed, error } = parseMcpJson(jsonText)
    if (error || parsed.length === 0) {
      message.error(error || t('employeeSettings.mcpJsonEmpty'))
      return
    }
    setSaving(true)
    try {
      if (editingId) {
        // 编辑模式：用第一个 server 更新现有记录，其余作为新增
        const [first, ...rest] = parsed
        await window.electronAPI.mcp.update({
          employee_id: employeeId,
          config: { ...first, id: editingId },
        })
        for (const s of rest) {
          await window.electronAPI.mcp.add({ employee_id: employeeId, config: s })
        }
        message.success(t('employeeSettings.mcpUpdated'))
      } else {
        // 新增模式：批量添加所有 server
        for (const s of parsed) {
          await window.electronAPI.mcp.add({ employee_id: employeeId, config: s })
        }
        message.success(t('employeeSettings.mcpAddedCount', { count: parsed.length }))
      }
      setModalOpen(false)
      loadServers()
    } catch (err: any) {
      message.error(t('employeeSettings.mcpSaveFailed') + (err?.message ? `: ${err.message}` : ''))
    } finally {
      setSaving(false)
    }
  }, [editingId, employeeId, jsonText, loadServers, message, t])

  // ============================================================
  // 删除 / 启用
  // ============================================================

  const handleDelete = useCallback(async (id: string) => {
    try {
      await window.electronAPI.mcp.delete({ id, employee_id: employeeId })
      message.success(t('employeeSettings.mcpDeleted'))
      loadServers()
    } catch (err: any) {
      message.error(t('employeeSettings.mcpDeleteFailed') + (err?.message ? `: ${err.message}` : ''))
    }
  }, [employeeId, loadServers, message, t])

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    try {
      await window.electronAPI.mcp.toggle({ id, enabled, employee_id: employeeId })
      setServers((prev) => prev.map((s) => (s.id === id ? { ...s, is_enabled: enabled } : s)))
    } catch (err: any) {
      message.error(t('employeeSettings.mcpToggleFailed') + (err?.message ? `: ${err.message}` : ''))
    }
  }, [employeeId, message, t])

  // ============================================================
  // 测试 / 刷新工具
  // ============================================================

  const handleTestForm = useCallback(async () => {
    const { servers: parsed, error } = parseMcpJson(jsonText)
    if (error || parsed.length === 0) {
      message.error(error || t('employeeSettings.mcpJsonEmpty'))
      return
    }
    // 测试第一个 server（用户如需测试其他可保存后用列表中的"刷新工具"按钮）
    const first = parsed[0]
    setTestingForm(true)
    try {
      const result: McpTestResult = await window.electronAPI.mcp.test({ config: first })
      if (result.success) {
        const toolCount = result.tools?.length || 0
        const serverName = result.serverInfo?.name || ''
        const version = result.serverInfo?.version || ''
        modal.success({
          title: t('employeeSettings.mcpTestSuccess'),
          content: (
            <div>
              <Paragraph>
                {t('employeeSettings.mcpTestConnectedTools', { count: toolCount })}
                {serverName && (
                  <Tag color="blue" style={{ marginLeft: 8 }}>
                    {serverName}
                    {version ? ` v${version}` : ''}
                  </Tag>
                )}
              </Paragraph>
              {parsed.length > 1 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('employeeSettings.mcpTestFirstOnly', { total: parsed.length })}
                </Text>
              )}
              {toolCount > 0 && (
                <Space wrap size={[4, 4]} style={{ marginTop: 8 }}>
                  {result.tools!.slice(0, 20).map((tool) => (
                    <Tooltip key={tool.name} title={tool.description}>
                      <Tag>{tool.name}</Tag>
                    </Tooltip>
                  ))}
                  {toolCount > 20 && <Tag>+{toolCount - 20}</Tag>}
                </Space>
              )}
            </div>
          ),
        })
      } else {
        modal.error({
          title: t('employeeSettings.mcpTestFailed'),
          content: <Text type="danger" style={{ wordBreak: 'break-all' }}>{result.error}</Text>,
        })
      }
    } catch (err: any) {
      message.error(t('employeeSettings.mcpTestFailed') + (err?.message ? `: ${err.message}` : ''))
    } finally {
      setTestingForm(false)
    }
  }, [jsonText, message, modal, t])

  const handleRefreshTools = useCallback(async (server: McpServerInfo) => {
    setTestingId(server.id)
    try {
      const result: McpTestResult = await window.electronAPI.mcp.refreshTools({
        id: server.id,
        employee_id: employeeId,
      })
      if (result.success) {
        const count = result.tools?.length || 0
        message.success(t('employeeSettings.mcpRefreshSuccess', { count }))
        loadServers()
      } else {
        message.error(t('employeeSettings.mcpRefreshFailed') + (result.error ? `: ${result.error}` : ''))
        loadServers()
      }
    } catch (err: any) {
      message.error(t('employeeSettings.mcpRefreshFailed') + (err?.message ? `: ${err.message}` : ''))
    } finally {
      setTestingId(null)
    }
  }, [employeeId, loadServers, message, t])

  // ============================================================
  // 渲染辅助
  // ============================================================

  const statusTag = useCallback((server: McpServerInfo) => {
    if (!server.is_enabled) {
      return <Tag color="default">{t('employeeSettings.mcpStatusDisabled')}</Tag>
    }
    switch (server.status) {
      case 'connected':
        return (
          <Tag color="success" icon={<CheckCircleFilled />}>
            {t('employeeSettings.mcpStatusConnected')}
          </Tag>
        )
      case 'error':
        return (
          <Tooltip title={server.last_error || ''}>
            <Tag color="error" icon={<ExclamationCircleFilled />}>
              {t('employeeSettings.mcpStatusError')}
            </Tag>
          </Tooltip>
        )
      case 'disconnected':
        return <Tag color="warning">{t('employeeSettings.mcpStatusDisconnected')}</Tag>
      default:
        return <Tag color="default">{t('employeeSettings.mcpStatusUnknown')}</Tag>
    }
  }, [t])

  const transportIcon = useCallback((type: McpTransportType) => {
    if (type === 'stdio') return <CodeOutlined />
    if (type === 'streamableHttp' || type === 'sse') return <LinkOutlined />
    return <ApiOutlined />
  }, [])

  const transportLabel = useCallback((type: McpTransportType) => {
    switch (type) {
      case 'stdio': return 'stdio'
      case 'streamableHttp': return 'Streamable HTTP'
      case 'sse': return 'SSE'
      default: return type
    }
  }, [])

  const totalTools = useMemo(
    () => servers.filter((s) => s.is_enabled).reduce((sum, s) => sum + (s.tools?.length || 0), 0),
    [servers]
  )

  // ============================================================
  // 渲染
  // ============================================================

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={16}>
      {/* MCP 服务列表 */}
      <Card
        title={
          <Space>
            <ApiOutlined />
            <span>{t('employeeSettings.mcpServerList', { count: servers.length })}</span>
            {totalTools > 0 && (
              <Tag color="blue" style={{ marginLeft: 8 }}>
                {t('employeeSettings.mcpTotalTools', { count: totalTools })}
              </Tag>
            )}
          </Space>
        }
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openAddModal}>
            {t('employeeSettings.mcpAddServer')}
          </Button>
        }
        loading={loading}
      >
        {servers.length === 0 ? (
          <Empty
            description={
              <Space orientation="vertical" size={4}>
                <Text type="secondary">{t('employeeSettings.mcpEmpty')}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('employeeSettings.mcpEmptyHint')}
                </Text>
              </Space>
            }
          />
        ) : (
          <div>
            {servers.map((server) => (
              <div
                key={server.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  padding: '12px 0',
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: server.is_enabled ? token.colorPrimaryBg : token.colorFillTertiary,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: server.is_enabled ? token.colorPrimary : token.colorTextTertiary,
                      fontSize: 18,
                      flexShrink: 0,
                    }}
                  >
                    {transportIcon(server.transport_type)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Text strong ellipsis style={{ display: 'inline-block', maxWidth: 300 }}>
                        {server.name}
                      </Text>
                      <Tag color="default" style={{ flexShrink: 0 }}>{transportLabel(server.transport_type)}</Tag>
                      {statusTag(server)}
                      {server.tools && server.tools.length > 0 && (
                        <Tag color="blue" style={{ flexShrink: 0 }}>
                          {t('employeeSettings.mcpToolsCount', { count: server.tools.length })}
                        </Tag>
                      )}
                    </div>
                    {/* 连接信息 */}
                    <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                      {server.transport_type === 'stdio' ? (
                        <span>
                          <Text code style={{ fontSize: 11 }}>{server.command}</Text>
                          {(server.args || []).length > 0 && (
                            <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                              {server.args!.join(' ')}
                            </Text>
                          )}
                        </span>
                      ) : (
                        <Text code style={{ fontSize: 11 }}>{server.url}</Text>
                      )}
                    </Text>
                    {/* 工具列表（折叠展示） */}
                    {server.tools && server.tools.length > 0 && (
                      <Collapse
                        size="small"
                        style={{ marginTop: 8, background: 'transparent' }}
                        items={[{
                          key: 'tools',
                          label: (
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {t('employeeSettings.mcpToolsList')}
                            </Text>
                          ),
                          children: (
                            <Space wrap size={[4, 4]}>
                              {server.tools.map((tool) => (
                                <Tooltip
                                  key={tool.name}
                                  title={
                                    <div style={{ maxWidth: 320 }}>
                                      <div><strong>{tool.name}</strong></div>
                                      <div style={{ marginTop: 4 }}>{tool.description}</div>
                                    </div>
                                  }
                                >
                                  <Tag style={{ cursor: 'help' }}>{tool.name}</Tag>
                                </Tooltip>
                              ))}
                            </Space>
                          ),
                        }]}
                      />
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                  <Space size={4}>
                    <Tooltip title={t('employeeSettings.mcpRefreshTools')}>
                      <Button
                        size="small"
                        icon={<ReloadOutlined />}
                        onClick={() => handleRefreshTools(server)}
                        loading={testingId === server.id}
                      />
                    </Tooltip>
                    <Tooltip title={t('common.edit')}>
                      <Button
                        size="small"
                        icon={<EditOutlined />}
                        onClick={() => openEditModal(server)}
                      />
                    </Tooltip>
                    <Popconfirm
                      title={t('employeeSettings.mcpConfirmDelete')}
                      description={t('employeeSettings.mcpDeleteDesc')}
                      onConfirm={() => handleDelete(server.id)}
                    >
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                  <Switch
                    checked={server.is_enabled}
                    onChange={(checked) => handleToggle(server.id, checked)}
                    checkedChildren={t('common.enable')}
                    unCheckedChildren={t('common.disable')}
                    size="small"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 使用说明 */}
      <Card
        size="small"
        title={<Space><ThunderboltOutlined /><span>{t('employeeSettings.mcpUsageTitle')}</span></Space>}
      >
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          {t('employeeSettings.mcpUsageDesc')}
        </Paragraph>
        <Paragraph style={{ fontSize: 12, marginBottom: 4 }}>
          <Text strong>stdio</Text>
          <Text type="secondary">：{t('employeeSettings.mcpUsageStdio')}</Text>
        </Paragraph>
        <Paragraph style={{ fontSize: 12, marginBottom: 4 }}>
          <Text strong>Streamable HTTP</Text>
          <Text type="secondary">：{t('employeeSettings.mcpUsageHttp')}</Text>
        </Paragraph>
        <Paragraph style={{ fontSize: 12, marginBottom: 0 }}>
          <Text strong>SSE</Text>
          <Text type="secondary">：{t('employeeSettings.mcpUsageSse')}</Text>
        </Paragraph>
      </Card>

      {/* 新增/编辑 Modal：JSON 导入 */}
      <Modal
        open={modalOpen}
        title={editingId ? t('employeeSettings.mcpEditServer') : t('employeeSettings.mcpAddServer')}
        width={640}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={saving}
        destroyOnHidden
        footer={(_, { OkBtn, CancelBtn }) => (
          <Space>
            <CancelBtn />
            <Button
              icon={<PlayCircleOutlined />}
              loading={testingForm}
              onClick={handleTestForm}
            >
              {t('employeeSettings.mcpTestConnection')}
            </Button>
            <OkBtn />
          </Space>
        )}
      >
        <div style={{ marginTop: 16 }}>
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            {t('employeeSettings.mcpJsonHint')}
          </Paragraph>
          <Input.TextArea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            autoSize={{ minRows: 12, maxRows: 24 }}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
            placeholder={DEFAULT_JSON_TEMPLATE}
            spellCheck={false}
          />
        </div>
      </Modal>
    </Space>
  )
}

export default React.memo(McpSection)
