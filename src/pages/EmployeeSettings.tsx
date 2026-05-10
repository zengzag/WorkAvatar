import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
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
  message,
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
      message.error('加载员工信息失败')
    }
  }

  const loadProviders = async () => {
    try {
      const result = await window.electronAPI.llm.getProviders()
      setProviders(result as LLMProvider[])
    } catch {}
  }

  const getProviderModels = (providerId: string): Array<{ value: string; label: string }> => {
    const provider = providers.find(p => p.id === providerId)
    if (!provider?.models_json) return []
    try {
      return JSON.parse(provider.models_json).map((m: any) => ({
        value: m.model,
        label: m.name,
      }))
    } catch {
      return []
    }
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
        title: '选择 Skill 目录',
        properties: ['openDirectory'],
      })
      if (result.canceled || !result.filePaths.length) return

      setInstallingSkill(true)
      const installResult = await window.electronAPI.skillRegistry.install({
        source: 'directory',
        path: result.filePaths[0],
      })

      if (installResult.success) {
        message.success(`Skill "${installResult.skill?.name}" 安装成功`)
        loadInstalledSkills()
        loadEmployeeSkills()
      } else {
        message.error(installResult.error || '安装失败')
      }
    } catch {
      message.error('安装失败')
    } finally {
      setInstallingSkill(false)
    }
  }

  const handleInstallSkillFromZip = async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: '选择 Skill ZIP 文件',
        properties: ['openFile'],
        filters: [{ name: 'ZIP 文件', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePaths.length) return

      setInstallingSkill(true)
      const installResult = await window.electronAPI.skillRegistry.install({
        source: 'zip',
        path: result.filePaths[0],
      })

      if (installResult.success) {
        message.success(`Skill "${installResult.skill?.name}" 安装成功`)
        loadInstalledSkills()
        loadEmployeeSkills()
      } else {
        message.error(installResult.error || '安装失败')
      }
    } catch {
      message.error('安装失败')
    } finally {
      setInstallingSkill(false)
    }
  }

  const handleUninstallSkill = async (skillId: string) => {
    try {
      const result = await window.electronAPI.skillRegistry.uninstall(skillId)
      if (result.success) {
        message.success('Skill 已卸载')
        loadInstalledSkills()
        loadEmployeeSkills()
      } else {
        message.error('卸载失败')
      }
    } catch {
      message.error('卸载失败')
    }
  }

  const handleAssignSkill = async (skillId: string) => {
    try {
      await window.electronAPI.skillRegistry.assignToEmployee({
        employee_id: id!,
        skill_id: skillId,
      })
      message.success('Skill 已分配')
      loadEmployeeSkills()
    } catch {
      message.error('分配失败')
    }
  }

  const handleRemoveSkill = async (skillId: string) => {
    try {
      await window.electronAPI.skillRegistry.removeFromEmployee({
        employee_id: id!,
        skill_id: skillId,
      })
      message.success('Skill 已移除')
      loadEmployeeSkills()
    } catch {
      message.error('移除失败')
    }
  }

  const handleSaveBasic = async (values: any) => {
    setLoading(true)
    try {
      await window.electronAPI.employee.update({
        id: id!,
        ...values,
      })
      message.success('保存成功')
      loadEmployee()
    } catch {
      message.error('保存失败')
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
      message.success(newStatus === 'active' ? '已启用' : '已暂停')
      loadEmployee()
    } catch {
      message.error('操作失败')
    }
  }

  const handleDeleteEmployee = async () => {
    try {
      await window.electronAPI.employee.delete(id!)
      message.success('已删除')
      navigate('/dashboard')
    } catch {
      message.error('删除失败')
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
      message.success(enabled ? '工具已启用' : '工具已禁用')
    } catch {
      message.error('操作失败')
    }
  }

  const handleCreateMCPServer = async (values: any) => {
    try {
      if (editingMcpServer) {
        await window.electronAPI.mcp.updateServer({
          id: editingMcpServer.id,
          ...values,
        })
        message.success('MCP 服务器已更新')
      } else {
        await window.electronAPI.mcp.createServer({
          name: values.name,
          command: values.command,
          args: values.args ? values.args.split('\n').filter((s: string) => s.trim()) : [],
          env: values.env ? JSON.parse(values.env) : {},
        })
        message.success('MCP 服务器已创建')
      }
      setIsMcpModalOpen(false)
      setEditingMcpServer(null)
      mcpForm.resetFields()
      loadMCPServers()
    } catch {
      message.error('保存失败')
    }
  }

  const handleConnectMCPServer = async (serverId: string) => {
    setConnectingMcp(serverId)
    try {
      const result = await window.electronAPI.mcp.connectServer(serverId)
      if (result.success) {
        message.success('MCP 服务器连接成功')
        if (result.tools) {
          message.info(`发现 ${result.tools.length} 个工具`)
        }
      } else {
        message.error(result.error || '连接失败')
      }
      loadMCPServers()
    } catch {
      message.error('连接失败')
    } finally {
      setConnectingMcp(null)
    }
  }

  const handleDisconnectMCPServer = async (serverId: string) => {
    try {
      await window.electronAPI.mcp.disconnectServer(serverId)
      message.success('已断开连接')
      loadMCPServers()
    } catch {
      message.error('断开失败')
    }
  }

  const handleDeleteMCPServer = async (serverId: string) => {
    try {
      await window.electronAPI.mcp.deleteServer(serverId)
      message.success('已删除')
      loadMCPServers()
    } catch {
      message.error('删除失败')
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

  const statusConfig = {
    draft: { color: 'default', text: '草稿' },
    active: { color: 'green', text: '运行中' },
    paused: { color: 'orange', text: '已暂停' },
    error: { color: 'red', text: '错误' },
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
        subTitle="数字员工配置管理"
        onBack={() => navigate(`/employee/${id}`)}
        breadcrumb={[
          { title: '仪表盘' },
          { title: employee.name },
          { title: '配置管理' },
        ]}
        extra={
          <Space>
            <Tag color={statusConfig[employee.status].color}>
              {statusConfig[employee.status].text}
            </Tag>
            <Button
              icon={employee.status === 'active' ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={handleToggleStatus}
            >
              {employee.status === 'active' ? '暂停' : '启用'}
            </Button>
            <Button type="primary" icon={<SaveOutlined />} loading={loading} onClick={() => form.submit()}>
              保存
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
            label: '基本信息',
            children: (
              <Card>
                <Form form={form} layout="vertical" onFinish={handleSaveBasic}>
                  <Row gutter={24}>
                    <Col span={16}>
                      <Form.Item
                        name="name"
                        label="数字员工名称"
                        rules={[{ required: true, message: '请输入名称' }]}
                      >
                        <Input placeholder="输入数字员工名称" />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item name="avatar_type" label="头像样式">
                        <Select>
                          {AVATAR_OPTIONS.map((opt) => (
                            <Select.Option key={opt.value} value={opt.value}>
                              <Space>
                                <Avatar size="small" style={{ backgroundColor: opt.color }}>
                                  {opt.icon}
                                </Avatar>
                                {opt.value === 'default' && '默认'}
                                {opt.value === 'business' && '商务'}
                                {opt.value === 'document' && '文档'}
                                {opt.value === 'settings' && '设置'}
                              </Space>
                            </Select.Option>
                          ))}
                        </Select>
                      </Form.Item>
                    </Col>
                  </Row>

                  <Form.Item name="description" label="描述">
                    <TextArea rows={3} placeholder="描述这个数字员工的职责和能力..." />
                  </Form.Item>

                  <Row gutter={24}>
                    <Col span={12}>
                      <Form.Item name="llm_provider_id" label="LLM 提供商">
                        <Select 
                          placeholder="选择 LLM 提供商" 
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
                      <Form.Item name="llm_model" label="模型名称">
                        {formLlmProviderId && getProviderModels(formLlmProviderId).length > 0 ? (
                          <Select 
                            placeholder="选择模型" 
                            allowClear
                            options={getProviderModels(formLlmProviderId)}
                          />
                        ) : (
                          <Input placeholder="如 gpt-4o, claude-3-sonnet 等" />
                        )}
                      </Form.Item>
                    </Col>
                  </Row>

                  <Form.Item name="review_mode" valuePropName="checked" label={null}>
                    <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                  </Form.Item>
                  <Text type="secondary">启用人工复核模式后，数字员工的输出需要用户确认后才能生效</Text>

                  <Divider />

                  <Form.Item>
                    <Space>
                      <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={loading}>
                        保存基本信息
                      </Button>
                      <Popconfirm
                        title="确定删除此数字员工？"
                        description="删除后无法恢复，相关对话记录也将被清除。"
                        onConfirm={handleDeleteEmployee}
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                      >
                        <Button danger icon={<DeleteOutlined />}>
                          删除数字员工
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
            label: '系统工具',
            children: (
              <Space orientation="vertical" style={{ width: '100%' }} size={16}>
                <Alert
                  title="系统工具让数字员工具备调用外部功能的能力"
                  description="开启工具后，数字员工在对话时可以根据需要自动调用这些工具。关闭则该员工无法使用对应工具。"
                  type="info"
                  showIcon
                />

                <Card
                  title={
                    <Space>
                      <ToolOutlined />
                      <span>内置工具 ({employeeTools.length})</span>
                    </Space>
                  }
                >
                  {employeeTools.length === 0 ? (
                    <Empty description="暂无内置工具" />
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
                                <Tag color="blue" style={{ flexShrink: 0 }}>内置</Tag>
                              </div>
                              <Text type="secondary" ellipsis style={{ display: 'block' }}>{tool.description || '无描述'}</Text>
                            </div>
                          </div>
                          <Switch
                            checked={tool.is_enabled}
                            onChange={(checked) => handleToggleTool(tool.id, checked)}
                            checkedChildren="启用"
                            unCheckedChildren="关闭"
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
            label: 'Skills 市场',
            children: (
              <Space orientation="vertical" style={{ width: '100%' }} size={16}>
                <Alert
                  title="Skills 是符合 Claude 协议的模块化能力包"
                  description="安装 Skill 后，可以直接分配给数字员工使用。Skill 包含完整的指令、参考资料和脚本，无需手动配置提示词。"
                  type="info"
                  showIcon
                />

                <Card
                  title={
                    <Space>
                      <BookOutlined />
                      <span>已安装 Skills ({installedSkills.length})</span>
                    </Space>
                  }
                  extra={
                    <Space>
                      <Button icon={<FolderOpenOutlined />} onClick={handleInstallSkillFromDir} loading={installingSkill}>
                        从目录安装
                      </Button>
                      <Button icon={<FileZipOutlined />} onClick={handleInstallSkillFromZip} loading={installingSkill}>
                        从 ZIP 安装
                      </Button>
                    </Space>
                  }
                >
                  {installedSkills.length === 0 ? (
                    <Empty description="暂无已安装的 Skills，点击上方按钮安装" />
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
                                <Text type="secondary" ellipsis style={{ display: 'block' }}>{skill.description || skill.skillMdContent?.substring(0, 200).replace(/^#\s+.+\n?/, '').trim() || '无描述'}</Text>
                                <Space size={4} style={{ marginTop: 4 }} wrap>
                                  {skill.tags.map((tag) => (
                                    <Tag key={tag}>{tag}</Tag>
                                  ))}
                                </Space>
                              </Space>
                            </div>
                          </div>
                          <Popconfirm
                            title="卸载 Skill？"
                            description="卸载后所有分配了此 Skill 的员工将无法使用"
                            onConfirm={() => handleUninstallSkill(skill.id)}
                          >
                            <Button type="text" danger icon={<DeleteOutlined />}>
                              卸载
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
                      <span>已分配 Skills ({employeeSkills.length})</span>
                    </Space>
                  }
                >
                  {employeeSkills.length === 0 ? (
                    <Empty description="暂无分配的 Skills，请从下方可用 Skills 中添加" />
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
                              <Text type="secondary" ellipsis style={{ display: 'block' }}>{skill.description || skill.skillMdContent?.substring(0, 200).replace(/^#\s+.+\n?/, '').trim() || '无描述'}</Text>
                            </div>
                          </div>
                          <Popconfirm
                            title="移除 Skill？"
                            description="移除后该员工将无法使用此 Skill"
                            onConfirm={() => handleRemoveSkill(skill.id)}
                          >
                            <Button type="text" danger icon={<DeleteOutlined />}>
                              移除
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
                      <span>可用 Skills ({availableSkills.length})</span>
                    </Space>
                  }
                >
                  {availableSkills.length === 0 ? (
                    <Empty description="暂无可用的 Skills，请先安装" />
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
                              <Text type="secondary" ellipsis style={{ display: 'block' }}>{skill.description || skill.skillMdContent?.substring(0, 200).replace(/^#\s+.+\n?/, '').trim() || '无描述'}</Text>
                            </div>
                          </div>
                          <Button
                            type="primary"
                            icon={<PlusOutlined />}
                            onClick={() => handleAssignSkill(skill.id)}
                          >
                            分配
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
            label: 'MCP 服务',
            children: (
              <Space orientation="vertical" style={{ width: '100%' }} size={16}>
                <Alert
                  title="MCP (Model Context Protocol) 让数字员工连接外部服务"
                  description="配置 MCP Server 后，数字员工可以调用外部工具和服务。例如：数据库查询、文件系统操作、API 调用等。"
                  type="info"
                  showIcon
                />

                <Card
                  title={
                    <Space>
                      <ApiOutlined />
                      <span>MCP 服务器列表 ({mcpServers.length})</span>
                    </Space>
                  }
                  extra={
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => openMcpEditor()}>
                      添加服务器
                    </Button>
                  }
                >
                  {mcpServers.length === 0 ? (
                    <Empty description="暂无 MCP 服务器，点击添加按钮创建" />
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
                                      ? '已连接'
                                      : server.status === 'error'
                                      ? '错误'
                                      : '未连接'
                                  }
                                  style={{ flexShrink: 0 }}
                                />
                              </div>
                              <Space orientation="vertical" size={0} style={{ width: '100%' }}>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  命令: {server.command}
                                </Text>
                                {server.last_error && (
                                  <Text type="danger" style={{ fontSize: 12 }}>
                                    错误: {server.last_error}
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
                                断开
                              </Button>
                            ) : (
                              <Button
                                type="primary"
                                icon={<LinkOutlined />}
                                loading={connectingMcp === server.id}
                                onClick={() => handleConnectMCPServer(server.id)}
                              >
                                连接
                              </Button>
                            )}
                            <Button type="text" icon={<EditOutlined />} onClick={() => openMcpEditor(server)}>
                              编辑
                            </Button>
                            <Popconfirm
                              title="删除 MCP 服务器？"
                              onConfirm={() => handleDeleteMCPServer(server.id)}
                            >
                              <Button type="text" danger icon={<DeleteOutlined />}>
                                删除
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
            label: '知识库',
            children: (
              <Card title="项目关联的知识库" extra={<Button type="link" icon={<LinkOutlined />} onClick={() => navigate(`/project/${employee?.project_id}`)}>管理关联</Button>}>
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
                              <Tooltip title={kb.description || '暂无描述'}>
                                <Text type="secondary" ellipsis style={{ display: 'block' }}>{kb.description || '暂无描述'}</Text>
                              </Tooltip>
                              <Tag style={{ marginTop: 4 }}>{kb.doc_count || 0} 文档</Tag>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty description="暂无关联的知识库">
                    <Button type="primary" onClick={() => navigate(`/project/${employee?.project_id}`)}>
                      前往关联知识库
                    </Button>
                  </Empty>
                )}
              </Card>
            )
          },
          {
            key: 'stats',
            label: '监控统计',
            children: (
              <>
                <Row gutter={16}>
                  <Col span={6}>
                    <Card>
                      <Statistic
                        title="总处理任务"
                        value={employee.total_tasks}
                        prefix={<BarChartOutlined />}
                      />
                    </Card>
                  </Col>
                  <Col span={6}>
                    <Card>
                      <Statistic
                        title="用户赞"
                        value={employee.total_approvals}
                        prefix={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
                      />
                    </Card>
                  </Col>
                  <Col span={6}>
                    <Card>
                      <Statistic title="关联知识库" value={linkedKBs.length} prefix={<DatabaseOutlined />} />
                    </Card>
                  </Col>
                </Row>
                <Card title="版本信息" style={{ marginTop: 16 }}>
                  <p>当前版本: v{employee.arch_version}</p>
                  <p>创建时间: {new Date(employee.created_at * 1000).toLocaleString()}</p>
                  <p>更新时间: {new Date(employee.updated_at * 1000).toLocaleString()}</p>
                </Card>
              </>
            )
          }
        ]}
      />

      <Modal
        title={editingMcpServer ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
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
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：文件系统 MCP" />
          </Form.Item>
          <Form.Item name="command" label="启动命令" rules={[{ required: true, message: '请输入命令' }]}>
            <Input placeholder="例如：npx 或 python mcp_server.py" />
          </Form.Item>
          <Form.Item name="args" label="参数（每行一个）">
            <TextArea rows={3} placeholder="例如：-m&#10;mcp-server-filesystem&#10;/path/to/allowed/dir" />
          </Form.Item>
          <Form.Item name="env" label="环境变量（JSON 格式）">
            <TextArea rows={2} placeholder={`{"API_KEY": "xxx", "DEBUG": "true"}`} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">
                {editingMcpServer ? '更新' : '创建'}
              </Button>
              <Button onClick={() => setIsMcpModalOpen(false)}>取消</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default EmployeeSettings
