export const APP_CHANNELS = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  APP_SHOW_OPEN_DIALOG: 'app:show-open-dialog',
  APP_SHOW_SAVE_DIALOG: 'app:show-save-dialog',

  PATH_GET_DATA_DIR: 'path:get-data-dir',
  PATH_SET_DATA_DIR: 'path:set-data-dir',

  APP_GET_VERSION: 'app:get-version',
  APP_OPEN_LOG_DIR: 'app:open-log-dir',
  APP_CLEAR_LOGS: 'app:clear-logs',
  APP_CLEAR_ALL_DATA: 'app:clear-all-data',
  // 存储占用量化：分类统计数据目录占用、打开指定分类目录
  APP_GET_STORAGE_USAGE: 'app:get-storage-usage',
  APP_OPEN_STORAGE_PATH: 'app:open-storage-path',
  // 前台防休眠：应用处于前台时禁止系统自动熄屏/休眠（查询/设置开关）
  POWER_SAVE_GET: 'power-save:get',
  POWER_SAVE_SET: 'power-save:set',
  // 重启应用（插件启停/导入/删除等变更后一键生效）
  APP_RESTART: 'app:restart',
  // 渲染进程日志转发（fire-and-forget）：渲染进程 console 输出转发到主进程写入日志文件
  APP_RENDERER_LOG: 'app:renderer-log',

  // 窗口控制（自定义标题栏）
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  WINDOW_ON_MAXIMIZED_CHANGE: 'window:on-maximized-change',

  // 系统右键"打开方式"或拖拽到应用图标时，主进程推送待打开的文件绝对路径给渲染进程
  APP_OPEN_EXTERNAL_FILE: 'app:open-external-file',

  // Tab 独立窗口：把主导航 tab 分离为独立窗口 / 回归主窗口 / 查询已分离列表 / 聚焦已存在的独立窗口
  TAB_WINDOW_OPEN: 'tab-window:open',
  TAB_WINDOW_RETURN: 'tab-window:return',
  TAB_WINDOW_LIST: 'tab-window:list',
  TAB_WINDOW_FOCUS: 'tab-window:focus',
  // 主进程 → 主窗口渲染进程：detached tabs 列表变化通知
  TAB_WINDOW_DETACHED_CHANGED: 'tab-window:detached-changed',
  // 独立窗口 → 主进程：查询当前窗口所属 tabKey（独立窗口渲染进程启动时调用）
  TAB_WINDOW_GET_OWN_TAB: 'tab-window:get-own-tab',
} as const

export interface SettingsGetParams {
  key: string
}

export interface SettingsSetParams {
  key: string
  value: string
}

export interface AppShowOpenDialogParams {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: Array<{ name: string; extensions: string[] }>
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles'>
}

export interface AppShowSaveDialogParams {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: Array<{ name: string; extensions: string[] }>
}

/**
 * 存储分类键，与主进程统计口径一一对应（避免渲染层传任意路径）。
 * - `dataDir` 仅用于"打开数据目录"，不参与占用统计
 * - `other` 为数据目录下未被识别的顶层条目聚合
 */
export type StorageCategoryKey =
  | 'dataDir'
  | 'mainDb'
  | 'kmsDb'
  | 'attachments'
  | 'workspaces'
  | 'skills'
  | 'pluginData'
  | 'plugins'
  | 'logs'
  | 'other'

export interface StorageCategoryUsage {
  key: StorageCategoryKey
  bytes: number
  /** 展示用主路径（可能是目录或文件） */
  path: string
  /** 目录型分类直接打开目录；文件型分类在资源管理器中定位 */
  isFile: boolean
  /** 是否提供"打开/定位"操作（`other` 为聚合项，不可打开） */
  canOpen: boolean
  /** 是否可清理 */
  cleanable: boolean
}

export interface StorageUsageResult {
  dataDir: string
  totalBytes: number
  categories: StorageCategoryUsage[]
  /** 所在磁盘可用/总容量；读取失败为 null */
  diskFreeBytes: number | null
  diskTotalBytes: number | null
}

export interface StoragePathParams {
  key: StorageCategoryKey
}

