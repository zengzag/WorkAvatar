import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Space, Segmented, theme, Input, Select } from 'antd'
import { PlusOutlined, FieldTimeOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAutomation } from './useAutomation'
import { auto as autoBridge } from './store'
import AutomationTaskList from './components/AutomationTaskList'
import AutomationHistoryList from './components/AutomationHistoryList'
import AutomationTaskForm, { type TaskFormMode } from './components/AutomationTaskForm'
import type {
  AutomationTask,
  AutomationRun,
  CreateAutomationTaskInput,
  UpdateAutomationTaskInput,
} from './types'

interface Employee {
  id: string
  name: string
  status: string
}

const AutomationPage: React.FC = () => {
  const { t } = useTranslation('automation')
  const { token } = theme.useToken()
  const auto = useAutomation()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [providers, setProviders] = useState<any[]>([])
  const [formOpen, setFormOpen] = useState(false)
  const [formMode, setFormMode] = useState<TaskFormMode>('create')
  const [editingTask, setEditingTask] = useState<AutomationTask | null>(null)
  const [search, setSearch] = useState('')

  const loadEmployees = useCallback(async () => {
    try {
      const empResult = await window.electronAPI.employee.list()
      if (Array.isArray(empResult)) setEmployees(empResult as Employee[])
      else if (empResult && Array.isArray((empResult as any).list)) setEmployees((empResult as any).list)
    } catch (err) {
      console.error('Failed to load employees:', err)
    }
  }, [])

  const loadProviders = useCallback(async () => {
    try {
      const result = await window.electronAPI.llm.getProviders()
      if (Array.isArray(result)) setProviders(result as any[])
    } catch (err) {
      console.error('Failed to load providers:', err)
    }
  }, [])

  useEffect(() => {
    void loadEmployees()
    void loadProviders()
  }, [loadEmployees, loadProviders])

  // 订阅员工/模型变更，刷新下拉选项
  useEffect(() => {
    const unsub = autoBridge.onMetaChanged(({ scope }) => {
      if (scope === 'employees') void loadEmployees()
      else void loadProviders()
    })
    return () => { unsub() }
  }, [loadEmployees, loadProviders])

  const filteredTasks = useMemo(() => {
    if (!search.trim()) return auto.tasks
    const kw = search.toLowerCase()
    return auto.tasks.filter(
      (tk) =>
        tk.title.toLowerCase().includes(kw) ||
        (tk.description || '').toLowerCase().includes(kw) ||
        (tk.prompt || '').toLowerCase().includes(kw) ||
        (tk.tags || []).some((tag: string) => tag.toLowerCase().includes(kw)),
    )
  }, [auto.tasks, search])

  const employeeOptions = useMemo(
    () => employees.map((e) => ({ label: e.name, value: e.id })),
    [employees],
  )

  const openCreate = useCallback(() => {
    setEditingTask(null)
    setFormMode('create')
    setFormOpen(true)
  }, [])

  const openEdit = useCallback((task: AutomationTask) => {
    setEditingTask(task)
    setFormMode('edit')
    setFormOpen(true)
  }, [])

  const handleSubmit = useCallback(
    async (input: CreateAutomationTaskInput | UpdateAutomationTaskInput) => {
      if (formMode === 'create') {
        await auto.createTask(input as CreateAutomationTaskInput)
      } else {
        await auto.updateTask(input as UpdateAutomationTaskInput)
      }
    },
    [auto, formMode],
  )

  const handleJump = useCallback((run: AutomationRun) => {
    if (!run.conversation_id || !run.employee_id) return
    localStorage.setItem(`employeeWorkbench:activeConvId:${run.employee_id}`, run.conversation_id)
    // hash 路由：跳转到任务页（插件渲染端不在宿主 Router 上下文，用 hash 跳转）
    window.location.hash = '#/tasks'
  }, [])

  const handlePreviewRuns = useCallback(
    async (taskId: string): Promise<number[]> => {
      return await auto.previewRuns({ task_id: taskId, count: 5 })
    },
    [auto],
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          flexShrink: 0,
        }}
      >
        <Space size="middle">
          <FieldTimeOutlined style={{ fontSize: 18, color: token.colorPrimary }} />
          <Segmented
            value={auto.activeTab}
            onChange={(v) => auto.setActiveTab(v as 'tasks' | 'history')}
            options={[
              { label: t('automation.tabTasks'), value: 'tasks' },
              { label: t('automation.tabHistory'), value: 'history' },
            ]}
          />
        </Space>
        <Space>
          {auto.activeTab === 'tasks' ? (
            <>
              <Input
                placeholder={t('automation.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                allowClear
                style={{ width: 200 }}
              />
              <Select
                allowClear
                placeholder={t('automation.filterByEmployee')}
                options={employeeOptions}
                style={{ width: 180 }}
                onChange={(v) => auto.setTaskFilters({ employee_id: v || undefined })}
              />
              <Button icon={<ReloadOutlined />} onClick={() => auto.refreshAll()} />
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                {t('automation.createTask')}
              </Button>
            </>
          ) : (
            <>
              <Select
                allowClear
                placeholder={t('automation.filterByStatus')}
                options={[
                  { label: t('automation.runStatus.running'), value: 'running' },
                  { label: t('automation.runStatus.success'), value: 'success' },
                  { label: t('automation.runStatus.failed'), value: 'failed' },
                ]}
                style={{ width: 140 }}
                onChange={(v) => auto.setRunFilters({ status: (v as any) || undefined })}
              />
              <Select
                allowClear
                placeholder={t('automation.filterByEmployee')}
                options={employeeOptions}
                style={{ width: 180 }}
                onChange={(v) => auto.setRunFilters({ employee_id: v || undefined })}
              />
              <Button icon={<ReloadOutlined />} onClick={() => auto.refreshAll()} />
            </>
          )}
        </Space>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {auto.activeTab === 'tasks' ? (
          <AutomationTaskList
            tasks={filteredTasks}
            loading={auto.loadingTasks}
            employees={employees}
            onCreate={openCreate}
            onEdit={openEdit}
            onDelete={auto.deleteTask}
            onToggle={auto.toggleTask}
            onRunNow={auto.runNow}
            onPreviewRuns={handlePreviewRuns}
          />
        ) : (
          <AutomationHistoryList
            runs={auto.runs}
            loading={auto.loadingRuns}
            employees={employees}
            tasks={auto.tasks}
            onDelete={auto.deleteRun}
            onClearAll={() => auto.clearRuns()}
            onJump={handleJump}
          />
        )}
      </div>

      <AutomationTaskForm
        open={formOpen}
        mode={formMode}
        task={editingTask}
        employees={employees}
        providers={providers}
        onClose={() => setFormOpen(false)}
        onSubmit={handleSubmit}
      />
    </div>
  )
}

export default AutomationPage
