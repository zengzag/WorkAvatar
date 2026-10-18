/** 后台终端任务状态：与 background-shell.service 的 BackgroundShellStatus 对齐 */
export type ShellBgStatus = 'running' | 'exited' | 'killed'

export const SHELL_BG_CHANNELS = {
  /** 列出后台终端任务（按当前会话及其子会话过滤） */
  SHELL_BG_LIST: 'shell-bg:list',
  /** 终止指定后台终端任务（用户手动停止入口） */
  SHELL_BG_KILL: 'shell-bg:kill',
  /** 主进程 → 渲染进程：任务集合或状态发生变化，渲染端据此刷新列表 */
  SHELL_BG_CHANGED: 'shell-bg:changed',
} as const

export interface ShellBgListParams {
  /** 当前会话 id；传入时仅返回该会话及其子会话（委托子任务）启动的任务，不传则返回全部 */
  conversationId?: string
}

export interface ShellBgKillParams {
  taskId: string
}

export interface ShellBgKillResult {
  ok: boolean
  error?: string
}

/** 渲染端可见的任务信息（不含属主键等内部字段） */
export interface ShellBgTaskItem {
  id: string
  command: string
  cwd: string
  pid?: number
  status: ShellBgStatus
  exitCode: number | null
  startedAt: number
  endedAt?: number
  totalChars: number
}
