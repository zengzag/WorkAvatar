import Database from 'better-sqlite3'
import DatabaseService from '../database.service'
import { createLogger } from '../logger'
import { generateId } from '../common-utils'

const logger = createLogger('Calendar')

// ====== 类型定义 ======

export type EventColor = 'default' | 'blue' | 'green' | 'orange' | 'red' | 'purple'
export type TodoPriority = 'none' | 'low' | 'medium' | 'high'
export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export type ReminderTargetType = 'event' | 'todo'

/** 重复规则：不重复时 recurrence_rule 为空串 */
export interface RecurrenceRule {
  /** daily / weekdays / weekly / monthly / yearly */
  freq: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'
  /** 间隔，例如 interval=2 + weekly = 每两周 */
  interval: number
  /** 最多重复次数（与 until 二选一） */
  count?: number
  /** 重复截止时间 unix 秒 */
  until?: number
}

export interface CalendarEvent {
  id: string
  title: string
  description: string
  location: string
  start_at: number
  end_at: number
  all_day: boolean
  color: EventColor
  recurrence_rule: RecurrenceRule | null
  /** 分钟偏移数组，如 [0, -10, -60] */
  reminders: number[]
  employee_id: string | null
  source: 'user' | 'agent'
  created_at: number
  updated_at: number
}

export interface CalendarTodo {
  id: string
  title: string
  description: string
  due_at: number | null
  priority: TodoPriority
  status: TodoStatus
  tags: string[]
  recurrence_rule: RecurrenceRule | null
  reminders: number[]
  completed_at: number | null
  employee_id: string | null
  source: 'user' | 'agent'
  created_at: number
  updated_at: number
}

/** 日历面板上展示的日程实例（重复日程展开后产生） */
export interface CalendarEventInstance extends CalendarEvent {
  /** 实例的实际开始时间（可能与 start_at 不同，重复展开时变化） */
  instance_start_at: number
  instance_end_at: number
  /** 是否为重复日程产生的实例 */
  is_recurring: boolean
}

export interface CalendarTodoStats {
  total: number
  pending: number
  in_progress: number
  completed: number
  overdue: number
  due_today: number
  due_this_week: number
  completion_rate: number
}

export interface CalendarSettings {
  /** 默认事件提醒分钟偏移列表 */
  default_event_reminders: number[]
  /** 默认 TODO 提醒分钟偏移列表 */
  default_todo_reminders: number[]
  /** 是否启用系统通知 */
  enable_system_notification: boolean
}

const DEFAULT_SETTINGS: CalendarSettings = {
  default_event_reminders: [-10],
  default_todo_reminders: [-30],
  enable_system_notification: true,
}

export interface ListEventsParams {
  start_at: number
  end_at: number
}

export interface ListTodosParams {
  status?: TodoStatus | TodoStatus[]
  priority?: TodoPriority | TodoPriority[]
  tag?: string
  /** 仅返回已逾期（status != completed 且 due_at < now） */
  overdue_only?: boolean
  /** 仅返回今日到期 */
  due_today?: boolean
  /** 截止区间过滤 [due_from, due_to] */
  due_from?: number
  due_to?: number
  limit?: number
}

export interface CreateEventInput {
  title: string
  description?: string
  location?: string
  start_at: number
  end_at?: number
  all_day?: boolean
  color?: EventColor
  recurrence_rule?: RecurrenceRule | null
  reminders?: number[]
  employee_id?: string | null
  source?: 'user' | 'agent'
}

export interface UpdateEventInput {
  id: string
  title?: string
  description?: string
  location?: string
  start_at?: number
  end_at?: number
  all_day?: boolean
  color?: EventColor
  recurrence_rule?: RecurrenceRule | null
  reminders?: number[]
}

export interface CreateTodoInput {
  title: string
  description?: string
  due_at?: number | null
  priority?: TodoPriority
  status?: TodoStatus
  tags?: string[]
  recurrence_rule?: RecurrenceRule | null
  reminders?: number[]
  employee_id?: string | null
  source?: 'user' | 'agent'
}

export interface UpdateTodoInput {
  id: string
  title?: string
  description?: string
  due_at?: number | null
  priority?: TodoPriority
  status?: TodoStatus
  tags?: string[]
  recurrence_rule?: RecurrenceRule | null
  reminders?: number[]
}

// ====== 服务实现 ======

class CalendarService {
  private static instance: CalendarService
  private db: Database.Database
  private settingsCache: CalendarSettings | null = null

  private constructor() {
    this.db = DatabaseService.getInstance().getDb()
  }

