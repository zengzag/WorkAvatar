import type { ToolDefinition } from './types'
import SubAgentRuntime from '../../agent-runtime/runtime'
import { interactionContext } from '../../unified-interaction.service'

/** 委托链深度上限：防止递归死循环（与运行时保持一致） */
const MAX_DELEGATION_DEPTH = 3

/**
 * delegate_to_employee 工具：
 * 主管员工调用此工具，将子任务委托给指定数字员工执行，同步等待返回结果。
 *
 * 实现方式：薄客户端 —— 校验与执行全部委托给 SubAgentRuntime。
 * - runtime 内部：子员工独立 conversation + 独立 SessionContext（工作区/权限隔离）
 * - 子会话 parent_conversation_id 指向主管会话，不出现在任务列表/检索结果中
 * - 子会话事件经 AGENT_RUN_EVENT / AGENT_DELEGATION_EVENT 双写转发到主管前端
 * - 主管 LLM 仅拿到结果摘要 + 文件清单（结构化），子员工完整过程不进主管上下文
 * - 递归防护（深度 ≤3 + 链上去环）与 abort 传播在 runtime 统一管理
 */
export const delegateTool: ToolDefinition = {
  id: 'delegate_to_employee',
  name: 'delegate_to_employee',
  title: '委托给数字员工',
  summary: '将子任务委托给指定数字员工执行，同步等待返回结果',
  description: `将当前子任务委托给另一个数字员工执行，适用于需要其他员工专业能力（如资料检索、文档生成）的场景。
参数：
- target_employee_id: 目标数字员工 id（从下方「可委托员工列表」中选择）
- instruction: 委托给该员工的任务指令（清晰描述要做什么）
- context_files: 可选，传给子员工的上下文文件绝对路径列表（最多 10 个，需位于当前任务工作区或员工工作区内）
返回：子员工的执行结果摘要与产物文件清单。
限制：不能委托给自己；委托深度上限 ${MAX_DELEGATION_DEPTH} 层。`,
  parameters: {
    type: 'object',
    properties: {
      target_employee_id: { type: 'string', description: '目标数字员工 id（从可委托员工列表中选择）' },
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

/** 构造 delegate_to_employee 工具的动态 description（含可委托员工列表） */
export function buildDelegateDescription(employeeId: string, employees: Array<{ id: string; name: string; description?: string; role?: string }>): string {
  const others = employees.filter(e => e.id !== employeeId)
  const listText = others.length > 0
    ? others.map(e => {
        const desc = e.description?.trim() || e.role?.trim()
        return `- ${e.name} (id=${e.id})${desc ? `：${desc}` : ''}`
      }).join('\n')
    : '（暂无其他数字员工）'
  return `${delegateTool.description}

可委托员工列表（依据各员工的能力描述判断是否适合委托，选择最匹配任务的员工）：
${listText}`
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