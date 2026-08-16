export type {
  EventColor,
  TodoPriority,
  TodoStatus,
  RecurrenceRule,
  CalendarEvent,
  CalendarEventInstance,
  CalendarTodo,
  CalendarTodoInstance,
  CalendarTodoStats,
  CalendarSettings,
  OutlookAccount,
  OutlookSyncConfig,
  OutlookSyncResult,
  OutlookSyncStatus,
  ListEventsParams,
  ListTodosParams,
  CreateEventInput,
  UpdateEventInput,
  CreateTodoInput,
  UpdateTodoInput,
  NotifyPayload,
  DeleteInstanceMode,
  DeleteEventInstanceParams,
  DeleteTodoInstanceParams,
} from '../../electron/shared/ipc-channels'

import type { TodoStatus, TodoPriority } from '../../electron/shared/ipc-channels'

// 前端专用：TODO 筛选条件
export interface TodoFilters {
  status?: TodoStatus | TodoStatus[]
  priority?: TodoPriority | TodoPriority[]
  /** 截止时间范围（unix ms），仅过滤有截止时间的待办 */
  dueFrom?: number
  dueTo?: number
}