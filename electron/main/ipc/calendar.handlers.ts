/**
 * 日历模块 IPC handlers。
 *
 * 暴露事件 CRUD、TODO CRUD、TODO 统计、设置读写共 12 个通道。
 * 写操作完成后通过 CALENDAR_DATA_CHANGED 事件推送变更，让所有打开的窗口刷新数据。
 */

import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  ListEventsParams,
  ListTodosParams,
  CreateEventInput,
  UpdateEventInput,
  CreateTodoInput,
  UpdateTodoInput,
  CalendarSettings,
  DeleteEventInstanceParams,
  DeleteTodoInstanceParams,
} from '../../shared/ipc-channels'
import CalendarService from '../services/calendar/calendar.service'
import { safeHandle } from './_shared'

function broadcastDataChanged(scope: 'event' | 'todo' | 'settings'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(IPC_CHANNELS.CALENDAR_DATA_CHANGED, { scope, ts: Date.now() })
      } catch { /* ignore */ }
    }
  }
}

export function registerCalendarHandlers(): void {
  const service = CalendarService.getInstance()

  // ====== 事件 ======

  safeHandle(IPC_CHANNELS.CALENDAR_LIST_EVENTS, (params: ListEventsParams) => {
    if (!params || typeof params.start_at !== 'number' || typeof params.end_at !== 'number') {
      return { error: '参数 start_at / end_at 必填' }
    }
    return service.listEvents(params)
  })

  safeHandle(IPC_CHANNELS.CALENDAR_CREATE_EVENT, (input: CreateEventInput) => {
    if (!input?.title || typeof input.start_at !== 'number') {
      return { error: 'title 和 start_at 必填' }
    }
    const event = service.createEvent(input)
    broadcastDataChanged('event')
    return event
  })

  safeHandle(IPC_CHANNELS.CALENDAR_UPDATE_EVENT, (input: UpdateEventInput) => {
    if (!input?.id) return { error: 'id 必填' }
    const event = service.updateEvent(input)
    if (event) broadcastDataChanged('event')
    return event
  })

  safeHandle(IPC_CHANNELS.CALENDAR_DELETE_EVENT, (params: { id: string }) => {
    if (!params?.id) return { error: 'id 必填' }
    const ok = service.deleteEvent(params.id)
    if (ok) broadcastDataChanged('event')
    return { success: ok }
  })

  safeHandle(IPC_CHANNELS.CALENDAR_DELETE_EVENT_INSTANCE, (params: DeleteEventInstanceParams) => {
    if (!params?.id || typeof params.anchor_at !== 'number' || !params.mode) {
      return { error: 'id / anchor_at / mode 必填' }
    }
    const ok = service.deleteEventInstance(params)
    if (ok) broadcastDataChanged('event')
    return { success: ok }
  })

  // ====== TODO ======

  safeHandle(IPC_CHANNELS.CALENDAR_LIST_TODOS, (params?: ListTodosParams) => {
    return service.listTodos(params || {})
  })

  safeHandle(IPC_CHANNELS.CALENDAR_LIST_TODO_INSTANCES, (params: ListEventsParams) => {
    if (!params || typeof params.start_at !== 'number' || typeof params.end_at !== 'number') {
      return { error: '参数 start_at / end_at 必填' }
    }
    return service.listTodoInstances(params)
  })

  safeHandle(IPC_CHANNELS.CALENDAR_CREATE_TODO, (input: CreateTodoInput) => {
    if (!input?.title) return { error: 'title 必填' }
    const todo = service.createTodo(input)
    broadcastDataChanged('todo')
    return todo
  })

  safeHandle(IPC_CHANNELS.CALENDAR_UPDATE_TODO, (input: UpdateTodoInput) => {
    if (!input?.id) return { error: 'id 必填' }
    const todo = service.updateTodo(input)
    if (todo) broadcastDataChanged('todo')
    return todo
  })

  safeHandle(IPC_CHANNELS.CALENDAR_DELETE_TODO, (params: { id: string }) => {
    if (!params?.id) return { error: 'id 必填' }
    const ok = service.deleteTodo(params.id)
    if (ok) broadcastDataChanged('todo')
    return { success: ok }
  })

  safeHandle(IPC_CHANNELS.CALENDAR_DELETE_TODO_INSTANCE, (params: DeleteTodoInstanceParams) => {
    if (!params?.id || typeof params.anchor_at !== 'number' || !params.mode) {
      return { error: 'id / anchor_at / mode 必填' }
    }
    const ok = service.deleteTodoInstance(params)
    if (ok) broadcastDataChanged('todo')
    return { success: ok }
  })

  safeHandle(IPC_CHANNELS.CALENDAR_COMPLETE_TODO, (params: { id: string; completed: boolean; instance_due_at?: number }) => {
    if (!params?.id) return { error: 'id 必填' }
    const todo = service.completeTodo(params.id, params.completed, params.instance_due_at)
    if (todo) broadcastDataChanged('todo')
    return todo
  })

  safeHandle(IPC_CHANNELS.CALENDAR_TODO_STATS, () => {
    return service.getTodoStats()
  })

  // ====== 设置 ======

  safeHandle(IPC_CHANNELS.CALENDAR_GET_SETTINGS, () => {
    return service.getSettings()
  })

  safeHandle(IPC_CHANNELS.CALENDAR_SET_SETTINGS, (params: Partial<CalendarSettings>) => {
    const next = service.setSettings(params || {})
    broadcastDataChanged('settings')
    return next
  })
}