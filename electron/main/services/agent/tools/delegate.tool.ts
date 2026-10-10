import type { ToolDefinition } from './types'
import SubAgentRuntime from '../../agent-runtime/runtime'
import UnifiedInteractionService, { interactionContext } from '../../unified-interaction.service'
import { resolveDelegationTarget } from './subagent-tools'

/** 委托链深度上限：防止递归死循环（与运行时保持一致） */
const MAX_DELEGATION_DEPTH = 3

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
 * - 递归防护（深度 ≤3 + 链上去环）与 abort 传播在 runtime 统一管理
 */
export const delegateTool: ToolDefinition = {
  id: 'delegate_to_employee',
  name: 'delegate_to_employee',
  title: '委托给数字员工',
  summary: '将子任务委托给指定执行者（已有员工/临时角色/模板），同步等待或后台执行',
  description: `将当前子任务委托给一个执行者。子智能体在独立上下文中工作，只回传自包含的结果，因此委托能保持你的上下文干净。
适用信号（满足其一即应主动委托）：
- 子任务独立，可与其他工作并行推进；
- 需要横扫大量文件/资料来源（约 3 轮以上查询或 10+ 文件读取）且你只想要结论而非原始内容；
- 需要其他专业能力、更窄的工具集，或需要隔离上下文避免污染本对话；
- 需要对已完成工作做独立的第三方复评。
不适用（自己做）：
- 已知文件/符号/取值的单点查找，或本对话、已有工具结果即可回答的问题；
- 依赖尚未拿到的部分输出的串行工作（应委托并等待，而非并行拆分）；
- 琐碎单步请求，不要为了显得有结构而委托。
执行者三选一：
- target_employee_id: 已有数字员工 id（从上下文信息 [DELEGATION] 段的可委托员工列表中选择）
- ephemeral_role: 临时子智能体（无合适已有员工时现场创建），对象字段：
  - name: 简洁职责名（如"财报分析师"）
  - system_prompt: 自包含角色提示词（身份/职责/输出要求/约束；子会话看不到主管对话）
  - description: 可选说明；tools: 可选宿主内置工具 id 白名单（仅确需收窄能力时指定）
- subagent_profile_id: 复用子智能体模板 id（用 list_subagent_profiles 查询）
其他参数：
- instruction: 任务指令（清晰、自包含：背景 + 目标 + 验收标准）
- context_files: 可选，上下文文件绝对路径列表（最多 10 个，需位于当前任务工作区或员工工作区内）
- task_items: 可选，任务台账要点字符串数组；子智能体需逐项收尾（task_item_update），未收尾项会计入未完成清单
- run_in_background: 可选，true 时立即返回 runId 不阻塞（后台执行，完成后经 read_run_notifications 获取结果）
- output_schema: 可选，JSON Schema；要求子智能体调用 submit_structured_result 上报机器可读结果
返回：子执行者的结果摘要、产物文件清单与 delegationId（委托 id）。
后续：若结果有错误、缺失细节或不达验收标准，用 followup_delegation 工具携带 delegationId 追问同一子智能体（保留其任务上下文）。
限制：不能委托给自己；委托深度上限 ${MAX_DELEGATION_DEPTH} 层。`,
  parameters: {
    type: 'object',
    properties: {
      target_employee_id: { type: 'string', description: '三选一：已有数字员工 id' },
      ephemeral_role: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '简洁职责名' },
          description: { type: 'string', description: '可选说明' },
          system_prompt: { type: 'string', description: '自包含角色提示词（身份/职责/输出要求/约束）' },
          tools: { type: 'array', items: { type: 'string' }, description: '可选宿主内置工具 id 白名单' },
          skills: { type: 'array', items: { type: 'string' }, description: '可选技能 id 列表' },
          provider_id: { type: 'string', description: '可选模型供应商 id（需与 model_id 成对）' },
          model_id: { type: 'string', description: '可选模型 id' },
        },
        required: ['name', 'system_prompt'],
        description: '三选一：临时子智能体规格',
      },
      subagent_profile_id: { type: 'string', description: '三选一：子智能体模板 id' },
      instruction: { type: 'string', description: '任务指令（自包含：背景/目标/验收标准）' },
      context_files: {
        type: 'array',
        items: { type: 'string' },
        description: '可选，上下文文件绝对路径（最多 10 个）',
      },
      task_items: {
        type: 'array',
        items: { type: 'string' },
        description: '可选，任务台账要点（子智能体需逐项收尾）',
      },
      run_in_background: { type: 'boolean', description: '可选，true 时后台执行立即返回' },
      output_schema: { type: 'object', description: '可选，JSON Schema 结构化输出契约' },
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
    parentSessionId: store.sessionId,
    parentEmployeeId: store.employeeId,
    parentConversationId: store.conversationId || '',
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
