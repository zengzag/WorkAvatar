/**
 * calendar 插件共享状态与宿主桥接。
 * - bridge：宿主注入的通用 IPC 桥（invoke 携带 calendar 插件 id 前缀）
 * - hostI18n：宿主受控 i18n（namespace=calendar 已注册，common.* 走宿主 translation）
 * - cal：封装全部日历 IPC 通道调用与事件订阅，供各组件使用
 */
import { useEffect, useState } from 'react'
import type { PluginBridge } from '../../../plugin-sdk/src/renderer'
import type {
  CalendarEvent,
  CalendarEventInstance,
  CalendarTodo,
  CalendarTodoInstance,
  CalendarTodoStats,
  CalendarSettings,
  OutlookSyncStatus,
  ListEventsParams,
  CreateEventInput,
  UpdateEventInput,
  DeleteInstanceMode,
  DeleteEventInstanceParams,
  DeleteTodoInstanceParams,
  CreateTodoInput,
  UpdateTodoInput,
  NotifyPayload,
  NotifyClickPayload,
} from './types'

let bridge: PluginBridge | null = null
let hostI18n: ((key: string, options?: Record<string, unknown>) => string) | null = null

export function setBridge(b: PluginBridge): void {
  bridge = b
}
export function setHostI18n(t: (key: string, options?: Record<string, unknown>) => string): void {
  hostI18n = t
}
/** 非组件场景（hook/store）下的宿主 i18n 取词，key 形如 calendar.xxx */
export function hostT(key: string, options?: Record<string, unknown>): string {
  if (hostI18n) return hostI18n(key, options)
  return key
}

export function invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  if (!bridge) return Promise.reject(new Error('插件桥未就绪'))
  return bridge.invoke<T>(channel, payload)
}

/** 订阅宿主 broadcast 事件，返回取消订阅函数 */
export function onEvent(event: string, callback: (payload: unknown) => void): () => void {
  if (!bridge) return () => {}
  return bridge.onEvent(event, callback)
}

// ====== DOM 主题 / 语言 ======

export function isDarkTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark'
}

/** 订阅宿主 DOM 主题/语言变化（宿主 appearance.store 变更时写入），返回取消订阅 */
export function subscribeAppearance(cb: () => void): () => void {
  const observer = new MutationObserver(() => cb())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-locale'] })
  return () => observer.disconnect()
}

/** React 响应式主题（替代宿主 appearance.store 订阅，DOM 变化自动刷新） */
export function useAppearance(): { isDark: boolean } {
  const [isDark, setIsDark] = useState(() => isDarkTheme())
  useEffect(() => {
    const unsub = subscribeAppearance(() => {
      setIsDark(isDarkTheme())
    })
    return unsub
  }, [])
  return { isDark }
}

// ====== 日历 IPC 通道封装 ======

type ResultWithError<T> = (T & { error?: string }) | { error: string }

export const cal = {
  // 事件
  listEvents: (range: ListEventsParams) => invoke<CalendarEventInstance[]>('list-events', range),
  createEvent: (input: CreateEventInput) => invoke<CalendarEvent | { error: string }>('create-event', input),
  updateEvent: (input: UpdateEventInput) => invoke<CalendarEvent | { error: string }>('update-event', input),
  deleteEvent: (id: string) => invoke<{ success: boolean } | { error: string }>('delete-event', { id }),
  deleteEventInstance: (params: DeleteEventInstanceParams) =>
    invoke<{ success: boolean } | { error: string }>('delete-event-instance', params),

  // TODO
  listTodos: (params: { expand_instances?: boolean }) => invoke<CalendarTodo[]>('list-todos', params),
  listTodoInstances: (range: { start_at: number; end_at: number }) =>
    invoke<CalendarTodoInstance[]>('list-todo-instances', range),
  createTodo: (input: CreateTodoInput) => invoke<CalendarTodo | { error: string }>('create-todo', input),
  updateTodo: (input: UpdateTodoInput) => invoke<CalendarTodo | { error: string }>('update-todo', input),
  deleteTodo: (id: string) => invoke<{ success: boolean } | { error: string }>('delete-todo', { id }),
  deleteTodoInstance: (params: DeleteTodoInstanceParams) =>
    invoke<{ success: boolean } | { error: string }>('delete-todo-instance', params),
  completeTodo: (id: string, completed: boolean, instance_due_at?: number) =>
    invoke<CalendarTodo | { error: string }>('complete-todo', { id, completed, instance_due_at }),
  todoStats: () => invoke<CalendarTodoStats | { error: string }>('todo-stats'),

  // 设置
  getSettings: () => invoke<CalendarSettings | { error: string }>('get-settings'),
  setSettings: (partial: Partial<CalendarSettings>) => invoke<CalendarSettings | { error: string }>('set-settings', partial),

  // Outlook 同步
  outlook: {
    login: () => invoke<ResultWithError<OutlookSyncStatus>>('outlook-login'),
    logout: () => invoke<ResultWithError<OutlookSyncStatus>>('outlook-logout'),
    status: () => invoke<ResultWithError<OutlookSyncStatus>>('outlook-status'),
    setConfig: (partial: Partial<OutlookSyncStatus['config']>) =>
      invoke<ResultWithError<OutlookSyncStatus>>('outlook-set-config', partial),
    syncNow: () => invoke<ResultWithError<OutlookSyncStatus>>('outlook-sync-now'),
  },

  // 事件订阅（返回取消订阅函数）
  onDataChanged: (cb: (payload: { scope: 'event' | 'todo' | 'settings'; ts: number }) => void): (() => void) =>
    onEvent('data-changed', (payload) => cb(payload as { scope: 'event' | 'todo' | 'settings'; ts: number })),
  onNotify: (cb: (payload: NotifyPayload) => void): (() => void) =>
    onEvent('notify', (payload) => cb(payload as NotifyPayload)),
  onNotifyClick: (cb: (payload: NotifyClickPayload) => void): (() => void) =>
    onEvent('notify-click', (payload) => cb(payload as NotifyClickPayload)),
  onSyncChanged: (cb: (status: OutlookSyncStatus) => void): (() => void) =>
    onEvent('outlook-sync-changed', (payload) => cb(payload as OutlookSyncStatus)),
}

export type { DeleteInstanceMode, NotifyPayload, NotifyClickPayload, OutlookSyncStatus }
