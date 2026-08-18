/**
 * calendar 内置插件主进程入口。
 * 由宿主日历服务（CalendarService / CalendarScheduler / OutlookAuth / OutlookSync / calendar.tool）迁移而来：
 * - 数据从内核主库一次性迁入插件分库（migrations，幂等建表 + 原子事务拷贝）
 * - IPC 经 ctx.ipc.handle 注册（通道自动加 plugin:calendar: 前缀，短名见 manifest 白名单），写操作后广播 data-changed
 * - agent 工具经 ctx.contributions.registerAgentTools 注入（工具 id 不变，老员工配置无需迁移）
 */
import type {
  PluginContext,
  PluginMigrationContext,
  PluginDatabase,
  PluginLegacyDatabase,
} from '../../../plugin-sdk/src'
import { getCalendarService, ensureCalendarTables } from './calendar-service'
import CalendarScheduler from './calendar-scheduler'
import { getOutlookAuthService } from './outlook-auth'
import { getOutlookSyncService } from './outlook-sync'
import { createCalendarTools } from './tools'

// ====== 迁移：内核主库 → 插件分库 ======

function countRows(db: PluginDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

/** 拷贝 events（旧表可能缺 tzid 列，用默认值兜底） */
function copyEvents(db: PluginDatabase, legacy: PluginLegacyDatabase): number {
  const rows = legacy.all('SELECT * FROM calendar_events') as any[]
  const stmt = db.prepare(
    `INSERT INTO calendar_events (id, title, description, location, start_at, end_at, all_day, tzid, color, recurrence_rule, reminders_json, employee_id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const r of rows) {
    stmt.run(
      r.id, r.title, r.description ?? '', r.location ?? '',
      r.start_at, r.end_at, r.all_day ? 1 : 0, r.tzid ?? '',
      r.color ?? 'default', r.recurrence_rule ?? '', r.reminders_json ?? '[]',
      r.employee_id ?? null, r.source ?? 'user', r.created_at, r.updated_at
    )
  }
  return rows.length
}

/** 拷贝 todos（旧表可能缺 tzid / started_at 列，用默认值兜底） */
function copyTodos(db: PluginDatabase, legacy: PluginLegacyDatabase): number {
  const rows = legacy.all('SELECT * FROM calendar_todos') as any[]
  const stmt = db.prepare(
    `INSERT INTO calendar_todos (id, title, description, due_at, tzid, priority, status, recurrence_rule, reminders_json, started_at, completed_at, employee_id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const r of rows) {
    stmt.run(
      r.id, r.title, r.description ?? '', r.due_at ?? null, r.tzid ?? '',
      r.priority ?? 'none', r.status ?? 'pending',
      r.recurrence_rule ?? '', r.reminders_json ?? '[]',
      r.started_at ?? null, r.completed_at ?? null,
      r.employee_id ?? null, r.source ?? 'user', r.created_at, r.updated_at
    )
  }
  return rows.length
}

function copyReminders(db: PluginDatabase, legacy: PluginLegacyDatabase): number {
  const rows = legacy.all('SELECT * FROM calendar_reminders') as any[]
  const stmt = db.prepare(
    `INSERT INTO calendar_reminders (id, target_type, target_id, trigger_at, fired_at, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  for (const r of rows) {
    stmt.run(r.id, r.target_type, r.target_id, r.trigger_at, r.fired_at ?? null, r.payload_json ?? '{}', r.created_at)
  }
  return rows.length
}

function copySyncMap(db: PluginDatabase, legacy: PluginLegacyDatabase): number {
  const rows = legacy.all('SELECT * FROM calendar_sync_map') as any[]
  const stmt = db.prepare(
    `INSERT INTO calendar_sync_map (target, local_type, local_id, remote_id, synced_updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  for (const r of rows) {
    stmt.run(r.target, r.local_type, r.local_id, r.remote_id, r.synced_updated_at, r.synced_at ?? Math.floor(Date.now() / 1000))
  }
  return rows.length
}

/** 拷贝设置（settings 表 KV → plugin_kv；token 为加密字符串，原样存储） */
function copySettings(db: PluginDatabase, legacy: PluginLegacyDatabase): void {
  const keys = ['calendar_settings', 'calendar_outlook_sync_config', 'calendar_outlook_sync_state', 'calendar_outlook_token']
  const stmt = db.prepare(
    `INSERT INTO plugin_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  for (const key of keys) {
    const raw = legacy.getSetting(key) as string | undefined
    if (raw != null) stmt.run(key, String(raw))
  }
}

const _migrations = [
  {
    version: '1-migrate-calendar-data',
    description: '迁移日历数据（事件/待办/提醒/同步映射/设置）从内核主库到插件分库',
    run(mig: PluginMigrationContext) {
      if (!mig.legacy) return
      const legacy = mig.legacy
      const db = mig.storage.openSqlite('index')
      ensureCalendarTables(db)
      try {
        const tables = new Set(legacy.listTables())
        const src = { events: 0, todos: 0, reminders: 0, sync_map: 0 }
        db.transaction(() => {
          if (tables.has('calendar_events')) src.events = copyEvents(db, legacy)
          if (tables.has('calendar_todos')) src.todos = copyTodos(db, legacy)
          if (tables.has('calendar_reminders')) src.reminders = copyReminders(db, legacy)
          if (tables.has('calendar_sync_map')) src.sync_map = copySyncMap(db, legacy)
          copySettings(db, legacy)
        })()
        const dst = {
          events: countRows(db, 'calendar_events'),
          todos: countRows(db, 'calendar_todos'),
          reminders: countRows(db, 'calendar_reminders'),
          sync_map: countRows(db, 'calendar_sync_map'),
        }
        if (src.events !== dst.events || src.todos !== dst.todos || src.reminders !== dst.reminders || src.sync_map !== dst.sync_map) {
          mig.logger.warn(
            `日历数据迁移行数不一致: events ${src.events}->${dst.events}, todos ${src.todos}->${dst.todos}, reminders ${src.reminders}->${dst.reminders}, sync_map ${src.sync_map}->${dst.sync_map}`
          )
        } else {
          mig.logger.info(
            `日历数据迁移完成: events=${dst.events}, todos=${dst.todos}, reminders=${dst.reminders}, sync_map=${dst.sync_map}`
          )
        }
      } catch (err: any) {
        mig.logger.warn('日历数据迁移失败（忽略，使用空数据）:', err?.message || err)
      }
    },
  },
]

export const migrations = _migrations

// ====== 激活 ======

let scheduler: CalendarScheduler | null = null
let outlookSync: ReturnType<typeof getOutlookSyncService> | null = null

export function activate(ctx: PluginContext): void {
  const calendar = getCalendarService(ctx)
  const auth = getOutlookAuthService(ctx)
  const sync = getOutlookSyncService(ctx)
  outlookSync = sync
  scheduler = new CalendarScheduler(ctx)
  registerIpc(ctx)
  ctx.contributions.registerAgentTools(createCalendarTools())
  scheduler.start()
  sync.start()
  ctx.services.logger.info('calendar 插件激活完成')
}

export function deactivate(): void {
  if (scheduler) {
    scheduler.stop()
    scheduler = null
  }
  if (outlookSync) {
    outlookSync.stop()
    outlookSync = null
  }
}

// ====== IPC ======

function broadcastDataChanged(ctx: PluginContext, scope: 'event' | 'todo' | 'settings'): void {
  ctx.ipc.broadcast('data-changed', { scope, ts: Date.now() })
}

function registerIpc(ctx: PluginContext): void {
  const calendar = getCalendarService(ctx)
  const auth = getOutlookAuthService(ctx)
  const sync = getOutlookSyncService(ctx)

  // ====== 事件 ======

  ctx.ipc.handle('list-events', (params: any) => {
    if (!params || typeof params.start_at !== 'number' || typeof params.end_at !== 'number') {
      return { error: '参数 start_at / end_at 必填' }
    }
    return calendar.listEvents(params)
  })

  ctx.ipc.handle('create-event', (input: any) => {
    if (!input?.title || typeof input.start_at !== 'number') {
      return { error: 'title 和 start_at 必填' }
    }
    const event = calendar.createEvent(input)
    broadcastDataChanged(ctx, 'event')
    return event
  })

  ctx.ipc.handle('update-event', (input: any) => {
    if (!input?.id) return { error: 'id 必填' }
    const event = calendar.updateEvent(input)
    if (event) broadcastDataChanged(ctx, 'event')
    return event
  })

  ctx.ipc.handle('delete-event', (params: any) => {
    if (!params?.id) return { error: 'id 必填' }
    const ok = calendar.deleteEvent(params.id)
    if (ok) broadcastDataChanged(ctx, 'event')
    return { success: ok }
  })

  ctx.ipc.handle('delete-event-instance', (params: any) => {
    if (!params?.id || typeof params.anchor_at !== 'number' || !params.mode) {
      return { error: 'id / anchor_at / mode 必填' }
    }
    const ok = calendar.deleteEventInstance(params)
    if (ok) broadcastDataChanged(ctx, 'event')
    return { success: ok }
  })

  // ====== TODO ======

  ctx.ipc.handle('list-todos', (params: any) => {
    return calendar.listTodos(params || {})
  })

  ctx.ipc.handle('list-todo-instances', (params: any) => {
    if (!params || typeof params.start_at !== 'number' || typeof params.end_at !== 'number') {
      return { error: '参数 start_at / end_at 必填' }
    }
    return calendar.listTodoInstances(params)
  })

  ctx.ipc.handle('create-todo', (input: any) => {
    if (!input?.title) return { error: 'title 必填' }
    const todo = calendar.createTodo(input)
    broadcastDataChanged(ctx, 'todo')
    return todo
  })

  ctx.ipc.handle('update-todo', (input: any) => {
    if (!input?.id) return { error: 'id 必填' }
    const todo = calendar.updateTodo(input)
    if (todo) broadcastDataChanged(ctx, 'todo')
    return todo
  })

  ctx.ipc.handle('delete-todo', (params: any) => {
    if (!params?.id) return { error: 'id 必填' }
    const ok = calendar.deleteTodo(params.id)
    if (ok) broadcastDataChanged(ctx, 'todo')
    return { success: ok }
  })

  ctx.ipc.handle('delete-todo-instance', (params: any) => {
    if (!params?.id || typeof params.anchor_at !== 'number' || !params.mode) {
      return { error: 'id / anchor_at / mode 必填' }
    }
    const ok = calendar.deleteTodoInstance(params)
    if (ok) broadcastDataChanged(ctx, 'todo')
    return { success: ok }
  })

  ctx.ipc.handle('complete-todo', (params: any) => {
    if (!params?.id) return { error: 'id 必填' }
    const todo = calendar.completeTodo(params.id, params.completed, params.instance_due_at)
    if (todo) broadcastDataChanged(ctx, 'todo')
    return todo
  })

  ctx.ipc.handle('todo-stats', () => {
    return calendar.getTodoStats()
  })

  // ====== 设置 ======

  ctx.ipc.handle('get-settings', () => {
    return calendar.getSettings()
  })

  ctx.ipc.handle('set-settings', (params: any) => {
    const next = calendar.setSettings(params || {})
    broadcastDataChanged(ctx, 'settings')
    return next
  })

  // ====== Outlook 同步 ======

  ctx.ipc.handle('outlook-login', async () => {
    const result = await auth.login()
    if ('error' in result && result.error) return { error: result.error }
    // 登录成功后立即触发一次全量同步
    sync.runSync().catch(() => { /* ignore */ })
    return sync.getStatus()
  })

  ctx.ipc.handle('outlook-logout', () => {
    auth.logout()
    sync.onLogout()
    return sync.getStatus()
  })

  ctx.ipc.handle('outlook-status', () => {
    return sync.getStatus()
  })

  ctx.ipc.handle('outlook-set-config', (params: any) => {
    sync.setConfig(params || {})
    return sync.getStatus()
  })

  ctx.ipc.handle('outlook-sync-now', async () => {
    return sync.syncNow()
  })
}
