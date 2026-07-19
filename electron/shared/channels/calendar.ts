/**
 * 日历模块 IPC 通道。
 *
 * 包含日程事件、TODO 任务、提醒、设置四类操作通道，
 * 以及主进程 → 渲染进程的 NOTIFY / NOTIFY_CLICK / DATA_CHANGED 三个事件推送通道。
 */
export const CALENDAR_CHANNELS = {
  // 事件 CRUD
  CALENDAR_LIST_EVENTS: 'calendar:list-events',
  CALENDAR_CREATE_EVENT: 'calendar:create-event',
  CALENDAR_UPDATE_EVENT: 'calendar:update-event',
  CALENDAR_DELETE_EVENT: 'calendar:delete-event',

  // TODO CRUD + 统计
  CALENDAR_LIST_TODOS: 'calendar:list-todos',
  CALENDAR_CREATE_TODO: 'calendar:create-todo',
  CALENDAR_UPDATE_TODO: 'calendar:update-todo',
  CALENDAR_DELETE_TODO: 'calendar:delete-todo',
  CALENDAR_COMPLETE_TODO: 'calendar:complete-todo',
  CALENDAR_TODO_STATS: 'calendar:todo-stats',

  // 设置
  CALENDAR_GET_SETTINGS: 'calendar:get-settings',
  CALENDAR_SET_SETTINGS: 'calendar:set-settings',

  // 事件推送（主进程 → 渲染进程）
  CALENDAR_NOTIFY: 'calendar:notify',
  CALENDAR_NOTIFY_CLICK: 'calendar:notify-click',
  CALENDAR_DATA_CHANGED: 'calendar:data-changed',

  // 渲染进程主动请求系统通知
  NOTIFY_SEND: 'notify:send',
} as const

// ====== 类型 ======

export type EventColor = 'default' | 'blue' | 'green' | 'orange' | 'red' | 'purple'
export type TodoPriority = 'none' | 'low' | 'medium' | 'high'
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface RecurrenceRule {
  freq: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  count?: number
  until?: number
}

export interface CalendarEvent {
  id: string
  title: string
  description: string
  location: string
  start_at: number
  end_at: number
  all_day: boolean
  color: EventColor
  recurrence_rule: RecurrenceRule | null
  reminders: number[]
  employee_id: string | null
  source: 'user' | 'agent'
  created_at: number
  updated_at: number
}

/** 日历面板上展示的日程实例（重复日程展开后产生） */
export interface CalendarEventInstance extends CalendarEvent {
  instance_start_at: number
  instance_end_at: number
  is_recurring: boolean
}

export interface CalendarTodo {
  id: string
  title: string
  description: string
  due_at: number | null
  priority: TodoPriority
  status: TodoStatus
  tags: string[]
  recurrence_rule: RecurrenceRule | null
  reminders: number[]
  completed_at: number | null
  employee_id: string | null
  source: 'user' | 'agent'
  created_at: number
  updated_at: number
}

export interface CalendarTodoStats {
  total: number
  pending: number
  in_progress: number
  completed: number
  overdue: number
  due_today: number
  due_this_week: number
  completion_rate: number
}

export interface CalendarSettings {
  default_event_reminders: number[]
  default_todo_reminders: number[]
  enable_system_notification: boolean
}

export interface ListEventsParams {
  start_at: number
  end_at: number
}

export interface ListTodosParams {
  status?: TodoStatus | TodoStatus[]
  priority?: TodoPriority | TodoPriority[]
  tag?: string
  overdue_only?: boolean
  due_today?: boolean
  due_from?: number
  due_to?: number
  limit?: number
}

export interface CreateEventInput {
  title: string
  description?: string
  location?: string
  start_at: number
  end_at?: number
  all_day?: boolean
  color?: EventColor
  recurrence_rule?: RecurrenceRule | null
  reminders?: number[]
  employee_id?: string | null
  source?: 'user' | 'agent'
}

export interface UpdateEventInput {
  id: string
  title?: string
  description?: string
  location?: string
  start_at?: number
  end_at?: number
  all_day?: boolean
  color?: EventColor
  recurrence_rule?: RecurrenceRule | null
  reminders?: number[]
}

export interface CreateTodoInput {
  title: string
  description?: string
  due_at?: number | null
  priority?: TodoPriority
  status?: TodoStatus
  tags?: string[]
  recurrence_rule?: RecurrenceRule | null
  reminders?: number[]
  employee_id?: string | null
  source?: 'user' | 'agent'
}

export interface UpdateTodoInput {
  id: string
  title?: string
  description?: string
  due_at?: number | null
  priority?: TodoPriority
  status?: TodoStatus
  tags?: string[]
  recurrence_rule?: RecurrenceRule | null
  reminders?: number[]
}

export interface NotifyPayload {
  title: string
  body: string
  clickTarget?: 'event' | 'todo' | 'calendar' | 'ask_user' | 'automation'
  clickId?: string
  /** 静默：不弹 antd notification，仅写日志 */
  silent?: boolean
  /** 来源标记 */
  source?: string
  /** @deprecated 旧字段，保留兼容 */
  targetId?: string
  /** @deprecated 旧字段，保留兼容 */
  scheduledAt?: number
}