import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Drawer, Tabs, Form, App, theme, Checkbox, Typography, Tooltip, Button, Spin,
} from 'antd'
import {
  IdcardOutlined, ToolOutlined, ApiOutlined, AppstoreOutlined,
  DatabaseOutlined, BarChartOutlined, ImportOutlined,
  FolderOutlined, FolderOpenOutlined,
} from '@ant-design/icons'
import {
  BasicInfoSection,
  ProfileSection,
  ToolsSection,
  SkillsSection,
  ExportImportSection,
  MemorySection,
  McpSection,
} from '../employee-settings'
import type { Employee } from '../../types'

interface ToolInfo {
  id: string
  name: string
  title: string
  description: string
  category: string
  is_enabled: boolean
  is_assigned: boolean
}

interface ToolCategoryInfo {
  id: string
  name: string
  title: string
  description: string
  icon: string
  tool_ids: string[]
  tools: Array<{
    id: string
    name: string
    title: string
    description: string
  }>
  is_enabled: boolean
  enabled_count: number
  total_count: number
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

interface EmployeeSettingsDrawerProps {
  open: boolean
  employeeId: string | undefined
  onClose: () => void
  initialTab?: string
}

const EmployeeSettingsDrawer: React.FC<EmployeeSettingsDrawerProps> = ({
  open, employeeId, onClose, initialTab,
}) => {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const [activeTab, setActiveTab] = useState('basic')

  const [employee, setEmployee] = useState<Employee | null>(null)
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()

  const [employeeTools, setEmployeeTools] = useState<ToolInfo[]>([])
  const [toolCategories, setToolCategories] = useState<ToolCategoryInfo[]>([])
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([])
  const [employeeSkills, setEmployeeSkills] = useState<EmployeeSkill[]>([])
  const [installingSkill, setInstallingSkill] = useState(false)

  useEffect(() => {
    if (open && initialTab) {
      setActiveTab(initialTab)
    } else if (open && !initialTab) {
      setActiveTab('basic')
    }
  }, [open, initialTab])

  useEffect(() => {
    if (employee) {
      form.setFieldsValue({
        name: employee.name,
        description: employee.description,
        avatar_type: employee.avatar_type,
      })
    }
  }, [employee, form])

  const loadEmployee = useCallback(async () => {
    if (!employeeId) return
    try {
      const result = await window.electronAPI.employee.get(employeeId)
      setEmployee(result)
    } catch {
      message.error(t('employeeSettings.loadFailed'))
    }
  }, [employeeId, message, t])

  const loadTools = useCallback(async () => {
    if (!employeeId) return
    try {
      // 同时加载平铺的工具列表（兼容）和分类聚合列表（新）
      const [toolsResult, categoriesResult] = await Promise.all([
        window.electronAPI.tool.getEmployeeTools({ employee_id: employeeId }),
        window.electronAPI.tool.getEmployeeToolCategories({ employee_id: employeeId }),
      ])
      setEmployeeTools(toolsResult || [])
      setToolCategories(categoriesResult || [])
    } catch {
      console.error('加载工具失败')
    }
  }, [employeeId])

  const loadInstalledSkills = useCallback(async () => {
    try {
      const result = await window.electronAPI.skillRegistry.list()
      setInstalledSkills(result || [])
    } catch {
      console.error('加载已安装 Skills 失败')
    }
  }, [])

  const loadEmployeeSkills = useCallback(async () => {
    if (!employeeId) return
    try {
      const result = await window.electronAPI.skillRegistry.getEmployeeSkills({ employee_id: employeeId })
      const allSkills: EmployeeSkill[] = [
        ...result.enabled.map((s: InstalledSkill) => ({ ...s, enabled: true })),
        ...result.disabled.map((s: InstalledSkill) => ({ ...s, enabled: false })),
      ]
      setEmployeeSkills(allSkills)
    } catch {
      console.error('加载员工 Skills 失败')
    }
  }, [employeeId])

  useEffect(() => {
    if (open && employeeId) {
      loadEmployee()
      loadTools()
      loadInstalledSkills()
      loadEmployeeSkills()
    }
  }, [open, employeeId, loadEmployee, loadTools, loadInstalledSkills, loadEmployeeSkills])

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
      message.error(t('employeeSettings.uninstallFailed')
      )
    }
  }

  const handleToggleSkill = async (skillId: string, enabled: boolean) => {
    if (!employeeId) return
    try {
      await window.electronAPI.skillRegistry.toggleForEmployee({
        employee_id: employeeId,
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
    if (!employeeId) return
    setLoading(true)
    try {
      await window.electronAPI.employee.update({
        id: employeeId,
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
    if (!employeeId) return
    try {
      await window.electronAPI.employee.update({
        id: employeeId,
        memory_enabled: enabled,
      })
      message.success(t('common.saveSuccess'))
      loadEmployee()
    } catch {
      message.error(t('common.saveFailed'))
    }
  }

  const handleDeleteEmployee = async (workspacePath?: string) => {
    if (!employeeId) return
    let deleteWorkspace = false

    const { Text } = Typography
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
            id: employeeId,
            delete_workspace: deleteWorkspace,
          })
          message.success(t('common.deleted'))
          onClose()
        } catch {
          message.error(t('common.deleteFailed'))
        }
      },
    })
  }

  const handleToggleTool = async (toolId: string, enabled: boolean) => {
    if (!employeeId) return
    try {
      await window.electronAPI.tool.assignToEmployee({
        employee_id: employeeId,
        tool_id: toolId,
        is_enabled: enabled,
      })
      setEmployeeTools(prev => prev.map(t => t.id === toolId ? { ...t, is_enabled: enabled, is_assigned: true } : t))
      // 切换单个工具后重新加载分类，保持分类状态同步
      const categoriesResult = await window.electronAPI.tool.getEmployeeToolCategories({ employee_id: employeeId })
      setToolCategories(categoriesResult || [])
      message.success(enabled ? t('employeeSettings.toolEnabled') : t('employeeSettings.toolDisabled'))
    } catch {
      message.error(t('employeeSettings.operationFailed'))
    }
  }

  const handleToggleCategory = async (categoryId: string, enabled: boolean) => {
    if (!employeeId) return
    try {
      await window.electronAPI.tool.assignCategoryToEmployee({
        employee_id: employeeId,
        category_id: categoryId,
        is_enabled: enabled,
      })
      // 批量更新前端状态
      setToolCategories(prev => prev.map(cat => {
        if (cat.id !== categoryId) return cat
        return {
          ...cat,
          is_enabled: enabled,
          enabled_count: enabled ? cat.total_count : 0,
        }
      }))
      setEmployeeTools(prev => {
        const targetCat = toolCategories.find(c => c.id === categoryId)
        if (!targetCat) return prev
        const affectedIds = new Set(targetCat.tool_ids)
        return prev.map(t => affectedIds.has(t.id) ? { ...t, is_enabled: enabled, is_assigned: true } : t)
      })
      message.success(
        enabled
          ? t('employeeSettings.toolCategoryEnabled', { name: t(`employeeSettings.toolCategory_${categoryId}`, { defaultValue: categoryId }) })
          : t('employeeSettings.toolCategoryDisabled', { name: t(`employeeSettings.toolCategory_${categoryId}`, { defaultValue: categoryId }) }),
      )
    } catch {
      message.error(t('employeeSettings.operationFailed'))
    }
  }

  // 内容区容器：统一顶部留白 + 滚动
  const contentWrap = (node: React.ReactNode) => (
    <div style={{ padding: '0 0 20px', height: '100%', overflow: 'auto' }}>
      {node}
    </div>
  )

  const tabItems = [
    {
      key: 'basic',
      label: <span><IdcardOutlined style={{ marginRight: 4 }} />{t('employeeSettings.tabBasic')}</span>,
      children: contentWrap(
        <BasicInfoSection
          form={form}
          loading={loading}
          onSave={handleSaveBasic}
          onDelete={handleDeleteEmployee}
          workspacePath={employee?.workspace_path}
          employeeId={employeeId || ''}
        />
      ),
    },
    {
      key: 'tools',
      label: <span><ToolOutlined style={{ marginRight: 4 }} />{t('employeeSettings.tabTools')}</span>,
      children: contentWrap(
        <ToolsSection
          employeeTools={employeeTools}
          toolCategories={toolCategories}
          onToggleTool={handleToggleTool}
          onToggleCategory={handleToggleCategory}
        />
      ),
    },
    {
      key: 'mcp',
      label: <span><ApiOutlined style={{ marginRight: 4 }} />{t('employeeSettings.tabMcp')}</span>,
      children: contentWrap(<McpSection employeeId={employeeId || ''} />),
    },
    {
      key: 'skills-market',
      label: <span><AppstoreOutlined style={{ marginRight: 4 }} />{t('employeeSettings.tabSkills')}</span>,
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
      ),
    },
    {
      key: 'memory',
      label: <span><DatabaseOutlined style={{ marginRight: 4 }} />{t('employeeSettings.tabMemory')}</span>,
      children: contentWrap(
        <MemorySection
          employeeId={employeeId || ''}
          memoryEnabled={employee?.memory_enabled ?? false}
          onMemoryEnabledChange={handleMemoryEnabledChange}
        />
      ),
    },
    {
      key: 'stats',
      label: <span><BarChartOutlined style={{ marginRight: 4 }} />{t('employeeSettings.tabMonitor')}</span>,
      children: contentWrap(
        employee ? <ProfileSection employee={employee} /> : (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
            <Spin />
          </div>
        )
      ),
    },
    {
      key: 'export-import',
      label: <span><ImportOutlined style={{ marginRight: 4 }} />{t('employeeSettings.tabExportImport')}</span>,
      children: contentWrap(
        <ExportImportSection
          employeeId={employeeId || ''}
          employeeName={employee?.name || ''}
        />
      ),
    },
  ]

  return (
    <Drawer
      title={employee ? `${employee.name} - ${t('employeeSettings.subtitle')}` : t('employeeSettings.subtitle')}
      open={open}
      onClose={onClose}
      size={640}
      styles={{ body: { padding: 0, overflow: 'hidden' } }}
      destroyOnHidden
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        className="employee-settings-drawer-tabs"
        style={{ height: '100%', padding: '0 16px' }}
        items={tabItems}
        size="small"
        tabBarStyle={{ marginBottom: 16 }}
      />
      <style>{`
        .employee-settings-drawer-tabs.ant-tabs {
          height: 100%;
        }
        .employee-settings-drawer-tabs .ant-tabs-body-holder {
          flex: auto;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
        }
        .employee-settings-drawer-tabs .ant-tabs-body {
          height: 100%;
        }
        .employee-settings-drawer-tabs .ant-tabs-content {
          height: 100%;
        }
        .employee-settings-drawer-tabs .ant-tabs-tabpane {
          height: 100%;
        }
      `}</style>
    </Drawer>
  )
}

export default EmployeeSettingsDrawer
