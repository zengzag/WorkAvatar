export const APP_CHANNELS = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  APP_SHOW_OPEN_DIALOG: 'app:show-open-dialog',
  APP_SHOW_SAVE_DIALOG: 'app:show-save-dialog',

  PATH_GET_DATA_DIR: 'path:get-data-dir',
  PATH_SET_DATA_DIR: 'path:set-data-dir',

  APP_GET_VERSION: 'app:get-version',
  APP_OPEN_LOG_DIR: 'app:open-log-dir',
  APP_CLEAR_ALL_DATA: 'app:clear-all-data',
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

