import { dialog, app, shell, BrowserWindow, ipcMain } from 'electron'
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
import { LoggerBackend } from '../services/logger'
import { safeHandle } from './_shared'

// 清除数据时保留的 settings 键（应用级配置，不属于"用户数据"）
const PRESERVED_SETTINGS_KEYS = new Set([
  'kms_auto_index',
  'web_search_engine',
  'web_search_result_count',
  'calendar_settings',
  'notes_settings',
])

// 需要清空的用户数据表（按依赖顺序，受外键约束）
const USER_DATA_TABLES = [
  'calendar_reminders',
  'calendar_todos',
  'calendar_events',
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

  // 渲染进程日志转发：接收渲染进程 console 输出，写入主进程日志文件
  // fire-and-forget（ipcMain.on），不阻塞渲染进程；仅写文件不打印主进程控制台，避免重复
  ipcMain.on(IPC_CHANNELS.APP_RENDERER_LOG, (_event, payload: { level: string; message: string }) => {
    try {
      const level = (payload?.level || 'info') as 'debug' | 'info' | 'warn' | 'error'
      const message = String(payload?.message ?? '')
      if (!message) return
      LoggerBackend.getInstance().writeToFile(level, 'Renderer', message)
    } catch {}
  })

  safeHandle(IPC_CHANNELS.APP_SHOW_OPEN_DIALOG, async (params: AppShowOpenDialogParams) => {
    const options = {
      title: params.title,
      defaultPath: params.defaultPath,
      buttonLabel: params.buttonLabel,
      filters: params.filters,
      properties: params.properties,
    }
    // 传入父窗口使对话框模态显示，避免在部分 Windows 环境下被主窗口遮挡而不显示
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result
  })

  safeHandle(IPC_CHANNELS.APP_SHOW_SAVE_DIALOG, async (params: AppShowSaveDialogParams) => {
    const options = {
      title: params.title,
      defaultPath: params.defaultPath,
      buttonLabel: params.buttonLabel,
      filters: params.filters,
    }
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
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

  // === 窗口控制（自定义标题栏）===
  // safeHandle 会拦截 ipcMain.handle 的 _event，仅透传用户参数，
  // 因此这里通过 BrowserWindow.getFocusedWindow() 获取当前窗口。

  safeHandle(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
    BrowserWindow.getFocusedWindow()?.minimize()
  })

  safeHandle(IPC_CHANNELS.WINDOW_TOGGLE_MAXIMIZE, () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return false
    if (win.isMaximized()) {
      win.unmaximize()
      return false
    }
    win.maximize()
    return true
  })

  safeHandle(IPC_CHANNELS.WINDOW_CLOSE, () => {
    BrowserWindow.getFocusedWindow()?.close()
  })

  safeHandle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, () => {
    const win = BrowserWindow.getFocusedWindow()
    return win ? win.isMaximized() : false
  })

  // 推送最大化状态变化事件给渲染进程
  ipcMain.on(IPC_CHANNELS.WINDOW_ON_MAXIMIZED_CHANGE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const sendState = () => {
      if (!win.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.WINDOW_ON_MAXIMIZED_CHANGE, win.isMaximized())
      }
    }
    win.on('maximize', sendState)
    win.on('unmaximize', sendState)
  })

}
