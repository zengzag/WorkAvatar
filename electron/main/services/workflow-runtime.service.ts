/**
 * 模板任务（Workflow）运行编排服务。
 *
 * 设计要点：
 * - 模板的持久化与画布 UI 由 workflow 插件持有；内核只负责「运行」这一段。
 * - 一次运行生成一条主任务会话（仅作运行工作区与子会话父级，**不写消息、不出现在任务页**），
 *   每个智能体节点作为其子会话执行，复用 SubAgentRuntime 的并发控制、级联中止、事件广播与产物采集。
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
  PluginWorkflowDeleteRunResult,
  PluginWorkflowEdgeSpec,
  PluginWorkflowGraphSpec,
  PluginWorkflowNodeEvent,
  PluginWorkflowNodeRun,
  PluginWorkflowNodeSpec,
  PluginWorkflowEphemeralRole,
  PluginWorkflowRun,
  PluginWorkflowRunParams,
  PluginWorkflowRunStatus,
  PluginWorkflowRunEvent,
  PluginWorkflowTokenUsage,
  PluginWorkflowVerdictRules,
} from '../../../plugin-sdk/src'

const logger = createLogger('WorkflowRuntime')

/** 运行内节点执行上限（防环、防失控） */
const MAX_NODE_EXECUTIONS = 50
/** 子会话单次等待上限（略小于委托工具层 300s 超时） */
const NODE_WAIT_TIMEOUT_MS = 280_000
/** 单个节点输出注入下游的最大字符数 */
const MAX_OUTPUT_INJECT_CHARS = 8000
/** transcript 文本上限：任务指令 / LLM 正文 */
const MAX_TRANSCRIPT_TEXT_CHARS = 20_000
/** transcript 思考过程上限 */
const MAX_TRANSCRIPT_THINKING_CHARS = 8_000
/** transcript 单次工具入参/输出上限 */
const MAX_TOOL_IO_CHARS = 3_000
/** 流式事件（text/thought）广播合并间隔 */
const TRANSCRIPT_EVENT_THROTTLE_MS = 200
/** 流式事件落库节流间隔 */
const TRANSCRIPT_PERSIST_THROTTLE_MS = 1_000
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
  /** 当前迭代轮次（loop 每执行一次自增），供节点轮次标注与 transcript 分轮 */
  currentRound: number
  /** 待注入的迭代反馈：回边携带的上一轮评审结论，供被回写节点承接返工 */
  pendingFeedback: IterationFeedback | null
}

