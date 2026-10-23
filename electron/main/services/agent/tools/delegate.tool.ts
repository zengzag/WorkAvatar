import type { ToolDefinition } from './types'
import SubAgentRuntime from '../../agent-runtime/runtime'
import UnifiedInteractionService, { interactionContext } from '../../unified-interaction.service'
import { resolveDelegationTarget } from './subagent-tools'

/** 委托链深度上限：主任务→子任务→子子任务（2 层），第 2 层不得再派发（与运行时保持一致） */
const MAX_DELEGATION_DEPTH = 2

/**
 * delegate_to_employee 工具：
 * 主管员工调用此工具，将子任务委托给指定执行者，同步等待返回结果。
 *
 * 执行者三选一：target_employee_id（已有数字员工）/ ephemeral_role（临时子智能体，现场创建）
 * / subagent_profile_id（子智能体模板）。
 *
 * 注册方式：由员工「委托能力设置」（employees.delegation_json.enabled）驱动，
 * 在 EmployeeAgentService.getOrCreateAgent 中按需注册，不参与员工工具三态配置。
 *
 * 实现方式：薄客户端 —— 校验与执行全部委托给 SubAgentRuntime。
 * - runtime 内部：子会话独立 conversation + 独立 SessionContext（工作区/权限隔离）
 * - 子会话 parent_conversation_id 指向主管会话，不出现在任务列表/检索结果中
 * - 主管 LLM 仅拿到结果摘要 + 文件清单（结构化），子员工完整过程不进主管上下文
 * - 返回 delegationId 可用于 followup_delegation 追问（复用同一子会话多轮协作）
 * - run_in_background=true 时立即返回 runId，完成后经 read_run_notifications 获取结果
 * - 递归防护（深度上限 2 层 + 链上去环）与 abort 传播在 runtime 统一管理
 */
export const delegateTool: ToolDefinition = {
  id: 'delegate_to_employee',
  name: 'delegate_to_employee',
  title: '委托给数字员工',
  summary: 'Delegate one self-contained sub-task to an executor (existing employee, ephemeral role, or profile); wait synchronously or run in the background.',
  description: `Delegate one self-contained sub-task to an executor and wait for its result. The sub-agent works in an isolated context and returns only a self-contained result, so your context stays clean.

Provide exactly one executor: an existing employee, a one-off ephemeral_role, or a reusable subagent_profile_id (candidates are enumerated in the parameter). The instruction must be self-contained — the sub-agent has never seen this conversation.

Returns the result summary, the generated file list and a delegationId.

The synchronous wait window is ~280s. A result with pending=true means the sub-task is still running — NOT a failure, never report it as failed. Check it later with get_subagent_status or await_agents, or read the completion notice via read_run_notifications. Do not repeat the same delegation to retry.

Hard limits: never delegate to yourself; delegation depth is capped at ${MAX_DELEGATION_DEPTH} levels.`,
  parameters: {
    type: 'object',
    properties: {
      target_employee_id: { type: 'string', description: 'Executor option 1 of 3: an existing employee id' },
      ephemeral_role: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short duty name' },
          description: { type: 'string', description: 'Optional note' },
          system_prompt: { type: 'string', description: 'Self-contained role prompt: identity, duties, output requirements, constraints' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Optional allowlist of host builtin tool ids' },
          skills: { type: 'array', items: { type: 'string' }, description: 'Optional skill id list' },
          provider_id: { type: 'string', description: 'Optional provider id (pair with model_id)' },
          model_id: { type: 'string', description: 'Optional model id' },
        },
        required: ['name', 'system_prompt'],
        description: 'Executor option 2 of 3: a one-off sub-agent spec',
      },
      subagent_profile_id: { type: 'string', description: 'Executor option 3 of 3: a reusable sub-agent profile id' },
      instruction: { type: 'string', description: 'Self-contained task instruction: background, objective, acceptance criteria' },
      context_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional absolute context file paths (max 10)',
      },
      task_items: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional checklist the sub-agent must close one by one',
      },
      run_in_background: { type: 'boolean', description: 'Return a runId immediately instead of waiting' },
      output_schema: { type: 'object', description: 'Optional JSON Schema the sub-agent must report against' },
    },
    required: ['instruction'],
  },
  handler: handleDelegate,
  source: 'builtin',
  onDemand: false,
  permission: 'safe',
  noRetry: true,
  timeoutMs: 5 * 60 * 1000,
}

