import type { ToolDefinition } from './types'
import SubAgentRuntime from '../../agent-runtime/runtime'
import UnifiedInteractionService, { interactionContext } from '../../unified-interaction.service'

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
  summary: 'Ask a finished delegation for revisions or clarifications; the sub-agent keeps its original task context.',
  description: `Ask follow-up questions or request revisions on a finished delegation. The same sub-agent keeps its original task context, so prefer this over re-delegating when a result is wrong, incomplete, or misses an acceptance criterion.

delegation_id: the delegationId returned by delegate_to_employee / followup_delegation.
instruction: what was wrong or missing, and what the corrected result should be.

Limits: only finished delegations can be followed up; a delegation conversation is capped at 5 rounds including the first.`,
  parameters: {
    type: 'object',
    properties: {
      delegation_id: { type: 'string', description: 'Target delegationId returned by delegate_to_employee / followup_delegation' },
      instruction: { type: 'string', description: 'What was wrong or missing, and the expected corrected result' },
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
    parentSessionId: store.rootSessionId || store.sessionId,
    parentEmployeeId: store.employeeId,
    parentConversationId: store.conversationId || '',
    instruction: String(instruction || ''),
    delegationDepth: store.delegationDepth ?? 0,
    delegationChain: store.delegationChain ?? [],
    parentAbortSignal: store.abortSignal,
    enableThinking: store.enableThinking,
    // 任务级高权限（确认弹窗中"本轮任务不再提醒"）随委托下传：子员工在自身工作区外操作同样免确认
    highPermission: store.highPermission || UnifiedInteractionService.getInstance().isTaskHighPermission(),
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

  // 同步等待窗口内未结束：子任务仍在执行（不是失败），完成后会向本会话投递通知
  if (outcome.pending) {
    return {
      success: true,
      pending: true,
      output: `${launched.targetEmployeeName} 仍在按追问要求继续执行（已超出同步等待窗口，尚未结束，未失败也未取消）。\n` +
        '不要向用户报告失败。可稍后用 get_subagent_status 查看进度，或等完成通知（read_run_notifications）后再次追问。',
      ...base,
    }
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
