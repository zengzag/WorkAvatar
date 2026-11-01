import type { ToolDefinition } from './types'
import BackgroundShellService, { type BackgroundShellSnapshot } from '../../background-shell.service'

/** 单次读取返回的输出字符上限（与 service 内部上限保持一致） */
const MAX_READ_CHARS = 30_000
const DEFAULT_READ_CHARS = 8_000
const MAX_WAIT_MS = 30_000

/** 任务状态的中文描述（含退出码） */
function describeStatus(snapshot: BackgroundShellSnapshot): string {
  if (snapshot.status === 'running') return '运行中'
  if (snapshot.status === 'killed') return '已终止'
  return `已结束（exit_code=${snapshot.exitCode === null ? '未知' : snapshot.exitCode}${snapshot.signal ? `, signal=${snapshot.signal}` : ''}）`
}

function describeElapsed(snapshot: BackgroundShellSnapshot): string {
  const seconds = Math.max(0, Math.round(((snapshot.endedAt || Date.now()) - snapshot.startedAt) / 1000))
  return `${seconds}s`
}

/**
 * 读取后台任务输出（增量，不阻塞回合）。
 * 不传 offset 时返回尾部窗口；wait_ms 用于等待新输出（如等待服务启动日志）。
 */
export const shellOutputTool: ToolDefinition = {
  id: 'shell_output',
  name: 'shell_output',
  title: '读取后台任务输出',
  summary: 'Read output from a task started with shell_exec(run_in_background), with incremental reads and waits for new output.',
  description: `Read the output of a background task started with shell_exec(run_in_background=true).

- task_id: background task id (returned at launch).
- offset: start offset (the next_offset from the previous read). Omit it to read the tail, which is useful for a status check.
- max_chars: maximum characters to return (default ${DEFAULT_READ_CHARS}, max ${MAX_READ_CHARS}).
- wait_ms: milliseconds to wait for new output (max ${MAX_WAIT_MS}). Returns as soon as output arrives; do not use long waits unnecessarily.

Behavior:
- Only the most recent 200000 characters are retained; older output is dropped and reported.
- next_offset continues the next read; retained output remains readable after the task ends.
- If a command can finish within the turn (e.g. a single build), run it in the foreground instead of polling.`,
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Background task id returned by shell_exec(run_in_background=true)' },
      offset: { type: 'number', description: 'Start character offset (the previous next_offset); omit to read the tail', minimum: 0 },
      max_chars: { type: 'number', description: `Maximum characters to return (default ${DEFAULT_READ_CHARS}, max ${MAX_READ_CHARS})`, minimum: 1, maximum: MAX_READ_CHARS },
      wait_ms: { type: 'number', description: `Milliseconds to wait for new output (max ${MAX_WAIT_MS}; default 0)`, minimum: 0, maximum: MAX_WAIT_MS },
    },
    required: ['task_id'],
  },
  handler: async (args: any) => {
    const taskId = String(args.task_id || '').trim()
    if (!taskId) return { success: false, error: 'task_id 不能为空' }

    const result = await BackgroundShellService.getInstance().read(taskId, {
      offset: args.offset === undefined || args.offset === null ? undefined : Number(args.offset),
      maxChars: args.max_chars,
      waitMs: args.wait_ms,
    })
    if (!result.ok) return { success: false, error: result.error }

    const { snapshot, text, nextOffset, droppedChars, hasMore } = result
    const lines = [
      `任务 ${snapshot.id} 状态: ${describeStatus(snapshot)}（已运行 ${describeElapsed(snapshot)}）`,
      `命令: ${snapshot.command}`,
      `工作目录: ${snapshot.cwd}`,
      `输出进度: 累计 ${snapshot.totalChars} 字符；本次返回 ${text.length} 字符（起始偏移 ${nextOffset - text.length}）`,
      `next_offset: ${nextOffset}`,
    ]
    if (droppedChars > 0) {
      lines.push(`注意: 起始偏移之前的 ${droppedChars} 字符已滚出保留窗口（仅保留最近 200000 字符），如需完整日志请把命令输出重定向到文件`)
    }

    lines.push('--- 输出 ---')
    lines.push(text || '（暂无输出）')
    if (hasMore) {
      lines.push(`（还有未返回的输出，继续调用 shell_output(task_id="${snapshot.id}", offset=${nextOffset})）`)
    } else if (snapshot.status === 'running' && text.length === 0) {
      lines.push('（任务仍在运行且暂无新输出；可传 wait_ms 等待，或稍后再读）')
    }

    return { success: true, output: lines.join('\n') }
  },
  source: 'builtin',
  permission: 'safe',
  onDemand: true,
  noRetry: true,
  // 覆盖默认工具超时：wait_ms 上限 30s，外层需留余量
  timeoutMs: MAX_WAIT_MS + 10_000,
}

/** 终止后台任务（终止的是本会话启动的任务，已结束的任务无需终止） */
export const shellKillTool: ToolDefinition = {
  id: 'shell_kill',
  name: 'shell_kill',
  title: '终止后台任务',
  summary: 'Terminate a background task started with shell_exec(run_in_background), including its child process tree.',
  description: `Terminate a background task and its child process tree (Windows uses taskkill /T /F).

- task_id: background task id.
- Calling it on an already-finished task is safe; it returns the current status without error.
- Stop dev servers and watch tasks once they are no longer needed to free ports and resources; at most 8 background tasks run per conversation.
- The user can also stop them from the "Background tasks" entry below the conversation.`,
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Background task id to terminate' },
    },
    required: ['task_id'],
  },
  handler: (args: any) => {
    const taskId = String(args.task_id || '').trim()
    if (!taskId) return { success: false, error: 'task_id 不能为空' }

    const result = BackgroundShellService.getInstance().kill(taskId)
    if (!result.ok) return { success: false, error: result.error }

    const snapshot = result.snapshot
    const prefix = snapshot.status === 'running'
      ? `已发送终止信号: ${snapshot.id}`
      : `任务 ${snapshot.id} 当前状态为「${describeStatus(snapshot)}」，无需终止`
    return {
      success: true,
      output: [
        prefix,
        `命令: ${snapshot.command}`,
        `输出进度: 累计 ${snapshot.totalChars} 字符（如需最后输出可调用 shell_output 读取）`,
      ].join('\n'),
    }
  },
  source: 'builtin',
  permission: 'safe',
  onDemand: true,
  noRetry: true,
}