/** 回边携带的迭代反馈：上一轮触发回写的评审/条件节点结论与意见 */
interface IterationFeedback {
  /** 触发回写的节点 id（评审/条件节点） */
  fromNodeId: string
  fromLabel: string
  verdict: string
  /** 该节点的产出文本（评审意见正文） */
  output: string
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
      // 会话仅承载运行工作区与节点子会话的父级，不写任何消息，
      // 因此不会出现在任务页（任务列表只列 message_count > 0 的顶层会话）
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
      variables: params.variables || {},
      startedAt: Math.floor(Date.now() / 1000),
    }
    const entry: RunEntry = {
      run, controller: new AbortController(), nodeRuns: new Map(), ephemeralIds,
      loopRounds: new Map(), currentRound: 1, pendingFeedback: null,
    }
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

  /**
   * 删除运行记录；运行中的记录拒绝删除（避免执行循环继续回写）。
   * 同时删除运行会话（级联其节点子会话），会话工作区非空时返回目录信息，
   * 供渲染端询问是否一并删除（与普通任务删除体验一致）。
   */
  deleteRun(runId: string): PluginWorkflowDeleteRunResult {
    const entry = this.entries.get(runId || '')
    if (entry && entry.run.status === 'running') return { ok: false }
    const db = DatabaseService.getInstance().getDb()
    const row = db.prepare('SELECT conversation_id FROM workflow_runs WHERE run_id = ?')
      .get(runId) as { conversation_id?: string } | undefined
    const info = db.prepare('DELETE FROM workflow_runs WHERE run_id = ?').run(runId)
    this.entries.delete(runId)
    if (info.changes === 0) return { ok: false }
    const conversationId = row?.conversation_id
    if (!conversationId) return { ok: true }
    const deleted = WorkspaceManagerService.getInstance().deleteConversation(conversationId)
    return { ok: true, taskDir: deleted.taskDir, taskDirNonEmpty: deleted.taskDirNonEmpty }
  }

  /** 删除运行工作区目录（移至回收站）；安全边界见 WorkspaceManagerService.deleteTaskWorkspace */
  async deleteRunWorkspace(path: string): Promise<boolean> {
    return WorkspaceManagerService.getInstance().deleteTaskWorkspace(path)
  }

  getRun(runId: string): PluginWorkflowRun | undefined {
    this.recoverStaleRuns()
    const entry = this.entries.get(runId)
    if (entry) return entry.run
    return this.loadRunFromDb(runId)
  }

  listRuns(filter?: { conversationId?: string; templateId?: string; limit?: number }): PluginWorkflowRun[] {
    this.recoverStaleRuns()
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

  /**
   * 进程重启后残留的 running 记录已无执行主体：标记为已中止、把执行中的节点置为失败，
   * 否则永远显示「运行中」且无法删除（一次性恢复，跳过本进程仍在执行的运行）。
   */
  private recovered = false
  private recoverStaleRuns(): void {
    if (this.recovered) return
    this.recovered = true
    try {
      const db = DatabaseService.getInstance().getDb()
      const rows = db.prepare("SELECT run_id, nodes_json FROM workflow_runs WHERE status = 'running'").all() as { run_id: string; nodes_json?: string }[]
      const reason = '应用重启，运行已中断'
      const now = Math.floor(Date.now() / 1000)
      for (const row of rows) {
        if (this.entries.has(row.run_id)) continue
        const nodes = safeParseArray<PluginWorkflowNodeRun>(row.nodes_json)
        for (const node of nodes) {
          if (node.status === 'running') {
            node.status = 'failed'
            node.error = reason
            node.endedAt = node.endedAt || now
          }
        }
        db.prepare(
          "UPDATE workflow_runs SET status = 'aborted', nodes_json = ?, error = ?, ended_at = COALESCE(ended_at, ?) WHERE run_id = ?"
        ).run(JSON.stringify(nodes), reason, now, row.run_id)
        logger.info(`Recovered stale workflow run ${row.run_id}`)
      }
    } catch (err: unknown) {
      logger.warn('Failed to recover stale workflow runs:', err instanceof Error ? err.message : String(err))
    }
  }

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
      // 循环节点即迭代计数点：每次经过即进入新一轮，供节点轮次标注与 transcript 分轮
      if (current.type === 'loop') {
        entry.currentRound = (entry.loopRounds.get(current.id) || 0) + 1
        entry.loopRounds.set(current.id, entry.currentRound)
      }
      // 首轮不标注轮次（避免非迭代流程出现「第 1 轮」噪声），仅回写轮次 > 1 时展示
      const roundTag = entry.currentRound > 1 ? entry.currentRound : undefined
      this.updateNode(entry, nodeRun, { status: 'running', round: roundTag, startedAt: Math.floor(Date.now() / 1000) })
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
          tokenUsage: result.tokenUsage,
          round: roundTag,
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
      current = this.nextNode(entry, graph, current, verdict, nodeMap, outputs)
    }

    this.finishRun(entry, 'completed')
  }

  /** 执行单个节点：智能体/评审/输入/条件/工具等类型 */
  private async executeNode(
    entry: RunEntry,
    node: PluginWorkflowNodeSpec,
    params: PluginWorkflowRunParams,
    outputs: Map<string, string>,
  ): Promise<{ output?: string; verdict?: string; conversationId?: string; tokenUsage?: PluginWorkflowTokenUsage }> {
    switch (node.type) {
      case 'input':
        // 输入节点只做变量标注：入参由运行发起方传入，此处直接产出可引用的文本
        return { output: this.renderInstruction(node.instruction || '', params.variables, outputs, true) }
      case 'end':
        return { output: this.renderInstruction(node.instruction || '', params.variables, outputs, true) }
      case 'condition':
        return { verdict: this.resolveConditionVerdict(node, params.variables, outputs) }
      case 'loop':
        // 循环节点无产出：轮次计数在主循环进入节点时统一累加（见 executeRun）
        return {}
      default: {
        const prompt = this.buildNodePrompt(entry, node, params.variables, outputs)
        return this.runAgentNode(entry, entry.nodeRuns.get(node.id)!, node, prompt)
      }
    }
  }

  /** 通过 SubAgentRuntime 以子会话方式执行一个智能体节点 */
  private async runAgentNode(
    entry: RunEntry,
    nodeRun: PluginWorkflowNodeRun,
    node: PluginWorkflowNodeSpec,
    prompt: string,
  ): Promise<{ output?: string; verdict?: string; conversationId?: string; tokenUsage?: PluginWorkflowTokenUsage }> {
    const run = entry.run
    const targetEmployeeId = this.resolveNodeEmployeeId(node)
    // 评审节点的结构化结论契约文案由调用方经 spec 注入（模板语义不进内核）
    const instruction = node.review?.contractSuffix ? `${prompt}\n${node.review.contractSuffix}` : prompt
    // 评审节点每次执行预建独立子会话并传入复用，保证多轮评审上下文隔离、且不留空会话
    const reviewConversationId = node.type === 'review'
      ? WorkspaceManagerService.getInstance().createConversation(
        targetEmployeeId, undefined, `评审: ${node.label}`, true, run.conversationId,
      ).id
      : undefined

    // transcript 采集：指令/思考/正文/工具调用实时进节点事件，供运行详情时间线展示
    const recorder = new NodeTranscriptRecorder(nodeRun.events || [], nodeRun.round || 1, {
      broadcast: (event) => this.broadcast(run.runId, 'node:event', node.id, { event }),
      persist: () => this.persistRun(run),
    })
    nodeRun.events = recorder.events
    recorder.addPrompt(instruction)

    const parentEmployeeId = this.resolveParentEmployeeId(entry)
    const launch = SubAgentRuntime.getInstance().launchSubAgent({
      parentSessionId: run.runId,
      parentEmployeeId,
      parentConversationId: run.conversationId!,
      targetEmployeeId,
      instruction,
      conversationId: reviewConversationId,
      delegationDepth: 0,
      delegationChain: [],
      parentAbortSignal: entry.controller.signal,
      highPermission: true,
      onEvent: (eventType, data) => recorder.handle(eventType, data),
    })
    if (!launch.success || !launch.runId) {
      recorder.finalize()
      throw new Error(launch.error || '子会话派发失败')
    }
    this.updateNode(entry, nodeRun, { childRunId: launch.runId })
    this.broadcast(run.runId, 'node:start', node.id, { childRunId: launch.runId, targetEmployeeName: launch.targetEmployeeName })

    const [outcome] = await SubAgentRuntime.getInstance().awaitRuns([launch.runId], NODE_WAIT_TIMEOUT_MS)
    const output = this.outcomeText(outcome)
    if (!outcome?.success && !output) {
      recorder.finalize()
      throw new Error(outcome?.error || '子会话执行失败')
    }
    recorder.finalize()

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
      conversationId: outcome?.conversationId || reviewConversationId,
      tokenUsage: outcome?.tokenUsage,
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
    outputs: Map<string, string>,
  ): PluginWorkflowNodeSpec | undefined {
    const outgoing = graph.edges.filter(e => e.from === current.id)
    if (outgoing.length === 0) return undefined

    // 选边：并行节点取首条主干；否则优先按判定结论匹配分支标签，其次默认分支
    let chosen: PluginWorkflowEdgeSpec | undefined
    if (current.type === 'parallel') {
      chosen = outgoing[0]
    } else {
      if (verdict) chosen = outgoing.find(e => this.edgeMatchesVerdict(e, verdict))
      if (!chosen) chosen = outgoing.find(e => !e.when)
    }
    if (!chosen) return undefined

    let target = nodeMap.get(chosen.to)
    // loop 回边上限：回到循环节点且轮次用尽时改走后续非回边分支，让流程继续向下（含带 fail 标签的回边）
    if (target?.type === 'loop' && target.maxRounds && target.maxRounds > 0) {
      const used = entry.loopRounds.get(target.id) || 0
      if (used >= target.maxRounds) {
        const forward = outgoing.find(e => e !== chosen && e.when !== 'loop' && !(verdict && this.edgeMatchesVerdict(e, verdict)))
        target = forward ? nodeMap.get(forward.to) : undefined
      }
    }
    // 评审节点结论更新迭代反馈：fail → 记录本轮评审意见供下游返工节点承接；
    // pass → 清空历史反馈，避免陈旧意见泄漏到后续无关节点
    if (target && current.type === 'review') {
      entry.pendingFeedback = verdict === 'fail'
        ? { fromNodeId: current.id, fromLabel: current.label, verdict, output: outputs.get(current.id) || '' }
        : null
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
   * 组装节点提示词：在指令插值基础上，若处于迭代回写路径，则前置上一轮评审意见与自身上一轮产出，
   * 让被回写的执行节点能「按意见修订」而不是从头重写（回写触发节点自身不再注入，并在此消费掉反馈）。
   */
  private buildNodePrompt(
    entry: RunEntry,
    node: PluginWorkflowNodeSpec,
    variables: Record<string, string> | undefined,
    outputs: Map<string, string>,
  ): string {
    const base = this.renderInstruction(node.instruction || '', variables, outputs, true)
    const feedback = entry.pendingFeedback
    if (!feedback) return base
    // 回写触发节点（评审/条件）再次执行：反馈已送达被回写节点，消费完毕
    if (node.id === feedback.fromNodeId) {
      entry.pendingFeedback = null
      return base
    }
    // 仅注入执行类节点：评审/条件节点只针对新产出复核，不承接返工上下文
    if (node.type === 'review' || node.type === 'condition') return base

    const sections: string[] = ['【迭代返工】流程回到本节点重新执行，请结合下列上一轮反馈修订产出，不要从头重写。']
    const verdict = feedback.verdict ? `（结论：${feedback.verdict}）` : ''
    sections.push(`— 来自「${feedback.fromLabel}」的上一轮反馈${verdict}：\n${feedback.output.trim().slice(0, MAX_OUTPUT_INJECT_CHARS) || '(未给出文字意见)'}`)
    const previous = entry.nodeRuns.get(node.id)?.output
    if (previous) sections.push(`— 你上一轮的产出（供修订参考）：\n${previous}`)
    return `${sections.join('\n\n')}\n\n————\n\n${base}`
  }

  /**
   * 指令模板插值：支持 {{var}} 运行入参、{{nodeId}} 节点输出。
   * 变量名不限 ASCII（中文参数名常见），除花括号外任意字符均可；strict=true 时
   * 对未解析变量保留原文（便于用户发现拼写问题）。
   */
  private renderInstruction(
    template: string,
    variables: Record<string, string> | undefined,
    outputs: Map<string, string>,
    strict = false,
  ): string {
    return String(template || '').replace(/\{\{([^{}]+)\}\}/g, (raw, key: string) => {
      const name = key.trim()
      if (variables && name in variables) return String(variables[name] ?? '')
      const output = outputs.get(name)
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
    // 字段构造复用注册表统一 helper（与委托临时子智能体同源），仅 description 沿用模板任务语义
    return EmployeeRegistryService.getInstance().toInlineRegisteredEmployee(`inline:${this.slugifyKey(role.key)}`, {
      name: role.name || this.slugifyKey(role.key),
      description: '模板任务内联角色（仅在模板运行期间存在）',
      systemPrompt: role.systemPrompt,
      tools: role.tools,
      skills: role.skills,
    })
  }

  private slugifyKey(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63)
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
    return { nodeId: node.id, label: node.label || node.id, type: node.type, status: 'pending', executor: this.resolveNodeExecutor(node) }
  }

  /** 节点执行者展示名：数字员工名 > 临时角色名（未知名时回退 id） */
  private resolveNodeExecutor(node: PluginWorkflowNodeSpec): string | undefined {
    if (node.employeeId) {
      const registered = EmployeeRegistryService.getInstance().getRegistered(node.employeeId)
      if (registered) return registered.name
      return WorkspaceManagerService.getInstance().getEmployee(node.employeeId)?.name || node.employeeId
    }
    return node.ephemeralRole?.name || undefined
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
    // 终态后释放内存条目（getRun 随后回落 DB），避免已完成运行常驻内存
    this.entries.delete(run.runId)
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
        `INSERT INTO workflow_runs (run_id, template_id, template_name, conversation_id, employee_id, status, graph_json, nodes_json, artifacts_json, variables_json, error, started_at, ended_at)
         VALUES (@run_id, @template_id, @template_name, @conversation_id, @employee_id, @status, @graph_json, @nodes_json, @artifacts_json, @variables_json, @error, @started_at, @ended_at)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status, nodes_json = excluded.nodes_json, artifacts_json = excluded.artifacts_json,
           variables_json = excluded.variables_json,
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
        variables_json: JSON.stringify(run.variables || {}),
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
    const variables = safeParseRecord(row.variables_json)
    return {
      runId: row.run_id,
      templateId: row.template_id || undefined,
      templateName: row.template_name || undefined,
      conversationId: row.conversation_id || undefined,
      employeeId: row.employee_id || undefined,
      status: row.status as PluginWorkflowRunStatus,
      nodes: safeParseArray<PluginWorkflowNodeRun>(row.nodes_json),
      artifacts: safeParseArray<PluginWorkflowArtifact>(row.artifacts_json),
      variables: Object.keys(variables).length > 0 ? variables : undefined,
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
  variables_json?: string
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

function safeParseRecord(json?: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string>
    return {}
  } catch {
    return {}
  }
}

/** 截断文本并在超限处标注省略 */
function clipText(text: string, max: number): string {
  const value = String(text || '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 工具入参/输出统一转展示文本（对象美化 JSON，字符串原样） */
function stringifyToolIO(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

interface RecorderHooks {
  /** 结构化事件增量广播（节流由记录器内部控制） */
  broadcast: (event: PluginWorkflowNodeEvent) => void
  /** 落库回调（节流由记录器内部控制） */
  persist: () => void
}

/**
 * 单个智能体节点执行 transcript 的采集器：
 * 把 SubAgentRuntime 的流式事件（thought/chunk/tool_call/tool_result/error）归并为
 * 有序的节点事件数组；思考/正文槽位按时间顺序追加、整槽位广播，工具按下发顺序匹配结果。
 */
class NodeTranscriptRecorder {
  readonly events: PluginWorkflowNodeEvent[]
  /** 待广播的脏事件下标（text/thinking 合并节流，工具类立即广播） */
  private dirtyBroadcast = new Set<number>()
  private broadcastTimer: NodeJS.Timeout | null = null
  private persistTimer: NodeJS.Timeout | null = null
  private finalized = false

  constructor(initial: PluginWorkflowNodeEvent[], private readonly round: number, private readonly hooks: RecorderHooks) {
    // 循环回流重复执行同一节点时，沿用历史各轮事件继续追加
    this.events = initial.length ? initial.map(e => ({ ...e })) : []
  }

  /** 任务指令（每轮执行一条） */
  addPrompt(text: string): void {
    this.appendEvent({
      type: 'prompt',
      text: clipText(text, MAX_TRANSCRIPT_TEXT_CHARS),
      startedAt: Date.now(),
    }, true)
  }

  /** 处理 SubAgentRuntime 原始事件 */
  handle(eventType: string, data: any): void {
    if (this.finalized) return
    switch (eventType) {
      case 'thought':
        this.appendStreaming('thinking', String(data || ''), MAX_TRANSCRIPT_THINKING_CHARS)
        break
      case 'chunk':
        this.appendStreaming('text', String(data || ''), MAX_TRANSCRIPT_TEXT_CHARS)
        break
      case 'tool_call':
        this.onToolCall(data)
        break
      case 'tool_result':
        this.onToolResult(data)
        break
      case 'error':
        this.appendEvent({
          type: 'error',
          text: typeof data?.error === 'string' ? data.error : stringifyToolIO(data),
          startedAt: Date.now(),
        }, true)
        break
      default:
        break
    }
  }

  /** 结束采集：冲刷待广播/落库的节流数据 */
  finalize(): void {
    if (this.finalized) return
    this.finalized = true
    if (this.broadcastTimer) { clearTimeout(this.broadcastTimer); this.broadcastTimer = null }
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null }
    this.flushBroadcast()
    this.hooks.persist()
  }

  /** 思考/正文：紧接同类型事件则并入，否则新开一条（还原 思考→工具→正文 的多轮顺序） */
  private appendStreaming(type: 'thinking' | 'text', delta: string, max: number): void {
    if (!delta) return
    const last = this.events[this.events.length - 1]
    if (last && last.type === type && last.round === this.round) {
      last.text = clipText(`${last.text || ''}${delta}`, max)
      this.markDirty(last.index)
    } else {
      const event = this.appendEvent({ type, text: clipText(delta, max), startedAt: Date.now() }, false)
      this.markDirty(event.index)
    }
  }

  private onToolCall(data: any): void {
    const event: Omit<PluginWorkflowNodeEvent, 'index' | 'round'> = {
      type: 'tool',
      name: String(data?.name || 'tool'),
      input: clipText(stringifyToolIO(data?.args), MAX_TOOL_IO_CHARS),
      status: 'running',
      startedAt: Date.now(),
    }
    this.appendEvent(event, true)
  }

  /** 工具结果：onToolResult 不带 id，匹配同名最早未完成的工具调用；匹配不到补一条已完成事件 */
  private onToolResult(data: any): void {
    const name = String(data?.name || 'tool')
    const target = this.events.find(e => e.type === 'tool' && e.name === name && e.status === 'running' && e.round === this.round)
    const failed = data?.success === false
    const output = clipText(stringifyToolIO(failed ? data?.error : data?.result), MAX_TOOL_IO_CHARS)
    if (target) {
      target.status = failed ? 'failed' : 'success'
      target.output = output
      target.endedAt = Date.now()
      this.markDirty(target.index, true)
    } else {
      this.appendEvent({
        type: 'tool',
        name,
        output,
        status: failed ? 'failed' : 'success',
        startedAt: Date.now(),
        endedAt: Date.now(),
      }, true)
    }
  }

  private appendEvent(event: Omit<PluginWorkflowNodeEvent, 'index' | 'round'>, immediate: boolean): PluginWorkflowNodeEvent {
    const full: PluginWorkflowNodeEvent = { ...event, index: this.events.length, round: this.round }
    this.events.push(full)
    if (immediate) this.hooks.broadcast(full)
    this.schedulePersist()
    return full
  }

  private markDirty(index: number, immediate = false): void {
    this.dirtyBroadcast.add(index)
    if (immediate) {
      this.flushBroadcast()
    } else {
      this.scheduleBroadcast()
    }
    this.schedulePersist()
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      this.flushBroadcast()
    }, TRANSCRIPT_EVENT_THROTTLE_MS)
  }

  private flushBroadcast(): void {
    if (this.dirtyBroadcast.size === 0) return
    for (const index of this.dirtyBroadcast) {
      const event = this.events[index]
      if (event) this.hooks.broadcast(event)
    }
    this.dirtyBroadcast.clear()
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.hooks.persist()
    }, TRANSCRIPT_PERSIST_THROTTLE_MS)
  }
}

export default WorkflowRuntimeService
