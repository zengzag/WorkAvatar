export type {
  EventColor,
  TodoPriority,
  TodoStatus,
  RecurrenceRule,
  CalendarEvent,
  CalendarEventInstance,
  CalendarTodo,
  CalendarTodoStats,
  CalendarSettings,
  ListEventsParams,
  ListTodosParams,
  CreateEventInput,
  UpdateEventInput,
  CreateTodoInput,
  UpdateTodoInput,
  NotifyPayload,
} from '../../electron/shared/ipc-channels'

import type { TodoStatus, TodoPriority } from '../../electron/shared/ipc-channels'

// 前端专用：TODO 筛选条件
export interface TodoFilters {
  status?: TodoStatus | TodoStatus[]
  priority?: TodoPriority | TodoPriority[]
  tag?: string
}