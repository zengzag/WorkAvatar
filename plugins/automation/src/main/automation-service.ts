/**
 * 自动化服务（由宿主 electron/main/services/automation/automation.service.ts 迁移而来）。
 * 差异点：
 * - DB 改为插件分库（ctx.storage.openSqlite('index')），automation_tasks / automation_runs 表在建库时自建
 * - 任务执行改用 ctx.services.agent.chatStream（底层 EmployeeAgentService.chatStream，精细控制 provider/model/high_permission 等）
 * - 通知改用 ctx.services.notification
 * - conversation 删除双向同步：订阅 ctx.services.conversations.onDeleted 清理关联 run 记录
 * - logger 用 ctx.services.logger，id 用本地 generateId()
 */
import * as crypto from 'crypto'
import type { PluginContext, PluginDatabase } from '../../../plugin-sdk/src'

function generateId(): string {
  return crypto.randomBytes(12).toString('hex')
}

/** 插件库两张表 + plugin_kv 的幂等建表 DDL（迁移与服务初始化共用） */
export function ensureAutomationTables(db: PluginDatabase): void {
  db.exec('CREATE TABLE IF NOT EXISTS plugin_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      prompt TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT,
      high_permission INTEGER NOT NULL DEFAULT 0,
      start_at INTEGER NOT NULL,
      recurrence_rule TEXT DEFAULT '',
      is_enabled INTEGER NOT NULL DEFAULT 1,
      notify_on_complete INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      tags_json TEXT DEFAULT '[]',
      last_run_at INTEGER,
      next_run_at INTEGER,
      last_status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_automation_tasks_enabled ON automation_tasks(is_enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_automation_tasks_employee ON automation_tasks(employee_id);
    CREATE INDEX IF NOT EXISTS idx_automation_tasks_status ON automation_tasks(last_status);

    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES automation_tasks(id) ON DELETE CASCADE,
      conversation_id TEXT,
      employee_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      triggered_by TEXT NOT NULL DEFAULT 'scheduler',
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration_ms INTEGER,
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_automation_runs_task ON automation_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_conv ON automation_runs(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(status);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_started ON automation_runs(started_at DESC);
  `)
}

// ====== 类型定义 ======

export type AutomationTaskStatus = 'idle' | 'running' | 'success' | 'failed'
export type AutomationRunStatus = 'running' | 'success' | 'failed'
export type AutomationTriggeredBy = 'scheduler' | 'manual'

export interface AutomationRecurrenceRule {
  freq: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  count?: number
  until?: number
}

export interface AutomationTask {
  id: string
  title: string
  description: string
  prompt: string
  employee_id: string
  provider_id: string
  model_id: string | null
  high_permission: boolean
  start_at: number
  recurrence_rule: AutomationRecurrenceRule | null
  is_enabled: boolean
  notify_on_complete: boolean
  retry_count: number
  tags: string[]
  last_run_at: number | null
  next_run_at: number | null
  last_status: AutomationTaskStatus
  last_error: string | null
  created_at: number
  updated_at: number
}

export interface AutomationRun {
  id: string
  task_id: string
  conversation_id: string | null
  employee_id: string
  provider_id: string
  model_id: string | null
  status: AutomationRunStatus
  triggered_by: AutomationTriggeredBy
  started_at: number
  finished_at: number | null
  duration_ms: number | null
  error_message: string | null
  created_at: number
}

export interface CreateAutomationTaskInput {
  title: string
  description?: string
  prompt: string
  employee_id: string
  provider_id: string
  model_id?: string | null
  high_permission?: boolean
  start_at: number
  recurrence_rule?: AutomationRecurrenceRule | null
  is_enabled?: boolean
  notify_on_complete?: boolean
  retry_count?: number
  tags?: string[]
}

export interface UpdateAutomationTaskInput {
  id: string
  title?: string
  description?: string
  prompt?: string
  employee_id?: string
  provider_id?: string
  model_id?: string | null
  high_permission?: boolean
  start_at?: number
  recurrence_rule?: AutomationRecurrenceRule | null
  is_enabled?: boolean
  notify_on_complete?: boolean
  retry_count?: number
  tags?: string[]
}

export interface ListAutomationTasksParams {
  employee_id?: string
  is_enabled?: boolean
  tag?: string
  search?: string
}

export interface ListAutomationRunsParams {
  task_id?: string
  employee_id?: string
  status?: AutomationRunStatus | AutomationRunStatus[]
  triggered_by?: AutomationTriggeredBy
  from?: number
  to?: number
  limit?: number
}

const MAX_PREVIEW = 10
const MAX_RETRY_ATTEMPTS = 3
const TASK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000

// ====== 服务实现 ======

class AutomationService {
  private db: PluginDatabase
  private ctx: PluginContext

  constructor(ctx: PluginContext) {
    this.ctx = ctx
    this.db = ctx.storage.openSqlite('index')
    // 幂等建表：迁移可能因 legacy 为空而提前返回，此处兜底确保表存在
    ensureAutomationTables(this.db)
  }

  getDb(): PluginDatabase {
    return this.db
  }

  /** 广播数据变更事件给所有渲染窗口（供 agent 工具与 IPC handler 共用） */
  broadcastDataChanged(scope: 'task' | 'run' | 'settings'): void {
    this.ctx.ipc.broadcast('data-changed', { scope, ts: Date.now() })
  }

  // ====== Tasks CRUD ======

  listTasks(params: ListAutomationTasksParams = {}): AutomationTask[] {
    const conditions: string[] = []
    const args: any[] = []
    if (params.employee_id) {
      conditions.push('employee_id = ?')
      args.push(params.employee_id)
    }
    if (params.is_enabled !== undefined) {
      conditions.push('is_enabled = ?')
      args.push(params.is_enabled ? 1 : 0)
    }
    if (params.tag) {
      conditions.push("tags_json LIKE ? ESCAPE '\\'")
      args.push(`%"${params.tag.replace(/[%_\\]/g, '\\$&')}"%`)
    }
    if (params.search) {
      conditions.push('(title LIKE ? OR description LIKE ? OR prompt LIKE ?)')
      const kw = `%${params.search.replace(/[%_\\]/g, '\\$&')}%`
      args.push(kw, kw, kw)
    }
    let sql = 'SELECT * FROM automation_tasks'
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
    sql += ' ORDER BY is_enabled DESC, COALESCE(next_run_at, start_at) ASC, created_at DESC'
    const rows = this.db.prepare(sql).all(...args) as any[]
    return rows.map((r) => this.rowToTask(r))
  }

  getTask(id: string): AutomationTask | null {
    const row = this.db.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(id) as any
    return row ? this.rowToTask(row) : null
  }

  createTask(input: CreateAutomationTaskInput): AutomationTask {
    if (!input.title?.trim()) throw new Error('title 必填')
    if (!input.prompt?.trim()) throw new Error('prompt 必填')
    if (!input.employee_id) throw new Error('employee_id 必填')
    if (!input.provider_id) throw new Error('provider_id 必填')
    if (typeof input.start_at !== 'number') throw new Error('start_at 必填')

    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    const rule = input.recurrence_rule ?? null
    const ruleJson = rule ? JSON.stringify(rule) : ''
    const retryCount = Math.max(0, Math.min(MAX_RETRY_ATTEMPTS, Math.floor(input.retry_count ?? 0)))
    const nextRunAt = input.is_enabled === false ? null : this.computeNextRunAfter(rule, input.start_at, input.start_at, now)

    this.db.prepare(
      `INSERT INTO automation_tasks
        (id, title, description, prompt, employee_id, provider_id, model_id, high_permission,
         start_at, recurrence_rule, is_enabled, notify_on_complete, retry_count, tags_json,
         last_run_at, next_run_at, last_status, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'idle', NULL, ?, ?)`
    ).run(
      id, input.title.trim(), input.description || '', input.prompt,
      input.employee_id, input.provider_id, input.model_id ?? null, input.high_permission ? 1 : 0,
      input.start_at, ruleJson, input.is_enabled === false ? 0 : 1,
      input.notify_on_complete ? 1 : 0, retryCount, JSON.stringify(input.tags || []),
      nextRunAt, now, now
    )

    this.ctx.services.logger.info(`Task created: ${id} "${input.title}"`)
    return this.getTask(id)!
  }

  updateTask(input: UpdateAutomationTaskInput): AutomationTask | null {
    const existing = this.getTask(input.id)
    if (!existing) return null
    if (existing.last_status === 'running') {
      const blocked = ['prompt', 'employee_id', 'provider_id', 'model_id',
        'recurrence_rule', 'start_at', 'retry_count', 'high_permission']
      if (blocked.some(k => (input as any)[k] !== undefined)) {
        throw new Error('Task is running, cannot modify execution-critical fields')
      }
    }
    const now = Math.floor(Date.now() / 1000)

    const sets: string[] = []
    const args: any[] = []
    const pushSet = (col: string, val: any) => {
      sets.push(`${col} = ?`)
      args.push(val)
    }

    if (input.title !== undefined) pushSet('title', input.title.trim())
    if (input.description !== undefined) pushSet('description', input.description)
    if (input.prompt !== undefined) pushSet('prompt', input.prompt)
    if (input.employee_id !== undefined) pushSet('employee_id', input.employee_id)
    if (input.provider_id !== undefined) pushSet('provider_id', input.provider_id)
    if (input.model_id !== undefined) pushSet('model_id', input.model_id ?? null)
    if (input.high_permission !== undefined) pushSet('high_permission', input.high_permission ? 1 : 0)
    if (input.notify_on_complete !== undefined) pushSet('notify_on_complete', input.notify_on_complete ? 1 : 0)
    if (input.retry_count !== undefined) pushSet('retry_count', Math.max(0, Math.min(MAX_RETRY_ATTEMPTS, Math.floor(input.retry_count))))
    if (input.tags !== undefined) pushSet('tags_json', JSON.stringify(input.tags))

    let needRecompute = false
    let newRule: AutomationRecurrenceRule | null = existing.recurrence_rule
    let newStartAt = existing.start_at
    if (input.recurrence_rule !== undefined) {
      newRule = input.recurrence_rule
      pushSet('recurrence_rule', newRule ? JSON.stringify(newRule) : '')
      needRecompute = true
    }
    if (input.start_at !== undefined) {
      newStartAt = input.start_at
      pushSet('start_at', input.start_at)
      needRecompute = true
    }
    if (input.is_enabled !== undefined) {
      pushSet('is_enabled', input.is_enabled ? 1 : 0)
      if (input.is_enabled) needRecompute = true
      else pushSet('next_run_at', null)
    }
    if (needRecompute) {
      const willEnable = input.is_enabled === undefined ? existing.is_enabled : input.is_enabled
      if (willEnable && existing.last_status !== 'running') {
        const next = this.computeNextRunAfter(newRule, newStartAt, newStartAt, now)
        pushSet('next_run_at', next)
      }
    }

    sets.push('updated_at = ?')
    args.push(now, input.id)
    this.db.prepare(`UPDATE automation_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args)
    return this.getTask(input.id)
  }

  async deleteTask(id: string): Promise<boolean> {
    const task = this.getTask(id)
    if (task?.last_status === 'running') {
      throw new Error('Task is running, cannot delete')
    }
    // 先级联删除关联的 conversations（automation_runs 由 ON DELETE CASCADE 自动删除）
    const runs = this.db.prepare('SELECT conversation_id FROM automation_runs WHERE task_id = ? AND conversation_id IS NOT NULL').all(id) as any[]
    for (const r of runs) {
      if (r.conversation_id) {
        try { await this.deleteConversation(r.conversation_id) } catch { /* ignore */ }
      }
    }
    const result = this.db.prepare('DELETE FROM automation_tasks WHERE id = ?').run(id)
    return result.changes > 0
  }

  toggleTask(id: string, enabled: boolean): AutomationTask | null {
    const task = this.getTask(id)
    if (!task) return null
    const now = Math.floor(Date.now() / 1000)
    let nextRunAt: number | null = null
    if (enabled && task.last_status !== 'running') {
      nextRunAt = this.computeNextRunAfter(task.recurrence_rule, task.start_at, task.start_at, now)
    }
    this.db.prepare(
      'UPDATE automation_tasks SET is_enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?'
    ).run(enabled ? 1 : 0, nextRunAt, now, id)
    return this.getTask(id)
  }

  async moveTask(id: string, targetEmployeeId: string): Promise<AutomationTask | null> {
    const task = this.getTask(id)
    if (!task) return null
    if (task.last_status === 'running') {
      throw new Error('Task is running, cannot move')
    }
    const now = Math.floor(Date.now() / 1000)
    const runs = this.db.prepare(
      'SELECT conversation_id FROM automation_runs WHERE task_id = ? AND conversation_id IS NOT NULL'
    ).all(id) as { conversation_id: string }[]
    this.db.transaction(() => {
      this.db.prepare(
        'UPDATE automation_tasks SET employee_id = ?, updated_at = ? WHERE id = ?'
      ).run(targetEmployeeId, now, id)
    })()
    for (const r of runs) {
      if (r.conversation_id) {
        try { await this.updateConversationEmployee(r.conversation_id, targetEmployeeId) } catch { /* ignore */ }
      }
    }
    this.ctx.services.logger.info(`Task ${id} moved to employee ${targetEmployeeId}`)
    return this.getTask(id)
  }

  // ====== Runs CRUD ======

  listRuns(params: ListAutomationRunsParams = {}): AutomationRun[] {
    const conditions: string[] = []
    const args: any[] = []
    if (params.task_id) {
      conditions.push('task_id = ?')
      args.push(params.task_id)
    }
    if (params.employee_id) {
      conditions.push('employee_id = ?')
      args.push(params.employee_id)
    }
    if (params.status) {
      if (Array.isArray(params.status)) {
        if (params.status.length > 0) {
          conditions.push(`status IN (${params.status.map(() => '?').join(',')})`)
          args.push(...params.status)
        }
      } else {
        conditions.push('status = ?')
        args.push(params.status)
      }
    }
    if (params.triggered_by) {
      conditions.push('triggered_by = ?')
      args.push(params.triggered_by)
    }
    if (params.from !== undefined) {
      conditions.push('started_at >= ?')
      args.push(params.from)
    }
    if (params.to !== undefined) {
      conditions.push('started_at <= ?')
      args.push(params.to)
    }
    let sql = 'SELECT * FROM automation_runs'
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
    sql += ' ORDER BY started_at DESC'
    if (params.limit) {
      sql += ' LIMIT ?'
      args.push(params.limit)
    }
    const rows = this.db.prepare(sql).all(...args) as any[]
    return rows.map((r) => this.rowToRun(r))
  }

  async deleteRun(id: string): Promise<boolean> {
    const row = this.db.prepare('SELECT conversation_id, status FROM automation_runs WHERE id = ?').get(id) as any
    if (!row) return false
    if (row.status === 'running') {
      throw new Error('Run is in progress, cannot delete')
    }
    if (row.conversation_id) {
      try { await this.deleteConversation(row.conversation_id) } catch { /* ignore */ }
    }
    const result = this.db.prepare('DELETE FROM automation_runs WHERE id = ?').run(id)
    return result.changes > 0
  }

  async clearRuns(taskId?: string): Promise<number> {
    const rows = taskId
      ? this.db.prepare('SELECT conversation_id FROM automation_runs WHERE task_id = ? AND conversation_id IS NOT NULL AND status != ?').all(taskId, 'running') as any[]
      : this.db.prepare('SELECT conversation_id FROM automation_runs WHERE conversation_id IS NOT NULL AND status != ?').all('running') as any[]
    for (const r of rows) {
      if (r.conversation_id) {
        try { await this.deleteConversation(r.conversation_id) } catch { /* ignore */ }
      }
    }
    const result = taskId
      ? this.db.prepare('DELETE FROM automation_runs WHERE task_id = ? AND status != ?').run(taskId, 'running')
      : this.db.prepare('DELETE FROM automation_runs WHERE status != ?').run('running')
    return result.changes
  }

  /** 删除指定 conversation 关联的 run（conversation 删除双向同步用） */
  deleteRunByConversation(conversationId: string): number {
    const result = this.db.prepare('DELETE FROM automation_runs WHERE conversation_id = ?').run(conversationId)
    return result.changes
  }

  /** 模型重命名同步：更新任务与执行历史中的 model_id（内核 model-renamed 事件触发） */
  syncModelRenames(providerId: string, renames: Record<string, string>): void {
    for (const [oldModel, newModel] of Object.entries(renames)) {
      this.db.prepare('UPDATE automation_tasks SET model_id = ?, updated_at = unixepoch() WHERE provider_id = ? AND model_id = ?')
        .run(newModel, providerId, oldModel)
      this.db.prepare('UPDATE automation_runs SET model_id = ? WHERE provider_id = ? AND model_id = ?')
        .run(newModel, providerId, oldModel)
    }
  }

  // ====== 调度支持 ======

  listDueTaskIds(now: number, limit: number): string[] {
    const rows = this.db.prepare(
      `SELECT id FROM automation_tasks
       WHERE is_enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         AND (last_status IS NULL OR last_status != 'running')
       ORDER BY next_run_at ASC
       LIMIT ?`
    ).all(now, Math.max(1, limit)) as { id: string }[]
    return rows.map((r) => r.id)
  }

  async recoverOrphanRuns(): Promise<{ tasks: number; runs: number }> {
    const now = Math.floor(Date.now() / 1000)
    const orphanRuns = this.db.prepare(
      `SELECT id, conversation_id FROM automation_runs WHERE status = 'running' AND conversation_id IS NOT NULL`
    ).all() as { id: string; conversation_id: string }[]

    const taskRes = this.db.prepare(
      `UPDATE automation_tasks SET last_status = 'failed', last_error = 'orphan recovered on startup', updated_at = ? WHERE last_status = 'running'`
    ).run(now)
    const runRes = this.db.prepare(
      `UPDATE automation_runs SET status = 'failed', finished_at = ?, error_message = 'orphan recovered on startup' WHERE status = 'running'`
    ).run(now)

    for (const r of orphanRuns) {
      try { await this.deleteConversation(r.conversation_id) } catch { /* ignore */ }
      this.db.prepare('UPDATE automation_runs SET conversation_id = NULL WHERE id = ?').run(r.id)
    }

    return { tasks: taskRes.changes, runs: runRes.changes }
  }

  // ====== 调度计算 ======

  computeNextRunAfter(rule: AutomationRecurrenceRule | null, startAt: number, after: number, now: number): number | null {
    if (!rule) {
      return startAt > now ? startAt : null
    }
    const interval = Math.max(1, rule.interval)
    const until = rule.until ?? Infinity
    const maxIterations = 500
    let cursor = this.fastForwardCursor(startAt, Math.max(after, now - 1), rule, interval)
    let iter = 0
    while (iter < maxIterations) {
      iter++
      if (cursor > after && cursor > now - 1) {
        if (cursor > until) return null
        return cursor
      }
      if (cursor > until) return null
      const next = this.advanceRecurrence(cursor, rule, interval)
      if (next === cursor) return null
      cursor = next
    }
    return null
  }

  private fastForwardCursor(startAt: number, target: number, rule: AutomationRecurrenceRule, interval: number): number {
    if (startAt >= target) return startAt
    const diffSec = target - startAt
    switch (rule.freq) {
      case 'daily':
        return startAt + Math.floor(diffSec / (interval * 86400)) * interval * 86400
      case 'weekly':
        return startAt + Math.floor(diffSec / (interval * 7 * 86400)) * interval * 7 * 86400
      case 'weekdays': {
        const chunkSec = interval * 7 * 86400
        return startAt + Math.floor(diffSec / chunkSec) * chunkSec
      }
      case 'monthly': {
        const startDate = new Date(startAt * 1000)
        const targetDate = new Date(target * 1000)
        const monthsDiff = (targetDate.getFullYear() - startDate.getFullYear()) * 12 + (targetDate.getMonth() - startDate.getMonth())
        const skipMonths = Math.max(0, (Math.floor(monthsDiff / interval) - 1) * interval)
        if (skipMonths <= 0) return startAt
        const skipped = this.addMonths(startDate, skipMonths)
        return Math.floor(skipped.getTime() / 1000)
      }
      case 'yearly': {
        const startDate = new Date(startAt * 1000)
        const targetDate = new Date(target * 1000)
        const yearsDiff = targetDate.getFullYear() - startDate.getFullYear()
        const skipYears = Math.max(0, (Math.floor(yearsDiff / interval) - 1) * interval)
        if (skipYears <= 0) return startAt
        const skipped = this.addYears(startDate, skipYears)
        return Math.floor(skipped.getTime() / 1000)
      }
      default:
        return startAt
    }
  }

  previewNextRuns(task: AutomationTask, count: number = 5): number[] {
    const n = Math.max(1, Math.min(MAX_PREVIEW, count))
    const result: number[] = []
    const now = Math.floor(Date.now() / 1000)
    const rule = task.recurrence_rule
    let cursor = task.start_at
    const until = rule?.until ?? Infinity
    const maxRuns = rule?.count && rule.count > 0 ? rule.count : Infinity
    const maxIterations = 200
    let iter = 0
    while (result.length < n && result.length < maxRuns && iter < maxIterations) {
      iter++
      if (cursor > until) break
      if (cursor > now - 1) {
        result.push(cursor)
      }
      if (!rule) break
      const next = this.advanceRecurrence(cursor, rule, Math.max(1, rule.interval))
      if (next === cursor) break
      cursor = next
    }
    return result
  }

  private addMonths(date: Date, months: number): Date {
    const originalDay = date.getDate()
    const result = new Date(date)
    result.setMonth(result.getMonth() + months)
    if (result.getDate() !== originalDay) {
      result.setDate(0)
    }
    return result
  }

  private addYears(date: Date, years: number): Date {
    const originalMonth = date.getMonth()
    const result = new Date(date)
    result.setFullYear(result.getFullYear() + years)
    if (result.getMonth() !== originalMonth) {
      result.setMonth(originalMonth + 1, 0)
    }
    return result
  }

  private advanceRecurrence(current: number, rule: AutomationRecurrenceRule, interval: number): number {
    const date = new Date(current * 1000)
    switch (rule.freq) {
      case 'daily':
        return current + interval * 86400
      case 'weekdays': {
        let next = current + 86400
        let stepped = 0
        while (stepped < interval) {
          const d = new Date(next * 1000)
          const day = d.getDay()
          if (day !== 0 && day !== 6) stepped++
          if (stepped < interval) next += 86400
        }
        return next
      }
      case 'weekly':
        return current + interval * 7 * 86400
      case 'monthly': {
        const d = this.addMonths(date, interval)
        return Math.floor(d.getTime() / 1000)
      }
      case 'yearly': {
        const d = this.addYears(date, interval)
        return Math.floor(d.getTime() / 1000)
      }
      default:
        return current
    }
  }

  // ====== 任务执行 ======

  async runTask(taskId: string, triggeredBy: AutomationTriggeredBy): Promise<AutomationRun | null> {
    const task = this.getTask(taskId)
    if (!task) {
      this.ctx.services.logger.warn(`runTask: task not found: ${taskId}`)
      return null
    }
    const now = Math.floor(Date.now() / 1000)
    const acquired = this.db.prepare(
      `UPDATE automation_tasks SET last_status = 'running', updated_at = ?
       WHERE id = ? AND (last_status IS NULL OR last_status != 'running')`
    ).run(now, taskId)
    if (acquired.changes === 0) {
      this.ctx.services.logger.info(`Task ${taskId} is still running, skip this trigger`)
      return null
    }

    return await this.executeOnce(task, triggeredBy, 0)
  }

  private async executeOnce(task: AutomationTask, triggeredBy: AutomationTriggeredBy, attempt: number): Promise<AutomationRun> {
    const now = Math.floor(Date.now() / 1000)
    const titleTime = this.formatRunTitleTime(now)
    const convTitle = `自动化-${task.title}-${titleTime}`

    let conv: any = null
    let runId: string | null = null
    let nextRunAt: number | null = null
    let willDisable = false

    try {
      nextRunAt = triggeredBy === 'scheduler'
        ? this.computeNextRunAfter(task.recurrence_rule, task.start_at, now, now)
        : task.next_run_at
      willDisable = !task.recurrence_rule && (nextRunAt === null || (task.next_run_at !== null && task.next_run_at <= now))
      if (task.recurrence_rule?.count && task.recurrence_rule.count > 0) {
        const successCount = (this.db.prepare(
          `SELECT COUNT(*) as cnt FROM automation_runs WHERE task_id = ? AND status = 'success'`
        ).get(task.id) as { cnt: number }).cnt
        if (successCount + 1 >= task.recurrence_rule.count) {
          willDisable = true
          nextRunAt = null
        }
      }

      runId = generateId()
      const tx = this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO automation_runs
            (id, task_id, conversation_id, employee_id, provider_id, model_id,
             status, triggered_by, started_at, finished_at, duration_ms, error_message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, NULL, NULL, NULL, ?)`
        ).run(runId, task.id, conv.id, task.employee_id, task.provider_id, task.model_id, triggeredBy, now, now)

        this.db.prepare(
          `UPDATE automation_tasks
           SET last_run_at = ?, next_run_at = ?, last_status = 'running', last_error = NULL,
               is_enabled = ?, updated_at = ?
           WHERE id = ?`
        ).run(now, nextRunAt, willDisable ? 0 : task.is_enabled ? 1 : 0, now, task.id)
      })
      // conversation 创建/写入走内核（async 桥），与插件库事务分离
      conv = await this.createConversation(task.employee_id, convTitle)
      const userMessage = {
        id: `msg_${generateId()}`,
        role: 'user',
        content: task.prompt,
        timestamp: Date.now(),
      }
      await this.updateConversation(conv.id, {
        messages_json: JSON.stringify([userMessage]),
        message_count: 1,
        last_message_at: now,
      })
      tx()

      this.ctx.services.logger.info(`Task ${task.id} run ${runId} started (attempt ${attempt + 1}, by ${triggeredBy})`)
    } catch (initErr: any) {
      this.ctx.services.logger.error(`Task ${task.id} failed to initialize: ${initErr?.message || initErr}`)
      if (conv?.id) {
        try { this.deleteConversation(conv.id) } catch { /* ignore */ }
      }
      throw initErr
    }

    const startMs = Date.now()
    let assistantContent = ''
    let thinkContent = ''
    let errorMsg: string | null = null

    try {
      const agent = this.ctx.services.agent!
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TASK_EXECUTION_TIMEOUT_MS)
      try {
        await agent.chatStream(
          {
            employeeId: task.employee_id,
            providerId: task.provider_id,
            modelId: task.model_id || undefined,
            messages: [{ role: 'user', content: task.prompt }],
            conversationId: conv!.id,
            useSkills: true,
            enableThinking: false,
            minimalMode: false,
            highPermission: task.high_permission,
          },
          {
            onChunk: (chunk: string) => { assistantContent += chunk },
            onThought: (thought: string) => { thinkContent += thought },
            onError: (err: string) => { errorMsg = err },
          },
          controller.signal
        )
      } finally {
        clearTimeout(timer)
      }
    } catch (err: any) {
      errorMsg = err?.name === 'AbortError'
        ? `Task execution timeout after ${TASK_EXECUTION_TIMEOUT_MS / 60000} minutes`
        : (err?.message || String(err))
    }

    const finishedAt = Math.floor(Date.now() / 1000)
    const durationMs = Date.now() - startMs
    const success = !errorMsg && assistantContent.trim().length > 0

    try {
      if (success) {
        const assistantMessage = {
          id: `msg_${generateId()}`,
          role: 'assistant',
          content: assistantContent,
          reasoning_content: thinkContent || undefined,
          timestamp: Date.now(),
        }
        const finalMessages = [
          { id: `msg_${generateId()}`, role: 'user', content: task.prompt, timestamp: startMs },
          assistantMessage,
        ]

        await this.updateConversation(conv!.id, {
          messages_json: JSON.stringify(finalMessages),
          message_count: finalMessages.length,
          last_message_at: finishedAt,
        })
        const tx = this.db.transaction(() => {
          this.db.prepare(
            `UPDATE automation_runs SET status = 'success', finished_at = ?, duration_ms = ?, error_message = NULL WHERE id = ?`
          ).run(finishedAt, durationMs, runId)
          this.db.prepare(
            `UPDATE automation_tasks SET last_status = 'success', last_error = NULL, updated_at = ? WHERE id = ?`
          ).run(finishedAt, task.id)
        })
        tx()

        this.ctx.services.logger.info(`Task ${task.id} run ${runId} success in ${durationMs}ms`)

        if (task.notify_on_complete) {
          this.sendNotification(task, 'success', durationMs, undefined, conv!.id, task.employee_id)
        }
        return this.getRun(runId!)!
      }

      const shouldRetry = attempt < task.retry_count && attempt < MAX_RETRY_ATTEMPTS

      const tx = this.db.transaction(() => {
        this.db.prepare(
          `UPDATE automation_runs SET status = 'failed', finished_at = ?, duration_ms = ?, error_message = ? WHERE id = ?`
        ).run(finishedAt, durationMs, errorMsg || 'Unknown error', runId)

        const taskError = shouldRetry
          ? `Attempt ${attempt + 1} failed: ${errorMsg || 'Unknown error'}, retrying...`
          : (errorMsg || 'Unknown error')
        this.db.prepare(
          `UPDATE automation_tasks SET last_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`
        ).run(taskError, finishedAt, task.id)
      })
      tx()

      this.ctx.services.logger.warn(`Task ${task.id} run ${runId} failed: ${errorMsg}`)

      if (shouldRetry) {
        const waitMs = Math.min(30000, 2000 * Math.pow(2, attempt))
        this.ctx.services.logger.info(`Task ${task.id} retrying in ${waitMs}ms (attempt ${attempt + 2}/${task.retry_count + 1})`)
        await new Promise(resolve => {
          const t = setTimeout(resolve, waitMs)
          if (t.unref) t.unref()
        })
        const refreshed = this.getTask(task.id)
        if (refreshed) {
          return await this.executeOnce(refreshed, triggeredBy, attempt + 1)
        }
      }

      if (task.notify_on_complete) {
        this.sendNotification(task, 'failed', durationMs, errorMsg || undefined, conv!.id, task.employee_id)
      }
    } catch (finalizeErr: any) {
      this.ctx.services.logger.error(`Task ${task.id} failed to finalize run ${runId}: ${finalizeErr?.message || finalizeErr}`)
    }

    return this.getRun(runId!)!
  }

  private getRun(id: string): AutomationRun | null {
    const row = this.db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as any
    return row ? this.rowToRun(row) : null
  }

  private sendNotification(
    task: AutomationTask,
    result: 'success' | 'failed',
    durationMs: number,
    error?: string,
    conversationId?: string,
    employeeId?: string,
  ): void {
    try {
      const title = result === 'success' ? `自动化任务完成：${task.title}` : `自动化任务失败：${task.title}`
      const body = result === 'success'
        ? `耗时 ${(durationMs / 1000).toFixed(1)} 秒`
        : `错误：${error || '未知错误'}`
      const clickId = JSON.stringify({ conversationId, employeeId })
      this.ctx.services.notification!.notify({
        title,
        body,
        clickTarget: 'automation',
        clickId,
        source: 'automation',
      })
    } catch { /* ignore */ }
  }

  private formatRunTitleTime(unixSec: number): string {
    const d = new Date(unixSec * 1000)
    const pad = (n: number) => n < 10 ? `0${n}` : `${n}`
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`
  }

  // ====== 内核 conversation 操作（经 ctx.services.conversations 桥接） ======

  /** 创建 conversation（复用内核 WorkspaceManagerService.createConversation） */
  private async createConversation(employeeId: string, title?: string): Promise<{ id: string }> {
    const id = await this.ctx.services.conversations!.create(employeeId, title)
    return { id }
  }

  private async updateConversation(id: string, data: Record<string, unknown>): Promise<void> {
    await this.ctx.services.conversations!.update(id, data)
  }

  private async deleteConversation(id: string): Promise<void> {
    await this.ctx.services.conversations!.delete(id)
  }

  private async updateConversationEmployee(id: string, employeeId: string): Promise<void> {
    await this.ctx.services.conversations!.update(id, { employee_id: employeeId })
  }

  // ====== 工具方法 ======

  private rowToTask(row: any): AutomationTask {
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      prompt: row.prompt,
      employee_id: row.employee_id,
      provider_id: row.provider_id,
      model_id: row.model_id ?? null,
      high_permission: !!row.high_permission,
      start_at: row.start_at,
      recurrence_rule: row.recurrence_rule ? this.safeParseJson(row.recurrence_rule, null) : null,
      is_enabled: !!row.is_enabled,
      notify_on_complete: !!row.notify_on_complete,
      retry_count: row.retry_count || 0,
      tags: this.safeParseJson(row.tags_json, []),
      last_run_at: row.last_run_at ?? null,
      next_run_at: row.next_run_at ?? null,
      last_status: (row.last_status || 'idle') as AutomationTaskStatus,
      last_error: row.last_error ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  private rowToRun(row: any): AutomationRun {
    return {
      id: row.id,
      task_id: row.task_id,
      conversation_id: row.conversation_id ?? null,
      employee_id: row.employee_id,
      provider_id: row.provider_id,
      model_id: row.model_id ?? null,
      status: (row.status || 'running') as AutomationRunStatus,
      triggered_by: (row.triggered_by || 'scheduler') as AutomationTriggeredBy,
      started_at: row.started_at,
      finished_at: row.finished_at ?? null,
      duration_ms: row.duration_ms ?? null,
      error_message: row.error_message ?? null,
      created_at: row.created_at,
    }
  }

  private safeParseJson<T>(raw: any, fallback: T): T {
    if (!raw) return fallback
    try {
      const parsed = JSON.parse(raw)
      return parsed ?? fallback
    } catch {
      return fallback
    }
  }
}

// ====== 单例管理 ======

let service: AutomationService | null = null

export function getAutomationService(ctx: PluginContext): AutomationService {
  if (!service) {
    service = new AutomationService(ctx)
  }
  return service
}

export function resetAutomationService(): void {
  service = null
}

export default AutomationService
