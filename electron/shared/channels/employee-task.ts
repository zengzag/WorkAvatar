export const EMPLOYEE_TASK_CHANNELS = {
  EMPLOYEE_TASK_LIST: 'employee-task:list',
  EMPLOYEE_TASK_GET: 'employee-task:get',
  EMPLOYEE_TASK_CREATE: 'employee-task:create',
  EMPLOYEE_TASK_UPDATE: 'employee-task:update',
  EMPLOYEE_TASK_DELETE: 'employee-task:delete',
  EMPLOYEE_TASK_EXECUTE: 'employee-task:execute',
  EMPLOYEE_TASK_ABORT_EXECUTION: 'employee-task:abort-execution',

  EMPLOYEE_SCHEDULE_LIST: 'employee-schedule:list',
  EMPLOYEE_SCHEDULE_GET: 'employee-schedule:get',
  EMPLOYEE_SCHEDULE_CREATE: 'employee-schedule:create',
  EMPLOYEE_SCHEDULE_UPDATE: 'employee-schedule:update',
  EMPLOYEE_SCHEDULE_DELETE: 'employee-schedule:delete',
  EMPLOYEE_SCHEDULE_VALIDATE_CRON: 'employee-schedule:validate-cron',

  EMPLOYEE_EXECUTION_LIST: 'employee-execution:list',
  EMPLOYEE_EXECUTION_LIST_FOR_TASK: 'employee-execution:list-for-task',
  EMPLOYEE_EXECUTION_GET: 'employee-execution:get',
  EMPLOYEE_EXECUTION_ALL_RECENT: 'employee-execution:all-recent',
  EMPLOYEE_EXECUTION_FAILED: 'employee-execution:failed',
  EMPLOYEE_EXECUTION_DELETE: 'employee-execution:delete',

  TASK_NOTIFICATION_COMPLETION: 'task-notification:completion',
  TASK_NOTIFICATION_CLICK: 'task-notification:click',
  TASK_EXECUTION_SEGMENTS_UPDATE: 'task-execution:segments-update',
  TASK_EXECUTION_STATUS_UPDATE: 'task-execution:status-update',
} as const

export interface EmployeeTaskCreateParams {
  employee_id: string
  name: string
  description?: string
  prompt: string
  timeout_ms?: number
  llm_provider_id?: string
  llm_model?: string
  enable_thinking?: boolean
  run_mode?: 'recurring' | 'once'
}

export interface EmployeeTaskUpdateParams {
  id: string
  name?: string
  description?: string
  prompt?: string
  is_enabled?: boolean
  run_mode?: 'recurring' | 'once'
  timeout_ms?: number
  llm_provider_id?: string | null
  llm_model?: string | null
  enable_thinking?: boolean
}

export interface EmployeeScheduleCreateParams {
  employee_id: string
  name: string
  cron_expr: string
  task_ids: string[]
  run_mode?: 'recurring' | 'once'
  notify_on_complete?: boolean
}

export interface EmployeeScheduleUpdateParams {
  id: string
  name?: string
  cron_expr?: string
  is_enabled?: boolean
  task_ids?: string[]
  run_mode?: 'recurring' | 'once'
  notify_on_complete?: boolean
}
