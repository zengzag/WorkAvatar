/**
 * automation 插件共享状态与宿主桥接。
 * - bridge：宿主注入的通用 IPC 桥（invoke 携带 automation 插件 id 前缀）
 * - auto：封装全部自动化 IPC 通道调用与事件订阅，供各组件使用
 */
import type { PluginBridge } from '../../../plugin-sdk/src/renderer'
import type {
  AutomationTask,
  AutomationRun,
  CreateAutomationTaskInput,
  UpdateAutomationTaskInput,
  PreviewRunsParams,
  ListAutomationTasksParams,
  ListAutomationRunsParams,
} from './types'

let bridge: PluginBridge | null = null

export function setBridge(b: PluginBridge): void {
  bridge = b
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

type ResultWithError<T> = (T & { error?: string }) | { error: string }

export const auto = {
  // 任务 CRUD
  listTasks: (params?: ListAutomationTasksParams) => invoke<AutomationTask[]>('list-tasks', params),
  getTask: (id: string) => invoke<AutomationTask | { error: string }>('get-task', id),
  createTask: (input: CreateAutomationTaskInput) => invoke<ResultWithError<AutomationTask>>('create-task', input),
  updateTask: (input: UpdateAutomationTaskInput) => invoke<ResultWithError<AutomationTask>>('update-task', input),
  deleteTask: (id: string) => invoke<{ success: boolean } | { error: string }>('delete-task', { id }),
  toggleTask: (id: string, enabled: boolean) => invoke<ResultWithError<AutomationTask>>('toggle-task', { id, enabled }),
  // 执行
  runNow: (id: string) => invoke<ResultWithError<AutomationRun>>('run-now', { id }),
  previewRuns: (params: PreviewRunsParams) => invoke<{ runs: number[] } | { error: string }>('preview-runs', params),
  // 运行历史 CRUD
  listRuns: (params?: ListAutomationRunsParams) => invoke<AutomationRun[]>('list-runs', params),
  deleteRun: (id: string) => invoke<{ success: boolean } | { error: string }>('delete-run', { id }),
  clearRuns: (params?: { task_id?: string }) => invoke<{ success: boolean; count: number } | { error: string }>('clear-runs', params),
  // 事件订阅
  onDataChanged: (cb: (payload: { scope: 'task' | 'run' | 'settings'; ts: number }) => void): (() => void) =>
    onEvent('data-changed', (payload) => cb(payload as { scope: 'task' | 'run' | 'settings'; ts: number })),
  onMetaChanged: (cb: (payload: { scope: 'employees' | 'providers'; ts: number }) => void): (() => void) =>
    onEvent('meta-changed', (payload) => cb(payload as { scope: 'employees' | 'providers'; ts: number })),
}
