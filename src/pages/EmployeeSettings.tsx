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
  ExportImportSection,
  MemorySection,
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
