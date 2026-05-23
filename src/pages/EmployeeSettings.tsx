import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Tabs,
  Form,
  Button,
  Checkbox,
  App,
  theme,
  Tooltip,
  Typography,
} from 'antd'
import { FolderOutlined, WarningOutlined, FolderOpenOutlined } from '@ant-design/icons'
import {
  SaveOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import {
  BasicInfoSection,
  ProfileSection,
  ToolsSection,
  SkillsSection,
  MCPServersSection,
  ExportImportSection,
  MemorySection,
} from '../components/employee-settings'
import type { Employee, LLMProvider } from '../types'

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

const EmployeeSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = theme.useToken()
  const [activeTab, setActiveTab] = useState('basic')

  useEffect(() => {
    const state = location.state as any
    if (state?.tab) {
      setActiveTab(state.tab)
    }
  }, [location.state])
  const [employee, setEmployee] = useState<Employee | null>(null)
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

  useEffect(() => {
    if (employee) {
      form.setFieldsValue({
        name: employee.name,
        description: employee.description,
        avatar_type: employee.avatar_type,
        review_mode: employee.review_mode,
        llm_provider_id: employee.llm_provider_id,
        llm_model: employee.llm_model,
      })
    }
  }, [employee])

  const loadEmployee = useCallback(async () => {
    try {
      const result = await window.electronAPI.employee.get(id!)
      setEmployee(result)
    } catch {
      message.error(t('employeeSettings.loadFailed'))
    }
  }, [id, message, t])

  const loadProviders = useCallback(async () => {
    try {
      const result = await window.electronAPI.llm.getProviders()
      setProviders(result as LLMProvider[])
    } catch {}
  }, [])

  const loadTools = useCallback(async () => {
    try {
      const result = await window.electronAPI.tool.getEmployeeTools({ employee_id: id! })
      setEmployeeTools(result || [])
    } catch {
      console.error('加载工具失败')
    }
  }, [id])

  const loadMCPServers = useCallback(async () => {
    try {
      const result = await window.electronAPI.mcp.listServers()
      setMcpServers(result || [])
    } catch {
      console.error('加载 MCP 服务器失败')
    }
  }, [])

  const loadInstalledSkills = useCallback(async () => {
    try {
      const result = await window.electronAPI.skillRegistry.list()
      setInstalledSkills(result || [])
    } catch {
      console.error('加载已安装 Skills 失败')
    }
  }, [])

  const loadEmployeeSkills = useCallback(async () => {
    try {
      const result = await window.electronAPI.skillRegistry.getEmployeeSkills({ employee_id: id! })
      setEmployeeSkills(result.assigned || [])
      setAvailableSkills(result.available || [])
    } catch {
      console.error('加载员工 Skills 失败')
    }
  }, [id])

  useEffect(() => {
    if (id) {
      loadEmployee()
      loadProviders()
      loadTools()
      loadMCPServers()
      loadInstalledSkills()
      loadEmployeeSkills()
    }
  }, [id, loadEmployee, loadProviders, loadTools, loadMCPServers, loadInstalledSkills, loadEmployeeSkills])

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

  const handleMemoryEnabledChange = async (enabled: boolean) => {
    try {
      await window.electronAPI.employee.update({
        id: id!,
        memory_enabled: enabled,
      })
      message.success(t('common.saveSuccess'))
      loadEmployee()
    } catch {
      message.error(t('common.saveFailed'))
    }
  }

  const { Text } = Typography

  const handleDeleteEmployee = async (workspacePath?: string) => {
    let deleteWorkspace = false

    let tasks: any[] = []
    let schedules: any[] = []
    try {
      tasks = await window.electronAPI.employeeTask.list(id!)
      schedules = await window.electronAPI.employeeTask.listSchedules(id!)
    } catch {}

    const hasBoundTasks = tasks.length > 0 || schedules.length > 0

    const handleOpenExplorer = (path: string) => {
      window.electronAPI.workspace.openInExplorer({ path }).catch(() => {})
    }

    modal.confirm({
      title: t('employeeSettings.confirmDeleteEmployee'),
      icon: null,
      width: 520,
      content: (
        <div>
          <Text>{t('employeeSettings.deleteEmployeeDesc')}</Text>
          {workspacePath && (
            <div style={{
              marginTop: 8,
              padding: '6px 10px',
              background: token.colorFillTertiary,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <FolderOutlined style={{ color: token.colorPrimary, flexShrink: 0 }} />
              <Tooltip title={workspacePath}>
                <Text
                  style={{
                    fontSize: 13,
                    color: token.colorTextSecondary,
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('employeeSettings.workspacePath')}: {workspacePath}
                </Text>
              </Tooltip>
              <Button
                type="link"
                size="small"
                icon={<FolderOpenOutlined />}
                onClick={() => handleOpenExplorer(workspacePath)}
                style={{ flexShrink: 0, padding: 0 }}
              />
            </div>
          )}
          {hasBoundTasks && (
            <div style={{
              marginTop: 12,
              padding: '10px 12px',
              background: token.colorWarningBg,
              border: `1px solid ${token.colorWarningBorder}`,
              borderRadius: 6,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: token.colorWarningText, display: 'flex', alignItems: 'center', gap: 6 }}>
                <WarningOutlined />
                {t('employeeSettings.boundTasksWarning')}
              </div>
              {tasks.length > 0 && (
                <div style={{ fontSize: 13, color: token.colorTextSecondary }}>
                  {t('employeeSettings.boundTaskCount', { count: tasks.length })}
                  {tasks.length <= 5 && (
                    <span style={{ marginLeft: 4 }}>
                      ({tasks.map((t: any) => t.name).join(', ')})
                    </span>
                  )}
                </div>
              )}
              {schedules.length > 0 && (
                <div style={{ fontSize: 13, color: token.colorTextSecondary, marginTop: 2 }}>
                  {t('employeeSettings.boundScheduleCount', { count: schedules.length })}
                  {schedules.length <= 5 && (
                    <span style={{ marginLeft: 4 }}>
                      ({schedules.map((s: any) => s.name).join(', ')})
                    </span>
                  )}
                </div>
              )}
              <div style={{ fontSize: 12, marginTop: 6, color: token.colorTextTertiary }}>
                {t('employeeSettings.boundTasksDeleteHint')}
              </div>
            </div>
          )}
          {workspacePath && (
            <Checkbox
              onChange={(e) => { deleteWorkspace = e.target.checked }}
              style={{ marginTop: 12 }}
            >
              {t('employeeSettings.alsoDeleteWorkspace')}
            </Checkbox>
          )}
        </div>
      ),
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.electronAPI.employee.delete({
            id: id!,
            delete_workspace: deleteWorkspace,
          })
          message.success(t('common.deleted'))
          navigate('/')
        } catch {
          message.error(t('common.deleteFailed'))
        }
      },
    })
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
          env: values.env ? (() => { try { return JSON.parse(values.env) } catch { message.error(t('employeeSettings.invalidJson')); throw new Error('invalid_json') } })() : {},
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
          { title: t('employeeSettings.breadcrumbDigitalEmployees'), onClick: () => navigate('/') },
          { title: employee.name },
          { title: t('employeeSettings.breadcrumbConfig') },
        ]}
        extra={
          <Button type="primary" icon={<SaveOutlined />} loading={loading} onClick={() => form.submit()}>
            {t('common.save')}
          </Button>
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
              <BasicInfoSection
                form={form}
                providers={providers}
                loading={loading}
                onSave={handleSaveBasic}
                onDelete={handleDeleteEmployee}
                workspacePath={employee.workspace_path}
                employeeId={id!}
              />
            )
          },
          {
            key: 'tools',
            label: t('employeeSettings.tabTools'),
            children: (
              <ToolsSection
                employeeTools={employeeTools}
                onToggleTool={handleToggleTool}
              />
            )
          },
          {
            key: 'skills-market',
            label: t('employeeSettings.tabSkills'),
            children: (
              <SkillsSection
                installedSkills={installedSkills}
                employeeSkills={employeeSkills}
                availableSkills={availableSkills}
                installingSkill={installingSkill}
                onInstallFromDir={handleInstallSkillFromDir}
                onInstallFromZip={handleInstallSkillFromZip}
                onUninstallSkill={handleUninstallSkill}
                onAssignSkill={handleAssignSkill}
                onRemoveSkill={handleRemoveSkill}
              />
            )
          },
          {
            key: 'mcp',
            label: t('employeeSettings.tabMcp'),
            children: (
              <MCPServersSection
                mcpServers={mcpServers}
                isMcpModalOpen={isMcpModalOpen}
                setIsMcpModalOpen={setIsMcpModalOpen}
                mcpForm={mcpForm}
                editingMcpServer={editingMcpServer}
                setEditingMcpServer={setEditingMcpServer}
                connectingMcp={connectingMcp}
                onCreateMCPServer={handleCreateMCPServer}
                onConnectMCPServer={handleConnectMCPServer}
                onDisconnectMCPServer={handleDisconnectMCPServer}
                onDeleteMCPServer={handleDeleteMCPServer}
                onOpenMcpEditor={openMcpEditor}
              />
            )
          },
          {
            key: 'memory',
            label: t('employeeSettings.tabMemory'),
            children: (
              <MemorySection
                employeeId={id!}
                memoryEnabled={employee.memory_enabled}
                onMemoryEnabledChange={handleMemoryEnabledChange}
              />
            )
          },
          {
            key: 'stats',
            label: t('employeeSettings.tabMonitor'),
            children: (
              <ProfileSection
                employee={employee}
              />
            )
          },
          {
            key: 'export-import',
            label: t('employeeSettings.tabExportImport'),
            children: (
              <ExportImportSection
                employeeId={id!}
                employeeName={employee.name}
              />
            )
          }
        ]}
      />
    </div>
  )
}

export default EmployeeSettings
