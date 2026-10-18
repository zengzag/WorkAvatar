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
  summary: '读取 shell_exec(run_in_background) 启动的任务输出，支持增量续读与等待新输出。',
  description: `读取后台任务的输出。任务由 shell_exec(run_in_background=true) 启动。

- task_id：后台任务 ID（sh 启动结果里返回）。
- offset：起始偏移（上次返回的 next_offset）。不传时返回尾部输出，适合"看看现在怎么样了"。
- max_chars：本次最多返回的字符数（默认 ${DEFAULT_READ_CHARS}，上限 ${MAX_READ_CHARS}）。
- wait_ms：等待新输出的毫秒数（上限 ${MAX_WAIT_MS}）。任务仍在运行且当前没有新输出时会等待，便于等启动日志/构建结束；不要滥用长等待。

行为说明：
- 输出只保留最近 200000 字符，更早的内容会被淘汰并在结果中提示。
- 返回的 next_offset 用于下次续读；任务结束后仍可读取已保留的输出。
- 明明可以一次性等待结束的场景（如一次构建），建议直接用前台 shell_exec，而不是后台 + 轮询。`,
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '后台任务 ID（shell_exec 的 run_in_background 启动结果返回）' },
      offset: { type: 'number', description: '起始字符偏移（上次返回的 next_offset）；不传则返回尾部输出', minimum: 0 },
      max_chars: { type: 'number', description: `本次最多返回字符数（默认 ${DEFAULT_READ_CHARS}，上限 ${MAX_READ_CHARS}）`, minimum: 1, maximum: MAX_READ_CHARS },
      wait_ms: { type: 'number', description: `等待新输出的毫秒数（上限 ${MAX_WAIT_MS}，默认 0 不等待）`, minimum: 0, maximum: MAX_WAIT_MS },
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
  summary: '终止 shell_exec(run_in_background) 启动的后台任务（连同其子进程树）。',
  description: `终止一个后台任务，连同它派生的子进程树一并结束（Windows 走 taskkill /T /F）。

- task_id：后台任务 ID。
- 对已结束的任务调用是安全的，会直接返回当前状态，不会报错。
- dev server / watch 等任务确认不再需要时请及时终止，避免占用端口与资源；同一会话同时运行的后台任务上限为 8 个。
- 用户也可在对话界面下方的「后台任务」入口手动停止（agent 回合异常结束时该入口仍然可用，无需依赖本工具）。`,
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '要终止的后台任务 ID' },
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
