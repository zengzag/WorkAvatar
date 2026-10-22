import type { ToolDefinition } from './types'
import SubAgentRuntime from '../../agent-runtime/runtime'
import UnifiedInteractionService, { interactionContext } from '../../unified-interaction.service'
import { resolveDelegationTarget } from './subagent-tools'

/** 单次并行派发的最大子任务数 */
const MAX_TASKS = 5
/** 委托链深度上限（与 delegate.tool / 运行时保持一致） */
const MAX_DELEGATION_DEPTH = 2
/**
 * await_agents 最长等待窗口。必须严格小于工具层超时（300s）：
 * 否则中间件先超时会抛出原始「工具超时」，而子任务仍在后台运行，主管误判为失败。
 */
const MAX_AWAIT_MS = 280_000

/**
 * 并行编排工具对：
 * - launch_agents：拆解为多个独立子任务并行派发，默认立即返回 runIds（不阻塞）
 * - await_agents：等待一组 runIds 完成，聚合结构化结果（摘要 + 文件 + token）
 *
 * 每个子任务执行者三选一：target_employee_id / ephemeral_role（临时子智能体）/ subagent_profile_id（模板）。
 *
 * 注册方式：与 delegate_to_employee 一样由员工「委托能力设置」驱动注册（见 employee-agent.service）。
 */
export const launchAgentsTool: ToolDefinition = {
  id: 'launch_agents',
  name: 'launch_agents',
  title: '并行派发子任务',
  summary: '拆解多个独立子任务并行派发，立即返回 runIds（可临时角色）',
  description: `Fan out several independent sub-tasks in one call and get their runIds back immediately. Use it whenever 2+ sub-tasks are genuinely independent: emit them all in a single call rather than one by one, then collect the results with await_agents. Use delegate_to_employee instead when sub-tasks depend on each other.

Hard limits: never delegate to yourself; delegation depth is capped at ${MAX_DELEGATION_DEPTH} levels; tasks must not depend on each other.`,
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: `Independent sub-tasks (max ${MAX_TASKS})`,
        items: {
          type: 'object',
          properties: {
            target_employee_id: { type: 'string', description: 'Executor option 1 of 3: an existing employee id' },
            ephemeral_role: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Short duty name' },
                description: { type: 'string', description: 'Optional note' },
                system_prompt: { type: 'string', description: 'Self-contained role prompt' },
                tools: { type: 'array', items: { type: 'string' }, description: 'Optional host builtin tool id allowlist' },
                skills: { type: 'array', items: { type: 'string' }, description: 'Optional skill id list' },
                provider_id: { type: 'string', description: 'Optional provider id (pair with model_id)' },
                model_id: { type: 'string', description: 'Optional model id' },
              },
              required: ['name', 'system_prompt'],
              description: 'Executor option 2 of 3: a one-off sub-agent spec',
            },
            subagent_profile_id: { type: 'string', description: 'Executor option 3 of 3: a reusable sub-agent profile id' },
            instruction: { type: 'string', description: 'Self-contained instruction for this sub-task' },
            context_files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional absolute context file paths (max 10)',
            },
            task_items: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional checklist for this sub-task',
            },
          },
          required: ['instruction'],
        },
      },
      run_in_background: { type: 'boolean', description: 'Dispatch all sub-tasks in the background' },
    },
    required: ['tasks'],
  },
  handler: handleLaunchAgents,
  source: 'builtin',
  onDemand: false,
  permission: 'safe',
  noRetry: true,
}

export const awaitAgentsTool: ToolDefinition = {
  id: 'await_agents',
  name: 'await_agents',
  title: '等待子任务完成',
  summary: '等待一组子任务（runIds）完成并聚合结果',
  description: `Wait for runIds returned by launch_agents / delegate_to_employee and aggregate their results (summary + generated files + token usage).

Each entry is ✓ completed, ⏳ still running, or ✗ failed. ⏳ is NOT a failure — those runs keep going in the background; call await_agents again or read the notice via read_run_notifications. A failed run does not block the others. Summarize from the returned results and file lists instead of replaying the sub-agents' traces to the user.

timeout_seconds defaults to 280 and is capped at 280.`,
  parameters: {
    type: 'object',
    properties: {
      run_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'runIds returned by launch_agents / delegate_to_employee',
      },
      timeout_seconds: { type: 'number', description: 'Max wait in seconds (default 280, max 280)' },
    },
    required: ['run_ids'],
  },
  handler: handleAwaitAgents,
  source: 'builtin',
  onDemand: false,
  permission: 'safe',
  noRetry: true,
  timeoutMs: 5 * 60 * 1000,
}

