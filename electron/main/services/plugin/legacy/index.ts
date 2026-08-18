/**
 * ─────────────────────────────────────────────────────────────────────────
 * 插件化迁出遗留（LEGACY）
 *
 * 背景：日历(calendar)、语音(voice) 等原为内核内置功能，现已整体迁为独立的第三方插件，
 * 数据在插件首次激活时一次性迁入插件各自的分库。内核侧不再使用这些数据，仅为迁出旧库
 * 数据 / 兼容旧字段而保留本目录的代码。可在确认存量用户都完成升级后整体删除本目录。
 *
 * 待整体移除清单（含因嵌入大块 SQL 未抽取、仍在原文件中的项）：
 *  - database.service.ts `createSchema`：calendar_events / calendar_todos /
 *    calendar_reminders / calendar_sync_map 的建表语句与索引
 *  - kms-database.service.ts `createSchema`：kms_voice_tasks 的建表语句与索引
 *  - 行为型兼容逻辑见下方各导出函数
 * ─────────────────────────────────────────────────────────────────────────
 */
import fs from 'fs'
import type Database from 'better-sqlite3'
import { createLogger } from '../../logger'

const logger = createLogger('Legacy')

/** 内核主库 / KMS 向量库连接 */
type Db = Database.Database

/**
 * 旧库字段兼容：日历表列（CalDAV 时区 / started_at / tags_json）。
 * 由 database.service 调用，等价于原内联 addColumnIfNotExists / dropColumnIfExists。
 */
export function migrateCalendarLegacyColumns(
  addColumn: (table: string, column: string, definition: string) => boolean,
  dropColumn: (table: string, column: string) => void,
): void {
  addColumn('calendar_todos', 'started_at', 'INTEGER')
  addColumn('calendar_events', 'tzid', "TEXT NOT NULL DEFAULT ''")
  addColumn('calendar_todos', 'tzid', "TEXT NOT NULL DEFAULT ''")
  dropColumn('calendar_todos', 'tags_json')
}

/**
 * CalDAV 兼容迁移：将旧版 recurrence_rule JSON 转换为新数据模型。
 * - freq: 'weekdays' → freq: 'weekly' + byday: ['MO','TU','WE','TH','FR']
 * - excluded_dates[] → overrides[] status='cancelled'
 * - completed_instances[] → overrides[] status='completed'
 * - 移除 weekdays / excluded_dates / completed_instances 字段
 * 版本化确保只执行一次。
 */
export function migrateCalendarRecurrenceRule(db: Db): void {
  const MIGRATION_VERSION = 'caldav_v1'
  const versionRow = db.prepare("SELECT value FROM settings WHERE key = 'calendar_recurrence_migration_version'").get() as { value: string } | undefined
  if (versionRow?.value === MIGRATION_VERSION) return

  const tables = ['calendar_events', 'calendar_todos'] as const
  let migrated = 0

  for (const table of tables) {
    const rows = db.prepare(`SELECT id, recurrence_rule FROM ${table} WHERE recurrence_rule IS NOT NULL AND recurrence_rule != ''`).all() as Array<{ id: string; recurrence_rule: string }>
    if (rows.length === 0) continue

    const updateStmt = db.prepare(`UPDATE ${table} SET recurrence_rule = ? WHERE id = ?`)
    const tx = db.transaction((items: typeof rows) => {
      for (const r of items) {
        try {
          const rule = JSON.parse(r.recurrence_rule)
          if (!rule || typeof rule !== 'object') continue
          let changed = false

          if (rule.freq === 'weekdays') {
            rule.freq = 'weekly'
            rule.byday = ['MO', 'TU', 'WE', 'TH', 'FR']
            changed = true
          }

          const excluded: number[] = Array.isArray(rule.excluded_dates) ? rule.excluded_dates : []
          const completed: number[] = Array.isArray(rule.completed_instances) ? rule.completed_instances : []
          if (excluded.length > 0 || completed.length > 0) {
            const existingOverrides = Array.isArray(rule.overrides) ? rule.overrides : []
            const overrideMap = new Map(existingOverrides.map((o: any) => [o.recurrence_id, o]))
            for (const ts of excluded) {
              overrideMap.set(ts, { ...(overrideMap.get(ts) ?? {}), recurrence_id: ts, status: 'cancelled' })
            }
            for (const ts of completed) {
              overrideMap.set(ts, { ...(overrideMap.get(ts) ?? {}), recurrence_id: ts, status: 'completed' })
            }
            rule.overrides = Array.from(overrideMap.values())
            delete rule.excluded_dates
            delete rule.completed_instances
            changed = true
          }

          if (changed) {
            updateStmt.run(JSON.stringify(rule), r.id)
            migrated++
          }
        } catch { /* skip invalid JSON */ }
      }
    })
    tx(rows)
  }

  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('calendar_recurrence_migration_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()"
  ).run(MIGRATION_VERSION)

  if (migrated > 0) {
    logger.info(`Legacy CalDAV migration: converted ${migrated} calendar recurrence_rule records to overrides model`)
  }
}

