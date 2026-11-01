import { dialog, app, shell, BrowserWindow, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  SettingsGetParams,
  SettingsSetParams,
  AppShowOpenDialogParams,
  AppShowSaveDialogParams,
  StorageCategoryKey,
  StorageCategoryUsage,
  StorageUsageResult,
  StoragePathParams,
} from '../../shared/ipc-channels'
import type DatabaseService from '../services/database.service'
import PathService from '../services/path.service'
import { resolveDialogDefaultPath, rememberDialogPath } from '../services/dialog-path'
import { LoggerBackend } from '../services/logger'
import LLMLoggerService from '../services/llm-logger.service'
import TabWindowService from '../services/tab-window.service'
import PluginHostService from '../services/plugin/plugin-host.service'
import PowerSaveService from '../services/power-save.service'
import mainUiI18n from '../services/ui-i18n.service'
import { WINDOW_STATE_SETTING_KEY } from '../services/window-state.service'
import { safeHandle } from './_shared'

// 清除数据时保留的 settings 键（应用级配置，不属于"用户数据"）
const PRESERVED_SETTINGS_KEYS = new Set([
  'kms_auto_index',
  'web_search_engine',
  'web_search_result_count',
  'web_search_mode',
  'web_search_api_provider',
  'prevent_sleep_when_foreground',
  WINDOW_STATE_SETTING_KEY,
])

// 需要清空的用户数据表（按依赖顺序，受外键约束）。
// calendar_* 仅存在于早期版本的库中，新库不再建表，清空前按实际存在的表过滤。
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

// 递归统计目录占用字节数；读取失败按 0 计，避免个别文件异常影响设置页展示
function getDirSize(dir: string): number {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        total += getDirSize(full)
      } else {
        try {
          total += fs.statSync(full).size
        } catch {}
      }
    }
  } catch {}
  return total
}

// 路径占用（文件取大小，目录递归求和），不存在或不可读按 0 计
function getPathSize(target: string): number {
  try {
    const stat = fs.statSync(target)
    return stat.isDirectory() ? getDirSize(target) : stat.size
  } catch {
    return 0
  }
}

// SQLite 主文件 + WAL/SHM 附属文件的后缀，统计时需一并计入
const SQLITE_SIDECAR_SUFFIXES = ['', '-wal', '-shm']

function getSqliteGroupSize(basePath: string): number {
  return SQLITE_SIDECAR_SUFFIXES.reduce((sum, suffix) => sum + getPathSize(`${basePath}${suffix}`), 0)
}

// 数据目录下已被分类统计的顶层条目，其余归入「其他」
const KNOWN_DATA_ENTRIES = new Set([
  'workavatar.db', 'workavatar.db-wal', 'workavatar.db-shm',
  'workavatar-kms.db', 'workavatar-kms.db-wal', 'workavatar-kms.db-shm',
  'workavatar-kms-vectors.db', 'workavatar-kms-vectors.db-wal', 'workavatar-kms-vectors.db-shm',
  'attachments', 'employees', 'skills', 'plugins', 'plugin-data', '.log',
])

function getOtherSize(dataDir: string): number {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (KNOWN_DATA_ENTRIES.has(entry.name)) continue
      total += getPathSize(path.join(dataDir, entry.name))
    }
  } catch {}
  return total
}

// 各存储分类对应的主路径与形态（文件型在资源管理器中定位，目录型直接打开）
function resolveStorageTarget(key: StorageCategoryKey): { path: string; isFile: boolean } | null {
  const dataDir = PathService.getInstance().getDataDir()
  switch (key) {
    case 'dataDir':
      return { path: dataDir, isFile: false }
    case 'mainDb':
      return { path: PathService.getInstance().getDbPath(), isFile: true }
    case 'kmsDb':
      return { path: PathService.getInstance().getKMSDbPath(), isFile: true }
    case 'attachments':
      return { path: path.join(dataDir, 'attachments'), isFile: false }
    case 'workspaces':
      return { path: path.join(dataDir, 'employees'), isFile: false }
    case 'skills':
      return { path: path.join(dataDir, 'skills'), isFile: false }
    case 'plugins':
      return { path: path.join(dataDir, 'plugins'), isFile: false }
    case 'pluginData':
      return { path: path.join(dataDir, 'plugin-data'), isFile: false }
    case 'logs':
      return { path: path.join(dataDir, '.log'), isFile: false }
    default:
      return null
  }
}

