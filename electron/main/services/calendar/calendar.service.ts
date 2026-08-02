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
  /** 被跳过（删除）的实例时间戳列表（Unix 秒），命中该实例时不生成 */
  excluded_dates?: number[]
  /** 实例级完成记录：instance_due_at → completed_at（Unix 秒）。支持"跳着完成"（下次未完成、下下次已完成） */
  completed_instances?: Record<string, number>
}

export type DeleteInstanceMode = 'this' | 'future' | 'all'

export interface DeleteEventInstanceParams {
  id: string
  /** 要删除的实例锚点时间（event 的 instance_start_at），Unix 秒 */
  anchor_at: number
  mode: DeleteInstanceMode
}

export interface DeleteTodoInstanceParams {
  id: string
  /** 要删除的实例锚点时间（todo 的 instance_due_at），Unix 秒 */
  anchor_at: number
  mode: DeleteInstanceMode
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
  recurrence_rule: RecurrenceRule | null
  reminders: number[]
  /** 进入"进行中"状态的时间戳 */
  started_at: number | null
  /** 完成时间戳 */
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

/** 日历面板上展示的 TODO 实例（重复 TODO 展开后产生） */
export interface CalendarTodoInstance extends CalendarTodo {
  /** 实例的实际截止时间（可能与 due_at 不同，重复展开时变化） */
  instance_due_at: number
  /** 是否为重复 TODO 产生的实例 */
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
  /** 仅返回已逾期（status != completed 且 due_at < now） */
  overdue_only?: boolean
  /** 仅返回今日到期 */
  due_today?: boolean
  /** 截止区间过滤 [due_from, due_to] */
  due_from?: number
  due_to?: number
  limit?: number
  /** 面板模式：重复 TODO 展开为「下一个未完成实例 + 已完成实例」（供右侧待办列表使用） */
  expand_instances?: boolean
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
  recurrence_rule?: RecurrenceRule | null
  reminders?: number[]
  /** 实例级操作锚点（编辑弹窗对某个具体实例完成/取消完成时携带） */
  instance_due_at?: number
}

// ====== 服务实现 ======

class CalendarService {
  private static instance: CalendarService
  private db: Database.Database
  private settingsCache: CalendarSettings | null = null
  private todoStatsCache: { stats: CalendarTodoStats; computedAt: number } | null = null
  private static readonly TODO_STATS_TTL_MS = 5000

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
    // 重复事件的原始 end_at 是首次发生时段的结束时间，翻页到未来窗口时
    // 原 end_at 早于窗口起点会被过滤掉，导致重复实例消失。
    // 因此重复事件只看 start_at <= winEnd（可能产生实例落在窗口内），
    // 非重复事件仍按原时段与窗口相交判断。
    const rows = this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE start_at <= ?
         AND (
           end_at >= ?
           OR (recurrence_rule IS NOT NULL AND recurrence_rule != '')
         )
       ORDER BY start_at ASC`
    ).all(params.end_at, params.start_at) as any[]

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

  /**
   * 删除事件的指定实例（支持三态：仅本次 / 本次及以后 / 全部）。
   * - 非重复事件：三态都等同于 deleteEvent。
   * - 重复事件：
   *   this    → 把 anchor_at 写入 recurrence_rule.excluded_dates（EXDATE）
   *   future  → 截断 until = anchor_at - 1 秒；若 anchor_at <= start_at，则退化为删除全量
   *   all     → deleteEvent
   */
  deleteEventInstance(params: DeleteEventInstanceParams): boolean {
    const { id, anchor_at, mode } = params
    const existing = this.getEvent(id)
    if (!existing) return false
    if (!existing.recurrence_rule || mode === 'all') return this.deleteEvent(id)

    const rule = { ...existing.recurrence_rule }
    const now = Math.floor(Date.now() / 1000)

    if (mode === 'future') {
      if (anchor_at <= existing.start_at) {
        // 锚点就是第一次或更早，直接删全量
        return this.deleteEvent(id)
      }
      // until 取「更小的那个」：已有 until 更小就保留，否则截断到 anchor_at - 1
      const newUntil = anchor_at - 1
      rule.until = rule.until != null ? Math.min(rule.until, newUntil) : newUntil
    } else {
      // this
      rule.excluded_dates = Array.from(new Set([...(rule.excluded_dates ?? []), anchor_at]))
    }

    const ruleJson = JSON.stringify(rule)
    this.db.prepare(
      `UPDATE calendar_events SET recurrence_rule=?, updated_at=? WHERE id=?`
    ).run(ruleJson, now, id)
    const updated = this.getEvent(id)
    if (updated) this.regenerateEventReminders(updated)
    return true
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
    const todos = rows.map((r) => this.rowToTodo(r))

    // 面板模式（expand_instances=true）：重复 TODO 展开为「下一个未完成实例 + 已完成实例」
    if (params.expand_instances) {
      const merged: CalendarTodoInstance[] = []
      for (const td of todos) {
        if (td.recurrence_rule && td.due_at != null) {
          const rule = td.recurrence_rule
          const map = rule.completed_instances ?? {}
          const hasCompletions = Object.keys(map).length > 0
          if (hasCompletions || td.status !== 'completed') {
            // 下一个未完成实例（系列整体完成时不再生成）
            if (td.status !== 'completed') {
              merged.push({ ...td, due_at: td.due_at, instance_due_at: td.due_at, is_recurring: true })
            }
            // 已完成实例（跳过被 EXDATE / 超出 until 的）
            for (const [k, v] of Object.entries(map)) {
              const instDue = Number(k)
              if (!Number.isFinite(instDue)) continue
              if (rule.excluded_dates?.includes(instDue)) continue
              if (rule.until != null && instDue > rule.until) continue
              merged.push({
                ...td, due_at: instDue, status: 'completed' as TodoStatus,
                started_at: null, completed_at: v, instance_due_at: instDue, is_recurring: true,
              })
            }
            continue
          }
        }
        merged.push(td as CalendarTodoInstance)
      }

      // 对合并结果重新应用筛选（SQL 只过滤了原始行）
      const now = Math.floor(Date.now() / 1000)
      const filtered = merged.filter((td) => {
        if (params.status) {
          const statuses = Array.isArray(params.status) ? params.status : [params.status]
          if (!statuses.includes(td.status)) return false
        }
        if (params.priority) {
          const prios = Array.isArray(params.priority) ? params.priority : [params.priority]
          if (!prios.includes(td.priority)) return false
        }
        if (params.overdue_only) {
          if (td.status === 'completed') return false
          if (td.due_at == null || td.due_at >= now) return false
        }
        if (params.due_today) {
          const dayStart = this.startOfDay(now)
          const dayEnd = dayStart + 86400
          if (td.due_at == null || td.due_at < dayStart || td.due_at >= dayEnd) return false
        }
        if (params.due_from !== undefined && (td.due_at == null || td.due_at < params.due_from)) return false
        if (params.due_to !== undefined && (td.due_at == null || td.due_at > params.due_to)) return false
        return true
      })
      return params.limit ? filtered.slice(0, params.limit) : filtered
    }

    return todos
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
    const status = input.status || 'pending'
    const startedAt = status === 'in_progress' ? now : null
    const completedAt = status === 'completed' ? now : null

    this.db.prepare(
      `INSERT INTO calendar_todos (id, title, description, due_at, priority, status, recurrence_rule, reminders_json, started_at, completed_at, employee_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, input.title, input.description || '', input.due_at ?? null,
      input.priority || 'none', status,
      ruleJson, JSON.stringify(reminders),
      startedAt, completedAt, input.employee_id ?? null, input.source || 'user', now, now
    )

