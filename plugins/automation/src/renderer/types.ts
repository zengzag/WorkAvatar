/** 自动化插件渲染端类型定义（与内核 shared/ipc-channels 的 automation 类型一致） */

export type AutomationTaskStatus = 'idle' | 'running' | 'success' | 'failed'
export type AutomationRunStatus = 'running' | 'success' | 'failed'
export type AutomationTriggeredBy = 'scheduler' | 'manual'

export interface AutomationRecurrenceRule {
  freq: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  count?: number
  until?: number
}

export interface AutomationTask {
  id: string
  title: string
  description: string
  prompt: string
  employee_id: string
  provider_id: string
  model_id: string | null
  high_permission: boolean
  start_at: number
  recurrence_rule: AutomationRecurrenceRule | null
  is_enabled: boolean
  notify_on_complete: boolean
  retry_count: number
  tags: string[]
  last_run_at: number | null
  next_run_at: number | null
  last_status: AutomationTaskStatus
  last_error: string | null
  created_at: number
  updated_at: number
}

export interface AutomationRun {
  id: string
  task_id: string
  conversation_id: string | null
  employee_id: string
  provider_id: string
  model_id: string | null
  status: AutomationRunStatus
  triggered_by: AutomationTriggeredBy
  started_at: number
  finished_at: number | null
  duration_ms: number | null
  error_message: string | null
  created_at: number
}

export interface CreateAutomationTaskInput {
  title: string
  description?: string
  prompt: string
  employee_id: string
  provider_id: string
  model_id?: string | null
  high_permission?: boolean
  start_at: number
  recurrence_rule?: AutomationRecurrenceRule | null
  is_enabled?: boolean
  notify_on_complete?: boolean
  retry_count?: number
  tags?: string[]
}

export interface UpdateAutomationTaskInput {
  id: string
  title?: string
  description?: string
  prompt?: string
  employee_id?: string
  provider_id?: string
  model_id?: string | null
  high_permission?: boolean
  start_at?: number
  recurrence_rule?: AutomationRecurrenceRule | null
  is_enabled?: boolean
  notify_on_complete?: boolean
  retry_count?: number
  tags?: string[]
}

export interface ListAutomationTasksParams {
  employee_id?: string
  is_enabled?: boolean
  tag?: string
  search?: string
}

export interface ListAutomationRunsParams {
  task_id?: string
  employee_id?: string
  status?: AutomationRunStatus | AutomationRunStatus[]
  triggered_by?: AutomationTriggeredBy
  from?: number
  to?: number
  limit?: number
}

export interface PreviewRunsParams {
  task_id: string
  count?: number
}

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
