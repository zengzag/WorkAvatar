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
import { FolderOutlined, FolderOpenOutlined } from '@ant-design/icons'
import {
  SaveOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import {
  BasicInfoSection,
  ProfileSection,
  ToolsSection,
  SkillsSection,
  ExportImportSection,
  MemorySection,
  McpSection,
} from '../components/employee-settings'
import type { Employee } from '../types'

interface ToolInfo {
  id: string
  name: string
  title: string
  description: string
  category: string
  is_enabled: boolean
  is_assigned: boolean
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

interface EmployeeSkill extends InstalledSkill {
  enabled: boolean
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
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()

  const [employeeTools, setEmployeeTools] = useState<ToolInfo[]>([])

  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([])
  const [employeeSkills, setEmployeeSkills] = useState<EmployeeSkill[]>([])
  const [installingSkill, setInstallingSkill] = useState(false)

  useEffect(() => {
    if (employee) {
      form.setFieldsValue({
        name: employee.name,
        description: employee.description,
        avatar_type: employee.avatar_type,
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

  const loadTools = useCallback(async () => {
    try {
      const result = await window.electronAPI.tool.getEmployeeTools({ employee_id: id! })
      setEmployeeTools(result || [])
    } catch {
      console.error('加载工具失败')
    }
  }, [id])

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
      const allSkills: EmployeeSkill[] = [
        ...result.enabled.map((s: InstalledSkill) => ({ ...s, enabled: true })),
        ...result.disabled.map((s: InstalledSkill) => ({ ...s, enabled: false })),
      ]
      setEmployeeSkills(allSkills)
    } catch {
      console.error('加载员工 Skills 失败')
    }
  }, [id])

  useEffect(() => {
    if (id) {
      loadEmployee()
      loadTools()
      loadInstalledSkills()
      loadEmployeeSkills()
    }
  }, [id, loadEmployee, loadTools, loadInstalledSkills, loadEmployeeSkills])

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

  const handleToggleSkill = async (skillId: string, enabled: boolean) => {
    try {
      await window.electronAPI.skillRegistry.toggleForEmployee({
        employee_id: id!,
        skill_id: skillId,
        enabled,
      })
      setEmployeeSkills((prev) =>
        prev.map((s) => (s.id === skillId ? { ...s, enabled } : s))
      )
    } catch {
      message.error(t('employeeSettings.toggleFailed'))
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

  if (!employee) {
    return (
      <div style={{ padding: 16 }}>
        <Card loading />
      </div>
    )
  }

  // 内容区容器：统一顶部留白 + 滚动
  const contentWrap = (node: React.ReactNode) => (
    <div style={{ padding: '16px 16px 20px', height: '100%', overflow: 'auto' }}>
      {node}
    </div>
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 16px 0', flexShrink: 0 }}>
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
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        className="employee-settings-tabs"
        style={{ flex: 1, minHeight: 0, height: '100%', paddingLeft: 16, paddingRight: 16 }}
        items={[
          {
            key: 'basic',
            label: t('employeeSettings.tabBasic'),
            children: contentWrap(
              <BasicInfoSection
                form={form}
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
            children: contentWrap(
              <ToolsSection
                employeeTools={employeeTools}
                onToggleTool={handleToggleTool}
              />
            )
          },
          {
            key: 'mcp',
            label: t('employeeSettings.tabMcp'),
            children: contentWrap(<McpSection employeeId={id!} />)
          },
          {
            key: 'skills-market',
            label: t('employeeSettings.tabSkills'),
            children: contentWrap(
              <SkillsSection
                installedSkills={installedSkills}
                employeeSkills={employeeSkills}
                installingSkill={installingSkill}
                onInstallFromDir={handleInstallSkillFromDir}
                onInstallFromZip={handleInstallSkillFromZip}
                onUninstallSkill={handleUninstallSkill}
                onToggleSkill={handleToggleSkill}
              />
            )
          },
          {
            key: 'memory',
            label: t('employeeSettings.tabMemory'),
            children: contentWrap(
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
            children: contentWrap(
              <ProfileSection
                employee={employee}
              />
            )
          },
          {
            key: 'export-import',
            label: t('employeeSettings.tabExportImport'),
            children: contentWrap(
              <ExportImportSection
                employeeId={id!}
                employeeName={employee.name}
              />
            )
          }
        ]}
      />
      <style>{`
        .employee-settings-tabs.ant-tabs {
          height: 100%;
        }
        .employee-settings-tabs .ant-tabs-body-holder {
          flex: auto;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
        }
        .employee-settings-tabs .ant-tabs-body {
          height: 100%;
        }
        .employee-settings-tabs .ant-tabs-content {
          height: 100%;
        }
        .employee-settings-tabs .ant-tabs-tabpane {
          height: 100%;
        }
      `}</style>
    </div>
  )
}

export default EmployeeSettings