    const todo = this.getTodo(id)!
    this.regenerateTodoReminders(todo)
    this.invalidateTodoStatsCache()
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
    if (input.recurrence_rule !== undefined) {
      // 表单/agent 重建规则时保留 EXDATE 与实例完成记录，避免丢失
      if (input.recurrence_rule && existing.recurrence_rule) {
        const nextRule: RecurrenceRule = { ...input.recurrence_rule }
        if (!nextRule.excluded_dates && existing.recurrence_rule.excluded_dates) {
          nextRule.excluded_dates = existing.recurrence_rule.excluded_dates
        }
        if (!nextRule.completed_instances && existing.recurrence_rule.completed_instances) {
          nextRule.completed_instances = existing.recurrence_rule.completed_instances
        }
        merged.recurrence_rule = nextRule
      } else {
        merged.recurrence_rule = input.recurrence_rule
      }
    }
    if (input.reminders !== undefined) merged.reminders = input.reminders

    // 实例级状态变更：编辑弹窗对某个具体实例执行完成/取消完成
    // （判断依据是该实例自身的完成记录，而非基础状态；操作均为幂等）
    if (input.instance_due_at != null && merged.recurrence_rule && input.status) {
      const rule: RecurrenceRule = { ...merged.recurrence_rule }
      const map = { ...(rule.completed_instances ?? {}) }
      const anchor = input.instance_due_at
      if (input.status === 'completed') {
        if (map[anchor] == null) map[anchor] = now
        if (anchor === merged.due_at) {
          const next = this.nextUncompletedAfter(anchor, rule, map)
          if (next == null) {
            merged.status = 'completed'
            merged.completed_at = now
            merged.started_at = merged.started_at ?? now
          } else {
            merged.due_at = next
            merged.status = 'pending'
            merged.started_at = null
            merged.completed_at = null
          }
        }
      } else {
        // pending / in_progress：取消该实例的完成标记
        delete map[anchor]
        if (merged.status === 'completed') {
          merged.status = 'pending'
          merged.completed_at = null
          merged.started_at = null
        }
        if (merged.due_at != null) merged.due_at = Math.min(merged.due_at, anchor)
        if (input.status === 'in_progress') {
          merged.status = 'in_progress'
          merged.started_at = existing.started_at ?? now
          merged.completed_at = null
        }
      }
      rule.completed_instances = Object.keys(map).length > 0 ? map : undefined
      merged.recurrence_rule = rule
    }

