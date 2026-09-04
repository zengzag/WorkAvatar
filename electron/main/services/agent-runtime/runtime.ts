import fs from 'fs'
import path from 'path'
import type { GeneratedFileInfo, ThinkingLevel } from '../../../shared/types'
import DatabaseService from '../database.service'
import MemoryRefinementService from '../memory-refinement.service'
import WorkspaceManagerService from '../workspace-manager.service'
import EmployeeAgentService from '../employee-agent.service'
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
} from './types'

const logger = createLogger('SubAgentRuntime')

/** context_files 最大数量，防止 LLM 传入过多文件撑爆上下文 */
const MAX_CONTEXT_FILES = 10
/** 单个 context_file 读取上限（字符），防止超大文件 */
const MAX_FILE_CHARS = 8000
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
/** 子会话强制报告条款（拼入子会话指令） */
const SUBAGENT_REPORT_RULE =
  '重要：如果本任务产生了用户可直接消费的成品文件（文档/表格/演示/PDF/图片/代码工程等），必须在最终回复前调用 report_generated_files 工具逐一声明其绝对路径，即使最终总结中不再提及。'

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
  /** 平级协作邮箱：send_message 写、read_messages 读 */
  inbox: Array<{ id: string; fromEmployeeName: string; content: string; sentAt: number }>
}

