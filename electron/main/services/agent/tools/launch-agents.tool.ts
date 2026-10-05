import type { ToolDefinition } from './types'
import SubAgentRuntime from '../../agent-runtime/runtime'
import UnifiedInteractionService, { interactionContext } from '../../unified-interaction.service'
import { resolveDelegationTarget } from './subagent-tools'

/** 单次并行派发的最大子任务数 */
const MAX_TASKS = 5

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
  description: `将一个任务拆解为多个相互独立的子任务，并行派发执行。适用于需要多名执行者同时分工（如同时调研多份资料、并行生成多个文档）的复杂任务。
参数：
- tasks: 子任务数组（1-${MAX_TASKS} 个），每项包含：
  - 执行者三选一：target_employee_id（已有员工，从上下文信息 [DELEGATION] 段选择）/ ephemeral_role（临时子智能体，字段同 delegate_to_employee）/ subagent_profile_id（模板 id）
  - instruction: 该子任务指令
  - context_files: 可选，上下文文件绝对路径列表（最多 10 个）
  - task_items: 可选，该子任务的台账要点（子任务需逐项收尾）
- run_in_background: 可选，true 时全部后台执行（跳过 await 也行，完成后经 read_run_notifications 获取）
返回：runIds 数组 + 各任务派发结果。**默认调用后立即继续**，随后用 await_agents 等待全部完成并聚合结果。
限制：不能委托给自己；委托深度上限 3；子任务之间不应有依赖（有依赖请改用 delegate_to_employee 串行）。`,
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: `子任务数组（最多 ${MAX_TASKS} 个）`,
        items: {
          type: 'object',
          properties: {
            target_employee_id: { type: 'string', description: '三选一：已有数字员工 id' },
            ephemeral_role: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '简洁职责名' },
                description: { type: 'string', description: '可选说明' },
                system_prompt: { type: 'string', description: '自包含角色提示词' },
                tools: { type: 'array', items: { type: 'string' }, description: '可选工具 id 白名单' },
                skills: { type: 'array', items: { type: 'string' }, description: '可选技能 id 列表' },
                provider_id: { type: 'string', description: '可选供应商 id（需与 model_id 成对）' },
                model_id: { type: 'string', description: '可选模型 id' },
              },
              required: ['name', 'system_prompt'],
              description: '三选一：临时子智能体规格',
            },
            subagent_profile_id: { type: 'string', description: '三选一：子智能体模板 id' },
            instruction: { type: 'string', description: '该子任务指令' },
            context_files: {
              type: 'array',
              items: { type: 'string' },
              description: '可选，上下文文件绝对路径（最多 10 个）',
            },
            task_items: {
              type: 'array',
              items: { type: 'string' },
              description: '可选，该子任务的台账要点',
            },
          },
          required: ['instruction'],
        },
      },
      run_in_background: { type: 'boolean', description: '可选，true 时全部后台执行' },
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
  description: `等待 launch_agents 派发的一组子任务全部完成（或超时、部分失败），聚合返回每个子任务的结构化结果（结果摘要 + 生成文件清单 + token 用量）。
参数：
- run_ids: launch_agents / delegate_to_employee 返回的子任务 runId 数组
- timeout_seconds: 可选，最长等待秒数（默认 280）
返回：按传入顺序排列的每个子任务结果数组。子任务失败不阻断其他子任务；请基于返回的文件清单向用户汇总（不要把子任务完整过程复述给用户）。`,
  parameters: {
    type: 'object',
    properties: {
      run_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'launch_agents / delegate_to_employee 返回的子任务 runId 数组',
      },
      timeout_seconds: { type: 'number', description: '可选，最长等待秒数（默认 280）' },
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
      parentSessionId: store.sessionId,
      parentEmployeeId: store.employeeId,
      parentConversationId: store.conversationId || '',
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
    ? Math.min(args.timeout_seconds * 1000, 5 * 60 * 1000)
    : 280000

  const runtime = SubAgentRuntime.getInstance()
  const outcomes = await runtime.awaitRuns(runIds, timeoutSec)

  const lines: string[] = []
  for (const o of outcomes) {
    if (o.success) {
      lines.push(`[✓ ${o.runId}] ${firstLine(o.output || '已完成')}`)
    } else {
      lines.push(`[✗ ${o.runId}] ${o.error || '执行失败'}`)
    }
  }
  return {
    success: outcomes.some(o => o.success),
    output: lines.join('\n'),
    results: outcomes,
  }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] || ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}