    // 状态变更时同步 started_at / completed_at（实例级状态已单独处理，此处仅处理基础状态）
    if (input.status && input.status !== existing.status && input.instance_due_at == null) {
      if (input.status === 'in_progress') {
        // 进入进行中：首次设置 started_at，清除 completed_at
        if (!existing.started_at) merged.started_at = now
        merged.completed_at = null
      } else if (input.status === 'completed') {
        merged.completed_at = now
        // 若从未记录 started_at 但直接完成，回填 started_at 为完成时间
        if (!merged.started_at) merged.started_at = now
      } else {
        // 回到 pending：清除 started_at / completed_at
        merged.started_at = null
        merged.completed_at = null
      }
    }

    const ruleJson = merged.recurrence_rule ? JSON.stringify(merged.recurrence_rule) : ''
    this.db.prepare(
      `UPDATE calendar_todos SET title=?, description=?, due_at=?, priority=?, status=?, recurrence_rule=?, reminders_json=?, started_at=?, completed_at=?, updated_at=? WHERE id=?`
    ).run(
      merged.title, merged.description, merged.due_at,
      merged.priority, merged.status,
      ruleJson, JSON.stringify(merged.reminders), merged.started_at, merged.completed_at, now, input.id
    )
    const updated = this.getTodo(input.id)!
    this.regenerateTodoReminders(updated)
    this.invalidateTodoStatsCache()
    return updated
  }

  /** 标记 TODO 完成（便捷方法）。重复 TODO 完成时记录该实例并推进到下一个未完成实例 */
  completeTodo(id: string, completed: boolean, instance_due_at?: number): CalendarTodo | null {
    const now = Math.floor(Date.now() / 1000)
    const existing = this.getTodo(id)
    if (!existing) return null

    if (!existing.recurrence_rule || existing.due_at == null) {
      // 非重复 TODO：直接更新状态
      if (completed) {
        this.db.prepare(
          `UPDATE calendar_todos SET status=?, completed_at=?, started_at=COALESCE(started_at, ?), updated_at=? WHERE id=?`
        ).run('completed', now, now, now, id)
      } else {
        // 取消完成：回到 pending，清除 started_at / completed_at（重新计时）
        this.db.prepare(
          `UPDATE calendar_todos SET status=?, completed_at=NULL, started_at=NULL, updated_at=? WHERE id=?`
        ).run('pending', now, id)
      }
    } else {
      // 重复 TODO：实例级完成记录（completed_instances: instance_due_at → completed_at）
      const rule = { ...existing.recurrence_rule }
      const map = { ...(rule.completed_instances ?? {}) }
      const anchor = instance_due_at ?? existing.due_at
      let dueAt = existing.due_at
      let status = existing.status
      let startedAt = existing.started_at
      let completedAt = existing.completed_at

      if (completed) {
        map[anchor] = now
        if (anchor === existing.due_at) {
          // 完成的是"当前到期"实例：推进 due_at 到下一个未完成实例
          const next = this.nextUncompletedAfter(anchor, rule, map)
          if (next == null) {
            // 系列耗尽：整系列标记完成
            status = 'completed'
            completedAt = now
            startedAt = existing.started_at ?? now
          } else {
            dueAt = next
            status = 'pending'
            startedAt = null
            completedAt = null
          }
        }
        // 跳着完成（anchor > due_at）：只记录，due_at 保持最早未完成实例
      } else {
        // 取消完成：移除该实例记录，due_at 回退到最早未完成实例
        delete map[anchor]
        if (status === 'completed') {
          // 系列曾整体完成 → 恢复为未完成系列
          status = 'pending'
          startedAt = null
          completedAt = null
        }
        dueAt = Math.min(dueAt, anchor)
      }

      rule.completed_instances = Object.keys(map).length > 0 ? map : undefined
      this.db.prepare(
        `UPDATE calendar_todos SET recurrence_rule=?, due_at=?, status=?, started_at=?, completed_at=?, updated_at=? WHERE id=?`
      ).run(JSON.stringify(rule), dueAt, status, startedAt, completedAt, now, id)
    }

    const todo = this.getTodo(id)
    if (todo) {
      this.regenerateTodoReminders(todo)
    }
    this.invalidateTodoStatsCache()
    return todo
  }