async function handleDelegate(args: Record<string, any>): Promise<any> {
  const { instruction } = args
  const contextFiles: string[] = Array.isArray(args.context_files) ? args.context_files : []

  const store = interactionContext.getStore()
  if (!store) {
    return { success: false, error: '委托失败：缺少会话上下文' }
  }

  const target = resolveDelegationTarget(args)
  if (target.error) {
    return { success: false, error: target.error }
  }

  const runtime = SubAgentRuntime.getInstance()
  const launched = runtime.launchSubAgent({
    // 根会话 id：嵌套层级也路由到顶层会话，前端才能看到子任务进度
    parentSessionId: store.rootSessionId || store.sessionId,
    parentEmployeeId: store.employeeId,
    parentConversationId: store.conversationId || '',
    // 发起方 run id（顶层会话为空）：前端据此把子子任务挂到父委托卡内
    parentRunId: store.delegationId,
    targetEmployeeId: target.targetEmployeeId || '',
    ephemeral: target.ephemeral,
    instruction,
    contextFiles,
    delegationDepth: store.delegationDepth ?? 0,
    delegationChain: store.delegationChain ?? [],
    parentAbortSignal: store.abortSignal,
    enableThinking: store.enableThinking,
    // 任务级高权限（确认弹窗中"本轮任务不再提醒"）随委托下传：子员工在自身工作区外操作同样免确认
    highPermission: store.highPermission || UnifiedInteractionService.getInstance().isTaskHighPermission(),
    runInBackground: args.run_in_background === true,
    outputSchema: (args.output_schema && typeof args.output_schema === 'object') ? args.output_schema as Record<string, unknown> : undefined,
  })

  if (!launched.success || !launched.runId) {
    return { success: false, error: launched.error || '委托失败', targetEmployeeName: launched.targetEmployeeName }
  }

  // 台账任务项：委托成功后登记到子 run（完成门依据）
  if (Array.isArray(args.task_items) && (args.task_items as any[]).length > 0) {
    for (const title of args.task_items) {
      if (typeof title === 'string' && title.trim()) runtime.createTask(launched.runId, title)
    }
  }

  // 后台派发：立即返回 runId，由主管稍后 read_run_notifications
  if (args.run_in_background === true) {
    return { success: true, background: true, delegationId: launched.runId, targetEmployeeName: launched.targetEmployeeName, targetEmployeeId: launched.targetEmployeeId, output: `已在后台派发 ${launched.targetEmployeeName}（runId=${launched.runId}），完成后可调 read_run_notifications 获取结果。` }
  }

  // 同步等待（单路委托，与旧行为一致）；结果经 awaitRuns 聚合
  const outcomes = await runtime.awaitRuns([launched.runId])
  const outcome = outcomes[0]
  const base = { delegationId: launched.runId, targetEmployeeName: launched.targetEmployeeName, targetEmployeeId: launched.targetEmployeeId }

  if (!outcome) {
    return { success: false, error: '委托执行异常', ...base }
  }

  // 同步等待窗口内未结束：子任务仍在执行（不是失败）。转为后台通知，完成后主管可读取
  if (outcome.pending) {
    return {
      success: true,
      pending: true,
      output: `${launched.targetEmployeeName} 仍在执行中（已超出同步等待窗口，尚未结束，未失败也未取消）。\n` +
        `不要向用户报告失败。可选动作：稍后用 get_subagent_status 查看进度（run_id=${launched.runId}）；用 await_agents(["${launched.runId}"]) 再次等待；` +
        '完成后会向本会话投递通知（read_run_notifications 读取），届时也可用 followup_delegation 追问同一子智能体。',
      ...base,
    }
  }

  if (outcome.success) {
    return {
      success: true,
      output: outcome.output || `已委托 ${launched.targetEmployeeName} 完成任务。`,
      ...base,
      tokenUsage: outcome.tokenUsage,
      result: outcome.result,
    }
  }
  return {
    success: false,
    error: outcome.error || '委托执行失败',
    ...base,
    tokenUsage: outcome.tokenUsage,
  }
}
