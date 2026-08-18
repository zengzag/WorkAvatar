/**
 * Outlook 单向同步引擎：本地 SQLite → Outlook（Graph API）。
 * 由宿主 outlook-sync.service.ts 迁移而来。差异点：
 * - 不再继承 ScheduledTaskBase：start() 立即跑一次 runCheck + every(60s)，stop() 取消
 * - 配置/状态存插件库 plugin_kv（calendar_outlook_sync_config / calendar_outlook_sync_state），映射表 calendar_sync_map
 * - broadcast() 改走 ctx.ipc.broadcast('outlook-sync-changed', status)
 */
import type { PluginContext } from '../../../plugin-sdk/src'
import type {
  CalendarEvent,
  CalendarTodo,
  OutlookSyncConfig,
  OutlookSyncResult,
  OutlookSyncStatus,
  RecurrenceRule,
} from './calendar-service'
import { getCalendarService } from './calendar-service'
import { getOutlookAuthService } from './outlook-auth'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
/** 推送到 Outlook 的目标日历名 / To Do 列表名 */
const TARGET_NAME = 'WorkAvatar'
const CONFIG_KEY = 'calendar_outlook_sync_config'
const STATE_KEY = 'calendar_outlook_sync_state'

const DEFAULT_CONFIG: OutlookSyncConfig = {
  enabled: true,
  auto_sync: true,
  sync_events: true,
  sync_todos: true,
}

