import type { ToolDefinition } from './types'
import SubAgentRuntime from '../../agent-runtime/runtime'
import SubAgentProfileService from '../../sub-agent-profile.service'
import { parseEphemeralRoleInput, type EphemeralSubAgentSpec } from '../../../../shared/types'
import { interactionContext } from '../../unified-interaction.service'

/**
 * 委托目标解析（delegate_to_employee / launch_agents 共用）：
 * 三选一 —— ephemeral_role（临时角色）> subagent_profile_id（模板）> target_employee_id（已有员工）。
 * 返回 { ephemeral, targetEmployeeId, error }；error 出现时调用方直接短路返回。
 */
export function resolveDelegationTarget(args: Record<string, any>): {
  ephemeral?: EphemeralSubAgentSpec
  targetEmployeeId?: string
  error?: string
} {
  const hasEphemeral = args.ephemeral_role !== undefined && args.ephemeral_role !== null
  const hasProfile = typeof args.subagent_profile_id === 'string' && args.subagent_profile_id.trim()
  const hasTarget = typeof args.target_employee_id === 'string' && args.target_employee_id.trim()
  const provided = [hasEphemeral, hasProfile, hasTarget].filter(Boolean).length
  if (provided === 0) {
    return { error: '缺少委托目标：target_employee_id / ephemeral_role / subagent_profile_id 三选一' }
  }
  if (provided > 1) {
    return { error: '委托目标只能三选一：target_employee_id（已有员工）/ ephemeral_role（临时角色）/ subagent_profile_id（子智能体模板）' }
  }
  if (hasEphemeral) {
    const parsed = parseEphemeralRoleInput(args.ephemeral_role)
    if (parsed.error) return { error: parsed.error }
    return { ephemeral: parsed.spec }
  }
  if (hasProfile) {
    const profile = SubAgentProfileService.getInstance().get(String(args.subagent_profile_id).trim())
    if (!profile) return { error: `子智能体模板不存在: ${args.subagent_profile_id}（可用 list_subagent_profiles 查询）` }
    return { ephemeral: SubAgentProfileService.getInstance().toEphemeralSpec(profile) }
  }
  return { targetEmployeeId: String(args.target_employee_id).trim() }
}

/**
 * 在委托类工具（delegate_to_employee / launch_agents）的 JSON Schema 上注入
 * 委托目标与子智能体模板的枚举，并在参数描述中列出候选名称。
 *
 * 动机：target_employee_id / subagent_profile_id 原为自由字符串，模型必须先读懂
 * 稳定上下文 [DELEGATION] 段才能猜出可用 id，是「委托几乎不触发」的重要原因之一。
 * 改为可枚举后，模型可直接内省候选（对标 MiMo-Code 将 subagent_type 改为动态枚举
 * 修复「多次运行零派发」的做法）。深度遍历以覆盖 launch_agents 的 tasks[].* 嵌套结构。
 *
 * 空候选时原样返回，避免注入空 enum 使参数不可用。
 */
export function applyDelegationEnums(
  tool: ToolDefinition,
  targets: Array<{ id: string; name: string }>,
  profiles: Array<{ id: string; name: string }>,
): ToolDefinition {
  if (targets.length === 0 && profiles.length === 0) return tool
  const parameters = JSON.parse(JSON.stringify(tool.parameters)) as Record<string, any>
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const props = node.properties
    if (props && typeof props === 'object') {
      const target = props.target_employee_id
      if (target && targets.length > 0) {
        target.enum = targets.map(t => t.id)
        target.description = `三选一：已有数字员工 id，可选：${targets.map(t => `${t.name}(id=${t.id})`).join('、')}`
      }
      const profile = props.subagent_profile_id
      if (profile && profiles.length > 0) {
        profile.enum = profiles.map(p => p.id)
        profile.description = `三选一：子智能体模板 id，可选：${profiles.map(p => `${p.name}(id=${p.id})`).join('、')}`
      }
      for (const key of Object.keys(props)) visit(props[key])
    }
    if (node.items) visit(node.items)
  }
  visit(parameters)
  return { ...tool, parameters: parameters as ToolDefinition['parameters'] }
}

/**
 * 多智能体运行时配套工具（阶段三/四）：
 * - list_subagents / get_subagent_status / cancel_subagent：运行观测与管理
 * - read_run_notifications：主管读取后台子任务的终态通知（读取即清空）
 * - task_item_create / task_item_update / task_item_list：任务台账（完成门依据）
 * - submit_structured_result：子会话上报结构化交付物（output_schema 契约）
 *
 * 均为 onDemand，不污染其他员工的常驻工具表；由委托能力开启时随委托类工具一并注册。
 */