/**
 * 旧库字段兼容：语音任务表列（secondary_audio_path / notes）。
 * 由 kms-database.service 调用。
 */
export function ensureVoiceLegacyColumns(db: Db): void {
  const voiceCols = db.prepare('PRAGMA table_info(kms_voice_tasks)').all() as any[]
  const voiceColNames = voiceCols.map((c: any) => c.name)
  if (!voiceColNames.includes('secondary_audio_path')) {
    db.exec('ALTER TABLE kms_voice_tasks ADD COLUMN secondary_audio_path TEXT')
  }
  if (!voiceColNames.includes('notes')) {
    db.exec("ALTER TABLE kms_voice_tasks ADD COLUMN notes TEXT DEFAULT ''")
  }
}

/**
 * 旧库数据清理（voice 迁出前由内核承载的录音任务渐进清理）：
 * - 30 天前已完成/失败：清空 transcript/minutes 等大文本字段（保留元数据）
 * - 180 天前已完成/失败：整条删除（含关联音频文件）
 * 由 kms-database.service autoCleanup 调用。
 */
export function cleanupVoiceLegacy(db: Db, now: number): void {
  try {
    const cutoff30 = now - 30 * 86400
    const result = db.prepare(`
      UPDATE kms_voice_tasks
      SET transcript = '', transcript_segments_json = '[]', minutes = ''
      WHERE status IN ('completed', 'error') AND updated_at < ?
        AND (transcript != '' OR minutes != '')
    `).run(cutoff30)
    if (result.changes > 0) {
      logger.info(`Legacy cleanup: cleared ${result.changes} old voice task large text fields`)
    }
  } catch (err: any) {
    logger.warn('Legacy cleanup voice large text failed:', err?.message || err)
  }

  try {
    const cutoff180 = now - 180 * 86400
    const oldTasks = db.prepare(
      `SELECT id, audio_path, secondary_audio_path FROM kms_voice_tasks
       WHERE status IN ('completed', 'error') AND updated_at < ?`
    ).all(cutoff180) as any[]
    if (oldTasks.length > 0) {
      for (const t of oldTasks) {
        if (t.audio_path) { try { fs.unlinkSync(t.audio_path) } catch { /* ignore */ } }
        if (t.secondary_audio_path) { try { fs.unlinkSync(t.secondary_audio_path) } catch { /* ignore */ } }
      }
      const ids = oldTasks.map((t: any) => t.id)
      for (let i = 0; i < ids.length; i += 500) {
        const batch = ids.slice(i, i + 500)
        const placeholders = batch.map(() => '?').join(',')
        db.prepare(`DELETE FROM kms_voice_tasks WHERE id IN (${placeholders})`).run(...batch)
      }
      logger.info(`Legacy cleanup: removed ${oldTasks.length} voice tasks older than 180 days`)
    }
  } catch (err: any) {
    logger.warn('Legacy cleanup voice tasks failed:', err?.message || err)
  }
}