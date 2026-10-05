import fs from 'fs'
import path from 'path'
import type { GeneratedFileInfo, ThinkingLevel, EphemeralSubAgentSpec } from '../../../shared/types'
import { parseEmployeeDelegation } from '../../../shared/types'
import DatabaseService from '../database.service'
import MemoryRefinementService from '../memory-refinement.service'
import WorkspaceManagerService from '../workspace-manager.service'
import EmployeeAgentService from '../employee-agent.service'
import EmployeeRegistryService from '../employee-registry.service'
import { interactionContext } from '../unified-interaction.service'
import { broadcastRunEvent } from '../../ipc/agent-run-events'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'
import type {
  ActiveRunInfo,
  AgentRun,
  AgentRunOutcome,
  AgentRunStatus,
  AgentRunTokenUsage,
  AgentRunEventEntry,
  LaunchSubAgentInput,
  LaunchSubAgentResult,
  LaunchFollowupInput,
  AgentRunLiveness,
} from './types'

const logger = createLogger('SubAgentRuntime')

/** context_files 最大数量，防止 LLM 传入过多文件撑爆上下文 */
const MAX_CONTEXT_FILES = 10
/** 单个 context_file 读取上限（字符），防止超大文件 */
const MAX_FILE_CHARS = 8000
/** 同一子会话的追问轮数上限（含首轮委托），防止无限多轮 */
const MAX_FOLLOWUP_ROUNDS = 5
/** 追问历史轮中单轮 summary 截断长度（字符），防止历史撑爆子智能体上下文 */
const MAX_ROUND_SUMMARY_CHARS = 4000
/** 单 run 事件日志上限（ring buffer），renderer 重载恢复用 */
const EVENT_LOG_CAP = 500
/** 工作区目录 diff 最多遍历的文件数，防止超大目录卡死 */
const SNAPSHOT_MAX_FILES = 5000
/** 工作区目录 diff 跳过目录 */
const SNAPSHOT_IGNORE_DIRS = new Set(['node_modules', '.git', '.cache', '.workavatar'])
/** 产品成品扩展名白名单（L2 自动检测仅认这些） */
const ARTIFACT_EXT_WHITELIST = new Set([
  '.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls',
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.md', '.txt', '.csv', '.html', '.htm', '.json', '.zip',
])
/** 子会话强制委托契约（拼入子会话指令）：成品文件声明 + 结构化任务回执 */
const SUBAGENT_CONTRACT = [
  'Delegation contract (mandatory):',
  '1. If this task produces user-facing deliverable files (documents, spreadsheets, presentations, PDFs, images, code projects, and similar), you MUST call report_generated_files and declare every file by its absolute path before your final reply, even if the files are not mentioned in the summary. Temporary files do not need to be declared.',
  '2. Your final reply must be a self-contained report: lead with the outcome in one or two sentences, then list key results and any produced deliverables. The parent agent cannot see your intermediate steps.',
  '3. End the final reply with the following receipt block, filled in exactly:',
  '---',
  'Delegation Receipt',
  'Status: Completed | Partially completed | Failed',
  'Deliverables: <absolute paths, one per line; or "None">',
  'Blockers: <reason and what is needed to proceed; or "None">',
  '---',
  '4. Do not ask the end user questions. If additional input from the parent agent is required, state it in Blockers and finish with status "Partially completed".',
].join('\n')

/** liveness 停滞阈值：运行中 run 最近一次事件超过该窗口判定为 stalled（无事件即无进展） */
const LIVENESS_STALL_MS = 6 * 60_000
/** 完成门重试上限：子会话存在未收尾任务时的收尾纠偏轮数上限 */
const MAX_GATE_ROUNDS = 2
/** 每个会话保留的主管通知条数上限 */
const MAX_NOTIFICATIONS_PER_CONV = 50

/** 后台 run 完成后投递给主管会话的通知 */
export interface SupervisorNotification {
  runId: string
  targetEmployeeId: string
  targetEmployeeName: string
  status: AgentRunStatus
  summary: string
  generatedFiles: GeneratedFileInfo[]
  error?: string
  completedAt: number
}

/** 派发时挂给子会话的任务项（任务台账，阶段四；完成后用于完成门） */
export interface SubTaskItem {
  id: string
  title: string
  status: 'open' | 'in_progress' | 'completed' | 'blocked'
}

interface RunEntry {
  run: AgentRun
  controller: AbortController
  eventLog: AgentRunEventEntry[]
  settled: Promise<void>
  resolveSettled: () => void
  /** 委托（嵌套）相关执行参数，由 launch 时从主管上下文捕获 */
  delegationDepth: number
  delegationChain: string[]
  enableThinking: ThinkingLevel
  highPermission: boolean
  /** 主管会话的 AbortSignal，用于级联中止 */
  parentAbortSignal?: AbortSignal
  /** 主管（发起方）的员工 id，用于嵌套委托链记录 */
  parentEmployeeId: string
  /** 执行事件实时回调（launch 方传入，如模板任务引擎采集节点 transcript） */
  onEvent?: (eventType: string, data: any) => void
  /** 平级协作邮箱：send_message 写、read_messages 读 */
  inbox: Array<{ id: string; fromEmployeeName: string; content: string; sentAt: number }>
  /** 临时角色注册的 inline 员工 id（settle 时下线；追问重建） */
  ephemeralId?: string
  /** 结构化交付物捕获（submit_structured_result 上报） */
  structuredCapture?: unknown
  /** 任务台账（子会话内 open/in_progress/completed/blocked） */
  tasks: SubTaskItem[]
}