/** AgentRunStatus → 中文展示名 */
const STATUS_LABELS: Record<string, string> = {
  queued: '排队',
  running: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 无参工具的空 JSON Schema */
const NO_PARAMS = { type: 'object' as const, properties: {} }

export const listSubagentsTool: ToolDefinition = {
  id: 'list_subagents',
  name: 'list_subagents',
  title: '查看子任务列表',
  summary: '查看本会话发起的子任务运行（活跃与最近完成）及其状态/活性',
  description: `列出当前会话发起的子任务运行（含活跃与最近完成），返回每个运行的 runId/执行者/状态/活性（progressing=推进中、stalled=停滞、idle=已结束）/结果摘要。
参数：无（自动限定为当前会话）。
用途：并行派发前后核对进度；发现 stalled 的子任务可 cancel_subagent 后重新派发。`,
  parameters: NO_PARAMS,
  handler: async () => {
    const store = interactionContext.getStore()
    if (!store) return { success: false, error: '缺少会话上下文' }
    const runtime = SubAgentRuntime.getInstance()
    const active = runtime.listActiveRuns({ parentConversationId: store.conversationId || '' })
    const lines = active.map(r => {
      const liveness = r.liveness === 'progressing' ? '进行中' : r.liveness === 'stalled' ? '停滞(无进展)' : '已结束'
      const status = STATUS_LABELS[r.status] || r.status
      return `[${r.runId}] ${r.employeeName} — ${status} / ${liveness}${r.summary ? ` · ${r.summary.split('\n')[0].slice(0, 80)}` : ''}`
    })
    return { success: true, output: lines.length > 0 ? lines.join('\n') : '当前会话暂无子任务运行', runs: active }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

export const getSubagentStatusTool: ToolDefinition = {
  id: 'get_subagent_status',
  name: 'get_subagent_status',
  title: '查询子任务状态',
  summary: '按 runId 查询子任务的详细状态（活性/摘要/产物/错误）',
  description: `按 runId 查询单个子任务运行的详细状态（状态机/活性/结果摘要/产物文件/错误）。
参数：
- run_id: 子任务运行 id（delegate/launch 系工具返回）`,
  parameters: {
    type: 'object',
    properties: { run_id: { type: 'string', description: '子任务运行 id' } },
    required: ['run_id'],
  },
  handler: async (args) => {
    const runId = String(args.run_id || '')
    if (!runId) return { success: false, error: '缺少 run_id' }
    const runtime = SubAgentRuntime.getInstance()
    const run = runtime.getRun(runId)
      || runtime.listRecentRuns(50).find(r => r.runId === runId)
    if (!run) return { success: false, error: `未找到运行记录: ${runId}` }
    const liveness = runtime.deriveLiveness(run)
    const label = STATUS_LABELS[run.status] || run.status
    const lines = [`runId=${run.runId}`, `执行者=${run.employeeName}`, `状态=${label}`, `活性=${liveness}`]
    if (run.summary) lines.push(`摘要：${run.summary}`)
    const files = [...run.generatedFiles, ...run.autoDetectedFiles]
    if (files.length > 0) lines.push(`产物文件：\n${files.map(f => `- ${f.path}`).join('\n')}`)
    if (run.error) lines.push(`错误：${run.error}`)
    return { success: true, output: lines.join('\n'), run }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

export const cancelSubagentTool: ToolDefinition = {
  id: 'cancel_subagent',
  name: 'cancel_subagent',
  title: '取消子任务',
  summary: '中止一个运行中的子任务（级联取消其子任务）',
  description: `中止一个运行中/排队中的子任务运行（含其嵌套子任务级联取消）。已结束的运行返回成功但不产生副作用。
参数：
- run_id: 子任务运行 id。`,
  parameters: {
    type: 'object',
    properties: { run_id: { type: 'string', description: '子任务运行 id' } },
    required: ['run_id'],
  },
  handler: async (args) => {
    const runId = String(args.run_id || '')
    if (!runId) return { success: false, error: '缺少 run_id' }
    const ok = SubAgentRuntime.getInstance().cancelRun(runId)
    return { success: true, output: ok ? `已中止子任务 ${runId}（若此前已结束则无副作用）。` : `未找到运行记录: ${runId}` }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

export const readRunNotificationsTool: ToolDefinition = {
  id: 'read_run_notifications',
  name: 'read_run_notifications',
  title: '读取子任务完成通知',
  summary: '读取后台子任务（run_in_background）完成后的终态通知（读取即清空）',
  description: `读取本会话收到的后台子任务终态通知（run_in_background 派发的子任务完成/失败/取消时产生）。读取即清空，重复调用只会返回新通知。
参数：无。建议：发起后台派发后，在回合收尾前调用一次避免遗漏；无通知时正常继续。`,
  parameters: NO_PARAMS,
  handler: async () => {
    const store = interactionContext.getStore()
    if (!store) return { success: false, error: '缺少会话上下文' }
    const list = SubAgentRuntime.getInstance().readNotifications(store.conversationId || '')
    if (list.length === 0) return { success: true, output: '暂无新的子任务通知' }
    const lines = list.map(n => {
      const label = STATUS_LABELS[n.status] || n.status
      return `[${label}] ${n.targetEmployeeName} (${n.runId})：${(n.summary || n.error || '').split('\n')[0].slice(0, 160)}`}
    )
    return { success: true, output: lines.join('\n'), notifications: list }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

export const listSubagentProfilesTool: ToolDefinition = {
  id: 'list_subagent_profiles',
  name: 'list_subagent_profiles',
  title: '查看子智能体模板',
  summary: '列出可用子智能体模板（可按模板委托）',
  description: `列出可复用子智能体模板（subagent_profile_id 委托的候选），返回 id/名称/描述/默认工具与模型。
参数：无。`,
  parameters: NO_PARAMS,
  handler: async () => {
    const profiles = SubAgentProfileService.getInstance().list()
    if (profiles.length === 0) return { success: true, output: '暂无子智能体模板', profiles }
    const lines = profiles.map(p => `- ${p.name} (id=${p.id})${p.description ? `: ${p.description}` : ''}`)
    return { success: true, output: lines.join('\n'), profiles }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

// ====== 任务台账 ======

export const taskItemCreateTool: ToolDefinition = {
  id: 'task_item_create',
  name: 'task_item_create',
  title: '登记子任务台账项',
  summary: '为委托子任务登记可跟踪的任务项（完成门依据）',
  description: `为一个子任务（runId）登记需要其完成的任务项。子任务会被要求逐项收尾（task_item_update），未收尾项会触发收尾纠偏并计入未完成清单。
参数：
- run_id: 子任务运行 id（delegate/launch 返回）
- title: 任务项描述（清单式要点，一次一项）。`,
  parameters: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: '子任务运行 id' },
      title: { type: 'string', description: '任务项描述' },
    },
    required: ['run_id', 'title'],
  },
  handler: async (args) => {
    const res = SubAgentRuntime.getInstance().createTask(String(args.run_id || ''), String(args.title || ''))
    return res.success ? { success: true, output: `已登记任务项 ${res.taskId}。`, taskId: res.taskId } : { success: false, error: res.error }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

export const taskItemUpdateTool: ToolDefinition = {
  id: 'task_item_update',
  name: 'task_item_update',
  title: '更新台账项状态',
  summary: '本子会话更新自己名下任务项的状态（子会话内使用）',
  description: `更新本子任务名下的一个台账项状态。结束最终回复前必须把每个任务项更新为 completed 或 blocked。
参数：
- task_id: 台账项 id（收到任务后可经 task_item_list 获取）
- status: completed=已完成 / blocked=受阻（需外部输入）/ in_progress=进行中 / open=恢复待办。`,
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '台账项 id' },
      status: { type: 'string', enum: ['open', 'in_progress', 'completed', 'blocked'], description: '新状态' },
    },
    required: ['task_id', 'status'],
  },
  handler: async (args) => {
    const store = interactionContext.getStore()
    const runId = store?.delegationId
    if (!runId) return { success: false, error: '当前上下文未关联子任务运行' }
    const status = String(args.status || '')
    if (!['open', 'in_progress', 'completed', 'blocked'].includes(status)) {
      return { success: false, error: `非法状态: ${status}（open/in_progress/completed/blocked）` }
    }
    const res = SubAgentRuntime.getInstance().updateTask(runId, String(args.task_id || ''), status as any)
    return res.success ? { success: true, output: '已更新任务项状态。' } : { success: false, error: res.error }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

export const taskItemListTool: ToolDefinition = {
  id: 'task_item_list',
  name: 'task_item_list',
  title: '查看台账项',
  summary: '列出本子会话名下的任务项与状态',
  description: '列出本子任务名下全部台账项及状态（分发后先查看确认自己要完成什么）。',
  parameters: NO_PARAMS,
  handler: async () => {
    const store = interactionContext.getStore()
    const runId = store?.delegationId
    if (!runId) return { success: false, error: '当前上下文未关联子任务运行' }
    const tasks = SubAgentRuntime.getInstance().listTasks(runId)
    if (tasks.length === 0) return { success: true, output: '名下暂无台账任务项', tasks }
    const lines = tasks.map(t => `[${t.id}] (${t.status}) ${t.title}`)
    return { success: true, output: lines.join('\n'), tasks }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

// ====== 结构化交付物 ======

export const submitStructuredResultTool: ToolDefinition = {
  id: 'submit_structured_result',
  name: 'submit_structured_result',
  title: '上报结构化结果',
  summary: '本子会话按要求上报机器可读的结构化结果（子会话内使用）',
  description: `当主管在委托指令中给定 JSON Schema 结构化契约时，用本工具上报完整结果对象（必须调用一次；普通文本文档之外的本工具即结构化结果）。result 直接透传 JSON 值。
参数：
- result: 符合契约 JSON Schema 的 JSON 对象。`,
  parameters: {
    type: 'object',
    properties: {
      result: { type: 'object', description: '符合契约 JSON Schema 的 JSON 对象' },
    },
    required: ['result'],
  },
  handler: async (args) => {
    const store = interactionContext.getStore()
    const runId = store?.delegationId
    if (!runId) return { success: false, error: '当前上下文未关联子任务运行' }
    const value = args.result
    if (value === undefined || value === null || typeof value !== 'object') {
      return { success: false, error: 'result 必须为 JSON 对象' }
    }
    const res = SubAgentRuntime.getInstance().recordStructuredResult(runId, value)
    return res.success ? { success: true, output: '结构化结果已采录。' } : { success: false, error: res.error }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}
