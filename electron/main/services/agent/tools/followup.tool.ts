import type { ToolDefinition } from './types'
import SubAgentRuntime from '../../agent-runtime/runtime'
import { interactionContext } from '../../unified-interaction.service'

/**
 * followup_delegation 工具：
 * 主管针对已完成委托的执行情况进行追问/补充要求，子智能体保留原任务上下文继续多轮协作。
 *
 * 与 delegate_to_employee 的关系：
 * - delegate_to_employee 每次创建全新子会话（无历史）
 * - followup_delegation 复用原委托的子会话与任务工作区，历史各轮（指令/结果/错误）
 *   自动注入子智能体上下文，实现跨轮记忆（含应用重启后，经 sub_agent_runs.conversation_id 恢复）
 *
 * 典型场景：委托结果有错误、缺失细节或不达验收标准时，追问修正而非重新委托。
 * 限制：只能追问已结束的委托；同一子会话累计轮数上限 5 轮（含首轮）。
 */
export const followupTool: ToolDefinition = {
  id: 'followup_delegation',
  name: 'followup_delegation',
  title: '追问子智能体',
  summary: '针对已完成委托的结果追问/补充要求，子智能体保留原任务上下文',
  description: `针对已完成委托（delegate_to_employee 或 followup_delegation）的执行结果进行追问，同一子智能体保留原任务全部上下文继续多轮协作。
适用场景：结果存在错误、缺失细节、不满足验收标准，需要修正或补充而非重新委托。
参数：
- delegation_id: 目标委托 id（delegate_to_employee / followup_delegation 返回结果中的 delegationId）
- instruction: 追问内容（明确指出问题所在与期望的修正结果）
返回：子智能体基于历史上下文的追问结果摘要与产物文件清单。
限制：只能追问已结束的委托；同一委托对话累计轮数上限 5 轮（含首轮）。`,
  parameters: {
    type: 'object',
    properties: {
      delegation_id: { type: 'string', description: '目标委托 id（delegate_to_employee / followup_delegation 返回结果中的 delegationId）' },
      instruction: { type: 'string', description: '追问内容：指出上一轮结果的问题（错误/缺失细节）与期望的修正结果' },
    },
    required: ['delegation_id', 'instruction'],
  },
  handler: handleFollowup,
  source: 'builtin',
  onDemand: false,
  permission: 'safe',
  noRetry: true,
  timeoutMs: 5 * 60 * 1000,
}

async function handleFollowup(args: Record<string, any>): Promise<any> {
  const { delegation_id, instruction } = args

  const store = interactionContext.getStore()
  if (!store) {
    return { success: false, error: '追问失败：缺少会话上下文' }
  }

  const runtime = SubAgentRuntime.getInstance()
  const launched = runtime.launchFollowup({
    followupOfRunId: String(delegation_id || ''),
    parentSessionId: store.sessionId,
    parentEmployeeId: store.employeeId,
    parentConversationId: store.conversationId || '',
    instruction: String(instruction || ''),
    delegationDepth: store.delegationDepth ?? 0,
    delegationChain: store.delegationChain ?? [],
    parentAbortSignal: store.abortSignal,
    enableThinking: store.enableThinking,
    highPermission: store.highPermission,
  })

  if (!launched.success || !launched.runId) {
    return { success: false, error: launched.error || '追问失败', targetEmployeeName: launched.targetEmployeeName }
  }

  // 同步等待（与 delegate_to_employee 行为一致）；结果经 awaitRuns 聚合
  const outcomes = await runtime.awaitRuns([launched.runId])
  const outcome = outcomes[0]
  const base = {
    delegationId: launched.runId,
    followupOfDelegationId: delegation_id,
    targetEmployeeName: launched.targetEmployeeName,
  }

  if (!outcome) {
    return { success: false, error: '追问执行异常', ...base }
  }

  if (outcome.success) {
    return {
      success: true,
      output: outcome.output || `已追问 ${launched.targetEmployeeName} 并获得补充结果。`,
      ...base,
      tokenUsage: outcome.tokenUsage,
    }
  }
  return {
    success: false,
    error: outcome.error || '追问执行失败',
    ...base,
    tokenUsage: outcome.tokenUsage,
  }
}
