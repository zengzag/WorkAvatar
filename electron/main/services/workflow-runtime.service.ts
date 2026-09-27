/**
 * 模板任务（Workflow）运行编排服务。
 *
 * 设计要点：
 * - 模板的持久化与画布 UI 由 workflow 插件持有；内核只负责「运行」这一段。
 * - 一次运行生成一条主任务会话（任务页可见），每个智能体节点作为其子会话执行，
 *   复用 SubAgentRuntime 的并发控制、级联中止、事件广播与产物采集。
 * - 临时数字员工（EphemeralRole）经注册表注册为「模板内联」注册员工，
 *   不落 employees 表、不进员工库列表，运行结束即下线。
 */

import path from 'path'
import DatabaseService from './database.service'
import WorkspaceManagerService from './workspace-manager.service'
import EmployeeRegistryService, { type RegisteredEmployee } from './employee-registry.service'
import SubAgentRuntime from './agent-runtime/runtime'
import MemoryRefinementService from './memory-refinement.service'
import { generateId } from './common-utils'
import { createLogger } from './logger'
import { broadcastWorkflowRunEvent } from './workflow-events'
import type { AgentRunOutcome } from './agent-runtime/types'
import type {
  PluginWorkflowArtifact,
  PluginWorkflowEdgeSpec,
  PluginWorkflowGraphSpec,
  PluginWorkflowNodeRun,
  PluginWorkflowNodeSpec,
  PluginWorkflowEphemeralRole,
  PluginWorkflowRun,
  PluginWorkflowRunParams,
  PluginWorkflowRunStatus,
  PluginWorkflowRunEvent,
  PluginWorkflowVerdictRules,
} from '../../../plugin-sdk/src'

const logger = createLogger('WorkflowRuntime')

/** 运行内节点执行上限（防环、防失控） */
const MAX_NODE_EXECUTIONS = 50
/** 子会话单次等待上限（略小于委托工具层 300s 超时） */
const NODE_WAIT_TIMEOUT_MS = 280_000
/** 单个节点输出注入下游的最大字符数 */
const MAX_OUTPUT_INJECT_CHARS = 8000
/**
 * 主任务会话（模板任务）的归属「运行宿主」员工 id。
 * 它不是员工库里的可见员工，而是运行期注册的**内联员工**——仅用于承载
 * conversations 外键与子会话的父子关系，不广播、不进员工库、不参与委托。
 * 模板任务本身是插件能力，不应为此在员工库里凭空造一个全局员工。
 */
const WORKFLOW_HOST_ROLE_KEY = 'workflow-runner'
const WORKFLOW_HOST_EMPLOYEE_ID = `inline:${WORKFLOW_HOST_ROLE_KEY}`

/** condition 节点表达式“真”词表的内核中性默认值（完整语义词表由调用方在 spec 传入） */
const DEFAULT_CONDITION_PASS_KEYWORDS = ['pass', 'true', '1', 'yes']

interface RunEntry {
  run: PluginWorkflowRun
  controller: AbortController
  nodeRuns: Map<string, PluginWorkflowNodeRun>
  /** 运行期注册的临时角色 id（结束后下线） */
  ephemeralIds: string[]
  /** loop 节点累计轮次（nodeId → 轮次），回边上限判定用 */
  loopRounds: Map<string, number>
}

export class WorkflowRuntimeService {
  private static instance: WorkflowRuntimeService
  private entries = new Map<string, RunEntry>()

  private constructor() {}

  static getInstance(): WorkflowRuntimeService {
    if (!WorkflowRuntimeService.instance) {
      WorkflowRuntimeService.instance = new WorkflowRuntimeService()
    }
    return WorkflowRuntimeService.instance
  }

  /** 启动一次运行，立即返回 runId（后台执行） */
  async startRun(params: PluginWorkflowRunParams): Promise<PluginWorkflowRun> {
    const graph = params.graph
    if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
      throw new Error('流程定义为空：至少需要一个节点')
    }
    const entryNode = this.resolveEntryNode(graph)
    if (!entryNode) throw new Error('未找到入口节点')

    const resolved = await MemoryRefinementService.getInstance().resolveEmployeeLLM()
    if (!resolved) throw new Error('无可用 LLM 提供商（请在设置中配置默认模型）')

