/**
 * 自动化模块 IPC 通道。
 *
 * 包含任务 CRUD、立即执行、运行历史 CRUD、下次执行预览等通道，
 * 以及主进程 → 渲染进程的 DATA_CHANGED 事件推送通道。
 */

export const AUTOMATION_CHANNELS = {
  // 任务 CRUD
  AUTOMATION_LIST_TASKS: 'automation:list-tasks',
  AUTOMATION_GET_TASK: 'automation:get-task',
  AUTOMATION_CREATE_TASK: 'automation:create-task',
  AUTOMATION_UPDATE_TASK: 'automation:update-task',
  AUTOMATION_DELETE_TASK: 'automation:delete-task',
  AUTOMATION_TOGGLE_TASK: 'automation:toggle-task',

  // 执行
  AUTOMATION_RUN_NOW: 'automation:run-now',
  AUTOMATION_PREVIEW_RUNS: 'automation:preview-runs',

  // 执行历史 CRUD
  AUTOMATION_LIST_RUNS: 'automation:list-runs',
  AUTOMATION_DELETE_RUN: 'automation:delete-run',
  AUTOMATION_CLEAR_RUNS: 'automation:clear-runs',

  // 事件推送（主进程 → 渲染进程）
  AUTOMATION_DATA_CHANGED: 'automation:data-changed',
} as const

// ====== 类型 ======

export type AutomationTaskStatus = 'idle' | 'running' | 'success' | 'failed'
export type AutomationRunStatus = 'running' | 'success' | 'failed'
export type AutomationTriggeredBy = 'scheduler' | 'manual'

/** 重复规则（与日历模块共用语义） */
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

export interface AutomationDataChangedPayload {
  scope: 'task' | 'run' | 'settings'
  ts: number
}