function isTerminal(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/** 把 run 结构化为可供主管 LLM 消费的结果（文本 + 结构化字段） */
export function formatRunOutput(run: AgentRun): string {
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

  private async buildSubMessages(instruction: string, contextFiles: string[]): Promise<Array<{ role: string; content: string }>> {
    let content = `${instruction.trim()}\n\n${SUBAGENT_REPORT_RULE}\n\n若主管通过 send_message 发送了补充指令，可调用 read_messages 查看最新要求。`
    if (contextFiles.length > 0) {
      const parts: string[] = [content, '', '--- 上下文文件 ---']
      for (const fp of contextFiles) {
        try {
          const text = await fs.promises.readFile(fp, 'utf-8')
          parts.push(`\n[文件: ${fp}]\n${text.slice(0, MAX_FILE_CHARS)}`)
        } catch {
          parts.push(`\n[文件: ${fp}]\n(读取失败)`)
        }
      }
      content = parts.join('\n')
    }
    return [{ role: 'user', content }]
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

  private emit(runId: string, eventType: string, data: any): void {
    const entry = this.entries.get(runId)
    if (!entry) return
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
      const inputs = { instruction: run.instruction, contextFiles: run.contextFiles }
      const result: any = {
        summary: run.summary,
        generatedFiles: run.generatedFiles,
        autoDetectedFiles: run.autoDetectedFiles,
      }
      const existing = db.prepare('SELECT run_id FROM sub_agent_runs WHERE run_id = ?').get(run.runId) as { run_id: string } | undefined
      if (existing) {
        db.prepare(
          `UPDATE sub_agent_runs SET parent_conversation_id = ?, employee_id = ?, parent_run_id = ?, status = ?,
             inputs_json = ?, result_json = ?, usage_json = ?, error = ?, started_at = ?, ended_at = ? WHERE run_id = ?`
        ).run(
          run.parentConversationId, run.employeeId, run.parentRunId || '', run.status,
          JSON.stringify(inputs), JSON.stringify(result), JSON.stringify(run.tokenUsage || {}),
          run.error || '', run.startedAt || null, run.endedAt || null, run.runId,
        )
      } else {
        db.prepare(
          `INSERT INTO sub_agent_runs (run_id, parent_conversation_id, employee_id, parent_run_id, status,
             inputs_json, result_json, usage_json, error, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          run.runId, run.parentConversationId, run.employeeId, run.parentRunId || '', run.status,
          JSON.stringify(inputs), JSON.stringify(result), JSON.stringify(run.tokenUsage || {}),
          run.error || '', run.startedAt || null, run.endedAt || null,
        )
      }
    } catch (err: any) {
      logger.warn(`Failed to persist run ${run.runId}:`, err?.message || err)
    }
  }

  private launchInternal(input: LaunchSubAgentInput): LaunchSubAgentResult {
    const db = DatabaseService.getInstance().getDb()
    const target = db.prepare('SELECT id, name, avatar_type FROM employees WHERE id = ?').get(input.targetEmployeeId) as
      | { id: string; name: string; avatar_type?: string }
      | undefined
    const targetName = target?.name || input.targetEmployeeId

    // 递归防护
    if (input.delegationDepth >= 3) {
      return { success: false, error: `委托深度超限（上限 3 层，当前 ${input.delegationDepth}）`, targetEmployeeName: targetName }
    }
    if (input.delegationChain.includes(input.targetEmployeeId)) {
      return { success: false, error: '检测到委托环：目标员工已在委托链中', targetEmployeeName: targetName }
    }
    if (input.targetEmployeeId === input.parentEmployeeId) {
      return { success: false, error: '不能委托给自己', targetEmployeeName: targetName }
    }
    if (!target) {
      return { success: false, error: `目标员工不存在: ${input.targetEmployeeId}`, targetEmployeeName: targetName }
    }

    const runId = generateId()
    const run: AgentRun = {
      runId,
      parentConversationId: input.parentConversationId,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      employeeId: input.targetEmployeeId,
      employeeName: target.name,
      employeeAvatarType: target.avatar_type,
      status: 'queued',
      instruction: input.instruction,
      contextFiles: input.contextFiles,
      generatedFiles: [],
      autoDetectedFiles: [],
    }

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
      inbox: [],
    }
    this.entries.set(runId, entry)
    this.persistRun(run)
    this.queue.push(runId)
    this.kickQueue()
    return { success: true, runId, targetEmployeeName: target.name }
  }

  /** 派发一个子会话运行。校验失败返回 error；成功立即返回 runId（异步排队执行） */
  launchSubAgent(input: LaunchSubAgentInput): LaunchSubAgentResult {
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
      return {
        runId: run.runId,
        employeeName: run.employeeName,
        status: run.status,
        success: true,
        output: formatRunOutput(run),
        tokenUsage: run.tokenUsage,
        result: {
          summary: run.summary || '',
          generatedFiles: run.generatedFiles,
          autoDetectedFiles: run.autoDetectedFiles,
          tokenUsage: run.tokenUsage,
        },
      }
    }
    if (run.status === 'cancelled') {
      return { runId: run.runId, employeeName: run.employeeName, status: run.status, success: false, error: run.error || '已取消' }
    }
    return { runId: run.runId, employeeName: run.employeeName, status: run.status, success: false, error: run.error || '执行失败' }
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
      result.push({ ...run, eventLog: [...entry.eventLog] })
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
          summary: result.summary,
          generatedFiles: result.generatedFiles || [],
          autoDetectedFiles: result.autoDetectedFiles || [],
          tokenUsage: usage,
          error: r.error || undefined,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          eventLog: [],
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

    this.beginRun(runId, {
      targetEmployeeId: run.employeeId,
      targetEmployeeName: run.employeeName,
      targetAvatarType: run.employeeAvatarType,
      instruction: run.instruction,
    })

    try {
      const resolved = await MemoryRefinementService.getInstance().resolveEmployeeLLM()
      if (!resolved) {
        subError = '无可用 LLM 提供商（请在设置中配置默认模型）'
      } else {
        const { providerId, modelId } = resolved
        const ws = WorkspaceManagerService.getInstance()
        const subConv = ws.createConversation(targetEmployeeId, undefined, `委托: ${run.instruction.slice(0, 30)}`, true, run.parentConversationId)
        subConvId = subConv.id
        run.conversationId = subConvId
        subWorkspace = subConv.workspace_path || ''
        if (subWorkspace) {
          beforeSnapshot = this.snapshotWorkspace(subWorkspace)
        }

        const subMessages = await this.buildSubMessages(run.instruction, run.contextFiles || [])

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
                messages: subMessages,
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
                  tokenUsage = metadata?.tokenUsage
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

    const summary = finalAnswer.trim() || '(子员工未产出文本)'
    this.settle(runId, 'completed', {
      summary,
      generatedFiles: reportedFiles,
      autoDetectedFiles: autoDetected,
      tokenUsage,
    })
  }
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