    // 运行前一次性注册本流程用到的临时角色（运行结束下线）；
    // 同时注册「运行宿主」内联员工，用于承载主任务会话的归属与子会话父子关系
    this.registerRunHostEmployee()
    const ephemeralIds = [WORKFLOW_HOST_EMPLOYEE_ID, ...this.registerEphemeralRoles(graph.nodes)]

    let conversationId = params.conversationId || ''
    let employeeId = WORKFLOW_HOST_EMPLOYEE_ID
    if (!conversationId) {
      const conversation = WorkspaceManagerService.getInstance().createConversation(
        WORKFLOW_HOST_EMPLOYEE_ID,
        undefined,
        params.templateName || '模板任务',
        true,
      )
      conversationId = conversation.id
    } else {
      const row = DatabaseService.getInstance().getDb()
        .prepare('SELECT employee_id FROM conversations WHERE id = ?')
        .get(conversationId) as { employee_id?: string } | undefined
      if (row?.employee_id) employeeId = row.employee_id
    }

    const runId = generateId()
    const run: PluginWorkflowRun = {
      runId,
      templateId: params.templateId,
      templateName: params.templateName,
      conversationId,
      employeeId,
      status: 'running',
      nodes: graph.nodes.map(n => this.initNodeRun(n)),
      artifacts: [],
      startedAt: Math.floor(Date.now() / 1000),
    }
    const entry: RunEntry = { run, controller: new AbortController(), nodeRuns: new Map(), ephemeralIds, loopRounds: new Map() }
    for (const node of run.nodes) entry.nodeRuns.set(node.nodeId, node)
    this.entries.set(runId, entry)
    this.persistRun(run)
    this.broadcast(runId, 'run:start', undefined, { templateName: run.templateName, conversationId })

    // 后台执行，不阻塞调用方
    void this.executeRun(entry, graph, params, entryNode).catch((err: unknown) => {
      logger.error(`Workflow run ${runId} crashed:`, err instanceof Error ? err.message : String(err))
      this.finishRun(entry, 'failed', err instanceof Error ? err.message : String(err))
    })