  static getInstance(): CalendarService {
    if (!CalendarService.instance) {
      CalendarService.instance = new CalendarService()
    }
    return CalendarService.instance
  }

  // ====== Settings ======

  getSettings(): CalendarSettings {
    if (this.settingsCache) return this.settingsCache
    try {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('calendar_settings') as { value?: string } | undefined
      if (row?.value) {
        const parsed = JSON.parse(row.value)
        this.settingsCache = { ...DEFAULT_SETTINGS, ...parsed }
      } else {
        this.settingsCache = { ...DEFAULT_SETTINGS }
      }
    } catch {
      this.settingsCache = { ...DEFAULT_SETTINGS }
    }
    return this.settingsCache!
  }

  setSettings(settings: Partial<CalendarSettings>): CalendarSettings {
    const current = this.getSettings()
    const next = { ...current, ...settings }
    const value = JSON.stringify(next)
    this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('calendar_settings', ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(value)
    this.settingsCache = next
    return next
  }

  // ====== Events CRUD ======

  listEvents(params: ListEventsParams): CalendarEventInstance[] {
    const rows = this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE end_at >= ? AND start_at <= ?
       ORDER BY start_at ASC`
    ).all(params.start_at, params.end_at) as any[]

    const instances: CalendarEventInstance[] = []
    for (const row of rows) {
      const event = this.rowToEvent(row)
      if (!event.recurrence_rule) {
        instances.push({ ...event, instance_start_at: event.start_at, instance_end_at: event.end_at, is_recurring: false })
      } else {
        const expanded = this.expandEventInstances(event, params.start_at, params.end_at)
        instances.push(...expanded)
      }
    }
    instances.sort((a, b) => a.instance_start_at - b.instance_start_at)
    return instances
  }

  getEvent(id: string): CalendarEvent | null {
    const row = this.db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as any
    return row ? this.rowToEvent(row) : null
  }

  createEvent(input: CreateEventInput): CalendarEvent {
    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    const startAt = input.start_at
    const endAt = input.end_at ?? (input.all_day ? startAt + 86400 : startAt + 3600)
    const reminders = input.reminders ?? this.getSettings().default_event_reminders
    const ruleJson = input.recurrence_rule ? JSON.stringify(input.recurrence_rule) : ''

    this.db.prepare(
      `INSERT INTO calendar_events (id, title, description, location, start_at, end_at, all_day, color, recurrence_rule, reminders_json, employee_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, input.title, input.description || '', input.location || '',
      startAt, endAt, input.all_day ? 1 : 0, input.color || 'default',
      ruleJson, JSON.stringify(reminders),
      input.employee_id ?? null, input.source || 'user', now, now
    )

    const event = this.getEvent(id)!
    this.regenerateEventReminders(event)
    logger.info(`Event created: ${id} "${input.title}"`)
    return event
  }

  updateEvent(input: UpdateEventInput): CalendarEvent | null {
    const existing = this.getEvent(input.id)
    if (!existing) return null
    const now = Math.floor(Date.now() / 1000)
    const merged: CalendarEvent = {
      ...existing,
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    }
    if (input.recurrence_rule !== undefined) {
      merged.recurrence_rule = input.recurrence_rule
    }
    if (input.reminders !== undefined) {
      merged.reminders = input.reminders
    }
    const ruleJson = merged.recurrence_rule ? JSON.stringify(merged.recurrence_rule) : ''
    this.db.prepare(
      `UPDATE calendar_events SET title=?, description=?, location=?, start_at=?, end_at=?, all_day=?, color=?, recurrence_rule=?, reminders_json=?, updated_at=? WHERE id=?`
    ).run(
      merged.title, merged.description, merged.location,
      merged.start_at, merged.end_at, merged.all_day ? 1 : 0,
      merged.color, ruleJson, JSON.stringify(merged.reminders), now, input.id
    )
    const updated = this.getEvent(input.id)!
    this.regenerateEventReminders(updated)
    return updated
  }

  deleteEvent(id: string): boolean {
    this.db.prepare('DELETE FROM calendar_reminders WHERE target_type = ? AND target_id = ?').run('event', id)
    const result = this.db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ====== Todos CRUD ======

  listTodos(params: ListTodosParams = {}): CalendarTodo[] {
    const conditions: string[] = []
    const args: any[] = []
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
    if (params.priority) {
      if (Array.isArray(params.priority)) {
        if (params.priority.length > 0) {
          conditions.push(`priority IN (${params.priority.map(() => '?').join(',')})`)
          args.push(...params.priority)
        }
      } else {
        conditions.push('priority = ?')
        args.push(params.priority)
      }
    }
    if (params.tag) {
      conditions.push('tags_json LIKE ?')
      args.push(`%"${params.tag.replace(/["%_]/g, '')}"%`)
    }
    if (params.due_from !== undefined) {
      conditions.push('due_at >= ?')
      args.push(params.due_from)
    }
    if (params.due_to !== undefined) {
      conditions.push('due_at <= ?')
      args.push(params.due_to)
    }
    const now = Math.floor(Date.now() / 1000)
    if (params.overdue_only) {
      conditions.push('status != ?')
      args.push('completed')
      conditions.push('due_at IS NOT NULL')
      conditions.push('due_at < ?')
      args.push(now)
    }
    if (params.due_today) {
      const dayStart = this.startOfDay(now)
      const dayEnd = dayStart + 86400
      conditions.push('due_at IS NOT NULL')
      conditions.push('due_at >= ?')
      args.push(dayStart)
      conditions.push('due_at < ?')
      args.push(dayEnd)
    }

    let sql = `SELECT * FROM calendar_todos`
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
    sql += ` ORDER BY due_at IS NULL, due_at ASC, created_at DESC`
    if (params.limit) {
      sql += ` LIMIT ?`
      args.push(params.limit)
    }
    const rows = this.db.prepare(sql).all(...args) as any[]
    return rows.map((r) => this.rowToTodo(r))
  }

  getTodo(id: string): CalendarTodo | null {
    const row = this.db.prepare('SELECT * FROM calendar_todos WHERE id = ?').get(id) as any
    return row ? this.rowToTodo(row) : null
  }

  createTodo(input: CreateTodoInput): CalendarTodo {
    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    const reminders = input.reminders ?? this.getSettings().default_todo_reminders
    const ruleJson = input.recurrence_rule ? JSON.stringify(input.recurrence_rule) : ''
    const completedAt = input.status === 'completed' ? now : null

    this.db.prepare(
      `INSERT INTO calendar_todos (id, title, description, due_at, priority, status, tags_json, recurrence_rule, reminders_json, completed_at, employee_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, input.title, input.description || '', input.due_at ?? null,
      input.priority || 'none', input.status || 'pending',
      JSON.stringify(input.tags || []), ruleJson, JSON.stringify(reminders),
      completedAt, input.employee_id ?? null, input.source || 'user', now, now
    )

    const todo = this.getTodo(id)!
    this.regenerateTodoReminders(todo)
    logger.info(`Todo created: ${id} "${input.title}"`)
    return todo
  }

  updateTodo(input: UpdateTodoInput): CalendarTodo | null {
    const existing = this.getTodo(input.id)
    if (!existing) return null
    const now = Math.floor(Date.now() / 1000)
    const merged: CalendarTodo = {
      ...existing,
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    }
    if (input.recurrence_rule !== undefined) merged.recurrence_rule = input.recurrence_rule
    if (input.reminders !== undefined) merged.reminders = input.reminders
    if (input.tags !== undefined) merged.tags = input.tags

    // 状态变更时同步 completed_at
    if (input.status === 'completed' && existing.status !== 'completed') {
      merged.completed_at = now
    } else if (input.status && input.status !== 'completed') {
      merged.completed_at = null
    }

    const ruleJson = merged.recurrence_rule ? JSON.stringify(merged.recurrence_rule) : ''
    this.db.prepare(
      `UPDATE calendar_todos SET title=?, description=?, due_at=?, priority=?, status=?, tags_json=?, recurrence_rule=?, reminders_json=?, completed_at=?, updated_at=? WHERE id=?`
    ).run(
      merged.title, merged.description, merged.due_at,
      merged.priority, merged.status, JSON.stringify(merged.tags),
      ruleJson, JSON.stringify(merged.reminders), merged.completed_at, now, input.id
    )
    const updated = this.getTodo(input.id)!
    this.regenerateTodoReminders(updated)
    return updated
  }

  /** 标记 TODO 完成（便捷方法） */
  completeTodo(id: string, completed: boolean): CalendarTodo | null {
    const now = Math.floor(Date.now() / 1000)
    const result = this.db.prepare(
      `UPDATE calendar_todos SET status=?, completed_at=?, updated_at=? WHERE id=?`
    ).run(completed ? 'completed' : 'pending', completed ? now : null, now, id)
    if (result.changes === 0) return null
    return this.getTodo(id)
  }

  deleteTodo(id: string): boolean {
    this.db.prepare('DELETE FROM calendar_reminders WHERE target_type = ? AND target_id = ?').run('todo', id)
    const result = this.db.prepare('DELETE FROM calendar_todos WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ====== Todo stats ======

  getTodoStats(): CalendarTodoStats {
    const now = Math.floor(Date.now() / 1000)
    const dayStart = this.startOfDay(now)
    const dayEnd = dayStart + 86400
    const weekStart = this.startOfWeek(now)
    const weekEnd = weekStart + 7 * 86400

    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM calendar_todos').get() as any).n
    const pending = (this.db.prepare('SELECT COUNT(*) AS n FROM calendar_todos WHERE status = ?').get('pending') as any).n
    const in_progress = (this.db.prepare('SELECT COUNT(*) AS n FROM calendar_todos WHERE status = ?').get('in_progress') as any).n
    const completed = (this.db.prepare('SELECT COUNT(*) AS n FROM calendar_todos WHERE status = ?').get('completed') as any).n
    const overdue = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM calendar_todos WHERE status != ? AND due_at IS NOT NULL AND due_at < ?`
    ).get('completed', now) as any).n
    const due_today = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM calendar_todos WHERE status != ? AND due_at IS NOT NULL AND due_at >= ? AND due_at < ?`
    ).get('completed', dayStart, dayEnd) as any).n
    const due_this_week = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM calendar_todos WHERE status != ? AND due_at IS NOT NULL AND due_at >= ? AND due_at < ?`
    ).get('completed', weekStart, weekEnd) as any).n

