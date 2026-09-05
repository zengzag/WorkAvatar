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
import TabWindowService from '../services/tab-window.service'
import PluginHostService from '../services/plugin/plugin-host.service'
import PowerSaveService from '../services/power-save.service'
import { safeHandle } from './_shared'

// 清除数据时保留的 settings 键（应用级配置，不属于"用户数据"）
const PRESERVED_SETTINGS_KEYS = new Set([
  'kms_auto_index',
  'web_search_engine',
  'web_search_result_count',
  'calendar_settings',
  'prevent_sleep_when_foreground',
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

  // 防休眠开关：查询当前是否开启（开启时窗口未全部关闭则禁止系统熄屏/休眠）
  safeHandle(IPC_CHANNELS.POWER_SAVE_GET, () => {
    return PowerSaveService.getInstance().getEnabled()
  })

  safeHandle(IPC_CHANNELS.POWER_SAVE_SET, (enabled: boolean) => {
    PowerSaveService.getInstance().setEnabled(!!enabled)
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

  // 插件变更生效入口（"重新扫描"按钮）：增量 reconcile 磁盘与内存差异，仅加载/卸载受影响插件。
  // 不再全量 deactivate + webContents.reload：运行中的对话/生成流程不受影响，
  // 渲染端经 PLUGIN_CHANGED 广播增量刷新导航/路由/视图。
  safeHandle(IPC_CHANNELS.APP_RESTART, () => {
    const host = PluginHostService.getInstance()
    // reconcile 内部在有变更时统一 bumpToolEpoch + 广播 PLUGIN_CHANGED（渲染端增量加载/卸载）
    const changed = host.reconcile()
    return { success: true, changed }
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

  // === Tab 独立窗口 ===

  // 打开（或聚焦已存在的）tab 独立窗口
  safeHandle(IPC_CHANNELS.TAB_WINDOW_OPEN, (tabKey: string) => {
    return TabWindowService.getInstance().openTabWindow(tabKey)
  })

  // 关闭 tab 独立窗口（回归主窗口）
  safeHandle(IPC_CHANNELS.TAB_WINDOW_RETURN, (tabKey: string) => {
    TabWindowService.getInstance().closeTabWindow(tabKey)
    return { success: true }
  })

  // 查询当前已分离的 tab 列表
  safeHandle(IPC_CHANNELS.TAB_WINDOW_LIST, () => {
    return TabWindowService.getInstance().getDetachedTabs()
  })

  // 聚焦指定 tab 的独立窗口（若存在），返回是否成功
  safeHandle(IPC_CHANNELS.TAB_WINDOW_FOCUS, (tabKey: string) => {
    return TabWindowService.getInstance().focusTabWindow(tabKey)
  })

  // 独立窗口渲染进程启动时查询自己所属的 tabKey
  // 通过 URL hash 解析：内置页 #/window/tasks → tasks；插件页 #/window/plugin/notes → notes
  // 需要 event.sender 所以单独注册
  ipcMain.handle(IPC_CHANNELS.TAB_WINDOW_GET_OWN_TAB, (event) => {
    try {
      const url = event.sender.getURL()
      const match = url.match(/#\/window\/(?:plugin\/)?([a-z][a-z0-9-]*)/)
      return match ? match[1] : null
    } catch {
      return null
    }
  })

}