    return run
  }

  abortRun(runId: string): boolean {
    const entry = this.entries.get(runId || '')
    if (!entry) return false
    entry.controller.abort()
    return true
  }

  getRun(runId: string): PluginWorkflowRun | undefined {
    const entry = this.entries.get(runId)
    if (entry) return entry.run
    return this.loadRunFromDb(runId)
  }

  listRuns(filter?: { conversationId?: string; templateId?: string; limit?: number }): PluginWorkflowRun[] {
    const db = DatabaseService.getInstance().getDb()
    const where: string[] = []
    const args: unknown[] = []
    if (filter?.conversationId) { where.push('conversation_id = ?'); args.push(filter.conversationId) }
    if (filter?.templateId) { where.push('template_id = ?'); args.push(filter.templateId) }
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200)
    const rows = db.prepare(
      `SELECT * FROM workflow_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`
    ).all(...args, limit) as WorkflowRunRow[]
    return rows.map(r => this.rowToRun(r))
  }

  // ====== 执行主循环 ======

  private async executeRun(
    entry: RunEntry,
    graph: PluginWorkflowGraphSpec,
    params: PluginWorkflowRunParams,
    entryNode: PluginWorkflowNodeSpec,
  ): Promise<void> {
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
    /** 节点产出（供下游变量插值） */
    const outputs = new Map<string, string>()

    let current: PluginWorkflowNodeSpec | undefined = entryNode
    let executions = 0

    while (current) {
      if (entry.controller.signal.aborted) {
        this.finishRun(entry, 'aborted', '已中止')
        return
      }
      if (++executions > MAX_NODE_EXECUTIONS) {
        this.finishRun(entry, 'failed', `节点执行次数超过上限（${MAX_NODE_EXECUTIONS}），可能存在流程死循环`)
        return
      }
      const nodeRun = entry.nodeRuns.get(current.id)!
      const loopRound = current.type === 'loop' ? entry.loopRounds.get(current.id) : undefined
      this.updateNode(entry, nodeRun, { status: 'running', round: loopRound, startedAt: Math.floor(Date.now() / 1000) })
      this.broadcast(entry.run.runId, 'node:start', current.id, { label: current.label, type: current.type })

      let verdict: string | undefined
      try {
        const result = await this.executeNode(entry, current, params, outputs)
        verdict = result.verdict
        if (result.output) outputs.set(current.id, result.output)
        this.updateNode(entry, nodeRun, {
          status: 'completed',
          verdict,
          output: result.output?.slice(0, MAX_OUTPUT_INJECT_CHARS),
          conversationId: result.conversationId,
          round: current.type === 'loop' ? entry.loopRounds.get(current.id) : nodeRun.round,
          endedAt: Math.floor(Date.now() / 1000),
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (entry.controller.signal.aborted) {
          this.updateNode(entry, nodeRun, { status: 'failed', error: message, endedAt: Math.floor(Date.now() / 1000) })
          this.finishRun(entry, 'aborted', '已中止')
          return
        }
        this.updateNode(entry, nodeRun, { status: 'failed', error: message, endedAt: Math.floor(Date.now() / 1000) })
        this.finishRun(entry, 'failed', `节点「${current.label}」执行失败：${message}`)
        return
      }

      this.broadcast(entry.run.runId, 'node:end', current.id, { status: 'completed', verdict })
      current = this.nextNode(entry, graph, current, verdict, nodeMap)
    }

    this.finishRun(entry, 'completed')
  }

  /** 执行单个节点：智能体/评审/输入/条件/工具等类型 */
  private async executeNode(
    entry: RunEntry,
    node: PluginWorkflowNodeSpec,
    params: PluginWorkflowRunParams,
    outputs: Map<string, string>,
  ): Promise<{ output?: string; verdict?: string; conversationId?: string }> {
    switch (node.type) {
      case 'input':
        // 输入节点只做变量标注：入参由运行发起方传入，此处直接产出可引用的文本
        return { output: this.renderInstruction(node.instruction || '', params.variables, outputs, true) }
      case 'end':
        return { output: this.renderInstruction(node.instruction || '', params.variables, outputs, true) }
      case 'condition':
        return { verdict: this.resolveConditionVerdict(node, params.variables, outputs) }
      case 'loop': {
        // 循环节点：本节点即「循环体每次经过的计数点」，回边（下游 → 循环体起点）经过此处累加轮次。
        // 次数超过上限时，nextNode 会忽略带轮次上限的回边，流程自然退出循环。
        const count = (entry.loopRounds.get(node.id) || 0) + 1
        entry.loopRounds.set(node.id, count)
        return {}
      }
      default: {
        const prompt = this.renderInstruction(node.instruction || '', params.variables, outputs, true)
        return this.runAgentNode(entry, node, prompt)
      }
    }
  }

  /** 通过 SubAgentRuntime 以子会话方式执行一个智能体节点 */
  private async runAgentNode(
    entry: RunEntry,
    node: PluginWorkflowNodeSpec,
    prompt: string,
  ): Promise<{ output?: string; verdict?: string; conversationId?: string }> {
    const run = entry.run
    const targetEmployeeId = this.resolveNodeEmployeeId(node)
    // 评审节点的结构化结论契约文案由调用方经 spec 注入（模板语义不进内核）
    const instruction = node.review?.contractSuffix ? `${prompt}\n${node.review.contractSuffix}` : prompt
    // 评审节点使用独立的子会话，保证多轮评审上下文隔离
    const conversationId = node.type === 'review'
      ? WorkspaceManagerService.getInstance().createConversation(
        targetEmployeeId, undefined, `评审: ${node.label}`, true, run.conversationId,
      ).id
      : run.conversationId!

    const parentEmployeeId = this.resolveParentEmployeeId(entry)
    const launch = SubAgentRuntime.getInstance().launchSubAgent({
      parentSessionId: run.runId,
      parentEmployeeId,
      parentConversationId: run.conversationId!,
      targetEmployeeId,
      instruction,
      delegationDepth: 0,
      delegationChain: [],
      parentAbortSignal: entry.controller.signal,
      highPermission: true,
    })
    if (!launch.success || !launch.runId) {
      throw new Error(launch.error || '子会话派发失败')
    }
    this.broadcast(run.runId, 'node:start', node.id, { childRunId: launch.runId, targetEmployeeName: launch.targetEmployeeName })

    const [outcome] = await SubAgentRuntime.getInstance().awaitRuns([launch.runId], NODE_WAIT_TIMEOUT_MS)
    const output = this.outcomeText(outcome)
    if (!outcome?.success && !output) {
      throw new Error(outcome?.error || '子会话执行失败')
    }

    // 采集产物
    const files = [...(outcome?.result?.generatedFiles || []), ...(outcome?.result?.autoDetectedFiles || [])]
    for (const file of files) {
      const artifact: PluginWorkflowArtifact = { nodeId: node.id, name: path.basename(file.path), path: file.path, kind: 'file' }
      run.artifacts.push(artifact)
      this.broadcast(run.runId, 'artifact', node.id, artifact)
    }

    return {
      output,
      verdict: node.review ? this.parseVerdict(node.review, output) : undefined,
      conversationId,
    }
  }

  /** 解析评审结论（通用解析器，判定规则来自 spec）：优先标记结论，其次否定词兜底，缺省 defaultVerdict */
  private parseVerdict(rules: PluginWorkflowVerdictRules, output: string): string {
    const text = String(output || '')
    if (rules.markedPattern) {
      const marked = text.match(new RegExp(rules.markedPattern, 'i'))
      const value = marked?.[1]?.trim().toLowerCase()
      if (value) return value
    }
    const failKeywords = rules.failKeywords || []
    for (const word of failKeywords) {
      if (word && text.toLowerCase().includes(word.toLowerCase())) return 'fail'
    }
    return rules.defaultVerdict || 'pass'
  }

  /** 依据出边（含条件标签）决定下一个节点；无匹配出边则流程结束 */
  private nextNode(
    entry: RunEntry,
    graph: PluginWorkflowGraphSpec,
    current: PluginWorkflowNodeSpec,
    verdict: string | undefined,
    nodeMap: Map<string, PluginWorkflowNodeSpec>,
  ): PluginWorkflowNodeSpec | undefined {
    const outgoing = graph.edges.filter(e => e.from === current.id)
    if (outgoing.length === 0) return undefined

    if (current.type === 'parallel') {
      // 并行节点：取第一条出边作为主干（并行派发由节点自身在上游聚合）
      return nodeMap.get(outgoing[0].to)
    }
    if (verdict) {
      const matched = outgoing.find(e => this.edgeMatchesVerdict(e, verdict))
      if (matched) return nodeMap.get(matched.to)
    }
    const fallback = outgoing.find(e => !e.when)
    if (!fallback) return undefined

    const target = nodeMap.get(fallback.to)
    // loop 回边上限：回边指向的循环节点轮次用尽后，忽略该回边让流程继续向下
    if (target?.type === 'loop' && target.maxRounds && target.maxRounds > 0) {
      const used = entry.loopRounds.get(target.id) || 0
      if (used > target.maxRounds) {
        const forward = outgoing.find(e => e !== fallback && e.when !== 'loop')
        return forward ? nodeMap.get(forward.to) : undefined
      }
    }
    return target
  }

  /** 边是否匹配判定结论：'fail' 兼容以 fail 开头的标签（如 fail_1） */
  private edgeMatchesVerdict(edge: PluginWorkflowEdgeSpec, verdict: string): boolean {
    const when = (edge.when || '').trim().toLowerCase()
    if (!when) return false
    if (when === verdict) return true
    return verdict === 'fail' && when.startsWith('fail')
  }

  private resolveConditionVerdict(
    node: PluginWorkflowNodeSpec,
    variables: Record<string, string> | undefined,
    outputs: Map<string, string>,
  ): string {
    const expression = node.instruction || ''
    const resolved = this.renderInstruction(expression, variables, outputs, true).trim()
    const keywords = node.condition?.passKeywords?.length ? node.condition.passKeywords : DEFAULT_CONDITION_PASS_KEYWORDS
    return keywords.some(k => k.toLowerCase() === resolved.toLowerCase()) ? 'pass' : 'fail'
  }

  // ====== 变量插值 ======

  /**
   * 指令模板插值：支持 {{var}} 运行入参、{{nodeId}} 节点输出。
   * strict=true 时对未解析变量保留原文（便于用户发现拼写问题）。
   */
  private renderInstruction(
    template: string,
    variables: Record<string, string> | undefined,
    outputs: Map<string, string>,
    strict = false,
  ): string {
    return String(template || '').replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (raw, key: string) => {
      if (variables && key in variables) return String(variables[key] ?? '')
      const output = outputs.get(key)
      if (output !== undefined) return output.slice(0, MAX_OUTPUT_INJECT_CHARS)
      return strict ? raw : ''
    })
  }

  // ====== 临时角色 ======

  /**
   * 注册「运行宿主」内联员工：模板任务会话的归属主体。
   * 仅作为 conversations 外键与子会话父级的占位，不出现在员工库，也不承担实际任务。
   */
  private registerRunHostEmployee(): void {
    EmployeeRegistryService.getInstance().registerInlineEmployee({
      id: WORKFLOW_HOST_EMPLOYEE_ID,
      source: 'inline',
      source_key: WORKFLOW_HOST_ROLE_KEY,
      name: '模板任务',
      description: '模板任务运行时的会话归属主体（运行期临时存在）',
      rules: '你是模板任务的会话归属主体。流程各节点由模板任务引擎以子会话方式派发执行，你无需自行拆分或执行步骤。',
      profile_json: JSON.stringify({ roleName: '模板任务' }),
      avatar_type: 'default',
      memory_enabled: false,
      arch_version: 1,
      total_tasks: 0,
      total_approvals: 0,
      created_at: 0,
      updated_at: 0,
    })
  }

  /** 注册流程内声明的临时角色为「模板内联」注册员工，返回其宿主员工 id 列表 */
  private registerEphemeralRoles(nodes: PluginWorkflowNodeSpec[]): string[] {
    const ids: string[] = []
    for (const node of nodes) {
      const role = node.ephemeralRole
      if (!role?.key || !role.systemPrompt) continue
      const employee = this.toRegisteredEmployee(role)
      EmployeeRegistryService.getInstance().registerInlineEmployee(employee)
      ids.push(employee.id)
    }
    return ids
  }

  private toRegisteredEmployee(role: PluginWorkflowEphemeralRole): RegisteredEmployee {
    const key = role.key.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63)
    return {
      id: `inline:${key}`,
      source: 'inline',
      source_key: key,
      name: role.name || key,
      description: '模板任务内联角色（仅在模板运行期间存在）',
      rules: role.systemPrompt,
      profile_json: JSON.stringify({ roleName: role.name || key }),
      avatar_type: 'default',
      memory_enabled: false,
      arch_version: 1,
      total_tasks: 0,
      total_approvals: 0,
      created_at: 0,
      updated_at: 0,
      defaultTools: role.tools,
      defaultSkills: role.skills,
    }
  }

  private resolveNodeEmployeeId(node: PluginWorkflowNodeSpec): string {
    if (node.employeeId) return node.employeeId
    const role = node.ephemeralRole
    if (role?.key) {
      const key = role.key.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63)
      return `inline:${key}`
    }
    return WORKFLOW_HOST_EMPLOYEE_ID
  }

  /** 子会话的「主管员工」：用主任务会话所属员工，避免运行时校验依赖委托开关 */
  private resolveParentEmployeeId(entry: RunEntry): string {
    const parent = entry.run.conversationId
    if (parent) {
      const row = DatabaseService.getInstance().getDb()
        .prepare('SELECT employee_id FROM conversations WHERE id = ?')
        .get(parent) as { employee_id?: string } | undefined
      if (row?.employee_id) return row.employee_id
    }
    return WORKFLOW_HOST_EMPLOYEE_ID
  }

  // ====== 运行状态维护 ======

  private initNodeRun(node: PluginWorkflowNodeSpec): PluginWorkflowNodeRun {
    return { nodeId: node.id, label: node.label || node.id, type: node.type, status: 'pending' }
  }

  private updateNode(entry: RunEntry, node: PluginWorkflowNodeRun, patch: Partial<PluginWorkflowNodeRun>): void {
    Object.assign(node, patch)
    this.persistRun(entry.run)
  }

  private finishRun(entry: RunEntry, status: PluginWorkflowRunStatus, error?: string): void {
    const run = entry.run
    run.status = status
    run.error = error
    run.endedAt = Math.floor(Date.now() / 1000)
    this.persistRun(run)
    this.broadcast(run.runId, 'run:end', undefined, { status, error })
    this.unregisterEphemeralRoles(entry)
  }

  private unregisterEphemeralRoles(entry: RunEntry): void {
    for (const id of entry.ephemeralIds) {
      EmployeeRegistryService.getInstance().unregisterInlineEmployee(id)
    }
    entry.ephemeralIds = []
  }

  private broadcast(
    runId: string,
    eventType: PluginWorkflowRunEvent['eventType'],
    nodeId: string | undefined,
    data?: unknown,
  ): void {
    const entry = this.entries.get(runId)
    const conversationId = entry?.run.conversationId
    broadcastWorkflowRunEvent({ runId, eventType, nodeId, data }, conversationId)
  }

  private outcomeText(outcome?: AgentRunOutcome): string {
    if (!outcome) return ''
    const parts: string[] = []
    if (outcome.output) parts.push(outcome.output)
    if (outcome.error && !outcome.output) parts.push(`[失败] ${outcome.error}`)
    const files = [...(outcome.result?.generatedFiles || []), ...(outcome.result?.autoDetectedFiles || [])]
    if (files.length > 0) {
      parts.push('产出文件：')
      for (const f of files) parts.push(`- ${f.path}`)
    }
    return parts.join('\n').trim()
  }

  private resolveEntryNode(graph: PluginWorkflowGraphSpec): PluginWorkflowNodeSpec | undefined {
    if (graph.entryNodeId) {
      const matched = graph.nodes.find(n => n.id === graph.entryNodeId)
      if (matched) return matched
    }
    const targets = new Set(graph.edges.map(e => e.to))
    return graph.nodes.find(n => !targets.has(n.id)) || graph.nodes[0]
  }

  // ====== 持久化 ======

  private persistRun(run: PluginWorkflowRun): void {
    try {
      DatabaseService.getInstance().getDb().prepare(
        `INSERT INTO workflow_runs (run_id, template_id, template_name, conversation_id, employee_id, status, graph_json, nodes_json, artifacts_json, error, started_at, ended_at)
         VALUES (@run_id, @template_id, @template_name, @conversation_id, @employee_id, @status, @graph_json, @nodes_json, @artifacts_json, @error, @started_at, @ended_at)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status, nodes_json = excluded.nodes_json, artifacts_json = excluded.artifacts_json,
           error = excluded.error, ended_at = excluded.ended_at`
      ).run({
        run_id: run.runId,
        template_id: run.templateId || '',
        template_name: run.templateName || '',
        conversation_id: run.conversationId || '',
        employee_id: run.employeeId || '',
        status: run.status,
        graph_json: '{}',
        nodes_json: JSON.stringify(run.nodes),
        artifacts_json: JSON.stringify(run.artifacts),
        error: run.error || '',
        started_at: run.startedAt || null,
        ended_at: run.endedAt || null,
      })
    } catch (err: unknown) {
      logger.warn(`Failed to persist workflow run ${run.runId}:`, err instanceof Error ? err.message : String(err))
    }
  }

  private loadRunFromDb(runId: string): PluginWorkflowRun | undefined {
    const row = DatabaseService.getInstance().getDb()
      .prepare('SELECT * FROM workflow_runs WHERE run_id = ?')
      .get(runId) as WorkflowRunRow | undefined
    return row ? this.rowToRun(row) : undefined
  }

  private rowToRun(row: WorkflowRunRow): PluginWorkflowRun {
    return {
      runId: row.run_id,
      templateId: row.template_id || undefined,
      templateName: row.template_name || undefined,
      conversationId: row.conversation_id || undefined,
      employeeId: row.employee_id || undefined,
      status: row.status as PluginWorkflowRunStatus,
      nodes: safeParseArray<PluginWorkflowNodeRun>(row.nodes_json),
      artifacts: safeParseArray<PluginWorkflowArtifact>(row.artifacts_json),
      error: row.error || undefined,
      startedAt: row.started_at || undefined,
      endedAt: row.ended_at || undefined,
    }
  }
}

interface WorkflowRunRow {
  run_id: string
  template_id?: string
  template_name?: string
  conversation_id?: string
  employee_id?: string
  status: string
  nodes_json?: string
  artifacts_json?: string
  error?: string
  started_at?: number
  ended_at?: number
}

function safeParseArray<T>(json?: string): T[] {
  try {
    const parsed = JSON.parse(json || '[]')
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

export default WorkflowRuntimeService