    const completion_rate = total > 0 ? Math.round((completed / total) * 100) : 0
    return { total, pending, in_progress, completed, overdue, due_today, due_this_week, completion_rate }
  }

  // ====== Reminders ======

  /** 取所有到期但未触发的提醒（scheduler 用） */
  listDueReminders(now: number): Array<{ id: string; target_type: ReminderTargetType; target_id: string; trigger_at: number; payload: any }> {
    const rows = this.db.prepare(
      `SELECT * FROM calendar_reminders WHERE trigger_at <= ? AND fired_at IS NULL ORDER BY trigger_at ASC`
    ).all(now) as any[]
    return rows.map((r) => ({
      id: r.id,
      target_type: r.target_type as ReminderTargetType,
      target_id: r.target_id,
      trigger_at: r.trigger_at,
      payload: this.safeParseJson(r.payload_json, {}),
    }))
  }

  markReminderFired(id: string): void {
    this.db.prepare('UPDATE calendar_reminders SET fired_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), id)
  }

  /** 清理 7 天前已 fired 的提醒记录 */
  cleanupOldReminders(): number {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400
    const result = this.db.prepare('DELETE FROM calendar_reminders WHERE fired_at IS NOT NULL AND fired_at < ?').run(cutoff)
    return result.changes
  }

  /** 重新生成指定事件的提醒（删除旧的，写入未来 N 天内的提醒） */
  private regenerateEventReminders(event: CalendarEvent): void {
    this.db.prepare('DELETE FROM calendar_reminders WHERE target_type = ? AND target_id = ?').run('event', event.id)
    const now = Math.floor(Date.now() / 1000)
    // 提前生成未来 90 天内的提醒，覆盖非重复与重复事件
    const horizon = now + 90 * 86400
    const instances = event.recurrence_rule
      ? this.expandEventInstances(event, now, horizon)
      : [{ instance_start_at: event.start_at, is_recurring: false }]
    for (const inst of instances) {
      for (const offsetMin of event.reminders) {
        const triggerAt = inst.instance_start_at + offsetMin * 60
        if (triggerAt < now) continue
        if (triggerAt > horizon) continue
        this.insertReminder('event', event.id, triggerAt, {
          title: event.title,
          body: this.formatEventReminderBody(event, inst.instance_start_at, offsetMin),
          clickTarget: 'event',
          clickId: event.id,
          startAt: inst.instance_start_at,
        })
      }
    }
  }

  private regenerateTodoReminders(todo: CalendarTodo): void {
    this.db.prepare('DELETE FROM calendar_reminders WHERE target_type = ? AND target_id = ?').run('todo', todo.id)
    if (!todo.due_at || todo.status === 'completed') return
    const now = Math.floor(Date.now() / 1000)
    if (todo.due_at <= now) return
    for (const offsetMin of todo.reminders) {
      const triggerAt = todo.due_at + offsetMin * 60
      if (triggerAt < now) continue
      this.insertReminder('todo', todo.id, triggerAt, {
        title: todo.title,
        body: this.formatTodoReminderBody(todo, offsetMin),
        clickTarget: 'todo',
        clickId: todo.id,
        dueAt: todo.due_at,
      })
    }
  }

  private insertReminder(targetType: ReminderTargetType, targetId: string, triggerAt: number, payload: any): void {
    this.db.prepare(
      `INSERT INTO calendar_reminders (id, target_type, target_id, trigger_at, fired_at, payload_json, created_at) VALUES (?, ?, ?, ?, NULL, ?, unixepoch())`
    ).run(generateId(), targetType, targetId, triggerAt, JSON.stringify(payload))
  }

  // ====== 重复规则展开 ======

  /** 展开重复事件在 [winStart, winEnd] 区间内的实例 */
  private expandEventInstances(event: CalendarEvent, winStart: number, winEnd: number): CalendarEventInstance[] {
    if (!event.recurrence_rule) {
      return [{
        ...event,
        instance_start_at: event.start_at,
        instance_end_at: event.end_at,
        is_recurring: false,
      }]
    }
    const rule = event.recurrence_rule
    const duration = event.end_at - event.start_at
    const instances: CalendarEventInstance[] = []
    const until = rule.until ?? winEnd + 86400
    const maxIterations = 500
    let iter = 0

    let cursor = event.start_at
    while (iter < maxIterations) {
      iter++
      if (cursor > until) break
      if (cursor > winEnd) break
      const instanceEnd = cursor + duration
      if (instanceEnd >= winStart) {
        instances.push({
          ...event,
          start_at: event.start_at,
          end_at: event.end_at,
          instance_start_at: cursor,
          instance_end_at: instanceEnd,
          is_recurring: true,
        })
      }
      if (rule.count && iter >= rule.count) break
      const next = this.advanceRecurrence(cursor, rule)
      if (next === cursor) break
      cursor = next
    }
    return instances
  }

  /** 根据重复规则推算下一个发生时间 */
  private advanceRecurrence(current: number, rule: RecurrenceRule): number {
    const interval = Math.max(1, rule.interval)
    const date = new Date(current * 1000)
    switch (rule.freq) {
      case 'daily':
        return current + interval * 86400
      case 'weekdays': {
        // 跳过周六周日，interval 表示跳过的工作日数
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
        const d = new Date(date.getFullYear(), date.getMonth() + interval, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds())
        return Math.floor(d.getTime() / 1000)
      }
      case 'yearly': {
        const d = new Date(date.getFullYear() + interval, date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds())
        return Math.floor(d.getTime() / 1000)
      }
      default:
        return current
    }
  }

  // ====== 工具方法 ======

  private startOfDay(unixSec: number): number {
    const d = new Date(unixSec * 1000)
    const local = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    return Math.floor(local.getTime() / 1000)
  }

  private startOfWeek(unixSec: number): number {
    const d = new Date(unixSec * 1000)
    const day = d.getDay()
    // 周一为一周开始
    const diff = (day === 0 ? 6 : day - 1)
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff)
    return Math.floor(monday.getTime() / 1000)
  }

  private rowToEvent(row: any): CalendarEvent {
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      location: row.location || '',
      start_at: row.start_at,
      end_at: row.end_at,
      all_day: !!row.all_day,
      color: row.color,
      recurrence_rule: row.recurrence_rule ? this.safeParseJson(row.recurrence_rule, null) : null,
      reminders: this.safeParseJson(row.reminders_json, []),
      employee_id: row.employee_id ?? null,
      source: row.source || 'user',
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  private rowToTodo(row: any): CalendarTodo {
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      due_at: row.due_at ?? null,
      priority: row.priority,
      status: row.status,
      tags: this.safeParseJson(row.tags_json, []),
      recurrence_rule: row.recurrence_rule ? this.safeParseJson(row.recurrence_rule, null) : null,
      reminders: this.safeParseJson(row.reminders_json, []),
      completed_at: row.completed_at ?? null,
      employee_id: row.employee_id ?? null,
      source: row.source || 'user',
      created_at: row.created_at,
      updated_at: row.updated_at,
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

  private formatEventReminderBody(event: CalendarEvent, startAt: number, offsetMin: number): string {
    const time = new Date(startAt * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    const prefix = offsetMin === 0 ? '即将开始' : offsetMin < 0 ? `${-offsetMin} 分钟后开始` : '已开始'
    let body = `${prefix} · ${time}`
    if (event.location) body += ` · ${event.location}`
    return body
  }

  private formatTodoReminderBody(todo: CalendarTodo, offsetMin: number): string {
    const time = todo.due_at ? new Date(todo.due_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
    const prefix = offsetMin === 0 ? '已到截止时间' : offsetMin < 0 ? `${-offsetMin} 分钟后到期` : '已过期'
    return `${prefix}${time ? ' · ' + time : ''}`
  }
}

export default CalendarService
