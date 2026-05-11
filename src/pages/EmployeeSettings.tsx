import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Tabs,
  Form,
  Input,
  Button,
  Select,
  Switch,
  Space,
  Tag,
  Avatar,
  Divider,
  Popconfirm,
  Empty,
  Typography,
  Row,
  Col,
  Statistic,
  Modal,
  Alert,
  Badge,
  Tooltip,
  theme,
  App,
} from 'antd'
import {
  SaveOutlined,
  UserOutlined,
  RobotOutlined,
  FileTextOutlined,
  SettingOutlined,
  BarChartOutlined,
  EditOutlined,
  DeleteOutlined,
  PlusOutlined,
  CheckCircleOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ToolOutlined,
  ApiOutlined,
  LinkOutlined,
  DisconnectOutlined,
  ThunderboltOutlined,
  CalculatorOutlined,
  SearchOutlined,
  ClockCircleOutlined,
  ImportOutlined,
  BookOutlined,
  FileZipOutlined,
  FolderOpenOutlined,
  DatabaseOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import type { Employee, LLMProvider } from '../types'
import { getProviderModelOptions } from '../utils/llm'
import { EMPLOYEE_STATUS_COLOR_MAP, getEmployeeStatusTextMap } from '../utils/status'

const { TextArea } = Input
const { Text } = Typography

interface ToolInfo {
  id: string
  name: string
  title: string
  description: string
  category: string
  is_enabled: boolean
  is_assigned: boolean
}

interface MCPServer {
  id: string
  name: string
  command: string
  status: string
  last_error?: string
}

interface InstalledSkill {
  id: string
  name: string
  description: string
  version: string
  author: string
  tags: string[]
  is_enabled: boolean
  created_at: number
  skillMdContent?: string
}

const AVATAR_OPTIONS = [
  { value: 'default', icon: <RobotOutlined />, color: '#1677ff' },
  { value: 'business', icon: <UserOutlined />, color: '#52c41a' },
  { value: 'document', icon: <FileTextOutlined />, color: '#faad14' },
  { value: 'settings', icon: <SettingOutlined />, color: '#722ed1' },
]

const TOOL_ICON_MAP: Record<string, React.ReactNode> = {
  calculator: <CalculatorOutlined />,
  file_search: <SearchOutlined />,
  date_time: <ClockCircleOutlined />,
  string_utils: <EditOutlined />,
}

const EmployeeSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const [activeTab, setActiveTab] = useState('basic')
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [linkedKBs, setLinkedKBs] = useState<any[]>([])
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()

  const [employeeTools, setEmployeeTools] = useState<ToolInfo[]>([])
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([])
  const [isMcpModalOpen, setIsMcpModalOpen] = useState(false)
  const [mcpForm] = Form.useForm()
  const [editingMcpServer, setEditingMcpServer] = useState<MCPServer | null>(null)
  const [connectingMcp, setConnectingMcp] = useState<string | null>(null)

  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([])
  const [employeeSkills, setEmployeeSkills] = useState<InstalledSkill[]>([])
  const [availableSkills, setAvailableSkills] = useState<InstalledSkill[]>([])
  const [installingSkill, setInstallingSkill] = useState(false)
  const [formLlmProviderId, setFormLlmProviderId] = useState<string>('')

  useEffect(() => {
    if (id) {
      loadEmployee()
      loadProviders()
      loadTools()
      loadMCPServers()
      loadInstalledSkills()
      loadEmployeeSkills()
    }
  }, [id])

  useEffect(() => {
    if (employee) {
      form.setFieldsValue({
        name: employee.name,
        description: employee.description,
        avatar_type: employee.avatar_type,
        status: employee.status,
        review_mode: employee.review_mode,
        llm_provider_id: employee.llm_provider_id,
        llm_model: employee.llm_model,
      })
      setFormLlmProviderId(employee.llm_provider_id || '')
      loadLinkedKBs(employee.project_id)
    }
  }, [employee])

  const loadEmployee = async () => {
    try {
      const result = await window.electronAPI.employee.get(id!)
      setEmployee(result)
    } catch {
      message.error(t('employeeSettings.loadFailed'))
    }
  }

  const loadProviders = async () => {
    try {
      const result = await window.electronAPI.llm.getProviders()
      setProviders(result as LLMProvider[])
    } catch {}
  }

  const loadLinkedKBs = async (projectId: string) => {
    try {
      const result = await window.electronAPI.kb.getKBsForProject(projectId)
      setLinkedKBs(result)
    } catch {}
  }

  const loadTools = async () => {
    try {
      const result = await window.electronAPI.tool.getEmployeeTools({ employee_id: id! })
      setEmployeeTools(result || [])
    } catch {
      console.error('加载工具失败')
    }
  }

  const loadMCPServers = async () => {
    try {
      const result = await window.electronAPI.mcp.listServers()
      setMcpServers(result || [])
    } catch {
      console.error('加载 MCP 服务器失败')
    }
  }

  const loadInstalledSkills = async () => {
    try {
      const result = await window.electronAPI.skillRegistry.list()
      setInstalledSkills(result || [])
    } catch {
      console.error('加载已安装 Skills 失败')
    }
  }

  const loadEmployeeSkills = async () => {
    try {
      const result = await window.electronAPI.skillRegistry.getEmployeeSkills({ employee_id: id! })
      setEmployeeSkills(result.assigned || [])
      setAvailableSkills(result.available || [])
    } catch {
      console.error('加载员工 Skills 失败')
    }
  }

  const handleInstallSkillFromDir = async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: t('employeeSettings.selectSkillDir'),
        properties: ['openDirectory'],
      })
      if (result.canceled || !result.filePaths.length) return

      setInstallingSkill(true)
      const installResult = await window.electronAPI.skillRegistry.install({
        source: 'directory',
        path: result.filePaths[0],
      })

      if (installResult.success) {
        message.success(t('employeeSettings.skillInstalled', { name: installResult.skill?.name }))
        loadInstalledSkills()
        loadEmployeeSkills()
      } else {
        message.error(installResult.error || t('employeeSettings.installFailed'))
      }
    } catch {
      message.error(t('employeeSettings.installFailed'))
    } finally {
      setInstallingSkill(false)
    }
  }

  const handleInstallSkillFromZip = async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: t('employeeSettings.selectSkillZip'),
        properties: ['openFile'],
        filters: [{ name: t('employeeSettings.zipFile'), extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePaths.length) return

      setInstallingSkill(true)
      const installResult = await window.electronAPI.skillRegistry.install({
        source: 'zip',
        path: result.filePaths[0],
      })

      if (installResult.success) {
        message.success(t('employeeSettings.skillInstalled', { name: installResult.skill?.name }))
        loadInstalledSkills()
        loadEmployeeSkills()
      } else {
        message.error(installResult.error || t('employeeSettings.installFailed'))
      }
    } catch {
      message.error(t('employeeSettings.installFailed'))
    } finally {
      setInstallingSkill(false)
    }
  }

  const handleUninstallSkill = async (skillId: string) => {
    try {
      const result = await window.electronAPI.skillRegistry.uninstall(skillId)
      if (result.success) {
        message.success(t('employeeSettings.skillUninstalled'))
        loadInstalledSkills()
        loadEmployeeSkills()
      } else {
        message.error(t('employeeSettings.uninstallFailed'))
      }
    } catch {
      message.error(t('employeeSettings.uninstallFailed'))
    }
  }

  const handleAssignSkill = async (skillId: string) => {
    try {
      await window.electronAPI.skillRegistry.assignToEmployee({
        employee_id: id!,
        skill_id: skillId,
      })
      message.success(t('employeeSettings.skillAssigned'))
      loadEmployeeSkills()
    } catch {
      message.error(t('employeeSettings.assignFailed'))
    }
  }

  const handleRemoveSkill = async (skillId: string) => {
    try {
      await window.electronAPI.skillRegistry.removeFromEmployee({
        employee_id: id!,
        skill_id: skillId,
      })
      message.success(t('employeeSettings.skillRemoved'))
      loadEmployeeSkills()
    } catch {
      message.error(t('employeeSettings.removeFailed'))
    }
  }

  const handleSaveBasic = async (values: any) => {
    setLoading(true)
    try {
      await window.electronAPI.employee.update({
        id: id!,
        ...values,
      })
      message.success(t('common.saveSuccess'))
      loadEmployee()
    } catch {
      message.error(t('common.saveFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleToggleStatus = async () => {
    if (!employee) return
    const newStatus = employee.status === 'active' ? 'paused' : 'active'
    try {
      await window.electronAPI.employee.update({
        id: id!,
        status: newStatus,
      })
      message.success(newStatus === 'active' ? t('employeeSettings.enabled') : t('employeeSettings.paused'))
      loadEmployee()
    } catch {
      message.error(t('employeeSettings.operationFailed'))
    }
  }

  const handleDeleteEmployee = async () => {
    try {
      await window.electronAPI.employee.delete(id!)
      message.success(t('common.deleted'))
      navigate('/dashboard')
    } catch {
      message.error(t('common.deleteFailed'))
    }
  }

  const handleToggleTool = async (toolId: string, enabled: boolean) => {
    try {
      await window.electronAPI.tool.assignToEmployee({
        employee_id: id!,
        tool_id: toolId,
        is_enabled: enabled,
      })
      setEmployeeTools(prev => prev.map(t => t.id === toolId ? { ...t, is_enabled: enabled, is_assigned: true } : t))
      message.success(enabled ? t('employeeSettings.toolEnabled') : t('employeeSettings.toolDisabled'))
    } catch {
      message.error(t('employeeSettings.operationFailed'))
    }
  }

  const handleCreateMCPServer = async (values: any) => {
    try {
      if (editingMcpServer) {
        await window.electronAPI.mcp.updateServer({
          id: editingMcpServer.id,
          ...values,
        })
        message.success(t('employeeSettings.mcpUpdated'))
      } else {
        await window.electronAPI.mcp.createServer({
          name: values.name,
          command: values.command,
          args: values.args ? values.args.split('\n').filter((s: string) => s.trim()) : [],
          env: values.env ? JSON.parse(values.env) : {},
        })
        message.success(t('employeeSettings.mcpCreated'))
      }
      setIsMcpModalOpen(false)
      setEditingMcpServer(null)
      mcpForm.resetFields()
      loadMCPServers()
    } catch {
      message.error(t('common.saveFailed'))
    }
  }

  const handleConnectMCPServer = async (serverId: string) => {
    setConnectingMcp(serverId)
    try {
      const result = await window.electronAPI.mcp.connectServer(serverId)
      if (result.success) {
        message.success(t('employeeSettings.mcpConnected'))
        if (result.tools) {
          message.info(t('employeeSettings.mcpToolsFound', { count: result.tools.length }))
        }
      } else {
        message.error(result.error || t('employeeSettings.mcpConnectFailed'))
      }
      loadMCPServers()
    } catch {
      message.error(t('employeeSettings.mcpConnectFailed'))
    } finally {
      setConnectingMcp(null)
    }
  }

  const handleDisconnectMCPServer = async (serverId: string) => {
    try {
      await window.electronAPI.mcp.disconnectServer(serverId)
      message.success(t('employeeSettings.mcpDisconnected'))
      loadMCPServers()
    } catch {
      message.error(t('employeeSettings.mcpDisconnectFailed'))
    }
  }

  const handleDeleteMCPServer = async (serverId: string) => {
    try {
      await window.electronAPI.mcp.deleteServer(serverId)
      message.success(t('common.deleted'))
      loadMCPServers()
    } catch {
      message.error(t('common.deleteFailed'))
    }
  }

  const openMcpEditor = (server?: MCPServer) => {
    if (server) {
      setEditingMcpServer(server)
      mcpForm.setFieldsValue({
        name: server.name,
        command: server.command,
      })
    } else {
      setEditingMcpServer(null)
      mcpForm.resetFields()
    }
    setIsMcpModalOpen(true)
  }

  if (!employee) {
    return (
      <div style={{ padding: 24 }}>
        <Card loading />
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 24px 24px' }}>
      <PageHeader
        title={employee.name}
        subTitle={t('employeeSettings.subtitle')}
        onBack={() => navigate(`/employee/${id}`)}
        breadcrumb={[
          { title: t('employeeSettings.breadcrumbDashboard') },
          { title: employee.name },
          { title: t('employeeSettings.breadcrumbConfig') },
        ]}
        extra={
          <Space>
            <Tag color={EMPLOYEE_STATUS_COLOR_MAP[employee.status]}>
              {getEmployeeStatusTextMap(t)[employee.status]}
            </Tag>
            <Button
              icon={employee.status === 'active' ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={handleToggleStatus}
            >
              {employee.status === 'active' ? t('employeeSettings.pause') : t('employeeSettings.activate')}
            </Button>
            <Button type="primary" icon={<SaveOutlined />} loading={loading} onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
      />

      <Tabs 
        activeKey={activeTab} 
        onChange={setActiveTab} 
        style={{ marginTop: 16 }}
        items={[
          {
            key: 'basic',
            label: t('employeeSettings.tabBasic'),
            children: (
              <Card>
                <Form form={form} layout="vertical" onFinish={handleSaveBasic}>
                  <Row gutter={24}>
                    <Col span={16}>
                      <Form.Item
                        name="name"
                        label={t('employeeSettings.employeeName')}
                        rules={[{ required: true, message: t('employeeSettings.enterName') }]}
                      >
                        <Input placeholder={t('employeeSettings.namePlaceholder')} />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item name="avatar_type" label={t('employeeSettings.avatarStyle')}>
                        <Select>
                          {AVATAR_OPTIONS.map((opt) => (
                            <Select.Option key={opt.value} value={opt.value}>
                              <Space>
                                <Avatar size="small" style={{ backgroundColor: opt.color }}>
                                  {opt.icon}
                                </Avatar>
                                {opt.value === 'default' && t('employeeSettings.avatarDefault')}
                                {opt.value === 'business' && t('employeeSettings.avatarBusiness')}
                                {opt.value === 'document' && t('employeeSettings.avatarDocument')}
                                {opt.value === 'settings' && t('employeeSettings.avatarSettings')}
                              </Space>
                            </Select.Option>
                          ))}
                        </Select>
                      </Form.Item>
                    </Col>
                  </Row>

                  <Form.Item name="description" label={t('common.description')}>
                    <TextArea rows={3} placeholder={t('employeeSettings.descPlaceholder')} />
                  </Form.Item>

                  <Row gutter={24}>
                    <Col span={12}>
                      <Form.Item name="llm_provider_id" label={t('employeeSettings.llmProvider')}>
                        <Select
                          placeholder={t('employeeSettings.selectProvider')}
                          allowClear
                          onChange={(value) => {
                            setFormLlmProviderId(value || '')
                            form.setFieldValue('llm_model', undefined)
                          }}
                        >
                          {providers.map((p) => (
                            <Select.Option key={p.id} value={p.id}>
                              {p.name} ({p.model})
                            </Select.Option>
                          ))}
                        </Select>
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="llm_model" label={t('employeeSettings.modelName')}>
                        {formLlmProviderId && getProviderModelOptions(providers.find(p => p.id === formLlmProviderId)!).length > 0 ? (
                          <Select
                            placeholder={t('employeeSettings.selectModel')}
                            allowClear
                            options={getProviderModelOptions(providers.find(p => p.id === formLlmProviderId)!)}
                          />
                        ) : (
                          <Input placeholder={t('employeeSettings.modelPlaceholder')} />
                        )}
                      </Form.Item>
                    </Col>
                  </Row>

                  <Form.Item name="review_mode" valuePropName="checked" label={null}>
                    <Switch checkedChildren={t('common.on')} unCheckedChildren={t('common.off')} />
                  </Form.Item>
                  <Text type="secondary">{t('employeeSettings.manualReviewDesc')}</Text>

                  <Divider />

                  <Form.Item>
                    <Space>
                      <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={loading}>
                        {t('employeeSettings.saveBasic')}
                      </Button>
                      <Popconfirm
                        title={t('employeeSettings.confirmDeleteEmployee')}
                        description={t('employeeSettings.deleteEmployeeDesc')}
                        onConfirm={handleDeleteEmployee}
                        okText={t('common.delete')}
                        cancelText={t('common.cancel')}
                        okButtonProps={{ danger: true }}
                      >
                        <Button danger icon={<DeleteOutlined />}>
                          {t('employeeSettings.deleteEmployee')}
                        </Button>
                      </Popconfirm>
                    </Space>
                  </Form.Item>
                </Form>
              </Card>
            )
          },
          {
            key: 'tools',
            label: t('employeeSettings.tabTools'),
            children: (
              <Space orientation="vertical" style={{ width: '100%' }} size={16}>
                <Alert
                  title={t('employeeSettings.toolsAlertTitle')}
                  description={t('employeeSettings.toolsAlertDesc')}
                  type="info"
                  showIcon
                />

                <Card
                  title={
                    <Space>
                      <ToolOutlined />
                      <span>{t('employeeSettings.builtinTools', { count: employeeTools.length })}</span>
                    </Space>
                  }
                >
                  {employeeTools.length === 0 ? (
                    <Empty description={t('employeeSettings.noBuiltinTools')} />
                  ) : (
                    <div>
                      {employeeTools.map((tool) => (
                        <div
                          key={tool.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '12px 0',
                            borderBottom: `1px solid ${token.colorBorderSecondary}`,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                            <Avatar
                              style={{ backgroundColor: tool.is_enabled ? token.colorPrimary : token.colorBgContainer, flexShrink: 0 }}
                              icon={TOOL_ICON_MAP[tool.name] || <ToolOutlined />}
                            />
                            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                              <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                                <Text strong ellipsis style={{ display: 'inline-block' }}>{tool.title || tool.name}</Text>
                                <Tag color="blue" style={{ flexShrink: 0 }}>{t('employeeSettings.builtin')}</Tag>
                              </div>
                              <Text type="secondary" ellipsis style={{ display: 'block' }}>{tool.description || t('employeeSettings.noDesc')}</Text>
                            </div>
                          </div>
                          <Switch
                            checked={tool.is_enabled}
                            onChange={(checked) => handleToggleTool(tool.id, checked)}
                            checkedChildren={t('common.enable')}
                            unCheckedChildren={t('common.disable')}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </Space>
            )
          },
          {
            key: 'skills-market',
            label: t('employeeSettings.tabSkills'),
            children: (
              <Space orientation="vertical" style={{ width: '100%' }} size={16}>
                <Alert
                  title={t('employeeSettings.skillsAlertTitle')}
                  description={t('employeeSettings.skillsAlertDesc')}
                  type="info"
                  showIcon
                />

                <Card
                  title={
                    <Space>
                      <BookOutlined />
                      <span>{t('employeeSettings.installedSkills', { count: installedSkills.length })}</span>
                    </Space>
                  }
                  extra={
                    <Space>
                      <Button icon={<FolderOpenOutlined />} onClick={handleInstallSkillFromDir} loading={installingSkill}>
                        {t('employeeSettings.installFromDir')}
                      </Button>
                      <Button icon={<FileZipOutlined />} onClick={handleInstallSkillFromZip} loading={installingSkill}>
                        {t('employeeSettings.installFromZip')}
                      </Button>
                    </Space>
                  }
                >
                  {installedSkills.length === 0 ? (
                    <Empty description={t('employeeSettings.noInstalledSkills')} />
                  ) : (
                    <div>
                      {installedSkills.map((skill) => (
                        <div
                          key={skill.id}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            padding: '12px 0',
                            borderBottom: `1px solid ${token.colorBorderSecondary}`,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 }}>
                            <Avatar style={{ backgroundColor: '#722ed1', flexShrink: 0 }} icon={<BookOutlined />} />
                            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                              <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                                <Text strong ellipsis style={{ display: 'inline-block' }}>{skill.name}</Text>
                                <Tag color="blue" style={{ flexShrink: 0 }}>v{skill.version}</Tag>
                                <Tag color="default" style={{ flexShrink: 0 }}>{skill.author}</Tag>
                              </div>
                              <Space orientation="vertical" size={0} style={{ width: '100%' }}>
                                <Text type="secondary" ellipsis style={{ display: 'block' }}>{skill.description || skill.skillMdContent?.substring(0, 200).replace(/^#\s+.+\n?/, '').trim() || t('employeeSettings.noDesc')}</Text>
                                <Space size={4} style={{ marginTop: 4 }} wrap>
                                  {skill.tags.map((tag) => (
                                    <Tag key={tag}>{tag}</Tag>
                                  ))}
                                </Space>
                              </Space>
                            </div>
                          </div>
                          <Popconfirm
                            title={t('employeeSettings.confirmUninstallSkill')}
                            description={t('employeeSettings.uninstallSkillDesc')}
                            onConfirm={() => handleUninstallSkill(skill.id)}
                          >
                            <Button type="text" danger icon={<DeleteOutlined />}>
                              {t('common.uninstall')}
                            </Button>
                          </Popconfirm>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <Card
                  title={
                    <Space>
                      <ImportOutlined />
                      <span>{t('employeeSettings.assignedSkills', { count: employeeSkills.length })}</span>
                    </Space>
                  }
                >
                  {employeeSkills.length === 0 ? (
                    <Empty description={t('employeeSettings.noAssignedSkills')} />
                  ) : (
                    <div>
                      {employeeSkills.map((skill) => (
                        <div
                          key={skill.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '12px 0',
                            borderBottom: `1px solid ${token.colorBorderSecondary}`,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                            <Avatar style={{ backgroundColor: token.colorPrimary, flexShrink: 0 }} icon={<BookOutlined />} />
                            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                              <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                                <Text strong ellipsis style={{ display: 'inline-block' }}>{skill.name}</Text>
                                <Tag color="blue" style={{ flexShrink: 0 }}>v{skill.version}</Tag>
                              </div>
                              <Text type="secondary" ellipsis style={{ display: 'block' }}>{skill.description || skill.skillMdContent?.substring(0, 200).replace(/^#\s+.+\n?/, '').trim() || t('employeeSettings.noDesc')}</Text>
                            </div>
                          </div>
                          <Popconfirm
                            title={t('employeeSettings.confirmRemoveSkill')}
                            description={t('employeeSettings.removeSkillDesc')}
                            onConfirm={() => handleRemoveSkill(skill.id)}
                          >
                            <Button type="text" danger icon={<DeleteOutlined />}>
                              {t('common.remove')}
                            </Button>
                          </Popconfirm>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <Card
                  title={
                    <Space>
                      <ThunderboltOutlined />
                      <span>{t('employeeSettings.availableSkills', { count: availableSkills.length })}</span>
                    </Space>
                  }
                >
                  {availableSkills.length === 0 ? (
                    <Empty description={t('employeeSettings.noAvailableSkills')} />
                  ) : (
                    <div>
                      {availableSkills.map((skill) => (
                        <div
                          key={skill.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '12px 0',
                            borderBottom: `1px solid ${token.colorBorderSecondary}`,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                            <Avatar style={{ backgroundColor: token.colorSuccess, flexShrink: 0 }} icon={<BookOutlined />} />
                            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                              <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                                <Text strong ellipsis style={{ display: 'inline-block' }}>{skill.name}</Text>
                                <Tag color="blue" style={{ flexShrink: 0 }}>v{skill.version}</Tag>
                              </div>
                              <Text type="secondary" ellipsis style={{ display: 'block' }}>{skill.description || skill.skillMdContent?.substring(0, 200).replace(/^#\s+.+\n?/, '').trim() || t('employeeSettings.noDesc')}</Text>
                            </div>
                          </div>
                          <Button
                            type="primary"
                            icon={<PlusOutlined />}
                            onClick={() => handleAssignSkill(skill.id)}
                          >
                            {t('common.assign')}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </Space>
            )
          },
          {
            key: 'mcp',
            label: t('employeeSettings.tabMcp'),
            children: (
              <Space orientation="vertical" style={{ width: '100%' }} size={16}>
                <Alert
                  title={t('employeeSettings.mcpAlertTitle')}
                  description={t('employeeSettings.mcpAlertDesc')}
                  type="info"
                  showIcon
                />

                <Card
                  title={
                    <Space>
                      <ApiOutlined />
                      <span>{t('employeeSettings.mcpServerList', { count: mcpServers.length })}</span>
                    </Space>
                  }
                  extra={
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => openMcpEditor()}>
                      {t('employeeSettings.addServer')}
                    </Button>
                  }
                >
                  {mcpServers.length === 0 ? (
                    <Empty description={t('employeeSettings.noMcpServers')} />
                  ) : (
                    <div>
                      {mcpServers.map((server) => (
                        <div
                          key={server.id}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            padding: '12px 0',
                            borderBottom: `1px solid ${token.colorBorderSecondary}`,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 }}>
                            <Avatar
                              style={{
                                backgroundColor:
                                  server.status === 'connected'
                                    ? token.colorSuccess
                                    : server.status === 'error'
                                    ? token.colorError
                                    : token.colorBgContainer,
                                flexShrink: 0,
                              }}
                              icon={<ApiOutlined />}
                            />
                            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                              <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                                <Text strong ellipsis style={{ display: 'inline-block' }}>{server.name}</Text>
                                <Badge
                                  status={
                                    server.status === 'connected'
                                      ? 'success'
                                      : server.status === 'error'
                                      ? 'error'
                                      : 'default'
                                  }
                                  text={
                                    server.status === 'connected'
                                      ? t('employeeSettings.connected')
                                      : server.status === 'error'
                                      ? t('employeeSettings.error')
                                      : t('employeeSettings.notConnected')
                                  }
                                  style={{ flexShrink: 0 }}
                                />
                              </div>
                              <Space orientation="vertical" size={0} style={{ width: '100%' }}>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {t('employeeSettings.command')} {server.command}
                                </Text>
                                {server.last_error && (
                                  <Text type="danger" style={{ fontSize: 12 }}>
                                    {t('employeeSettings.errorLabel')} {server.last_error}
                                  </Text>
                                )}
                              </Space>
                            </div>
                          </div>
                          <Space>
                            {server.status === 'connected' ? (
                              <Button
                                type="text"
                                icon={<DisconnectOutlined />}
                                onClick={() => handleDisconnectMCPServer(server.id)}
                              >
                                {t('common.disconnect')}
                              </Button>
                            ) : (
                              <Button
                                type="primary"
                                icon={<LinkOutlined />}
                                loading={connectingMcp === server.id}
                                onClick={() => handleConnectMCPServer(server.id)}
                              >
                                {t('common.connect')}
                              </Button>
                            )}
                            <Button type="text" icon={<EditOutlined />} onClick={() => openMcpEditor(server)}>
                              {t('common.edit')}
                            </Button>
                            <Popconfirm
                              title={t('employeeSettings.confirmDeleteMcp')}
                              onConfirm={() => handleDeleteMCPServer(server.id)}
                            >
                              <Button type="text" danger icon={<DeleteOutlined />}>
                                {t('common.delete')}
                              </Button>
                            </Popconfirm>
                          </Space>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </Space>
            )
          },
          {
            key: 'knowledge',
            label: t('employeeSettings.tabKnowledge'),
            children: (
              <Card title={t('employeeSettings.projectKb')} extra={<Button type="link" icon={<LinkOutlined />} onClick={() => navigate(`/project/${employee?.project_id}`)}>{t('employeeSettings.manageAssociation')}</Button>}>
                {linkedKBs.length > 0 ? (
                  <div>
                    {linkedKBs.map((kb: any) => (
                      <div
                        key={kb.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          padding: '12px 0',
                          borderBottom: `1px solid ${token.colorBorderSecondary}`,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              width: 40,
                              height: 40,
                              borderRadius: 8,
                              background: token.colorPrimaryBg,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <DatabaseOutlined style={{ fontSize: 20, color: '#722ed1' }} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                            <Tooltip title={kb.name}>
                              <Text strong ellipsis style={{ display: 'block' }}>{kb.name}</Text>
                            </Tooltip>
                            <div style={{ overflow: 'hidden' }}>
                              <Tooltip title={kb.description || t('common.noDescription')}>
                                <Text type="secondary" ellipsis style={{ display: 'block' }}>{kb.description || t('common.noDescription')}</Text>
                              </Tooltip>
                              <Tag style={{ marginTop: 4 }}>{t('common.documents', { count: kb.doc_count || 0 })}</Tag>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty description={t('employeeSettings.noLinkedKb')}>
                    <Button type="primary" onClick={() => navigate(`/project/${employee?.project_id}`)}>
                      {t('employeeSettings.goToLinkKb')}
                    </Button>
                  </Empty>
                )}
              </Card>
            )
          },
          {
            key: 'stats',
            label: t('employeeSettings.tabMonitor'),
            children: (
              <>
                <Row gutter={16}>
                  <Col span={6}>
                    <Card>
                      <Statistic
                        title={t('employeeSettings.totalTasks')}
                        value={employee.total_tasks}
                        prefix={<BarChartOutlined />}
                      />
                    </Card>
                  </Col>
                  <Col span={6}>
                    <Card>
                      <Statistic
                        title={t('employeeSettings.userApprovals')}
                        value={employee.total_approvals}
                        prefix={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
                      />
                    </Card>
                  </Col>
                  <Col span={6}>
                    <Card>
                      <Statistic title={t('employeeSettings.linkedKb')} value={linkedKBs.length} prefix={<DatabaseOutlined />} />
                    </Card>
                  </Col>
                </Row>
                <Card title={t('employeeSettings.versionInfo')} style={{ marginTop: 16 }}>
                  <p>{t('employeeSettings.currentVersion')} v{employee.arch_version}</p>
                  <p>{t('employeeSettings.createTime')} {new Date(employee.created_at * 1000).toLocaleString()}</p>
                  <p>{t('employeeSettings.updateTime')} {new Date(employee.updated_at * 1000).toLocaleString()}</p>
                </Card>
              </>
            )
          }
        ]}
      />

      <Modal
        title={editingMcpServer ? t('employeeSettings.editMcp') : t('employeeSettings.addMcp')}
        open={isMcpModalOpen}
        onCancel={() => {
          setIsMcpModalOpen(false)
          setEditingMcpServer(null)
          mcpForm.resetFields()
        }}
        footer={null}
        width={560}
      >
        <Form form={mcpForm} layout="vertical" onFinish={handleCreateMCPServer}>
          <Form.Item name="name" label={t('employeeSettings.serverName')} rules={[{ required: true, message: t('employeeSettings.enterServerName') }]}>
            <Input placeholder={t('employeeSettings.serverNamePlaceholder')} />
          </Form.Item>
          <Form.Item name="command" label={t('employeeSettings.startCommand')} rules={[{ required: true, message: t('employeeSettings.enterCommand') }]}>
            <Input placeholder={t('employeeSettings.commandPlaceholder')} />
          </Form.Item>
          <Form.Item name="args" label={t('employeeSettings.args')}>
            <TextArea rows={3} placeholder="例如：-m&#10;mcp-server-filesystem&#10;/path/to/allowed/dir" />
          </Form.Item>
          <Form.Item name="env" label={t('employeeSettings.envVars')}>
            <TextArea rows={2} placeholder={`{"API_KEY": "xxx", "DEBUG": "true"}`} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">
                {editingMcpServer ? t('employeeSettings.update') : t('common.create')}
              </Button>
              <Button onClick={() => setIsMcpModalOpen(false)}>{t('common.cancel')}</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default EmployeeSettings
