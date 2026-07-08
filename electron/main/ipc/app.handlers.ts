import { dialog, app, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  SettingsGetParams,
  SettingsSetParams,
  AppShowOpenDialogParams,
  AppShowSaveDialogParams,
} from '../../shared/ipc-channels'
import type DatabaseService from '../services/database.service'
import PathService from '../services/path.service'
import { safeHandle } from './_shared'

// 清除数据时保留的 settings 键（应用级配置，不属于"用户数据"）
const PRESERVED_SETTINGS_KEYS = new Set([
  'kms_auto_index',
  'web_search_engine',
  'web_search_result_count',
])

// 需要清空的用户数据表（按依赖顺序，受外键约束）
const USER_DATA_TABLES = [
  'employee_memories',
  'employee_skills',
  'employee_tools',
  'installed_skills',
  'feedbacks',
  'conversations',
  'skills',
  'tools',
  'llm_providers',
  'employees',
]

export function registerAppHandlers(
  db: ReturnType<DatabaseService['getDb']>
) {
  // 缓存 prepared statement，避免每次调用都重新编译 SQL
  const settingsGetStmt = db.prepare('SELECT value FROM settings WHERE key = ?')
  const settingsSetStmt = db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  )

  safeHandle(IPC_CHANNELS.APP_SHOW_OPEN_DIALOG, async (params: AppShowOpenDialogParams) => {
    const result = await dialog.showOpenDialog({
      title: params.title,
      defaultPath: params.defaultPath,
      buttonLabel: params.buttonLabel,
      filters: params.filters,
      properties: params.properties,
    })
    return result
  })

  safeHandle(IPC_CHANNELS.APP_SHOW_SAVE_DIALOG, async (params: AppShowSaveDialogParams) => {
    const result = await dialog.showSaveDialog({
      title: params.title,
      defaultPath: params.defaultPath,
      buttonLabel: params.buttonLabel,
      filters: params.filters,
    })
    return result
  })

  safeHandle(IPC_CHANNELS.SETTINGS_GET, (params: SettingsGetParams) => {
    const row = settingsGetStmt.get(params.key) as any
    return row?.value || null
  })

  safeHandle(IPC_CHANNELS.SETTINGS_SET, (params: SettingsSetParams) => {
    settingsSetStmt.run(params.key, params.value)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.PATH_GET_DATA_DIR, () => {
    return PathService.getInstance().getDataDir()
  })

  safeHandle(IPC_CHANNELS.PATH_SET_DATA_DIR, (newDir: string) => {
    return PathService.getInstance().setDataDir(newDir)
  })

  // 获取应用版本号（读取 package.json 的 version）
  safeHandle(IPC_CHANNELS.APP_GET_VERSION, () => {
    return app.getVersion()
  })

  // 打开日志目录（{dataDir}/.log），不存在则创建
  safeHandle(IPC_CHANNELS.APP_OPEN_LOG_DIR, () => {
    const logDir = path.join(PathService.getInstance().getDataDir(), '.log')
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }
    shell.openPath(logDir)
    return { success: true }
  })

  // 清除所有用户数据（保留应用级 settings 配置），需重启应用生效
  safeHandle(IPC_CHANNELS.APP_CLEAR_ALL_DATA, () => {
    const tx = db.transaction(() => {
      // 按外键依赖顺序清空用户数据表
      for (const table of USER_DATA_TABLES) {
        db.exec(`DELETE FROM ${table}`)
      }
      // 清理 settings 表，但保留应用级配置键
      const preserved = Array.from(PRESERVED_SETTINGS_KEYS)
      const placeholders = preserved.map(() => '?').join(',')
      db.prepare(`DELETE FROM settings WHERE key NOT IN (${placeholders})`).run(...preserved)
    })
    tx()
    return { success: true }
  })

}
