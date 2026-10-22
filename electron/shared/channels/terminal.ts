export const TERMINAL_CHANNELS = {
  /** 在任务工作区执行一条命令（命令级终端，非交互式 PTY） */
  TERMINAL_EXEC: 'terminal:exec',
  /** 终止当前正在执行的命令 */
  TERMINAL_STOP: 'terminal:stop',
  /** 主进程 → 渲染进程：命令输出与退出事件 */
  TERMINAL_EVENT: 'terminal:event',
} as const

export interface TerminalExecParams {
  /** 终端会话标识：同一标识的 cwd 会延续（cd 生效） */
  terminalId: string
  /** 首次执行时使用的工作目录 */
  cwd: string
  command: string
}

export interface TerminalExecResult {
  ok: boolean
  /** 执行后的工作目录（cd 命令会更新） */
  cwd?: string
  /** 是否启动了子进程（cd / 空命令为 false，不会收到 exit 事件） */
  running?: boolean
  /** 错误码或原始错误文案：busy / outside / not-directory / invalid-cwd */
  error?: string
}

export type TerminalEvent =
  | { terminalId: string; type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { terminalId: string; type: 'exit'; code: number | null; cwd: string }
