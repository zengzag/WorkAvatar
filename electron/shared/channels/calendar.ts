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
  CALENDAR_DELETE_EVENT_INSTANCE: 'calendar:delete-event-instance',

  // TODO CRUD + 统计
  CALENDAR_LIST_TODOS: 'calendar:list-todos',
  CALENDAR_LIST_TODO_INSTANCES: 'calendar:list-todo-instances',
  CALENDAR_CREATE_TODO: 'calendar:create-todo',
  CALENDAR_UPDATE_TODO: 'calendar:update-todo',
  CALENDAR_DELETE_TODO: 'calendar:delete-todo',
  CALENDAR_DELETE_TODO_INSTANCE: 'calendar:delete-todo-instance',
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
  /** 被跳过（删除）的实例时间戳列表（Unix 秒），命中该实例时不生成 */
  excluded_dates?: number[]
  /** 实例级完成记录：instance_due_at → completed_at（Unix 秒）。支持"跳着完成"（下次未完成、下下次已完成） */
  completed_instances?: Record<string, number>
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
  recurrence_rule: RecurrenceRule | null
  reminders: number[]
  /** 进入"进行中"状态的时间戳 */
  started_at: number | null
  /** 完成时间戳 */
  completed_at: number | null
  employee_id: string | null
  source: 'user' | 'agent'
  created_at: number
  updated_at: number
}

/** 日历面板上展示的 TODO 实例（重复 TODO 展开后产生） */
export interface CalendarTodoInstance extends CalendarTodo {
  /** 实例的实际截止时间（可能与 due_at 不同，重复展开时变化） */
  instance_due_at: number
  /** 是否为重复 TODO 产生的实例 */
  is_recurring: boolean
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
  overdue_only?: boolean
  due_today?: boolean
  due_from?: number
  due_to?: number
  limit?: number
  /** 面板模式：重复 TODO 展开为「下一个未完成实例 + 已完成实例」（供右侧待办列表使用） */
  expand_instances?: boolean
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
  recurrence_rule?: RecurrenceRule | null
  reminders?: number[]
  /** 实例级操作锚点（编辑弹窗对某个具体实例完成/取消完成时携带） */
  instance_due_at?: number
}

/**
 * 循环实例级「删除」模式：
 * - this: 仅跳过选中实例（写入 excluded_dates）
 * - future: 从选中实例开始截断（把 until 设为该实例前一周期的结束点，或把之后所有候选写入 excluded_dates）
 * - all: 删除整条记录（非循环记录唯一可用选项）
 */
export type DeleteInstanceMode = 'this' | 'future' | 'all'

export interface DeleteEventInstanceParams {
  id: string
  /** 要删除的实例锚点时间（event 的 instance_start_at），Unix 秒 */
  anchor_at: number
  mode: DeleteInstanceMode
}

export interface DeleteTodoInstanceParams {
  id: string
  /** 要删除的实例锚点时间（todo 的 instance_due_at），Unix 秒 */
  anchor_at: number
  mode: DeleteInstanceMode
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