async function handleLaunchAgents(args: Record<string, any>): Promise<any> {
  const tasks: any[] = Array.isArray(args.tasks) ? args.tasks : []
  const background = args.run_in_background === true
  if (tasks.length === 0) {
    return { success: false, error: 'tasks 不能为空' }
  }
  if (tasks.length > MAX_TASKS) {
    return { success: false, error: `tasks 数量超限（最多 ${MAX_TASKS} 个，传入 ${tasks.length} 个）` }
  }

  const store = interactionContext.getStore()
  if (!store) {
    return { success: false, error: '并行派发失败：缺少会话上下文' }
  }

  const runtime = SubAgentRuntime.getInstance()
  const runIds: string[] = []
  const failures: Array<{ index: number; error: string }> = []

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i] || {}
    if (typeof task.instruction !== 'string' || !task.instruction.trim()) {
      failures.push({ index: i, error: '缺少 instruction' })
      continue
    }
    const target = resolveDelegationTarget(task)
    if (target.error) {
      failures.push({ index: i, error: target.error })
      continue
    }
    const launched = runtime.launchSubAgent({
      // 根会话 id：嵌套层级也路由到顶层会话，前端才能看到子任务进度
      parentSessionId: store.rootSessionId || store.sessionId,
      parentEmployeeId: store.employeeId,
      parentConversationId: store.conversationId || '',
      // 发起方 run id（顶层会话为空）：前端据此把子子任务挂到父委托卡内
      parentRunId: store.delegationId,
      targetEmployeeId: target.targetEmployeeId || '',
      ephemeral: target.ephemeral,
      instruction: String(task.instruction),
      contextFiles: Array.isArray(task.context_files) ? task.context_files : [],
      delegationDepth: store.delegationDepth ?? 0,
      delegationChain: store.delegationChain ?? [],
      parentAbortSignal: store.abortSignal,
      enableThinking: store.enableThinking,
      // 任务级高权限（确认弹窗中"本轮任务不再提醒"）随委托下传：子员工在自身工作区外操作同样免确认
      highPermission: store.highPermission || UnifiedInteractionService.getInstance().isTaskHighPermission(),
      runInBackground: background,
    })
    if (launched.success && launched.runId) {
      runIds.push(launched.runId)
      if (Array.isArray(task.task_items) && (task.task_items as any[]).length > 0) {
        for (const title of task.task_items) {
          if (typeof title === 'string' && title.trim()) runtime.createTask(launched.runId, title)
        }
      }
    } else {
      failures.push({ index: i, error: launched.error || '派发失败' })
    }
  }

  const parts: string[] = []
  if (runIds.length > 0) {
    if (background) {
      parts.push(`已在后台并行派发 ${runIds.length} 个子任务：\n${runIds.map((id, i) => `${i + 1}. ${id}`).join('\n')}\n完成后调 read_run_notifications 获取结果。`)
    } else {
      parts.push(`已并行派发 ${runIds.length} 个子任务：\n${runIds.map((id, i) => `${i + 1}. ${id}`).join('\n')}\n请随后调用 await_agents(run_ids) 等待结果。`)
    }
  }
  if (failures.length > 0) {
    parts.push(`以下子任务派发失败：\n${failures.map(f => `${f.index + 1}. ${f.error}`).join('\n')}`)
  }
  return {
    success: runIds.length > 0,
    output: parts.join('\n\n'),
    runIds,
    failed: failures,
  }
}

async function handleAwaitAgents(args: Record<string, any>): Promise<any> {
  const runIds: string[] = Array.isArray(args.run_ids) ? args.run_ids.filter(Boolean) : []
  if (runIds.length === 0) {
    return { success: false, error: 'run_ids 不能为空' }
  }
  const timeoutSec = typeof args.timeout_seconds === 'number' && args.timeout_seconds > 0
    ? Math.min(args.timeout_seconds * 1000, MAX_AWAIT_MS)
    : MAX_AWAIT_MS

  const runtime = SubAgentRuntime.getInstance()
  const outcomes = await runtime.awaitRuns(runIds, timeoutSec)

  const lines: string[] = []
  const pendingIds: string[] = []
  for (const o of outcomes) {
    if (o.success) {
      lines.push(`[✓ ${o.runId}] ${firstLine(o.output || '已完成')}`)
    } else if (o.pending) {
      pendingIds.push(o.runId)
      lines.push(`[⏳ ${o.runId}] 仍在执行中（尚未结束，未失败也未取消）`)
    } else {
      lines.push(`[✗ ${o.runId}] ${o.error || '执行失败'}`)
    }
  }
  if (pendingIds.length > 0) {
    lines.push('仍在执行中的子任务不是失败：请勿向用户报告失败。可用 await_agents 再次等待或 get_subagent_status 查询，完成后会收到通知（read_run_notifications）。')
  }
  return {
    // 仍在执行的子任务不算失败（已结束的成功子任务同样满足）
    success: outcomes.some(o => o.success || o.pending),
    output: lines.join('\n'),
    results: outcomes,
  }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] || ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}
