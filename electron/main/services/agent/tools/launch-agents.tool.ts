import type { ToolDefinition } from './types'
import SubAgentRuntime from '../../agent-runtime/runtime'
import { interactionContext } from '../../unified-interaction.service'

/** 单次并行派发的最大子任务数 */
const MAX_TASKS = 5

/**
 * 并行编排工具对：
 * - launch_agents：拆解为多个独立子任务并行派发，立即返回 runIds（不阻塞）
 * - await_agents：等待一组 runIds 完成，聚合结构化结果（摘要 + 文件 + token）
 *
 * 与 delegate_to_employee（单路串行）互补：任务之间相互独立且价值足够高时用并行，
 * 有依赖关系时用串行委托。
 */
export const launchAgentsTool: ToolDefinition = {
  id: 'launch_agents',
  name: 'launch_agents',
  title: '并行派发子任务',
  summary: '拆解多个独立子任务并行派发给数字员工，立即返回 runIds',
  description: `将一个任务拆解为多个相互独立的子任务，并行派发给不同的数字员工执行。适用于需要多名员工同时分工（如同时调研多份资料、并行生成多个文档）的复杂任务。
参数：
- tasks: 子任务数组（1-${MAX_TASKS} 个），每项包含：
  - target_employee_id: 目标数字员工 id（从可委托员工列表中选择）
  - instruction: 该子任务指令
  - context_files: 可选，上下文文件绝对路径列表（最多 10 个）
返回：runIds 数组 + 各任务派发结果。**调用后立即继续**，随后用 await_agents 等待全部完成并聚合结果。
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
            target_employee_id: { type: 'string', description: '目标数字员工 id（从可委托员工列表中选择）' },
            instruction: { type: 'string', description: '该子任务指令' },
            context_files: {
              type: 'array',
              items: { type: 'string' },
              description: '可选，传给子员工的上下文文件绝对路径（最多 10 个）',
            },
          },
          required: ['target_employee_id', 'instruction'],
        },
      },
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
- run_ids: launch_agents 返回的子任务 runId 数组
- timeout_seconds: 可选，最长等待秒数（默认 280）
返回：按传入顺序排列的每个子任务结果数组。子任务失败不阻断其他子任务；请基于返回的文件清单向用户汇总（不要把子任务完整过程复述给用户）。`,
  parameters: {
    type: 'object',
    properties: {
      run_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'launch_agents 返回的子任务 runId 数组',
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

/** 编排工作流协议（"计划→并行→验证"循环），注入多智能体描述 */
const ORCHESTRATION_PROTOCOL = `编排工作流（处理复杂任务时按以下循环执行）：
1. 规划：将大任务拆解为相互独立、边界清晰的子任务。
2. 并行：调用 launch_agents 一次性派发全部子任务（一次派发一批，不要逐个串行派发）。
3. 聚合：调用 await_agents 等待并收集每个子任务的结构化结果（摘要 + 生成文件清单 + token 用量）。
4. 验证：核对各子任务结果与产物文件；对失败或不达标的子任务，用 delegate_to_employee 串行补做，或再次 launch_agents 重新派发。
5. 汇总：基于结果与文件向用户交付最终结论；不要复述子任务完整执行过程，只给结论、文件与关键依据。`

/** 构造 launch_agents/await_agents 的动态 description（含可委托员工列表） */
export function buildMultiAgentDescription(employeeId: string, employees: Array<{ id: string; name: string; description?: string; role?: string }>): string {
  const others = employees.filter(e => e.id !== employeeId)
  const listText = others.length > 0
    ? others.map(e => {
        const desc = e.description?.trim() || e.role?.trim()
        return `- ${e.name} (id=${e.id})${desc ? `：${desc}` : ''}`
      }).join('\n')
    : '（暂无其他数字员工）'
  return `${launchAgentsTool.description}

可委托员工列表（依据各员工的能力描述判断是否适合派发，为每个子任务选择最匹配的员工）：
${listText}

${ORCHESTRATION_PROTOCOL}`
}

async function handleLaunchAgents(args: Record<string, any>): Promise<any> {
  const tasks: any[] = Array.isArray(args.tasks) ? args.tasks : []
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
    if (!task.target_employee_id || typeof task.target_employee_id !== 'string') {
      failures.push({ index: i, error: '缺少 target_employee_id' })
      continue
    }
    if (typeof task.instruction !== 'string' || !task.instruction.trim()) {
      failures.push({ index: i, error: '缺少 instruction' })
      continue
    }
    const launched = runtime.launchSubAgent({
      parentSessionId: store.sessionId,
      parentEmployeeId: store.employeeId,
      parentConversationId: store.conversationId || '',
      targetEmployeeId: task.target_employee_id,
      instruction: String(task.instruction),
      contextFiles: Array.isArray(task.context_files) ? task.context_files : [],
      delegationDepth: store.delegationDepth ?? 0,
      delegationChain: store.delegationChain ?? [],
      parentAbortSignal: store.abortSignal,
      enableThinking: store.enableThinking,
      highPermission: store.highPermission,
    })
    if (launched.success && launched.runId) {
      runIds.push(launched.runId)
    } else {
      failures.push({ index: i, error: launched.error || '派发失败' })
    }
  }

  const parts: string[] = []
  if (runIds.length > 0) {
    parts.push(`已并行派发 ${runIds.length} 个子任务：\n${runIds.map((id, i) => `${i + 1}. ${id}`).join('\n')}\n请随后调用 await_agents(run_ids) 等待结果。`)
  }
  if (failures.length > 0) {
    parts.push(`以下子任务派发失败：\n${failures.map(f => `${f.index + 1}. ${f.error}`).join('\n')}`)
  }
  if (parts.length === 0) {
    parts.push('全部子任务派发失败')
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