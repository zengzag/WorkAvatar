export type {
  AutomationTask,
  AutomationRun,
  AutomationTaskStatus,
  AutomationRunStatus,
  AutomationTriggeredBy,
  AutomationRecurrenceRule,
  CreateAutomationTaskInput,
  UpdateAutomationTaskInput,
  ListAutomationTasksParams,
  ListAutomationRunsParams,
  PreviewRunsParams,
} from '../../electron/shared/ipc-channels'

// 前端专用：执行历史筛选条件
export interface RunFilters {
  status?: 'running' | 'success' | 'failed' | ('running' | 'success' | 'failed')[]
  employee_id?: string
  task_id?: string
  triggered_by?: 'scheduler' | 'manual'
  from?: number
  to?: number
}

// 前端专用：任务筛选条件
export interface TaskFilters {
  employee_id?: string
  is_enabled?: boolean
  tag?: string
  search?: string
}