const BYDAY_MAP: Record<string, string> = {
  SU: 'sunday', MO: 'monday', TU: 'tuesday', WE: 'wednesday',
  TH: 'thursday', FR: 'friday', SA: 'saturday',
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

class OutlookSyncService {
  private db: any
  private schedulerJob: string | null = null
  private syncing = false
  private lastDataVersion = ''
  private calendarId: string | null = null
  private todoListId: string | null = null

  constructor(private ctx: PluginContext) {
    this.db = ctx.storage.openSqlite('index')
    this.db.exec('CREATE TABLE IF NOT EXISTS plugin_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_sync_map (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL,
        local_type TEXT NOT NULL,
        local_id TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        synced_updated_at INTEGER NOT NULL,
        synced_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_sync_map_unique ON calendar_sync_map(target, local_type, local_id);
    `)
  }

  start(): void {
    // 启动先跑一次（变化即同步），随后每 60 秒检查
    this.runCheck()
    this.schedulerJob = this.ctx.services.scheduler!.every(60_000, () => this.runCheck())
  }

  stop(): void {
    if (this.schedulerJob) {
      this.ctx.services.scheduler!.cancel(this.schedulerJob)
      this.schedulerJob = null
    }
  }

  // ====== 配置 / 状态持久化 ======

  getConfig(): OutlookSyncConfig {
    try {
      const row = this.db.prepare('SELECT value FROM plugin_kv WHERE key = ?').get(CONFIG_KEY) as { value?: string } | undefined
      if (row?.value) return { ...DEFAULT_CONFIG, ...JSON.parse(row.value) }
    } catch { /* ignore */ }
    return { ...DEFAULT_CONFIG }
  }

  setConfig(partial: Partial<OutlookSyncConfig>): OutlookSyncConfig {
    const next = { ...this.getConfig(), ...partial }
    this.db.prepare(
      `INSERT INTO plugin_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(CONFIG_KEY, JSON.stringify(next))
    return next
  }

  private loadState(): { last_result: OutlookSyncResult | null; last_error: string | null } {
    try {
      const row = this.db.prepare('SELECT value FROM plugin_kv WHERE key = ?').get(STATE_KEY) as { value?: string } | undefined
      if (row?.value) return JSON.parse(row.value)
    } catch { /* ignore */ }
    return { last_result: null, last_error: null }
  }

  private saveState(state: { last_result: OutlookSyncResult | null; last_error: string | null }): void {
    this.db.prepare(
      `INSERT INTO plugin_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(STATE_KEY, JSON.stringify(state))
  }

  getStatus(): OutlookSyncStatus {
    const auth = getOutlookAuthService(this.ctx)
    const state = this.loadState()
    return {
      signed_in: auth.isLoggedIn(),
      account: auth.getAccount(),
      config: this.getConfig(),
      syncing: this.syncing,
      last_result: state.last_result,
      last_error: state.last_error,
    }
  }

  /** 登出时清空映射（换账号后旧 remote_id 无效，重新登录会全量重建） */
  onLogout(): void {
    this.db.prepare('DELETE FROM calendar_sync_map WHERE target = ?').run('outlook')
    this.calendarId = null
    this.todoListId = null
    this.lastDataVersion = ''
    this.saveState({ last_result: null, last_error: null })
    this.broadcast()
  }

  // ====== 调度 ======

  /** 数据版本指纹：updated_at 最大值 + 行数，变化则触发同步 */
  private computeDataVersion(): string {
    const e = this.db.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), 0) AS m FROM calendar_events').get() as any
    const t = this.db.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), 0) AS m FROM calendar_todos').get() as any
    return `${e.c}:${e.m}|${t.c}:${t.m}`
  }

  private async runCheck(): Promise<void> {
    const cfg = this.getConfig()
    if (!cfg.enabled || !cfg.auto_sync) return
    if (!getOutlookAuthService(this.ctx).isLoggedIn()) return
    const version = this.computeDataVersion()
    if (version === this.lastDataVersion) return
    this.lastDataVersion = version
    await this.runSync()
  }

  /** 手动触发同步（设置面板"立即同步"） */
  async syncNow(): Promise<OutlookSyncStatus> {
    await this.runSync()
    return this.getStatus()
  }

  private broadcast(): void {
    this.ctx.ipc.broadcast('outlook-sync-changed', this.getStatus())
  }

  // ====== 同步主流程 ======

  async runSync(): Promise<void> {
    const auth = getOutlookAuthService(this.ctx)
    if (this.syncing || !auth.isLoggedIn()) return
    const cfg = this.getConfig()
    if (!cfg.enabled) return

    this.syncing = true
    this.broadcast()
    const result: OutlookSyncResult = { created: 0, updated: 0, deleted: 0, failed: 0, errors: [], synced_at: Math.floor(Date.now() / 1000) }
    try {
      const token = await auth.getAccessToken()
      if (!token) throw new Error('登录已过期，请重新登录 Outlook 账号')

      if (cfg.sync_events) {
        this.calendarId = await this.ensureTargetCalendar(token)
        await this.syncEvents(token, result)
      }
      if (cfg.sync_todos) {
        this.todoListId = await this.ensureTodoList(token)
        await this.syncTodos(token, result)
      }
      this.saveState({ last_result: result, last_error: result.failed > 0 ? `${result.failed} 条同步失败` : null })
      this.ctx.services.logger.info(`Sync done: +${result.created} ~${result.updated} -${result.deleted} !${result.failed}`)
    } catch (err: any) {
      this.ctx.services.logger.error('Sync failed:', err?.message)
      this.saveState({ ...this.loadState(), last_error: err?.message || '同步失败' })
    } finally {
      this.syncing = false
      this.lastDataVersion = this.computeDataVersion()
      this.broadcast()
    }
  }

  // ====== Graph API 请求 ======

  private async graph(token: string, method: string, path: string, body?: any): Promise<any> {
    const doFetch = async (tk: string) => fetch(`${GRAPH_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${tk}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    let resp = await doFetch(token)
    if (resp.status === 401) {
      // token 失效，刷新后重试一次
      const fresh = await getOutlookAuthService(this.ctx).getAccessToken()
      if (!fresh) throw new Error('登录已过期，请重新登录 Outlook 账号')
      resp = await doFetch(fresh)
    }
    if (resp.status === 204) return null
    const json = resp.status === 204 ? null : await resp.json().catch(() => null)
    if (!resp.ok) {
      const detail = JSON.stringify(json?.error || json)
      this.ctx.services.logger.error(`Graph ${method} ${path} -> ${resp.status}: ${detail}`)
      throw new Error(json?.error?.message || `Graph ${method} ${path} 失败 (${resp.status})`)
    }
    return json
  }

  /** 确保 Outlook 侧存在名为 WorkAvatar 的日历 */
  private async ensureTargetCalendar(token: string): Promise<string> {
    const found = await this.graph(token, 'GET', `/me/calendars?$filter=${encodeURIComponent(`name eq '${TARGET_NAME}'`)}&$select=id,name`)
    if (found?.value?.length) return found.value[0].id
    const created = await this.graph(token, 'POST', '/me/calendars', { name: TARGET_NAME })
    this.ctx.services.logger.info(`Created Outlook calendar "${TARGET_NAME}"`)
    return created.id
  }

  /** 确保存在名为 WorkAvatar 的 To Do 列表 */
  private async ensureTodoList(token: string): Promise<string> {
    // 注意：/me/todo/lists 不支持 $select 投影（会返回 400 RequestBroker--ParseUri），需拉全量
    const lists = await this.graph(token, 'GET', '/me/todo/lists')
    const hit = (lists?.value || []).find((l: any) => l.displayName === TARGET_NAME)
    if (hit) return hit.id
    const created = await this.graph(token, 'POST', '/me/todo/lists', { displayName: TARGET_NAME })
    this.ctx.services.logger.info(`Created To Do list "${TARGET_NAME}"`)
    return created.id
  }

  // ====== 事件同步 ======

  private async syncEvents(token: string, result: OutlookSyncResult): Promise<void> {
    const calendar = getCalendarService(this.ctx)
    const items = calendar.listAllEvents()
    const mapRows = this.loadMap('event')
    const mapByLocal = new Map(mapRows.map(r => [r.local_id, r]))
    const localIds = new Set(items.map(i => i.id))

    for (const event of items) {
      const mapping = mapByLocal.get(event.id)
      const body = this.eventToGraphBody(event)
      try {
        if (!mapping) {
          const created = await this.graph(token, 'POST', `/me/calendars/${this.calendarId}/events`, body)
          this.upsertMap('event', event.id, created.id, event.updated_at)
          result.created++
        } else if (event.updated_at > mapping.synced_updated_at) {
          await this.graph(token, 'PATCH', `/me/events/${mapping.remote_id}`, body)
          this.upsertMap('event', event.id, mapping.remote_id, event.updated_at)
          result.updated++
        }
      } catch (err: any) {
        result.failed++
        this.pushError(result, `事件「${event.title}」: ${err?.message || err}`)
      }
      await sleep(150)
    }

    await this.syncDeletions(token, 'event', localIds, mapRows, result)
  }

  // ====== TODO 同步 ======

  private async syncTodos(token: string, result: OutlookSyncResult): Promise<void> {
    const calendar = getCalendarService(this.ctx)
    const items = calendar.listAllTodos()
    const mapRows = this.loadMap('todo')
    const mapByLocal = new Map(mapRows.map(r => [r.local_id, r]))
    const localIds = new Set(items.map(i => i.id))

    for (const todo of items) {
      const mapping = mapByLocal.get(todo.id)
      const body = this.todoToGraphBody(todo, !mapping)
      try {
        if (!mapping) {
          const created = await this.graph(token, 'POST', `/me/todo/lists/${this.todoListId}/tasks`, body)
          this.upsertMap('todo', todo.id, created.id, todo.updated_at)
          result.created++
        } else if (todo.updated_at > mapping.synced_updated_at) {
          await this.graph(token, 'PATCH', `/me/todo/lists/${this.todoListId}/tasks/${mapping.remote_id}`, body)
          this.upsertMap('todo', todo.id, mapping.remote_id, todo.updated_at)
          result.updated++
        }
      } catch (err: any) {
        result.failed++
        this.pushError(result, `待办「${todo.title}」: ${err?.message || err}`)
      }
      await sleep(150)
    }

    await this.syncDeletions(token, 'todo', localIds, mapRows, result)
  }

  /** 映射中存在但本地已删除的记录 → 删除远端对象 */
  private async syncDeletions(token: string, type: 'event' | 'todo', localIds: Set<string>, mapRows: any[], result: OutlookSyncResult): Promise<void> {
    for (const mapping of mapRows) {
      if (localIds.has(mapping.local_id)) continue
      try {
        const path = type === 'event'
          ? `/me/events/${mapping.remote_id}`
          : `/me/todo/lists/${this.todoListId}/tasks/${mapping.remote_id}`
        await this.graph(token, 'DELETE', path)
        this.deleteMap(type, mapping.local_id)
        result.deleted++
      } catch (err: any) {
        result.failed++
        this.pushError(result, `删除${type === 'event' ? '事件' : '待办'} ${mapping.local_id}: ${err?.message || err}`)
      }
      await sleep(150)
    }
  }

  private pushError(result: OutlookSyncResult, msg: string): void {
    if (result.errors.length < 5) result.errors.push(msg)
  }

  // ====== 映射表操作 ======

  private loadMap(type: 'event' | 'todo'): any[] {
    return this.db.prepare('SELECT * FROM calendar_sync_map WHERE target = ? AND local_type = ?').all('outlook', type)
  }

  private upsertMap(type: 'event' | 'todo', localId: string, remoteId: string, syncedUpdatedAt: number): void {
    this.db.prepare(
      `INSERT INTO calendar_sync_map (target, local_type, local_id, remote_id, synced_updated_at, synced_at)
       VALUES ('outlook', ?, ?, ?, ?, unixepoch())
       ON CONFLICT(target, local_type, local_id) DO UPDATE SET remote_id = excluded.remote_id, synced_updated_at = excluded.synced_updated_at, synced_at = excluded.synced_at`
    ).run(type, localId, remoteId, syncedUpdatedAt)
  }

  private deleteMap(type: 'event' | 'todo', localId: string): void {
    this.db.prepare('DELETE FROM calendar_sync_map WHERE target = ? AND local_type = ? AND local_id = ?').run('outlook', type, localId)
  }

  // ====== 字段转换 ======

  private get systemTz(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  }

  /** unix 秒 → Graph dateTimeTimeZone。全天事件用纯日期(YYYY-MM-DD)，否则 YYYY-MM-DDTHH:mm:ss */
  private toGraphDateTime(unixSec: number, tzid: string, allDay = false): { dateTime: string; timeZone: string } {
    const tz = tzid || this.systemTz
    const d = new Date(unixSec * 1000)
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(d)
    const get = (t: string) => parts.find(p => p.type === t)?.value || '00'
    const dateStr = `${get('year')}-${get('month')}-${get('day')}`
    if (allDay) return { dateTime: dateStr, timeZone: tz }
    return { dateTime: `${dateStr}T${get('hour')}:${get('minute')}:${get('second')}`, timeZone: tz }
  }

  private reminderToGraph(reminders: number[]): { isReminderOn: boolean; reminderMinutesBeforeStart?: number } {
    if (!reminders?.length) return { isReminderOn: false }
    // Graph 事件仅支持单个提醒，取最早（绝对值最大）的一个；上限 20160 分钟（14 天）
    const minutes = Math.min(Math.max(...reminders.map(r => Math.abs(r))), 20160)
    return { isReminderOn: true, reminderMinutesBeforeStart: minutes }
  }

  /**
   * 本地 RecurrenceRule → Graph patternedRecurrence。
   * bysetpos / rdates / 多值 bymonthday、实例级 overrides（单实例取消/修改）不精细同步，仅同步主规则。
   */
  private ruleToGraphRecurrence(rule: RecurrenceRule, startSec: number, tzid: string): any {
    const tz = tzid || this.systemTz
    const startDate = this.toGraphDateTime(startSec, tz, true).dateTime
    const dayOfMonth = Number(startDate.slice(8, 10))
    const month = Number(startDate.slice(5, 7))
    // Graph 的 absoluteMonthly 不接受负数（最后一天用 -1），越界时回退到开始日
    const ruleDay = rule.bymonthday?.[0]
    const graphDay = ruleDay && ruleDay > 0 ? ruleDay : dayOfMonth

    let pattern: any
    switch (rule.freq) {
      case 'daily':
        pattern = { type: 'daily', interval: rule.interval }
        break
      case 'weekly': {
        const days = rule.byday?.length
          ? rule.byday.map(d => BYDAY_MAP[d]).filter(Boolean)
          : [new Date(startSec * 1000).toLocaleString('en-US', { timeZone: tz, weekday: 'long' }).toLowerCase()]
        pattern = { type: 'weekly', interval: rule.interval, daysOfWeek: days }
        break
      }
      case 'monthly':
        pattern = { type: 'absoluteMonthly', interval: rule.interval, dayOfMonth: graphDay }
        break
      case 'yearly':
        pattern = { type: 'absoluteYearly', interval: rule.interval, dayOfMonth: graphDay, month: rule.bymonth?.[0] ?? month }
        break
      default:
        return undefined
    }

    let range: any
    if (rule.count) {
      range = { type: 'numbered', startDate, numberOfOccurrences: rule.count }
    } else if (rule.until) {
      const endDate = this.toGraphDateTime(rule.until * 1000, tz, true).dateTime
      // Graph 要求 startDate <= endDate；截至日早于开始日说明规则已失效，不同步主规则
      if (endDate < startDate) return undefined
      range = { type: 'endDate', startDate, endDate }
    } else {
      range = { type: 'noEnd', startDate }
    }
    return { pattern, range }
  }

  private eventToGraphBody(event: CalendarEvent): any {
    const tz = event.tzid
    const start = this.toGraphDateTime(event.start_at, tz, event.all_day)
    let end = this.toGraphDateTime(event.end_at, tz, event.all_day)
    if (event.all_day) {
      // 全天事件 end 必须 strict 大于 start（纯日期比较，至少 +1 天）
      if (end.dateTime <= start.dateTime) end.dateTime = this.addDays(start.dateTime, 1)
    } else if (event.end_at <= event.start_at) {
      // 异常数据：end 早于 start，兜底为开始后 1 分钟
      end = this.toGraphDateTime(event.start_at + 60, tz)
    }
    const body: any = {
      subject: event.title,
      body: { contentType: 'text', content: event.description || '' },
      start,
      end,
      isAllDay: event.all_day,
      categories: [TARGET_NAME],
      ...this.reminderToGraph(event.reminders),
    }
    if (event.location) body.location = { displayName: event.location }
    const recurrence = event.recurrence_rule ? this.ruleToGraphRecurrence(event.recurrence_rule, event.start_at, tz) : undefined
    if (recurrence) body.recurrence = recurrence
    return body
  }

  /** 'YYYY-MM-DD' 纯日期 +N 天（UTC 计算避免时区偏移） */
  private addDays(dateStr: string, days: number): string {
    const [y, m, d] = dateStr.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
  }

  private todoToGraphBody(todo: CalendarTodo, isCreate = true): any {
    const tz = todo.tzid
    const importance = todo.priority === 'high' ? 'high' : todo.priority === 'low' ? 'low' : 'normal'
    const status = todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'inProgress' : 'notStarted'
    const body: any = {
      title: todo.title,
      body: { contentType: 'text', content: todo.description || '' },
      importance,
      status,
    }
    if (todo.due_at) body.dueDateTime = this.toGraphDateTime(todo.due_at, tz)
    // Graph 要求 completedDateTime 仅当 status=completed 时存在，否则 400
    if (todo.status === 'completed' && todo.completed_at) body.completedDateTime = this.toGraphDateTime(todo.completed_at, tz)

    // To Do 提醒基于截止时间；提醒时刻已过去则不设置
    if (todo.reminders?.length && todo.due_at) {
      const offsetMin = Math.max(...todo.reminders.map(r => Math.abs(r)))
      const remindAt = todo.due_at - offsetMin * 60
      if (remindAt > Math.floor(Date.now() / 1000)) {
        body.isReminderOn = true
        body.reminderDateTime = this.toGraphDateTime(remindAt, tz)
      }
    }

    const recurrence = todo.recurrence_rule && todo.due_at
      ? this.ruleToGraphRecurrence(todo.recurrence_rule, todo.due_at, tz)
      : undefined
    if (recurrence) {
      if (isCreate) {
        body.recurrence = recurrence
      } else {
        // To-Do 服务端 bug：PATCH 携带 range.startDate 纯日期会报 Edm.Date 转换错误。
        // 规避：仅同步 pattern，range 置空由服务端重建（社区验证的 workaround）
        body.recurrence = { pattern: recurrence.pattern, range: {} }
      }
    }
    return body
  }
}

let _instance: OutlookSyncService | null = null

export function getOutlookSyncService(ctx?: PluginContext): OutlookSyncService {
  if (!_instance) {
    if (!ctx) throw new Error('OutlookSyncService 未初始化：缺少 PluginContext')
    _instance = new OutlookSyncService(ctx)
  }
  return _instance
}

export default getOutlookSyncService
