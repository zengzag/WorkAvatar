/**
 * automation 内置插件主进程入口。
 * 由宿主自动化服务（AutomationService / AutomationSchedulerService / automation.tool / automation.handlers）迁移而来：
 * - 数据从内核主库一次性迁入插件分库（migrations，幂等建表 + 原子事务拷贝）
 * - IPC 经 ctx.ipc.handle 注册（通道自动加 plugin:automation: 前缀，短名见 manifest 白名单），写操作后广播 data-changed
 * - agent 工具经 ctx.contributions.registerAgentTools 注入（工具 id 不变，老员工配置无需迁移）
 * - 调度器经 ctx.services.scheduler.every(30s) 驱动
 * - conversation 删除双向同步：订阅 ctx.services.conversations.onDeleted 清理关联 run 记录
 */
import type {
  PluginContext,
  PluginMigrationContext,
  PluginDatabase,
  PluginLegacyDatabase,
} from '../../../plugin-sdk/src'
import { getAutomationService, ensureAutomationTables, resetAutomationService } from './automation-service'
import AutomationScheduler from './automation-scheduler'
import { createAutomationTools } from './tools'

// ====== 迁移：内核主库 → 插件分库 ======

function countRows(db: PluginDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

function copyTasks(db: PluginDatabase, legacy: PluginLegacyDatabase): number {
  const rows = legacy.all('SELECT * FROM automation_tasks') as any[]
  const stmt = db.prepare(
    `INSERT INTO automation_tasks
      (id, title, description, prompt, employee_id, provider_id, model_id, high_permission,
       start_at, recurrence_rule, is_enabled, notify_on_complete, retry_count, tags_json,
       last_run_at, next_run_at, last_status, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const r of rows) {
    stmt.run(
      r.id, r.title, r.description ?? '', r.prompt,
      r.employee_id, r.provider_id, r.model_id ?? null, r.high_permission ? 1 : 0,
      r.start_at, r.recurrence_rule ?? '', r.is_enabled ? 1 : 0,
      r.notify_on_complete ? 1 : 0, r.retry_count ?? 0, r.tags_json ?? '[]',
      r.last_run_at ?? null, r.next_run_at ?? null, r.last_status ?? 'idle', r.last_error ?? null,
      r.created_at, r.updated_at
    )
  }
  return rows.length
}

function copyRuns(db: PluginDatabase, legacy: PluginLegacyDatabase): number {
  const rows = legacy.all('SELECT * FROM automation_runs') as any[]
  const stmt = db.prepare(
    `INSERT INTO automation_runs
      (id, task_id, conversation_id, employee_id, provider_id, model_id,
       status, triggered_by, started_at, finished_at, duration_ms, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const r of rows) {
    stmt.run(
      r.id, r.task_id, r.conversation_id ?? null, r.employee_id, r.provider_id, r.model_id ?? null,
      r.status ?? 'running', r.triggered_by ?? 'scheduler', r.started_at,
      r.finished_at ?? null, r.duration_ms ?? null, r.error_message ?? null, r.created_at
    )
  }
  return rows.length
}

const _migrations = [
  {
    version: '1-migrate-automation-data',
    description: '迁移自动化数据（任务/执行历史）从内核主库到插件分库',
    run(mig: PluginMigrationContext) {
      if (!mig.legacy) return
      const legacy = mig.legacy
      const db = mig.storage.openSqlite('index')
      ensureAutomationTables(db)
      try {
        const tables = new Set(legacy.listTables())
        const src = { tasks: 0, runs: 0 }
        db.transaction(() => {
          if (tables.has('automation_tasks')) src.tasks = copyTasks(db, legacy)
          if (tables.has('automation_runs')) src.runs = copyRuns(db, legacy)
        })()
        const dst = {
          tasks: countRows(db, 'automation_tasks'),
          runs: countRows(db, 'automation_runs'),
        }
        if (src.tasks !== dst.tasks || src.runs !== dst.runs) {
          mig.logger.warn(
            `自动化数据迁移行数不一致: tasks ${src.tasks}->${dst.tasks}, runs ${src.runs}->${dst.runs}`
          )
        } else {
          mig.logger.info(
            `自动化数据迁移完成: tasks=${dst.tasks}, runs=${dst.runs}`
          )
        }
      } catch (err: any) {
        mig.logger.warn('自动化数据迁移失败（忽略，使用空数据）:', err?.message || err)
      }
    },
  },
]

export const migrations = _migrations

// ====== 激活 ======

let scheduler: AutomationScheduler | null = null
let unsubscribeConversationDeleted: (() => void) | null = null
let unsubscribeModelRenamed: (() => void) | null = null

export function activate(ctx: PluginContext): void {
  const service = getAutomationService(ctx)
  scheduler = new AutomationScheduler(ctx)
  registerIpc(ctx)
  ctx.contributions.registerAgentTools(createAutomationTools(ctx))
  // conversation 删除双向同步：内核删除对话 → 清理关联 run 记录
  unsubscribeConversationDeleted = ctx.services.events!.subscribe('conversation:deleted', (conversationId) => {
    try { service.deleteRunByConversation(conversationId as string) } catch { /* ignore */ }
  })
  // 模型重命名同步：内核重命名模型 → 更新任务/执行历史中的 model_id
  unsubscribeModelRenamed = ctx.services.events!.subscribe('model:renamed', (payload) => {
    try {
      const { providerId, renames } = payload as { providerId: string; renames: Record<string, string> }
      service.syncModelRenames(providerId, renames)
    } catch { /* ignore */ }
  })
  scheduler.start()
  ctx.services.logger.info('automation 插件激活完成')
}

export function deactivate(): void {
  if (scheduler) {
    scheduler.stop()
    scheduler = null
  }
  if (unsubscribeConversationDeleted) {
    unsubscribeConversationDeleted()
    unsubscribeConversationDeleted = null
  }
  if (unsubscribeModelRenamed) {
    unsubscribeModelRenamed()
    unsubscribeModelRenamed = null
  }
  resetAutomationService()
}

// ====== IPC ======

function broadcastDataChanged(ctx: PluginContext, scope: 'task' | 'run' | 'settings'): void {
  ctx.ipc.broadcast('data-changed', { scope, ts: Date.now() })
}

function registerIpc(ctx: PluginContext): void {
  const service = getAutomationService(ctx)

  // ====== 任务 CRUD ======

  ctx.ipc.handle('list-tasks', (params: any) => {
    return service.listTasks(params || {})
  })

  ctx.ipc.handle('get-task', (id: string) => {
    if (!id) return { error: 'id 必填' }
    return service.getTask(id)
  })

  ctx.ipc.handle('create-task', (input: any) => {
    if (!input?.title?.trim()) return { error: 'title 必填' }
    if (!input?.prompt?.trim()) return { error: 'prompt 必填' }
    if (!input?.employee_id) return { error: 'employee_id 必填' }
    if (!input?.provider_id) return { error: 'provider_id 必填' }
    if (typeof input?.start_at !== 'number') return { error: 'start_at 必填' }
    try {
      const task = service.createTask(input)
      broadcastDataChanged(ctx, 'task')
      return task
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('update-task', (input: any) => {
    if (!input?.id) return { error: 'id 必填' }
    try {
      const task = service.updateTask(input)
      if (task) broadcastDataChanged(ctx, 'task')
      return task
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('delete-task', async (params: any) => {
    if (!params?.id) return { error: 'id 必填' }
    try {
      const ok = await service.deleteTask(params.id)
      if (ok) broadcastDataChanged(ctx, 'task')
      return { success: ok }
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('toggle-task', (params: any) => {
    if (!params?.id) return { error: 'id 必填' }
    const task = service.toggleTask(params.id, params.enabled)
    if (task) broadcastDataChanged(ctx, 'task')
    return task
  })

  // ====== 执行 ======

  ctx.ipc.handle('run-now', async (params: any) => {
    if (!params?.id) return { error: 'id 必填' }
    try {
      const run = await service.runTask(params.id, 'manual')
      broadcastDataChanged(ctx, 'run')
      broadcastDataChanged(ctx, 'task')
      return run
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('preview-runs', (params: any) => {
    if (!params?.task_id) return { error: 'task_id 必填' }
    const task = service.getTask(params.task_id)
    if (!task) return { error: '任务不存在' }
    const count = Math.max(1, Math.min(10, params.count ?? 5))
    const runs = service.previewNextRuns(task, count)
    return { runs }
  })

  // ====== 运行历史 CRUD ======

  ctx.ipc.handle('list-runs', (params: any) => {
    return service.listRuns(params || {})
  })

  ctx.ipc.handle('delete-run', async (params: any) => {
    if (!params?.id) return { error: 'id 必填' }
    try {
      const ok = await service.deleteRun(params.id)
      if (ok) broadcastDataChanged(ctx, 'run')
      return { success: ok }
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('clear-runs', async (params: any) => {
    try {
      const count = await service.clearRuns(params?.task_id)
      broadcastDataChanged(ctx, 'run')
      return { success: true, count }
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })
}