  deleteTodo(id: string): boolean {
    this.db.prepare('DELETE FROM calendar_reminders WHERE target_type = ? AND target_id = ?').run('todo', id)
    const result = this.db.prepare('DELETE FROM calendar_todos WHERE id = ?').run(id)
    if (result.changes > 0) {
      this.invalidateTodoStatsCache()
    }
    return result.changes > 0
  }

  /**
   * 删除 TODO 的指定实例（支持三态：仅本次 / 本次及以后 / 全部）。
   * - 非重复 TODO：三态都等同于 deleteTodo。
   * - 重复 TODO：
   *   this    → 把 anchor_at 写入 excluded_dates；若此时原始 due_at 命中 EXDATE / 旧截止，则推进 due_at 到下一次有效日期
   *   future  → 截断 until = anchor_at - 1；若截断后 due_at >= until / 命中 EXDATE，推进 due_at；若 anchor_at <= due_at（首条就删未来）退化为 deleteTodo
   *   all     → deleteTodo
   */
  deleteTodoInstance(params: DeleteTodoInstanceParams): boolean {
    const { id, anchor_at, mode } = params
    const existing = this.getTodo(id)
    if (!existing) return false
    if (!existing.recurrence_rule || mode === 'all') return this.deleteTodo(id)

    const rule = { ...existing.recurrence_rule }
    const now = Math.floor(Date.now() / 1000)
    let truncated = false

    if (mode === 'future') {
      if (existing.due_at != null && anchor_at <= existing.due_at) {
        // 锚点就是第一次或更早，直接删全量
        return this.deleteTodo(id)
      }
      const newUntil = anchor_at - 1
      rule.until = rule.until != null ? Math.min(rule.until, newUntil) : newUntil
      truncated = true
    } else {
      rule.excluded_dates = Array.from(new Set([...(rule.excluded_dates ?? []), anchor_at]))
      // 同步清理该实例的完成记录，避免已删除实例仍出现在已完成列表中
      if (rule.completed_instances) {
        const map = { ...rule.completed_instances }
        delete map[anchor_at]
        if (Object.keys(map).length > 0) rule.completed_instances = map
        else delete rule.completed_instances
      }
    }

    // 推进 due_at：保证原始 due_at 落在下一个有效实例（excluded_dates / until 之后）
    let nextDueAt = existing.due_at
    if (existing.due_at != null && existing.status !== 'completed') {
      const until = rule.until ?? Infinity
      const maxIter = 1000
      let iter = 0
      let cursor = existing.due_at
      // count 不再计数：只是推进 due_at，真正 count 语义交给 expand / regenerate 处理
      while (iter < maxIter) {
        iter++
        const excluded = rule.excluded_dates?.includes(cursor)
        const pastUntil = cursor > until
        if (!excluded && !pastUntil) break
        const nxt = this.advanceRecurrence(cursor, rule)
        if (nxt === cursor) break
        cursor = nxt
        if (cursor > until) break
      }
      nextDueAt = cursor
    }

    const ruleJson = JSON.stringify(rule)
    if (nextDueAt != null && nextDueAt !== existing.due_at) {
      this.db.prepare(
        `UPDATE calendar_todos SET recurrence_rule=?, due_at=?, started_at=NULL, completed_at=NULL, status='pending', updated_at=? WHERE id=?`
      ).run(ruleJson, nextDueAt, now, id)
    } else if (truncated && nextDueAt != null && existing.status === 'completed') {
      // 截断后已完成 TODO，不强制改动状态（completed 语义不变），但更新 due_at
      this.db.prepare(`UPDATE calendar_todos SET recurrence_rule=?, due_at=?, updated_at=? WHERE id=?`).run(ruleJson, nextDueAt, now, id)
    } else {
      this.db.prepare(`UPDATE calendar_todos SET recurrence_rule=?, updated_at=? WHERE id=?`).run(ruleJson, now, id)
    }

    const updated = this.getTodo(id)
    if (updated) this.regenerateTodoReminders(updated)
    this.invalidateTodoStatsCache()
    return true
  }