function isTerminal(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/** 把 run 结构化为可供主管 LLM 消费的结果（文本 + 结构化字段） */
export function formatRunOutput(run: AgentRun, extras?: { structured?: unknown; incompleteTasks?: string[] }): string {
  const lines: string[] = []
  lines.push(`已委托 ${run.employeeName} 完成任务。`)
  if (run.summary) {
    lines.push(`结果摘要：${run.summary}`)
  }
  const files = [...run.generatedFiles, ...run.autoDetectedFiles]
  if (files.length > 0) {
    lines.push('生成的成果文件：')
    for (const f of files) {
      lines.push(`- ${f.path}`)
    }
  }
  if (extras?.incompleteTasks && extras.incompleteTasks.length > 0) {
    lines.push(`未收尾任务项：${extras.incompleteTasks.join('；')}`)
  }
  if (extras?.structured !== undefined) {
    lines.push(`结构化结果（structured JSON）：\n${typeof extras.structured === 'string' ? extras.structured : JSON.stringify(extras.structured)}`)
  }
  if (run.error) {
    lines.push(`错误：${run.error}`)
  }
  return lines.join('\n')
}

/**
 * 子会话运行时：管理"主管 → 子员工"的运行（AgentRun）。
 *
 * 职责：
 * - launchSubAgent 异步派发（立即返回 runId），内部创建子 conversation + 执行子 chatStream
 * - awaitRuns 阻塞聚合一组 run 的结构化结果（支持部分成功/超时）
 * - cancelRun/cancelTree 中止 run 子树
 * - 事件双写广播：旧 AGENT_DELEGATION_EVENT + 新 AGENT_RUN_EVENT（ring buffer 支持重载恢复）
 * - 产物 L1 采集 report_generated_files、L2 工作区目录 diff 自动检测
 * - 并发上限与排队
 */
class SubAgentRuntime {
  private static instance: SubAgentRuntime
  private entries: Map<string, RunEntry> = new Map()
  private queue: string[] = []
  private activeCount = 0
  /** 内存中保留的 run 条目上限（仅淘汰已终态，防止长会话内存膨胀） */
  private readonly MAX_MEMORY_ENTRIES = 100
  /** 主管通知队列（conversationId → 后台 run 终态通知，read_run_notifications 读取清空） */
  private notifications = new Map<string, SupervisorNotification[]>()
  /** 启动僵尸恢复是否已执行（每进程一次） */
  private recovered = false

  private constructor() {}

  static getInstance(): SubAgentRuntime {
    if (!SubAgentRuntime.instance) {
      SubAgentRuntime.instance = new SubAgentRuntime()
    }
    return SubAgentRuntime.instance
  }

  private getMaxParallel(): number {
    try {
      const row = DatabaseService.getInstance().getDb().prepare(
        "SELECT value FROM settings WHERE key = 'sub_agent_max_parallel'"
      ).get() as { value?: string } | undefined
      const n = row?.value ? parseInt(row.value, 10) : NaN
      return Number.isFinite(n) && n > 0 ? n : 3
    } catch {
      return 3
    }
  }

  /** 校验 context_files 路径安全：必须位于主管会话工作区或主管员工工作区内 */
  private validateContextFiles(files: string[], parentConversationId: string, parentEmployeeId: string): { valid: string[]; errors: string[] } {
    if (!files || files.length === 0) return { valid: [], errors: [] }
    if (files.length > MAX_CONTEXT_FILES) {
      return { valid: [], errors: [`context_files 数量超限（最多 ${MAX_CONTEXT_FILES} 个，传入 ${files.length} 个）`] }
    }
    const ws = WorkspaceManagerService.getInstance()
    const db = DatabaseService.getInstance().getDb()
    const allowedRoots: string[] = []
    const convWs = ws.getConversationWorkspacePath(parentConversationId)
    if (convWs) allowedRoots.push(path.resolve(convWs))
    const emp = db.prepare('SELECT workspace_path FROM employees WHERE id = ?').get(parentEmployeeId) as { workspace_path?: string } | undefined
    if (emp?.workspace_path) allowedRoots.push(path.resolve(emp.workspace_path))
    const valid: string[] = []
    const errors: string[] = []
    for (const fp of files) {
      if (!fp || typeof fp !== 'string') {
        errors.push(`路径无效: ${String(fp)}`)
        continue
      }
      const resolved = path.resolve(fp)
      const isAllowed = allowedRoots.some(root => {
        const rel = path.relative(root, resolved)
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
      })
      if (!isAllowed) {
        errors.push(`路径不在允许的工作区范围内: ${fp}`)
        continue
      }
      valid.push(fp)
    }
    return { valid, errors }
  }

  private async buildSubMessages(instruction: string, contextFiles: string[], suffix?: string): Promise<Array<{ role: string; content: string }>> {
    let content = `${instruction.trim()}\n\n${SUBAGENT_CONTRACT}${suffix ? `\n\n${suffix}` : ''}\n\nIf the parent sent additional instructions through send_message, call read_messages to check for the latest requirements before finishing.`
    if (contextFiles.length > 0) {
      const parts: string[] = [content, '', '--- Context files ---']
      for (const fp of contextFiles) {
        try {
          const text = await fs.promises.readFile(fp, 'utf-8')
          parts.push(`\n[File: ${fp}]\n${text.slice(0, MAX_FILE_CHARS)}`)
        } catch {
          parts.push(`\n[File: ${fp}]\n(failed to read)`)
        }
      }
      content = parts.join('\n')
    }
    return [{ role: 'user', content }]
  }

  /**
   * 加载同一子会话的历史轮次（追问上下文持久化）：
   * 按 run 插入顺序（rowid）还原各轮 user(指令)/assistant(结果) 对，
   * 失败/取消轮的 assistant 内容附错误说明，让子智能体明确上一轮的问题所在。
   */
  private loadFollowupHistory(conversationId: string, excludeRunId: string): Array<{ role: string; content: string }> {
    try {
      const db = DatabaseService.getInstance().getDb()
      const rows = db.prepare(
        `SELECT run_id, status, inputs_json, result_json, error FROM sub_agent_runs
         WHERE conversation_id = ? AND run_id != ? ORDER BY rowid`
      ).all(conversationId, excludeRunId) as Array<{ run_id: string; status: string; inputs_json?: string; result_json?: string; error?: string }>
      const history: Array<{ role: string; content: string }> = []
      for (const r of rows) {
        const inputs = safeParse(r.inputs_json || '')
        const result = safeParse(r.result_json || '')
        const instruction = String(inputs.instruction || '').trim()
        if (!instruction) continue
        history.push({ role: 'user', content: instruction })
        let reply = String(result.summary || '').trim()
        if (r.status === 'failed' || r.status === 'cancelled') {
          const label = r.status === 'failed' ? 'failed' : 'cancelled'
          const tail = `(This turn was ${label}${r.error ? `: ${r.error}` : ''})`
          reply = reply ? `${reply}\n${tail}` : tail
        }
        history.push({ role: 'assistant', content: reply.slice(0, MAX_ROUND_SUMMARY_CHARS) || '(No text output this turn)' })
      }
      return history
    } catch (err: any) {
      logger.warn(`Failed to load followup history for conversation ${conversationId}:`, err?.message || err)
      return []
    }
  }

  private snapshotWorkspace(dir: string): Map<string, { size: number; mtime: number }> {
    const snapshot = new Map<string, { size: number; mtime: number }>()
    if (!dir || !fs.existsSync(dir)) return snapshot
    const walk = (current: string, rel: string) => {
      if (snapshot.size >= SNAPSHOT_MAX_FILES) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        if (snapshot.size >= SNAPSHOT_MAX_FILES) return
        if (ent.isDirectory()) {
          if (SNAPSHOT_IGNORE_DIRS.has(ent.name)) continue
          walk(path.join(current, ent.name), rel ? `${rel}/${ent.name}` : ent.name)
          continue
        }
        const relName = rel ? `${rel}/${ent.name}` : ent.name
        try {
          const stat = fs.statSync(path.join(current, ent.name))
          snapshot.set(relName, { size: stat.size, mtime: Math.floor(stat.mtimeMs) })
        } catch {
          /* skip unreadable file */
        }
      }
    }
    walk(dir, '')
    return snapshot
  }

  private diffSnapshot(before: Map<string, { size: number; mtime: number }>, dir: string): GeneratedFileInfo[] {
    if (!dir || !fs.existsSync(dir)) return []
    const after = this.snapshotWorkspace(dir)
    const detected: GeneratedFileInfo[] = []
    for (const [relName, stat] of after) {
      const prev = before.get(relName)
      if (prev && prev.size === stat.size && prev.mtime === stat.mtime) continue
      const ext = path.extname(relName).toLowerCase()
      if (!ARTIFACT_EXT_WHITELIST.has(ext)) continue
      const abs = path.join(dir, ...relName.split('/'))
      if (!fs.existsSync(abs)) continue
      const fileStat = fs.statSync(abs)
      detected.push({
        path: abs,
        name: path.basename(abs),
        ext: ext.replace('.', ''),
        size: fileStat.size,
        mtime: Math.floor(fileStat.mtimeMs / 1000),
      })
    }
    return detected
  }

  private dedupArtifacts(reported: GeneratedFileInfo[], detected: GeneratedFileInfo[]): GeneratedFileInfo[] {
    const reportedPaths = new Set(reported.map(f => path.resolve(f.path)))
    return detected.filter(f => !reportedPaths.has(path.resolve(f.path)))
  }

  /** 按绝对路径去重一份文件清单（保留首次出现） */
  private dedupFiles(files: GeneratedFileInfo[]): GeneratedFileInfo[] {
    const seen = new Set<string>()
    const out: GeneratedFileInfo[] = []
    for (const f of files) {
      const key = path.resolve(f.path)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(f)
    }
    return out
  }

  /** 递归收集某 run 的所有已完成后代 run 的产物（供父 run 展平） */
  private collectDescendantArtifacts(runId: string): { reported: GeneratedFileInfo[]; auto: GeneratedFileInfo[] } {
    const out: { reported: GeneratedFileInfo[]; auto: GeneratedFileInfo[] } = { reported: [], auto: [] }
    const collect = (parentId: string) => {
      for (const [childId, child] of this.entries) {
        if (child.run.parentRunId !== parentId) continue
        if (child.run.status === 'completed') {
          out.reported.push(...child.run.generatedFiles)
          out.auto.push(...child.run.autoDetectedFiles)
        }
        collect(childId)
      }
    }
    collect(runId)
    return out
  }

  /**
   * 平级协作基元：向指定 run 的邮箱发送一条消息（供 send_message 工具调用）。
   * 目标子会话可在执行过程中通过 read_messages 工具读取。
   */
  sendMessage(targetRunId: string, content: string, fromEmployeeName: string): { success: boolean; error?: string } {
    const target = this.entries.get(targetRunId)
    if (!target) {
      return { success: false, error: `run 不存在: ${targetRunId}` }
    }
    if (isTerminal(target.run.status)) {
      return { success: false, error: '目标 run 已结束，无法接收消息' }
    }
    const msg = { id: generateId(), fromEmployeeName: fromEmployeeName || '主管', content: String(content || ''), sentAt: Date.now() }
    target.inbox.push(msg)
    this.emit(targetRunId, 'message', { id: msg.id, fromEmployeeName: msg.fromEmployeeName, content: msg.content, sentAt: msg.sentAt })
    return { success: true }
  }

  /** 读取并清空指定 run 的未读消息（供 read_messages 工具调用） */
  readMessages(runId: string): Array<{ id: string; fromEmployeeName: string; content: string; sentAt: number }> {
    const entry = this.entries.get(runId)
    if (!entry) return []
    const messages = [...entry.inbox]
    entry.inbox = []
    return messages
  }

  // ====== 任务台账（阶段四）+ 结构化交付物 + 主管通知 ======

  /** 创建任务项（launch_tools 的 task_item_create 调用；绑定 delegationId 即当前 run） */
  createTask(runId: string, title: string): { success: boolean; taskId?: string; error?: string } {
    const entry = this.entries.get(runId)
    if (!entry) return { success: false, error: 'run 不存在或已结束，无法登记任务' }
    const titleTrim = String(title || '').trim()
    if (!titleTrim) return { success: false, error: '任务标题不能为空' }
    if (entry.tasks.length >= 20) return { success: false, error: '任务项数量超限（最多 20 个）' }
    const item: SubTaskItem = { id: `t${entry.tasks.length + 1}`, title: titleTrim, status: 'open' }
    entry.tasks.push(item)
    this.emit(runId, 'task_item', { ...item })
    return { success: true, taskId: item.id }
  }

  /** 更新任务项状态（task_item_update） */
  updateTask(runId: string, taskId: string, status: SubTaskItem['status']): { success: boolean; error?: string } {
    const entry = this.entries.get(runId)
    if (!entry) return { success: false, error: 'run 不存在或已结束' }
    const item = entry.tasks.find(t => t.id === taskId)
    if (!item) return { success: false, error: `任务项不存在: ${taskId}` }
    item.status = status
    this.emit(runId, 'task_item', { ...item })
    return { success: true }
  }

  listTasks(runId: string): SubTaskItem[] {
    return [...(this.entries.get(runId)?.tasks || [])]
  }

  /** 子会话经 submit_structured_result 上报结构化交付物 */
  recordStructuredResult(runId: string, value: unknown): { success: boolean; error?: string } {
    const entry = this.entries.get(runId)
    if (!entry) return { success: false, error: '当前上下文未关联有效委托运行，无法上报结构化结果' }
    entry.structuredCapture = value
    this.emit(runId, 'structured_result', value)
    return { success: true }
  }

  /** 主管会话读取后台 run 的终态通知（读取即清空） */
  readNotifications(conversationId: string): SupervisorNotification[] {
    const list = this.notifications.get(conversationId)
    if (!list || list.length === 0) return []
    this.notifications.delete(conversationId)
    return list
  }

  private pushNotification(convId: string, notice: SupervisorNotification): void {
    if (!convId) return
    const list = this.notifications.get(convId) || []
    list.push(notice)
    if (list.length > MAX_NOTIFICATIONS_PER_CONV) list.splice(0, list.length - MAX_NOTIFICATIONS_PER_CONV)
    this.notifications.set(convId, list)
    this.emit(notice.runId, 'notification', notice)
  }

  /** 运行活性派生：终态→idle；最近事件超过停滞窗口→stalled；否则 progressing */
  deriveLiveness(run: AgentRun): AgentRunLiveness {
    if (isTerminal(run.status)) return 'idle'
    const last = run.lastActivityAt || (run.startedAt ? run.startedAt * 1000 : 0)
    if (!last || Date.now() - last > LIVENESS_STALL_MS) return 'stalled'
    return 'progressing'
  }

  /**
   * 启动僵尸恢复（每进程首次派发前调用）：应用重启后 DB 中残留 running/queued 的 run
   * 已无执行主体，统一标记 failed（错误说明应用重启），避免永远显示运行中。
   */
  recoverStaleRuns(): void {
    if (this.recovered) return
    this.recovered = true
    try {
      const db = DatabaseService.getInstance().getDb()
      const info = db.prepare(
        `UPDATE sub_agent_runs SET status = 'failed', error = COALESCE(NULLIF(error, ''), '执行中断（应用重启）'),
           ended_at = ? WHERE status IN ('running', 'queued') AND ended_at IS NULL`
      ).run(Math.floor(Date.now() / 1000))
      if (info.changes > 0) logger.warn(`恢复僵尸子任务运行 ${info.changes} 条（应用重启）`)
    } catch (err: any) {
      logger.warn('recoverStaleRuns failed:', err?.message || err)
    }
  }

  private emit(runId: string, eventType: string, data: any): void {
    const entry = this.entries.get(runId)
    if (!entry) return
    if (!isTerminal(entry.run.status)) entry.run.lastActivityAt = Date.now()
    // chunk/thought 高频事件在日志中合并追加，避免占满 ring buffer 挤掉结构化事件（start/tool/result）
    const last = entry.eventLog[entry.eventLog.length - 1]
    if ((eventType === 'chunk' || eventType === 'thought')
      && last?.eventType === eventType
      && typeof last.data === 'string'
      && typeof data === 'string') {
      last.data += data
    } else {
      entry.eventLog.push({ eventType, data })
    }
    if (entry.eventLog.length > EVENT_LOG_CAP) {
      entry.eventLog.splice(0, entry.eventLog.length - EVENT_LOG_CAP)
    }
    broadcastRunEvent(entry.run.parentSessionId, runId, eventType, data, entry.run.parentConversationId)
    // launch 方事件回调（如模板任务引擎）：透传未经合并的原始事件，异常隔离不影响执行
    if (entry.onEvent) {
      try { entry.onEvent(eventType, data) } catch { /* ignore */ }
    }
  }

  private beginRun(runId: string, data: Record<string, any>): void {
    this.emit(runId, 'start', { runId, ...data })
    this.emit(runId, 'status', { status: 'running' })
  }

  private buildResultEvent(run: AgentRun): any {
    return {
      runId: run.runId,
      status: run.status,
      summary: run.summary || '',
      generatedFiles: run.generatedFiles,
      autoDetectedFiles: run.autoDetectedFiles,
      references: undefined,
      tokenUsage: run.tokenUsage,
      error: run.error,
      targetEmployeeId: run.employeeId,
      targetEmployeeName: run.employeeName,
      targetAvatarType: run.employeeAvatarType,
      followupOfRunId: run.followupOfRunId,
      conversationId: run.conversationId,
    }
  }

  private settle(runId: string, status: AgentRunStatus, patch: Partial<AgentRun>): void {
    const entry = this.entries.get(runId)
    if (!entry) return
    // 幂等：已终态的 run 不再重复结算（executeRun 异常与 kickQueue catch 可能双路径到达）
    if (isTerminal(entry.run.status)) return
    const run = entry.run
    run.status = status
    run.endedAt = Math.floor(Date.now() / 1000)
    Object.assign(run, patch)
    // 产物递归展平：子 run 的成果文件并入父 run（含嵌套后代），按路径去重
    if (status === 'completed') {
      const descendant = this.collectDescendantArtifacts(runId)
      run.generatedFiles = this.dedupFiles([...run.generatedFiles, ...descendant.reported])
      run.autoDetectedFiles = this.dedupArtifacts(run.generatedFiles, [...run.autoDetectedFiles, ...descendant.auto])
    }
    this.persistRun(run)
    // 后台派发：投递主管通知（前端收打扰小，由主管在下一轮经 read_run_notifications 获取）
    if (run.runInBackground && run.parentConversationId) {
      this.pushNotification(run.parentConversationId, {
        runId: run.runId,
        targetEmployeeId: run.employeeId,
        targetEmployeeName: run.employeeName,
        status: run.status,
        summary: run.summary || '',
        generatedFiles: [...run.generatedFiles, ...run.autoDetectedFiles],
        error: run.error,
        completedAt: Date.now(),
      })
    }
    // 临时角色下线（run 结束；追问时由 executeRun 按 ephemeral_json 重建）
    if (entry.ephemeralId) {
      try {
        EmployeeRegistryService.getInstance().unregisterInlineEmployee(entry.ephemeralId)
      } catch { /* ignore */ }
      entry.ephemeralId = undefined
    }
    if (status === 'cancelled') {
      this.emit(runId, 'cancelled', { runId })
      this.emit(runId, 'error', { error: run.error || '已取消' })
      this.emit(runId, 'result', this.buildResultEvent(run))
    } else if (status === 'failed') {
      this.emit(runId, 'error', { error: run.error })
      this.emit(runId, 'result', this.buildResultEvent(run))
    } else {
      this.emit(runId, 'result', this.buildResultEvent(run))
      this.emit(runId, 'done', {
        tokenUsage: run.tokenUsage,
        generatedFiles: run.generatedFiles,
        autoDetectedFiles: run.autoDetectedFiles,
        runId,
        targetEmployeeId: run.employeeId,
        targetEmployeeName: run.employeeName,
        targetAvatarType: run.employeeAvatarType,
      })
    }
    entry.resolveSettled()
    // 淘汰内存中过老的已结束 run，防止长会话累积导致内存膨胀
    this.evictTerminalEntries()
  }

  private persistRun(run: AgentRun): void {
    try {
      const db = DatabaseService.getInstance().getDb()
      const entry = this.entries.get(run.runId)
      const inputs: any = { instruction: run.instruction, contextFiles: run.contextFiles }
      if (run.followupOfRunId) inputs.followupOfRunId = run.followupOfRunId
      if (run.runInBackground) inputs.runInBackground = true
      const result: any = {
        summary: run.summary,
        generatedFiles: run.generatedFiles,
        autoDetectedFiles: run.autoDetectedFiles,
        structured: entry?.structuredCapture,
        incompleteTasks: entry?.tasks.filter(t => t.status === 'open' || t.status === 'in_progress').map(t => t.title),
      }
      const existing = db.prepare('SELECT run_id FROM sub_agent_runs WHERE run_id = ?').get(run.runId) as { run_id: string } | undefined
      if (existing) {
        db.prepare(
          `UPDATE sub_agent_runs SET parent_conversation_id = ?, employee_id = ?, parent_run_id = ?, conversation_id = ?,
             status = ?, inputs_json = ?, result_json = ?, usage_json = ?, error = ?, started_at = ?, ended_at = ?,
             ephemeral_json = ?, lifecycle = ?, last_activity_at = ? WHERE run_id = ?`
        ).run(
          run.parentConversationId, run.employeeId, run.parentRunId || '', run.conversationId || '',
          run.status,
          JSON.stringify(inputs), JSON.stringify(result), JSON.stringify(run.tokenUsage || {}),
          run.error || '', run.startedAt || null, run.endedAt || null,
          run.ephemeral ? JSON.stringify(run.ephemeral) : null,
          run.lifecycle || (run.ephemeral ? 'ephemeral' : 'persistent'),
          run.lastActivityAt || null, run.runId,
        )
      } else {
        db.prepare(
          `INSERT INTO sub_agent_runs (run_id, parent_conversation_id, employee_id, parent_run_id, conversation_id, status,
             inputs_json, result_json, usage_json, error, started_at, ended_at, ephemeral_json, lifecycle, last_activity_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          run.runId, run.parentConversationId, run.employeeId, run.parentRunId || '', run.conversationId || '', run.status,
          JSON.stringify(inputs), JSON.stringify(result), JSON.stringify(run.tokenUsage || {}),
          run.error || '', run.startedAt || null, run.endedAt || null,
          run.ephemeral ? JSON.stringify(run.ephemeral) : null,
          run.lifecycle || (run.ephemeral ? 'ephemeral' : 'persistent'),
          run.lastActivityAt || null,
        )
      }
    } catch (err: any) {
      logger.warn(`Failed to persist run ${run.runId}:`, err?.message || err)
    }
  }

  private launchInternal(input: LaunchSubAgentInput): LaunchSubAgentResult {
    const db = DatabaseService.getInstance().getDb()
    const isEphemeral = !!input.ephemeral
    const runId = generateId()

    // 目标员工解析：临时角色优先（现场生成 inline 员工，不经员工库）
    let targetEmployeeId = input.targetEmployeeId
    let targetName: string
    let targetAvatar: string | undefined
    if (isEphemeral) {
      const spec = input.ephemeral!
      const registry = EmployeeRegistryService.getInstance()
      const slug = registry.slugifyInlineKey(spec.key || spec.name)
      targetEmployeeId = `inline:sub-${slug}-${runId.slice(0, 6).toLowerCase()}`
      targetName = spec.name
      // 临时角色归属 key 参与委托环检测（与父链上的内联 key 比对）
      if (input.delegationChain.some(id => id.replace(/^inline:/, '').startsWith(`sub-${slug}`))) {
        return { success: false, error: `检测到委托环：临时角色 ${spec.name} 已在委托链中`, targetEmployeeName: targetName }
      }
    } else {
      // 自委托防护（优先于目标存在性/设置校验，保持既有错误语义）
      if (input.targetEmployeeId === input.parentEmployeeId) {
        return { success: false, error: '不能委托给自己', targetEmployeeName: input.targetEmployeeId }
      }
      const target = db.prepare('SELECT id, name, avatar_type FROM employees WHERE id = ?').get(input.targetEmployeeId) as
        | { id: string; name: string; avatar_type?: string }
        | undefined
      targetName = target?.name || input.targetEmployeeId
      targetAvatar = target?.avatar_type
      if (!target) {
        return { success: false, error: `目标员工不存在: ${input.targetEmployeeId}`, targetEmployeeName: targetName }
      }
      // 委托设置校验：主管须开启委托且目标在可委托列表中；目标须允许被委托
      const settingsError = this.validateDelegationSettings(input.parentEmployeeId, input.targetEmployeeId, targetName)
      if (settingsError) {
        return { success: false, error: settingsError, targetEmployeeName: targetName }
      }
    }

    // 递归防护
    if (input.delegationDepth >= 3) {
      return { success: false, error: `委托深度超限（上限 3 层，当前 ${input.delegationDepth}）`, targetEmployeeName: targetName }
    }
    if (input.delegationChain.includes(input.targetEmployeeId)) {
      return { success: false, error: '检测到委托环：目标员工已在委托链中', targetEmployeeName: targetName }
    }

    const run: AgentRun = {
      runId,
      parentConversationId: input.parentConversationId,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      employeeId: targetEmployeeId,
      employeeName: targetName,
      employeeAvatarType: targetAvatar,
      status: 'queued',
      instruction: input.instruction,
      contextFiles: input.contextFiles,
      // 调用方指定复用的子会话（如评审节点预建会话）；executeRun 据此跳过新建
      conversationId: input.conversationId,
      generatedFiles: [],
      autoDetectedFiles: [],
      ephemeral: input.ephemeral,
      lifecycle: isEphemeral ? 'ephemeral' : 'persistent',
      runInBackground: input.runInBackground === true,
      outputSchema: input.outputSchema,
    }
    this.enqueueRun(run, input)
    return { success: true, runId, targetEmployeeName: targetName, targetEmployeeId }
  }

  /** 委托设置校验：主管须开启委托且目标在可委托列表中；目标须允许被委托 */
  private validateDelegationSettings(parentEmployeeId: string, targetEmployeeId: string, targetName: string): string | undefined {
    // 内联员工（模板任务编排）无委托设置也无 UI 可配置，不走用户侧委托校验
    if (parentEmployeeId.startsWith('inline:') || targetEmployeeId.startsWith('inline:')) {
      return undefined
    }
    const db = DatabaseService.getInstance().getDb()
    const delegationRows = db.prepare(
      'SELECT id, delegation_json FROM employees WHERE id IN (?, ?)'
    ).all(parentEmployeeId, targetEmployeeId) as Array<{ id: string; delegation_json?: string | null }>
    const parentDelegation = parseEmployeeDelegation(delegationRows.find(r => r.id === parentEmployeeId)?.delegation_json)
    const targetDelegation = parseEmployeeDelegation(delegationRows.find(r => r.id === targetEmployeeId)?.delegation_json)
    if (!parentDelegation.enabled || !parentDelegation.targetIds.includes(targetEmployeeId)) {
      return '目标员工不在当前数字员工的可委托列表中，请从上下文信息 [DELEGATION] 段的可委托员工列表中选择'
    }
    if (!targetDelegation.acceptDelegation) {
      return `目标员工 ${targetName} 已设置为不允许被委托任务`
    }
    return undefined
  }

  /**
   * 追问：针对已结束委托的同一子会话继续多轮对话。
   * 复用原子会话与任务工作区，历史各轮（指令/结果/错误）从 sub_agent_runs 加载注入子智能体上下文。
   * 支持追问链（追问的追问）：按 conversation_id 分组即同一条多轮对话。
   */
  launchFollowup(input: LaunchFollowupInput): LaunchSubAgentResult {
    const db = DatabaseService.getInstance().getDb()

    // 1) 解析原 run：内存优先，回落 DB（重启或内存淘汰后仍可追问）
    const memEntry = this.entries.get(input.followupOfRunId)
    let origin: { runId: string; conversationId: string; employeeId: string; parentConversationId: string; parentRunId?: string; status: string; ephemeral?: EphemeralSubAgentSpec }
    if (memEntry) {
      const r = memEntry.run
      origin = {
        runId: r.runId, conversationId: r.conversationId || '', employeeId: r.employeeId,
        parentConversationId: r.parentConversationId, parentRunId: r.parentRunId, status: r.status,
        ephemeral: r.ephemeral,
      }
      if (!isTerminal(r.status)) {
        return { success: false, error: '原委托仍在执行中，请等待完成后再追问' }
      }
    } else {
      const row = db.prepare(
        `SELECT run_id, employee_id, parent_run_id, conversation_id, parent_conversation_id, status, ephemeral_json
         FROM sub_agent_runs WHERE run_id = ?`
      ).get(input.followupOfRunId) as
        | { run_id: string; employee_id: string; parent_run_id?: string; conversation_id?: string; parent_conversation_id?: string; status: string; ephemeral_json?: string }
        | undefined
      if (!row) {
        return { success: false, error: `未找到委托记录: ${input.followupOfRunId}（请使用 delegate_to_employee / followup_delegation 返回的 delegationId）` }
      }
      let ephemeral: EphemeralSubAgentSpec | undefined
      try { if (row.ephemeral_json) ephemeral = JSON.parse(row.ephemeral_json) } catch { /* ignore */ }
      origin = {
        runId: row.run_id, conversationId: row.conversation_id || '', employeeId: row.employee_id,
        parentConversationId: row.parent_conversation_id || '', parentRunId: row.parent_run_id || undefined, status: row.status,
        ephemeral,
      }
      // 重启后内存丢失的僵尸 run（DB 仍为 running/queued）：标记失败后允许追问，子会话历史仍可续用
      if (origin.status === 'running' || origin.status === 'queued') {
        db.prepare(
          `UPDATE sub_agent_runs SET status = 'failed', error = COALESCE(NULLIF(error, ''), '执行中断（应用重启）'), ended_at = ? WHERE run_id = ?`
        ).run(Math.floor(Date.now() / 1000), origin.runId)
      }
    }

    if (!origin.conversationId) {
      return { success: false, error: '原委托未建立子会话（可能未执行即失败），无法追问，请重新委托' }
    }
    if (origin.parentConversationId && origin.parentConversationId !== input.parentConversationId) {
      return { success: false, error: '原委托不属于当前会话，无法追问' }
    }

    // 2) 轮数上限（同一子会话累计，含首轮）
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM sub_agent_runs WHERE conversation_id = ?').get(origin.conversationId) as { n: number } | undefined
    if ((cnt?.n ?? 0) >= MAX_FOLLOWUP_ROUNDS) {
      return { success: false, error: `追问轮数已达上限（${MAX_FOLLOWUP_ROUNDS} 轮），如需继续请重新委托` }
    }

    // 3) 目标员工仍存在且允许被委托；主管委托设置与首轮一致，继续校验保持策略一致
    const target = db.prepare('SELECT id, name, avatar_type FROM employees WHERE id = ?').get(origin.employeeId) as
      | { id: string; name: string; avatar_type?: string }
      | undefined
    if (!target) {
      return { success: false, error: `目标员工不存在: ${origin.employeeId}` }
    }
    const settingsError = this.validateDelegationSettings(input.parentEmployeeId, origin.employeeId, target.name)
    if (settingsError) {
      return { success: false, error: settingsError, targetEmployeeName: target.name }
    }

    const runId = generateId()
    const run: AgentRun = {
      runId,
      parentConversationId: input.parentConversationId,
      parentSessionId: input.parentSessionId,
      parentRunId: origin.parentRunId,
      employeeId: origin.employeeId,
      employeeName: target.name,
      employeeAvatarType: target.avatar_type,
      status: 'queued',
      instruction: input.instruction,
      contextFiles: [],
      generatedFiles: [],
      autoDetectedFiles: [],
      conversationId: origin.conversationId,
      followupOfRunId: origin.runId,
      ephemeral: origin.ephemeral,
      lifecycle: origin.ephemeral ? 'ephemeral' : 'persistent',
    }
    this.enqueueRun(run, input)
    return { success: true, runId, targetEmployeeName: target.name }
  }

  /** 创建 run 条目入队执行（launch 与 followup 共用） */
  private enqueueRun(run: AgentRun, input: Pick<LaunchSubAgentInput, 'delegationDepth' | 'delegationChain' | 'enableThinking' | 'highPermission' | 'parentAbortSignal' | 'parentEmployeeId' | 'onEvent'>): void {
    let resolveSettled: () => void = () => {}
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
    const entry: RunEntry = {
      run,
      controller: new AbortController(),
      eventLog: [],
      settled,
      resolveSettled,
      delegationDepth: input.delegationDepth,
      delegationChain: input.delegationChain,
      enableThinking: input.enableThinking ?? false,
      highPermission: input.highPermission === true,
      parentAbortSignal: input.parentAbortSignal,
      parentEmployeeId: input.parentEmployeeId,
      onEvent: input.onEvent,
      inbox: [],
      tasks: [],
    }
    this.entries.set(run.runId, entry)
    this.persistRun(run)
    this.queue.push(run.runId)
    this.kickQueue()
  }

  /** 派发一个子会话运行。校验失败返回 error；成功立即返回 runId（异步排队执行） */
  launchSubAgent(input: LaunchSubAgentInput): LaunchSubAgentResult {
    this.recoverStaleRuns()
    const validated = this.validateContextFiles(input.contextFiles || [], input.parentConversationId, input.parentEmployeeId)
    if (validated.errors.length > 0) {
      return { success: false, error: validated.errors.join('\n') }
    }
    return this.launchInternal({ ...input, contextFiles: validated.valid })
  }

  /** 阻塞等待一组 run 完毕，返回结构化结果数组（支持部分成功/超时）。默认 280s（小于工具层 300s 超时） */
  async awaitRuns(runIds: string[], timeoutMs?: number): Promise<AgentRunOutcome[]> {
    const timeout = timeoutMs ?? 280000
    const waiters = runIds.map(async (runId) => {
      const entry = this.entries.get(runId)
      if (!entry) {
        return { runId, status: 'failed' as AgentRunStatus, success: false, error: 'run 不存在或已过期' }
      }
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          entry.settled,
          new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new Error('await timeout')), timeout)
          }),
        ])
      } catch {
        // 超时：返回当前状态
      } finally {
        if (timer) clearTimeout(timer)
      }
      return this.buildOutcome(entry.run)
    })
    return Promise.all(waiters)
  }

  private buildOutcome(run: AgentRun): AgentRunOutcome {
    if (run.status === 'completed') {
      const entry = this.entries.get(run.runId)
      return {
        runId: run.runId,
        employeeName: run.employeeName,
        status: run.status,
        success: true,
        output: formatRunOutput(run, {
          structured: entry?.structuredCapture,
          incompleteTasks: entry?.tasks.filter(t => t.status === 'open' || t.status === 'in_progress').map(t => t.title),
        }),
        tokenUsage: run.tokenUsage,
        conversationId: run.conversationId,
        result: {
          summary: run.summary || '',
          generatedFiles: run.generatedFiles,
          autoDetectedFiles: run.autoDetectedFiles,
          tokenUsage: run.tokenUsage,
          structured: entry?.structuredCapture,
          incompleteTasks: entry?.tasks.filter(t => t.status === 'open' || t.status === 'in_progress').map(t => t.title),
        },
      }
    }
    if (run.status === 'cancelled') {
      return { runId: run.runId, employeeName: run.employeeName, status: run.status, success: false, error: run.error || '已取消', conversationId: run.conversationId }
    }
    return { runId: run.runId, employeeName: run.employeeName, status: run.status, success: false, error: run.error || '执行失败', conversationId: run.conversationId }
  }

  /** 取消单个 run 及其子树 */
  cancelRun(runId: string): boolean {
    const entry = this.entries.get(runId)
    if (!entry) return false
    if (!isTerminal(entry.run.status)) {
      this.cancelDescendants(runId)
      entry.controller.abort()
    }
    return true
  }

  private cancelDescendants(runId: string): void {
    for (const [childId, child] of this.entries) {
      if (child.run.parentRunId === runId && !isTerminal(child.run.status)) {
        this.cancelDescendants(childId)
        child.controller.abort()
      }
    }
  }

  cancelTree(runId: string): void {
    this.cancelRun(runId)
  }

  getRun(runId: string): AgentRun | undefined {
    const entry = this.entries.get(runId)
    return entry ? { ...entry.run } : undefined
  }

  /** 活跃 run 列表（含事件日志），供 renderer 重载后恢复 */
  listActiveRuns(params?: { employeeId?: string; parentConversationId?: string }): ActiveRunInfo[] {
    const result: ActiveRunInfo[] = []
    for (const [, entry] of this.entries) {
      const run = entry.run
      if (params?.employeeId && run.employeeId !== params.employeeId) continue
      if (params?.parentConversationId && run.parentConversationId !== params.parentConversationId) continue
      result.push({ ...run, eventLog: [...entry.eventLog], liveness: this.deriveLiveness(run) })
    }
    result.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    return result
  }

  /** 历史 run（含活动记录与最近完成，按时间倒序） */
  listRecentRuns(limit = 100): Array<AgentRun & { eventLog: AgentRunEventEntry[] }> {
    try {
      const db = DatabaseService.getInstance().getDb()
      const rows = db.prepare(`
        SELECT r.*, e.name as employee_name FROM sub_agent_runs r
        LEFT JOIN employees e ON e.id = r.employee_id
        ORDER BY COALESCE(r.started_at, 0) DESC LIMIT ?
      `).all(limit) as any[]
      return rows.map(r => {
        const inputs = safeParse(r.inputs_json)
        const result = safeParse(r.result_json)
        const usage = safeParse(r.usage_json)
        let ephemeral: EphemeralSubAgentSpec | undefined
        try { if (r.ephemeral_json) ephemeral = JSON.parse(r.ephemeral_json) } catch { /* ignore */ }
        return {
          runId: r.run_id,
          parentConversationId: r.parent_conversation_id,
          parentSessionId: '',
          parentRunId: r.parent_run_id || undefined,
          employeeId: r.employee_id,
          employeeName: (r as any).employee_name || '',
          status: r.status,
          instruction: inputs.instruction || '',
          contextFiles: inputs.contextFiles,
          conversationId: r.conversation_id || undefined,
          followupOfRunId: inputs.followupOfRunId,
          summary: result.summary,
          generatedFiles: result.generatedFiles || [],
          autoDetectedFiles: result.autoDetectedFiles || [],
          tokenUsage: usage,
          error: r.error || undefined,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          eventLog: [],
          ephemeral,
          lifecycle: ephemeral ? 'ephemeral' : 'persistent',
          lastActivityAt: r.last_activity_at || undefined,
          runInBackground: inputs.runInBackground === true,
          outputSchema: undefined,
        }
      })
    } catch {
      return []
    }
  }

  /** 主管会话累计的子会话 token 用量（onDone 合并用，替代旧 childTokenUsage） */
  getAggregatedUsage(parentSessionId: string): AgentRunTokenUsage | undefined {
    let hasAny = false
    const total: AgentRunTokenUsage = {}
    for (const [, entry] of this.entries) {
      if (entry.run.parentSessionId !== parentSessionId) continue
      const u = entry.run.tokenUsage
      if (!u) continue
      hasAny = true
      total.promptTokens = (total.promptTokens || 0) + (u.promptTokens || 0)
      total.completionTokens = (total.completionTokens || 0) + (u.completionTokens || 0)
      total.totalTokens = (total.totalTokens || 0) + (u.totalTokens || 0)
      total.cachedTokens = (total.cachedTokens || 0) + (u.cachedTokens || 0)
    }
    return hasAny ? total : undefined
  }

  /** 清理指定 conversation 的 run 记录（conversation 删除时调用） */
  clearRunsByConversations(conversationIds: string[]): void {
    const ids = conversationIds.filter(Boolean)
    try {
      if (ids.length > 0) {
        const db = DatabaseService.getInstance().getDb()
        const del = db.prepare('DELETE FROM sub_agent_runs WHERE parent_conversation_id = ?')
        for (const id of ids) del.run(id)
      }
    } catch { /* ignore */ }
    for (const [, entry] of this.entries) {
      if (ids.includes(entry.run.parentConversationId) && !isTerminal(entry.run.status)) {
        entry.controller.abort()
      }
    }
  }

  /** 淘汰内存中最老的已终态 run 条目，超出上限时逐出（保留运行中/排队中） */
  private evictTerminalEntries(): void {
    if (this.entries.size <= this.MAX_MEMORY_ENTRIES) return
    const terminal: Array<[string, RunEntry]> = []
    for (const [id, e] of this.entries) {
      if (isTerminal(e.run.status)) terminal.push([id, e])
    }
    if (terminal.length === 0) return
    terminal.sort((a, b) => (a[1].run.endedAt || 0) - (b[1].run.endedAt || 0))
    let overflow = this.entries.size - this.MAX_MEMORY_ENTRIES
    for (const [id] of terminal) {
      if (overflow <= 0) break
      this.entries.delete(id)
      overflow--
    }
  }

  private kickQueue(): void {
    const maxParallel = this.getMaxParallel()
    while (this.activeCount < maxParallel && this.queue.length > 0) {
      const runId = this.queue.shift()
      if (!runId) continue
      const entry = this.entries.get(runId)
      if (!entry) continue
      this.activeCount++
      this.executeRun(runId)
        .catch((err: any) => {
          logger.error(`Sub-agent run ${runId} failed unexpectedly:`, err?.message || err)
          const e = this.entries.get(runId)
          if (e && !isTerminal(e.run.status)) {
            this.settle(runId, 'failed', { error: err?.message || String(err), summary: '' })
          }
        })
        .finally(() => {
          this.activeCount--
          this.kickQueue()
        })
    }
  }

  private async executeRun(runId: string): Promise<void> {
    const entry = this.entries.get(runId)
    if (!entry) return
    const run = entry.run
    // 排队期间已被取消/中止：不再创建子会话，直接结算（先发 start 让前端建卡，再进入取消态）
    if (entry.controller.signal.aborted) {
      this.beginRun(runId, {
        targetEmployeeId: run.employeeId,
        targetEmployeeName: run.employeeName,
        targetAvatarType: run.employeeAvatarType,
        instruction: run.instruction,
      })
      this.settle(runId, 'cancelled', { error: '已取消', summary: '' })
      return
    }
    run.status = 'running'
    run.startedAt = Math.floor(Date.now() / 1000)
    this.persistRun(run)

    const targetEmployeeId = run.employeeId
    const parentSessionId = run.parentSessionId

    // abort 传播：主管 signal → 本 run controller
    const onParentAbort = () => entry.controller.abort()
    let parentSignal = entry.parentAbortSignal
    if (parentSignal) {
      if (parentSignal.aborted) {
        entry.controller.abort()
      } else {
        parentSignal.addEventListener('abort', onParentAbort, { once: true })
      }
    }

    let beforeSnapshot: Map<string, { size: number; mtime: number }> = new Map()
    let subWorkspace = ''
    let subConvId = ''
    let finalAnswer = ''
    let tokenUsage: AgentRunTokenUsage | undefined
    let subError: string | null = null
    let reportedFiles: GeneratedFileInfo[] = []

    // 临时子智能体：执行前注册 inline 员工（settle 时下线；含追问轮重建）
    if (run.ephemeral) {
      try {
        EmployeeRegistryService.getInstance().registerInlineEmployee(
          EmployeeRegistryService.getInstance().toInlineRegisteredEmployee(run.employeeId, run.ephemeral)
        )
        entry.ephemeralId = run.employeeId
      } catch (err: any) {
        logger.warn(`临时角色注册失败 ${run.employeeId}:`, err?.message || err)
      }
    }

    this.beginRun(runId, {
      targetEmployeeId: run.employeeId,
      targetEmployeeName: run.employeeName,
      targetAvatarType: run.employeeAvatarType,
      instruction: run.instruction,
      followupOfRunId: run.followupOfRunId,
    })

    /** 单轮流式执行（完成门重试会多次调用）；callbacks 闭包复用 finalAnswer 等累积状态 */
    const streamOnce = async (messages: Array<{ role: string; content: string }>, providerId: string, modelId: string) => {
      await interactionContext.run(
        {
          sessionId: generateId(),
          employeeId: targetEmployeeId,
          conversationId: subConvId,
          // 嵌套委托链记录：深度 +1，链上追加发起方员工（防环守卫只在运行时层生效）
          delegationDepth: entry.delegationDepth + 1,
          delegationChain: [...entry.delegationChain, entry.parentEmployeeId],
          parentSessionId,
          delegationId: runId,
          abortSignal: entry.controller.signal,
          enableThinking: entry.enableThinking,
          highPermission: entry.highPermission,
        },
        async () => {
          await EmployeeAgentService.getInstance().chatStream(
            {
              employee_id: targetEmployeeId,
              provider_id: providerId,
              model_id: modelId,
              messages,
              conversation_id: subConvId,
              minimal_mode: false,
              enable_thinking: entry.enableThinking,
              use_skills: true,
              high_permission: entry.highPermission,
            },
            {
              onChunk: (chunk: string) => {
                if (entry.controller.signal.aborted) return
                finalAnswer += chunk
                this.emit(runId, 'chunk', chunk)
              },
              onThought: (thought: string) => {
                if (entry.controller.signal.aborted) return
                this.emit(runId, 'thought', thought)
              },
              onToolCallDelta: (d: any) => {
                if (entry.controller.signal.aborted) return
                this.emit(runId, 'tool_call_delta', d)
              },
              onToolCall: (tc: any) => {
                if (entry.controller.signal.aborted) return
                this.emit(runId, 'tool_call', { ...tc, delegationId: runId })
              },
              onToolResult: (tr: any) => {
                if (entry.controller.signal.aborted) return
                // 产物 L1：被动采集 report_generated_files 声明清单
                if (tr?.name === 'report_generated_files' && Array.isArray(tr.generatedFiles) && tr.generatedFiles.length > 0) {
                  reportedFiles.push(...tr.generatedFiles)
                }
                this.emit(runId, 'tool_result', { ...tr, delegationId: runId })
              },
              onToolProgress: (p: any) => {
                if (entry.controller.signal.aborted) return
                this.emit(runId, 'tool_progress', p)
              },
              onDone: (metadata?: any) => {
                tokenUsage = mergeTokenUsage(tokenUsage, metadata?.tokenUsage)
                this.emit(runId, 'status', { status: entry.controller.signal.aborted ? 'cancelled' : 'completed' })
              },
              onError: (error: string) => {
                subError = error
                this.emit(runId, 'error', { error, delegationId: runId })
              },
            },
            entry.controller.signal
          )
        }
      )
    }

    // 完成门提示词：列出未收尾任务项，要求子员工继续收尾
    const buildGatePrompt = (): string => {
      const open = entry.tasks.filter(t => t.status === 'open' || t.status === 'in_progress')
      return [
        'Completion gate: your task ledger still has unfinished items.',
        ...open.map(t => `- [${t.id}] (${t.status}) ${t.title}`),
        'Open task items until none remain (use task_item_update to mark each completed or blocked), then submit your final Delegation Receipt.',
      ].join('\n')
    }

    try {
      const resolved = await MemoryRefinementService.getInstance().resolveEmployeeLLM()
      if (!resolved) {
        subError = '无可用 LLM 提供商（请在设置中配置默认模型）'
      } else {
        let { providerId, modelId } = resolved
        // 临时角色可选模型覆盖：providerId+modelId 成对才生效（无效则继承主管解析结果）
        if (run.ephemeral?.providerId && run.ephemeral?.modelId) {
          providerId = run.ephemeral.providerId
          modelId = run.ephemeral.modelId
        }
        const ws = WorkspaceManagerService.getInstance()
        if (run.conversationId) {
          // 追问轮：复用原子会话与任务工作区，历史轮上下文注入 messages
          subConvId = run.conversationId
          subWorkspace = ws.getConversationWorkspacePath(subConvId)
        } else {
          const subConv = ws.createConversation(targetEmployeeId, undefined, `委托: ${run.instruction.slice(0, 30)}`, true, run.parentConversationId)
          subConvId = subConv.id
          run.conversationId = subConvId
          subWorkspace = subConv.workspace_path || ''
        }
        // 立即落库 conversation_id：作为追问锚点（应用重启后仍可追问）
        this.persistRun(run)
        if (subWorkspace) {
          beforeSnapshot = this.snapshotWorkspace(subWorkspace)
        }

        // 结构化交付契约（output_schema）：强制子员工调用 submit_structured_result 上报机器可读结果
        const structuredSuffix = run.outputSchema
          ? [
              'Structured output (mandatory): this delegation requires a machine-readable result.',
              'Before your final reply, call the `submit_structured_result` tool ONCE with the complete JSON result conforming EXACTLY to this JSON Schema:',
              JSON.stringify(run.outputSchema),
              'If some fields cannot be filled, still call it with a best-effort object and explain the gaps in the Blockers section of your receipt.',
            ].join('\n\n')
          : ''
        const ledgerSuffix = [
          'Task ledger: the parent may attach task items to this delegation.',
          'If task items were attached, update each one via task_item_update (completed or blocked) before finishing.',
        ].join('\n')

        let subMessages = await this.buildSubMessages(run.instruction, run.contextFiles || [], [structuredSuffix, ledgerSuffix].filter(Boolean).join('\n\n'))
        if (run.followupOfRunId && subConvId) {
          const history = this.loadFollowupHistory(subConvId, run.runId)
          subMessages = [...history, ...subMessages]
        }

        await streamOnce(subMessages, providerId, modelId)

        // 完成门（MiMo 语义）：台账仍有未收尾项时注入纠偏轮，最多 MAX_GATE_ROUNDS 次
        // 第一轮的回答与关键工具产出固化为一条 assistant 上下文置于 gatePrompt 前，纠偏轮才能"续聊"而非失忆
        const buildGateContext = (): Array<{ role: string; content: string }> => {
          const parts: string[] = []
          if (finalAnswer.trim()) parts.push(finalAnswer.trim().slice(0, 4000))
          if (entry.structuredCapture !== undefined && entry.structuredCapture !== null) {
            parts.push(`Structured result: ${JSON.stringify(entry.structuredCapture).slice(0, 2000)}`)
          }
          if (reportedFiles.length) {
            parts.push(`Generated files:\n${reportedFiles.map(f => `- ${f.path}`).join('\n')}`)
          }
          return parts.length ? [{ role: 'assistant', content: ['[First-round progress]', ...parts].join('\n') }] : []
        }
        for (let gate = 0; gate < MAX_GATE_ROUNDS; gate++) {
          if (entry.controller.signal.aborted || subError) break
          if (!entry.tasks.some(t => t.status === 'open' || t.status === 'in_progress')) break
          await streamOnce(
            [...subMessages, ...buildGateContext(), { role: 'user', content: buildGatePrompt() }],
            providerId,
            modelId,
          )
        }
      }
    } catch (err: any) {
      if (!entry.controller.signal.aborted) {
        subError = err?.message || String(err)
        this.emit(runId, 'error', { error: subError, delegationId: runId })
      }
    } finally {
      if (parentSignal) {
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    }

    if (!this.entries.has(runId)) return

    if (entry.controller.signal.aborted) {
      this.settle(runId, 'cancelled', { error: subError || '已取消', summary: finalAnswer.trim().slice(0, 2000), tokenUsage })
      return
    }
    if (subError && !finalAnswer.trim()) {
      this.settle(runId, 'failed', { error: subError, summary: '', tokenUsage })
      return
    }

    // 产物 L2：工作区目录 diff 自动检测（与 L1 去重）
    let autoDetected: GeneratedFileInfo[] = []
    if (subWorkspace && !subError) {
      try {
        autoDetected = this.dedupArtifacts(reportedFiles, this.diffSnapshot(beforeSnapshot, subWorkspace))
      } catch (err: any) {
        logger.warn(`Artifact diff failed for run ${runId}:`, err?.message || err)
      }
    }

    // 子会话中途出错但已产出部分文本：按 completed 结算并保留错误信息，
    // 让主管 LLM 与前端能看到失败原因，而非静默当成功交付
    const summary = finalAnswer.trim() || '(子员工未产出文本)'
    this.settle(runId, 'completed', {
      summary: subError
        ? `${summary}\n\n[执行异常] ${subError}`
        : summary,
      error: subError ?? undefined,
      generatedFiles: reportedFiles,
      autoDetectedFiles: autoDetected,
      tokenUsage,
    })
  }
}

/** tokenUsage 对象级累加：字段级求和，任一侧缺省字段沿用另一方；两侧均无数据返回 undefined */
function mergeTokenUsage(a: AgentRunTokenUsage | undefined, b: AgentRunTokenUsage | undefined): AgentRunTokenUsage | undefined {
  if (!a) return b ? { ...b } : undefined
  if (!b) return a
  const out: AgentRunTokenUsage = { ...a }
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens'] as const) {
    const val = b[key]
    if (val !== undefined) out[key] = (a[key] || 0) + val
  }
  return out
}

function safeParse(json: string): any {
  try {
    return JSON.parse(json || '{}')
  } catch {
    return {}
  }
}

export default SubAgentRuntime
export { MAX_CONTEXT_FILES, MAX_FILE_CHARS }