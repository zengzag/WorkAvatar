/**
 * 自动化模块 IPC handlers。
 *
 * 暴露任务 CRUD、立即执行、未来执行预览、运行历史 CRUD 共 10 个通道。
 * 写操作完成后通过 AUTOMATION_DATA_CHANGED 事件推送变更，让所有打开的窗口刷新数据。
 */

import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  ListAutomationTasksParams,
  ListAutomationRunsParams,
  CreateAutomationTaskInput,
  UpdateAutomationTaskInput,
  PreviewRunsParams,
} from '../../shared/ipc-channels'
import AutomationService from '../services/automation/automation.service'
import { safeHandle } from './_shared'

function broadcastDataChanged(scope: 'task' | 'run' | 'settings'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(IPC_CHANNELS.AUTOMATION_DATA_CHANGED, { scope, ts: Date.now() })
      } catch { /* ignore */ }
    }
  }
}

export function registerAutomationHandlers(): void {
  const service = AutomationService.getInstance()

  // ====== 任务 CRUD ======

  safeHandle(IPC_CHANNELS.AUTOMATION_LIST_TASKS, (params?: ListAutomationTasksParams) => {
    return service.listTasks(params || {})
  })

  safeHandle(IPC_CHANNELS.AUTOMATION_GET_TASK, (id: string) => {
    if (!id) return { error: 'id 必填' }
    return service.getTask(id)
  })

  safeHandle(IPC_CHANNELS.AUTOMATION_CREATE_TASK, (input: CreateAutomationTaskInput) => {
    if (!input?.title?.trim()) return { error: 'title 必填' }
    if (!input?.prompt?.trim()) return { error: 'prompt 必填' }
    if (!input?.employee_id) return { error: 'employee_id 必填' }
    if (!input?.provider_id) return { error: 'provider_id 必填' }
    if (typeof input?.start_at !== 'number') return { error: 'start_at 必填' }
    try {
      const task = service.createTask(input)
      broadcastDataChanged('task')
      return task
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  safeHandle(IPC_CHANNELS.AUTOMATION_UPDATE_TASK, (input: UpdateAutomationTaskInput) => {
    if (!input?.id) return { error: 'id 必填' }
    try {
      const task = service.updateTask(input)
      if (task) broadcastDataChanged('task')
      return task
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  safeHandle(IPC_CHANNELS.AUTOMATION_DELETE_TASK, (params: { id: string }) => {
    if (!params?.id) return { error: 'id 必填' }
    const ok = service.deleteTask(params.id)
    if (ok) broadcastDataChanged('task')
    return { success: ok }
  })

  safeHandle(IPC_CHANNELS.AUTOMATION_TOGGLE_TASK, (params: { id: string; enabled: boolean }) => {
    if (!params?.id) return { error: 'id 必填' }
    const task = service.toggleTask(params.id, params.enabled)
    if (task) broadcastDataChanged('task')
    return task
  })

  // ====== 执行 ======

  safeHandle(IPC_CHANNELS.AUTOMATION_RUN_NOW, async (params: { id: string }) => {
    if (!params?.id) return { error: 'id 必填' }
    try {
      const run = await service.runTask(params.id, 'manual')
      broadcastDataChanged('run')
      broadcastDataChanged('task')
      return run
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  safeHandle(IPC_CHANNELS.AUTOMATION_PREVIEW_RUNS, (params: PreviewRunsParams) => {
    if (!params?.task_id) return { error: 'task_id 必填' }
    const task = service.getTask(params.task_id)
    if (!task) return { error: '任务不存在' }
    const count = Math.max(1, Math.min(10, params.count ?? 5))
    const runs = service.previewNextRuns(task, count)
    return { runs }
  })

  // ====== 运行历史 CRUD ======

  safeHandle(IPC_CHANNELS.AUTOMATION_LIST_RUNS, (params?: ListAutomationRunsParams) => {
    return service.listRuns(params || {})
  })

  safeHandle(IPC_CHANNELS.AUTOMATION_DELETE_RUN, (params: { id: string }) => {
    if (!params?.id) return { error: 'id 必填' }
    const ok = service.deleteRun(params.id)
    if (ok) broadcastDataChanged('run')
    return { success: ok }
  })

  safeHandle(IPC_CHANNELS.AUTOMATION_CLEAR_RUNS, (params?: { task_id?: string }) => {
    const count = service.clearRuns(params?.task_id)
    broadcastDataChanged('run')
    return { success: true, count }
  })
}
