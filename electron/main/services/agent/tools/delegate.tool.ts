import type { ToolDefinition } from './types'
import SubAgentRuntime from '../../agent-runtime/runtime'
import { interactionContext } from '../../unified-interaction.service'

/** 委托链深度上限：防止递归死循环（与运行时保持一致） */
const MAX_DELEGATION_DEPTH = 3

/**
 * delegate_to_employee 工具：
 * 主管员工调用此工具，将子任务委托给指定数字员工执行，同步等待返回结果。
 *
 * 注册方式：由员工「委托能力设置」（employees.delegation_json）驱动，
 * 在 EmployeeAgentService.getOrCreateAgent 中按需注册，不参与员工工具三态配置。
 * 可委托员工列表注入系统提示词 [DELEGATION] 段（见 prompts.ts），本工具描述不再动态拼装。
 *
 * 实现方式：薄客户端 —— 校验与执行全部委托给 SubAgentRuntime。
 * - runtime 内部：子员工独立 conversation + 独立 SessionContext（工作区/权限隔离）
 * - 子会话 parent_conversation_id 指向主管会话，不出现在任务列表/检索结果中
 * - 子会话事件经 AGENT_RUN_EVENT / AGENT_DELEGATION_EVENT 双写转发到主管前端
 * - 主管 LLM 仅拿到结果摘要 + 文件清单（结构化），子员工完整过程不进主管上下文
 * - 返回 delegationId 可用于 followup_delegation 追问（复用同一子会话多轮协作）
 * - 递归防护（深度 ≤3 + 链上去环）与 abort 传播在 runtime 统一管理
 */
export const delegateTool: ToolDefinition = {
  id: 'delegate_to_employee',
  name: 'delegate_to_employee',
  title: '委托给数字员工',
  summary: '将子任务委托给指定数字员工执行，同步等待返回结果',
  description: `将当前子任务委托给另一个数字员工执行，适用于需要其他员工专业能力（如资料检索、文档生成）的场景。
参数：
- target_employee_id: 目标数字员工 id（从上下文信息 [DELEGATION] 段的可委托员工列表中选择）
- instruction: 委托给该员工的任务指令（清晰描述要做什么）
- context_files: 可选，传给子员工的上下文文件绝对路径列表（最多 10 个，需位于当前任务工作区或员工工作区内）
返回：子员工的执行结果摘要、产物文件清单与 delegationId（委托 id）。
后续：若结果有错误、缺失细节或不达验收标准，用 followup_delegation 工具携带 delegationId 追问同一子智能体（保留其任务上下文）。
限制：不能委托给自己；委托深度上限 ${MAX_DELEGATION_DEPTH} 层。`,
  parameters: {
    type: 'object',
    properties: {
      target_employee_id: { type: 'string', description: '目标数字员工 id（从系统提示词 [DELEGATION] 段的可委托员工列表中选择）' },
      instruction: { type: 'string', description: '委托给该员工的任务指令' },
      context_files: {
        type: 'array',
        items: { type: 'string' },
        description: '可选，传给子员工的上下文文件绝对路径（最多 10 个）',
      },
    },
    required: ['target_employee_id', 'instruction'],
  },
  handler: handleDelegate,
  source: 'builtin',
  onDemand: false,
  permission: 'safe',
  noRetry: true,
  timeoutMs: 5 * 60 * 1000,
}

async function handleDelegate(args: Record<string, any>): Promise<any> {
  const { target_employee_id, instruction } = args
  const contextFiles: string[] = Array.isArray(args.context_files) ? args.context_files : []

  const store = interactionContext.getStore()
  if (!store) {
    return { success: false, error: '委托失败：缺少会话上下文' }
  }

  const runtime = SubAgentRuntime.getInstance()
  const launched = runtime.launchSubAgent({
    parentSessionId: store.sessionId,
    parentEmployeeId: store.employeeId,
    parentConversationId: store.conversationId || '',
    targetEmployeeId: target_employee_id,
    instruction,
    contextFiles,
    delegationDepth: store.delegationDepth ?? 0,
    delegationChain: store.delegationChain ?? [],
    parentAbortSignal: store.abortSignal,
    enableThinking: store.enableThinking,
    highPermission: store.highPermission,
  })

  if (!launched.success || !launched.runId) {
    return { success: false, error: launched.error || '委托失败', targetEmployeeName: launched.targetEmployeeName }
  }

  // 同步等待（单路委托，与旧行为一致）；结果经 awaitRuns 聚合
  const outcomes = await runtime.awaitRuns([launched.runId])
  const outcome = outcomes[0]
  const base = { delegationId: launched.runId, targetEmployeeName: launched.targetEmployeeName }

  if (!outcome) {
    return { success: false, error: '委托执行异常', ...base }
  }

  if (outcome.success) {
    return {
      success: true,
      output: outcome.output || `已委托 ${launched.targetEmployeeName} 完成任务。`,
      ...base,
      tokenUsage: outcome.tokenUsage,
    }
  }
  return {
    success: false,
    error: outcome.error || '委托执行失败',
    ...base,
    tokenUsage: outcome.tokenUsage,
  }
}