  // ====== Todo stats ======

  private invalidateTodoStatsCache(): void {
    this.todoStatsCache = null
  }

  getTodoStats(): CalendarTodoStats {
    const now = Date.now()
    if (this.todoStatsCache && (now - this.todoStatsCache.computedAt) < CalendarService.TODO_STATS_TTL_MS) {
      return this.todoStatsCache.stats
    }

    const nowSec = Math.floor(now / 1000)
    const dayStart = this.startOfDay(nowSec)
    const dayEnd = dayStart + 86400
    const weekStart = this.startOfWeek(nowSec)
    const weekEnd = weekStart + 7 * 86400

    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM calendar_todos').get() as any).n
    const pending = (this.db.prepare('SELECT COUNT(*) AS n FROM calendar_todos WHERE status = ?').get('pending') as any).n
    const in_progress = (this.db.prepare('SELECT COUNT(*) AS n FROM calendar_todos WHERE status = ?').get('in_progress') as any).n
    const completed = (this.db.prepare('SELECT COUNT(*) AS n FROM calendar_todos WHERE status = ?').get('completed') as any).n
    const overdue = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM calendar_todos WHERE status != ? AND due_at IS NOT NULL AND due_at < ?`
    ).get('completed', nowSec) as any).n
    const due_today = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM calendar_todos WHERE status != ? AND due_at IS NOT NULL AND due_at >= ? AND due_at < ?`
    ).get('completed', dayStart, dayEnd) as any).n
    const due_this_week = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM calendar_todos WHERE status != ? AND due_at IS NOT NULL AND due_at >= ? AND due_at < ?`
    ).get('completed', weekStart, weekEnd) as any).n

    const completion_rate = total > 0 ? Math.round((completed / total) * 100) : 0
    const stats = { total, pending, in_progress, completed, overdue, due_today, due_this_week, completion_rate }
    this.todoStatsCache = { stats, computedAt: now }
    return stats
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

  /**
   * 检查重复事件/TODO 的未来提醒是否耗尽，若耗尽则滚动再生。
   * 解决 90 天地平线导致的长期重复任务提醒静默消失问题。
   */
  ensureRemindersForRecurring(targetType: ReminderTargetType, targetId: string): void {
    const now = Math.floor(Date.now() / 1000)
    const futureCount = (this.db.prepare(
      `SELECT COUNT(*) as n FROM calendar_reminders
       WHERE target_type = ? AND target_id = ? AND fired_at IS NULL AND trigger_at > ?`
    ).get(targetType, targetId, now) as any).n
    if (futureCount > 0) return

    if (targetType === 'event') {
      const event = this.getEvent(targetId)
      if (event?.recurrence_rule) this.regenerateEventReminders(event)
    } else if (targetType === 'todo') {
      const todo = this.getTodo(targetId)
      if (todo?.recurrence_rule && todo.status !== 'completed') this.regenerateTodoReminders(todo)
    }
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
        this.insertReminder('event', event.id, triggerAt,
          this.buildReminderPayload({
            title: event.title,
            body: this.formatEventReminderBody(event, inst.instance_start_at, offsetMin),
            clickTarget: 'event',
            clickId: event.id,
            i18nKey: offsetMin === 0 ? 'calendar.eventStartingNow' : offsetMin < 0 ? 'calendar.eventStartingIn' : 'calendar.eventStarted',
            i18nParams: { minutes: -offsetMin, time: new Date(inst.instance_start_at * 1000).toISOString() },
            startAt: inst.instance_start_at,
          })
        )
      }
    }
  }

  private regenerateTodoReminders(todo: CalendarTodo): void {
    this.db.prepare('DELETE FROM calendar_reminders WHERE target_type = ? AND target_id = ?').run('todo', todo.id)
    if (!todo.due_at || todo.status === 'completed') return
    const now = Math.floor(Date.now() / 1000)
    const horizon = now + 90 * 86400

    // 重复TODO：展开未来90天内的实例，为每个实例生成提醒（复用 expandTodoInstances 的 EXDATE 过滤，跳过已完成实例）
    const dueDates: number[] = []
    if (todo.recurrence_rule) {
      const insts = this.expandTodoInstances(todo, now - 86400, horizon)
      for (const inst of insts) {
        if (inst.instance_due_at > now - 86400 && inst.status !== 'completed') dueDates.push(inst.instance_due_at)
      }
    } else {
      if (todo.due_at > now - 86400) {
        dueDates.push(todo.due_at)
      }
    }

    for (const dueAt of dueDates) {
      for (const offsetMin of todo.reminders) {
        const triggerAt = dueAt + offsetMin * 60
        if (triggerAt < now) continue
        if (triggerAt > horizon) continue
        this.insertReminder('todo', todo.id, triggerAt,
          this.buildReminderPayload({
            title: todo.title,
            body: this.formatTodoReminderBody(todo, offsetMin),
            clickTarget: 'todo',
            clickId: todo.id,
            i18nKey: offsetMin === 0 ? 'calendar.todoDueNow' : offsetMin < 0 ? 'calendar.todoDueIn' : 'calendar.todoOverdue',
            i18nParams: { minutes: -offsetMin, time: new Date(dueAt * 1000).toISOString() },
            dueAt,
          })
        )
      }
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
    // 提高上限作为安全网；fastForwardCursor 已跳过大量历史迭代
    const maxIterations = 10000
    let iter = 0

    // 跳过窗口之前的历史实例，避免对长期重复事件做无效迭代
    let cursor = this.fastForwardCursor(event.start_at, winStart - 86400, rule)
    // count 限制基于从 start_at 起的总实例数，需消耗已跳过的迭代
    if (rule.count) {
      const skipped = this.countOccurrencesBetween(event.start_at, cursor, rule)
      iter = skipped
    }

    while (iter < maxIterations) {
      iter++
      if (cursor > until) break
      if (cursor > winEnd) break
      // 跳过被排除的实例（EXDATE）
      if (rule.excluded_dates?.includes(cursor)) {
        if (rule.count && iter >= rule.count) break
        const next = this.advanceRecurrence(cursor, rule)
        if (next === cursor) break
        cursor = next
        continue
      }
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

  /** 展开重复 TODO 在 [winStart, winEnd] 区间内的实例（含已完成实例，实例状态由 completed_instances 决定） */
  private expandTodoInstances(todo: CalendarTodo, winStart: number, winEnd: number): CalendarTodoInstance[] {
    if (!todo.recurrence_rule || todo.due_at == null) {
      return [{
        ...todo,
        instance_due_at: todo.due_at as number,
        is_recurring: false,
      }]
    }
    const rule = todo.recurrence_rule
    const completedMap = rule.completed_instances ?? {}
    const instances: CalendarTodoInstance[] = []
    const until = rule.until ?? winEnd + 86400
    const maxIterations = 10000
    let iter = 0

    // 从系列最早实例开始，保证窗口内已完成实例也能展开（due_at 可能已推进到未来）
    const origin = this.getSeriesOrigin(todo)
    let cursor = this.fastForwardCursor(origin, winStart - 86400, rule)
    if (rule.count) {
      const skipped = this.countOccurrencesBetween(origin, cursor, rule)
      iter = skipped
    }

    while (iter < maxIterations) {
      iter++
      if (cursor > until) break
      if (cursor > winEnd) break
      // 跳过被排除的实例（EXDATE）
      if (rule.excluded_dates?.includes(cursor)) {
        if (rule.count && iter >= rule.count) break
        const next = this.advanceRecurrence(cursor, rule)
        if (next === cursor) break
        cursor = next
        continue
      }
      if (cursor >= winStart) {
        const completedAt = completedMap[cursor]
        instances.push({
          ...todo,
          due_at: todo.due_at,
          instance_due_at: cursor,
          is_recurring: true,
          status: completedAt != null ? 'completed' : todo.status,
          started_at: completedAt != null ? null : todo.started_at,
          completed_at: completedAt ?? todo.completed_at,
        })
      }
      if (rule.count && iter >= rule.count) break
      const next = this.advanceRecurrence(cursor, rule)
      if (next === cursor) break
      cursor = next
    }
    return instances
  }

  /** 按视图窗口查询 TODO 并展开重复实例（供日历面板渲染使用） */
  listTodoInstances(params: ListEventsParams): CalendarTodoInstance[] {
    const winStart = params.start_at
    const winEnd = params.end_at
    // 重复 TODO 全部拉出（可能含窗口内的已完成实例，due_at 已推进到未来不能作为过滤条件），展开时按窗口裁剪
    const rows = this.db.prepare(
      `SELECT * FROM calendar_todos
       WHERE (
         (due_at IS NOT NULL AND due_at >= ? AND due_at <= ?)
         OR (recurrence_rule IS NOT NULL AND recurrence_rule != '' AND due_at IS NOT NULL)
       )
       ORDER BY due_at IS NULL, due_at ASC, created_at DESC`
    ).all(winStart, winEnd) as any[]

    const instances: CalendarTodoInstance[] = []
    for (const row of rows) {
      const todo = this.rowToTodo(row)
      instances.push(...this.expandTodoInstances(todo, winStart, winEnd))
    }
    instances.sort((a, b) => a.instance_due_at - b.instance_due_at)
    return instances
  }

  /**
   * 将 cursor 从 eventStart 快进到不超过 target 的最近一次重复发生时间。
   * 用于跳过窗口之前的大量历史实例，避免 expandEventInstances 迭代超限。
   * 仅做近似跳进，可能比 target 略早一个间隔，后续迭代会补齐。
   */
  private fastForwardCursor(eventStart: number, target: number, rule: RecurrenceRule): number {
    if (eventStart >= target) return eventStart
    const interval = Math.max(1, rule.interval)
    const diffSec = target - eventStart
    switch (rule.freq) {
      case 'daily':
        return eventStart + Math.floor(diffSec / (interval * 86400)) * interval * 86400
      case 'weekly':
        return eventStart + Math.floor(diffSec / (interval * 7 * 86400)) * interval * 7 * 86400
      case 'weekdays': {
        // 按周为单位跳进，剩余由迭代补齐
        const chunkSec = interval * 7 * 86400
        return eventStart + Math.floor(diffSec / chunkSec) * chunkSec
      }
      case 'monthly': {
        // 少跳一个 interval，避免月末钳位导致 cursor 偏离实际序列
        // expandEventInstances 的 while 循环会逐月修正
        const startDate = new Date(eventStart * 1000)
        const targetDate = new Date(target * 1000)
        const monthsDiff = (targetDate.getFullYear() - startDate.getFullYear()) * 12 + (targetDate.getMonth() - startDate.getMonth())
        const skipMonths = Math.max(0, (Math.floor(monthsDiff / interval) - 1) * interval)
        if (skipMonths <= 0) return eventStart
        const skipped = this.addMonths(startDate, skipMonths)
        return Math.floor(skipped.getTime() / 1000)
      }
      case 'yearly': {
        // 少跳一个 interval，与 monthly 同理
        const startDate = new Date(eventStart * 1000)
        const targetDate = new Date(target * 1000)
        const yearsDiff = targetDate.getFullYear() - startDate.getFullYear()
        const skipYears = Math.max(0, (Math.floor(yearsDiff / interval) - 1) * interval)
        if (skipYears <= 0) return eventStart
        const skipped = this.addYears(startDate, skipYears)
        return Math.floor(skipped.getTime() / 1000)
      }
      default:
        return eventStart
    }
  }

  /** 估算从 from 到 to 之间按规则产生的实例数（用于消耗 count 配额） */
  private countOccurrencesBetween(from: number, to: number, rule: RecurrenceRule): number {
    if (to <= from) return 0
    const interval = Math.max(1, rule.interval)
    const diffSec = to - from
    switch (rule.freq) {
      case 'daily':
        return Math.floor(diffSec / (interval * 86400))
      case 'weekly':
        return Math.floor(diffSec / (interval * 7 * 86400))
      case 'weekdays':
        return Math.floor(diffSec / (interval * 7 * 86400)) * 5
      case 'monthly':
        return Math.floor(diffSec / (interval * 30 * 86400))
      case 'yearly':
        return Math.floor(diffSec / (interval * 365 * 86400))
      default:
        return 0
    }
  }

  /**
   * 安全增减月份：处理月末日期溢出（如1月31日+1月→2月28/29日而非3月3日）
   */
  private addMonths(date: Date, months: number): Date {
    const originalDay = date.getDate()
    const result = new Date(date)
    result.setMonth(result.getMonth() + months)
    if (result.getDate() !== originalDay) {
      result.setDate(0)
    }
    return result
  }

  /**
   * 安全增减年份：处理2月29日闰年问题
   */
  private addYears(date: Date, years: number): Date {
    const originalDay = date.getDate()
    const originalMonth = date.getMonth()
    const result = new Date(date)
    result.setFullYear(result.getFullYear() + years)
    if (result.getMonth() !== originalMonth || result.getDate() !== originalDay) {
      result.setDate(0)
    }
    return result
  }

  /** 根据重复规则推算下一个发生时间 */
  private advanceRecurrence(current: number, rule: RecurrenceRule): number {
    const interval = Math.max(1, rule.interval)
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

  /** 重复系列的最早实例时间（用于从历史已完成实例开始展开日历窗口） */
  private getSeriesOrigin(todo: CalendarTodo): number {
    let origin = todo.due_at ?? 0
    const rule = todo.recurrence_rule
    if (!rule) return origin
    for (const k of Object.keys(rule.completed_instances ?? {})) {
      const v = Number(k)
      if (Number.isFinite(v)) origin = Math.min(origin, v)
    }
    for (const e of rule.excluded_dates ?? []) origin = Math.min(origin, e)
    return origin
  }

  /**
   * 返回 after 之后首个未完成且未被排除（EXDATE）的实例；系列耗尽返回 null。
   * - 无 count：从 after 逐次推进，越过已完成 / 被排除实例
   * - 有 count：从系列起点走序号校验（含被排除占位，语义与 expand 一致），序号超过 count 即耗尽
   */
  private nextUncompletedAfter(after: number, rule: RecurrenceRule, map: Record<string, number>): number | null {
    const until = rule.until ?? Infinity
    const maxIter = 10000
    if (!rule.count) {
      let cursor = after
      for (let i = 0; i < maxIter; i++) {
        const next = this.advanceRecurrence(cursor, rule)
        if (next === cursor) return null
        cursor = next
        if (cursor > until) return null
        if (rule.excluded_dates?.includes(cursor)) continue
        if (map[cursor] != null) continue
        return cursor
      }
      return null
    }
    // count 路径：从系列起点（after 与已完成/被排除实例的最小值）走序号
    let origin = after
    for (const k of Object.keys(map)) {
      const v = Number(k)
      if (Number.isFinite(v)) origin = Math.min(origin, v)
    }
    for (const e of rule.excluded_dates ?? []) origin = Math.min(origin, e)
    let cursor = origin
    let idx = 1
    for (let i = 0; i < maxIter; i++) {
      if (cursor > after) {
        if (cursor > until) return null
        if (idx > rule.count) return null
        if (!rule.excluded_dates?.includes(cursor) && map[cursor] == null) return cursor
      }
      const next = this.advanceRecurrence(cursor, rule)
      if (next === cursor) return null
      cursor = next
      idx++
    }
    return null
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
      recurrence_rule: row.recurrence_rule ? this.safeParseJson(row.recurrence_rule, null) : null,
      reminders: this.safeParseJson(row.reminders_json, []),
      started_at: row.started_at ?? null,
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

  /** 构建提醒 payload 时同时附带 i18n key 和参数，渲染进程可用 t() 本地化 */
  private buildReminderPayload(options: {
    title: string
    body: string
    clickTarget: string
    clickId: string
    i18nKey: string
    i18nParams: Record<string, string | number>
    startAt?: number
    dueAt?: number
  }): any {
    return {
      title: options.title,
      body: options.body,
      clickTarget: options.clickTarget,
      clickId: options.clickId,
      i18nKey: options.i18nKey,
      i18nParams: options.i18nParams,
      startAt: options.startAt,
      dueAt: options.dueAt,
    }
  }
}

export default CalendarService
