import { useCallback, useEffect } from 'react'
import { message } from 'antd'
import { useTranslation } from 'react-i18next'
import type {
  AutomationTask,
  AutomationRun,
  CreateAutomationTaskInput,
  UpdateAutomationTaskInput,
  PreviewRunsParams,
  ListAutomationTasksParams,
  ListAutomationRunsParams,
} from './types'
import { useAutomationStore } from './automation.store'
import { auto } from './store'

/**
 * 自动化模块统一 Hook：
 * - 封装所有 IPC 调用（经插件桥）
 * - 监听 data-changed 自动刷新
 * - 提供任务 CRUD、立即执行、暂停/启用、清空历史等动作
 */
export function useAutomation() {
  const {
    tasks, runs, taskFilters, runFilters, activeTab,
    loadingTasks, loadingRuns,
    setTasks, setRuns, setTaskFilters, setRunFilters, setActiveTab,
    setLoadingTasks, setLoadingRuns,
  } = useAutomationStore()
  const { t } = useTranslation('automation')

  const refreshTasks = useCallback(async () => {
    setLoadingTasks(true)
    try {
      const params: ListAutomationTasksParams = { ...taskFilters }
      const result = await auto.listTasks(params)
      if (Array.isArray(result)) setTasks(result as AutomationTask[])
    } catch (err) {
      console.error('Failed to load automation tasks:', err)
    } finally {
      setLoadingTasks(false)
    }
  }, [taskFilters, setTasks, setLoadingTasks])

  const refreshRuns = useCallback(async () => {
    setLoadingRuns(true)
    try {
      const params: ListAutomationRunsParams = { ...runFilters }
      if (!params.limit) params.limit = 200
      const result = await auto.listRuns(params)
      if (Array.isArray(result)) setRuns(result as AutomationRun[])
    } catch (err) {
      console.error('Failed to load automation runs:', err)
    } finally {
      setLoadingRuns(false)
    }
  }, [runFilters, setRuns, setLoadingRuns])

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshTasks(), refreshRuns()])
  }, [refreshTasks, refreshRuns])

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  useEffect(() => {
    const unsubscribe = auto.onDataChanged((payload) => {
      if (payload.scope === 'task') refreshTasks()
      if (payload.scope === 'run') refreshRuns()
    })
    return () => { unsubscribe() }
  }, [refreshTasks, refreshRuns])

  // ====== Task 操作 ======

  const createTask = useCallback(async (input: CreateAutomationTaskInput): Promise<AutomationTask | null> => {
    const result = await auto.createTask(input)
    if (result?.error) { message.error(result.error); return null }
    message.success(t('automation.createSuccess'))
    await refreshTasks()
    return result as AutomationTask
  }, [t, refreshTasks])

  const updateTask = useCallback(async (input: UpdateAutomationTaskInput): Promise<AutomationTask | null> => {
    const result = await auto.updateTask(input)
    if (result?.error) { message.error(result.error); return null }
    message.success(t('automation.updateSuccess'))
    await refreshTasks()
    return result as AutomationTask
  }, [t, refreshTasks])

  const deleteTask = useCallback(async (id: string): Promise<boolean> => {
    const result = await auto.deleteTask(id)
    if (result?.error) { message.error(result.error); return false }
    message.success(t('automation.deleteSuccess'))
    await refreshTasks()
    await refreshRuns()
    return true
  }, [t, refreshTasks, refreshRuns])

  const toggleTask = useCallback(async (id: string, enabled: boolean): Promise<boolean> => {
    const result = await auto.toggleTask(id, enabled)
    if (result?.error) { message.error(result.error); return false }
    message.success(enabled ? t('automation.enabledSuccess') : t('automation.disabledSuccess'))
    await refreshTasks()
    return true
  }, [t, refreshTasks])

  const runNow = useCallback(async (id: string): Promise<AutomationRun | null> => {
    const result = await auto.runNow(id)
    if (result?.error) { message.error(result.error); return null }
    message.success(t('automation.runStarted'))
    await refreshTasks()
    await refreshRuns()
    return result as AutomationRun
  }, [t, refreshTasks, refreshRuns])

  const previewRuns = useCallback(async (params: PreviewRunsParams): Promise<number[]> => {
    const result = await auto.previewRuns(params)
    if (result?.error) return []
    return (result?.runs as number[]) || []
  }, [])

  // ====== Run 操作 ======

  const deleteRun = useCallback(async (id: string): Promise<boolean> => {
    const result = await auto.deleteRun(id)
    if (result?.error) { message.error(result.error); return false }
    message.success(t('automation.deleteRunSuccess'))
    await refreshRuns()
    return true
  }, [t, refreshRuns])

  const clearRuns = useCallback(async (taskId?: string): Promise<boolean> => {
    const result = await auto.clearRuns(taskId ? { task_id: taskId } : undefined)
    if (result?.error) { message.error(result.error); return false }
    message.success(t('automation.clearRunsSuccess'))
    await refreshRuns()
    return true
  }, [t, refreshRuns])

  return {
    tasks, runs, taskFilters, runFilters, activeTab,
    loadingTasks, loadingRuns,
    setTaskFilters, setRunFilters, setActiveTab,
    refreshTasks, refreshRuns, refreshAll,
    createTask, updateTask, deleteTask, toggleTask, runNow, previewRuns,
    deleteRun, clearRuns,
  }
}