function buildStorageUsage(): StorageUsageResult {
  const dataDir = PathService.getInstance().getDataDir()
  const dir = (name: string) => path.join(dataDir, name)
  const categories: StorageCategoryUsage[] = [
    { key: 'mainDb', bytes: getSqliteGroupSize(PathService.getInstance().getDbPath()), path: PathService.getInstance().getDbPath(), isFile: true, canOpen: true, cleanable: false },
    { key: 'kmsDb', bytes: getSqliteGroupSize(PathService.getInstance().getKMSDbPath()) + getSqliteGroupSize(PathService.getInstance().getKMSVectorDbPath()), path: PathService.getInstance().getKMSDbPath(), isFile: true, canOpen: true, cleanable: false },
    { key: 'attachments', bytes: getPathSize(dir('attachments')), path: dir('attachments'), isFile: false, canOpen: true, cleanable: false },
    { key: 'workspaces', bytes: getPathSize(dir('employees')), path: dir('employees'), isFile: false, canOpen: true, cleanable: false },
    { key: 'skills', bytes: getPathSize(dir('skills')), path: dir('skills'), isFile: false, canOpen: true, cleanable: false },
    { key: 'plugins', bytes: getPathSize(dir('plugins')), path: dir('plugins'), isFile: false, canOpen: true, cleanable: false },
    { key: 'pluginData', bytes: getPathSize(dir('plugin-data')), path: dir('plugin-data'), isFile: false, canOpen: true, cleanable: false },
    { key: 'logs', bytes: getPathSize(dir('.log')), path: dir('.log'), isFile: false, canOpen: true, cleanable: true },
    { key: 'other', bytes: getOtherSize(dataDir), path: dataDir, isFile: false, canOpen: false, cleanable: false },
  ]

  const totalBytes = categories.reduce((sum, c) => sum + c.bytes, 0)

  let diskFreeBytes: number | null = null
  let diskTotalBytes: number | null = null
  try {
    const stat = fs.statfsSync(dataDir)
    diskFreeBytes = stat.bavail * stat.bsize
    diskTotalBytes = stat.blocks * stat.bsize
  } catch {
    // 部分平台/文件系统不支持 statfs，忽略磁盘容量展示
  }

  return {
    dataDir,
    totalBytes,
    // 无占用分类不展示；可清理分类（如日志）始终展示，便于随时清理
    categories: categories.filter((c) => c.bytes > 0 || c.cleanable),
    diskFreeBytes,
    diskTotalBytes,
  }
}

// 递归列出目录下的所有文件，不存在或不可读的目录返回空
function listFilesRecursive(dir: string): string[] {
  const files: string[] = []
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...listFilesRecursive(full))
      } else {
        files.push(full)
      }
    }
  } catch {}
  return files
}

// 清空日志：先暂停主进程日志写入并等待句柄释放，再删除日志目录。
// 日志文件可能正被其它进程（OCR 子进程 / 索引 Worker）写入而无法删除，
// 此时逐个截断为 0，避免因单个正在使用的文件导致整个清理失败。
async function clearLogsInternal(): Promise<{ success: boolean; error?: string }> {
  const logDir = path.join(PathService.getInstance().getDataDir(), '.log')
  const activeLogPath = LoggerBackend.getInstance().getLogFilePath()
  await LoggerBackend.getInstance().closeStream()
  await LLMLoggerService.getInstance().closeStreams()

  let failed = 0
  try {
    if (fs.existsSync(logDir)) {
      // Windows 下句柄释放存在延迟，重试以提高删除成功率
      fs.rmSync(logDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  } catch {
    // 整体删除失败：逐文件清理，正在使用的文件保留为空文件（不影响后续写入）
    for (const file of listFilesRecursive(logDir)) {
      let cleared = false
      try {
        fs.truncateSync(file, 0)
        cleared = true
      } catch {}
      try {
        fs.rmSync(file, { force: true, maxRetries: 2, retryDelay: 50 })
        cleared = true
      } catch {}
      if (!cleared) failed++
    }
  }

  // 当前日志文件仍存在说明有其它进程占用，续写同一文件，避免日志被拆成多个文件
  const reusePath = activeLogPath && fs.existsSync(activeLogPath) ? activeLogPath : null
  LoggerBackend.getInstance().reopen(reusePath)
  LLMLoggerService.getInstance().resume()
  return failed > 0 ? { success: false, error: `${failed} 个日志文件正被占用，未能清理` } : { success: true }
}

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
      defaultPath: resolveDialogDefaultPath(params.defaultPath),
      buttonLabel: params.buttonLabel,
      filters: params.filters,
      properties: params.properties,
    }
    // 传入父窗口使对话框模态显示，避免在部分 Windows 环境下被主窗口遮挡而不显示
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    rememberDialogPath(result.filePaths?.[0])
    return result
  })

  safeHandle(IPC_CHANNELS.APP_SHOW_SAVE_DIALOG, async (params: AppShowSaveDialogParams) => {
    const options = {
      title: params.title,
      defaultPath: resolveDialogDefaultPath(params.defaultPath),
      buttonLabel: params.buttonLabel,
      filters: params.filters,
    }
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    rememberDialogPath(result.filePath)
    return result
  })

  safeHandle(IPC_CHANNELS.SETTINGS_GET, (params: SettingsGetParams) => {
    // API Key 由 SecureKeyStorage 专管（加密存储 + 后端解密），不开放给渲染层直读
    if (params.key.startsWith('llm_api_key_') || params.key.startsWith('web_search_api_key_')) {
      return null
    }
    const row = settingsGetStmt.get(params.key) as any
    return row?.value || null
  })

  safeHandle(IPC_CHANNELS.SETTINGS_SET, (params: SettingsSetParams) => {
    settingsSetStmt.run(params.key, params.value)
    // 语言变更需同步刷新主进程 UI（托盘菜单等）
    if (params.key === 'appearance_locale' && (params.value === 'zh-CN' || params.value === 'en-US')) {
      mainUiI18n.setLocale(params.value)
    }
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

  // 单独清空日志占用
  safeHandle(IPC_CHANNELS.APP_CLEAR_LOGS, () => clearLogsInternal())

  // 存储分类占用统计（数据目录下的库/附件/工作区/技能/插件/日志等）
  safeHandle(IPC_CHANNELS.APP_GET_STORAGE_USAGE, () => buildStorageUsage())

  // 打开指定存储分类：目录型直接打开，文件型在资源管理器中定位（仅接受分类键，杜绝任意路径）
  safeHandle(IPC_CHANNELS.APP_OPEN_STORAGE_PATH, async (params: StoragePathParams) => {
    const target = resolveStorageTarget(params?.key)
    if (!target) return { success: false, error: '未知的存储分类' }
    if (target.isFile) {
      if (!fs.existsSync(target.path)) return { success: false, error: '文件不存在' }
      shell.showItemInFolder(target.path)
      return { success: true }
    }
    if (!fs.existsSync(target.path)) {
      fs.mkdirSync(target.path, { recursive: true })
    }
    const errMsg = await shell.openPath(target.path)
    return { success: !errMsg, error: errMsg || undefined }
  })

  // 清除所有用户数据（保留应用级 settings 配置），需重启应用生效
  safeHandle(IPC_CHANNELS.APP_CLEAR_ALL_DATA, () => {
    const tx = db.transaction(() => {
      // 按外键依赖顺序清空用户数据表（遗留日历表仅存在于升级库，按实际存在的表过滤）
      const existingTables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(r => r.name)
      )
      for (const table of USER_DATA_TABLES) {
        if (!existingTables.has(table)) continue
        db.exec(`DELETE FROM ${table}`)
      }
      // FTS 虚拟表为独立内容存储（非 external-content），须一并清空，
      // 否则已删除对话/记忆的全文残留其中（隐私残留 + 搜索幽灵结果）
      db.exec('DELETE FROM conversations_fts')
      db.exec('DELETE FROM employee_memories_fts')
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
  // 按窗口去重注册系统监听器（渲染端组件多次挂载/HMR 会重复 send 订阅消息）；
  // 同窗口多个 webContents（如 devtools/webview）各自订阅、各自接收推送
  const maximizedWatchers = new Map<BrowserWindow, Set<Electron.WebContents>>()
  ipcMain.on(IPC_CHANNELS.WINDOW_ON_MAXIMIZED_CHANGE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    let senders = maximizedWatchers.get(win)
    if (!senders) {
      senders = new Set()
      maximizedWatchers.set(win, senders)
      const sendState = () => {
        if (win.isDestroyed()) return
        for (const wc of senders!) {
          if (!wc.isDestroyed()) wc.send(IPC_CHANNELS.WINDOW_ON_MAXIMIZED_CHANGE, win.isMaximized())
        }
      }
      win.on('maximize', sendState)
      win.on('unmaximize', sendState)
      win.once('closed', () => maximizedWatchers.delete(win))
    }
    // 新订阅者：登记并回发当前状态完成初始同步
    if (!senders.has(event.sender)) {
      senders.add(event.sender)
      event.sender.send(IPC_CHANNELS.WINDOW_ON_MAXIMIZED_CHANGE, win.isMaximized())
    }
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
