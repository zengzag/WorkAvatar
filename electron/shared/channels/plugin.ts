/** 插件分发包自定义扩展名（不含点）：内部仍为 zip 归档，仅换后缀便于识别与文件关联 */
export const PLUGIN_PACKAGE_EXT = 'wap'

export const PLUGIN_CHANNELS = {
  /** 渲染端查询插件列表（含启停状态/来源/兼容性/导航贡献） */
  PLUGIN_LIST: 'plugin-host:list',
  /** 通用调用桥：转发到 plugin:<id>:<channel> */
  PLUGIN_INVOKE: 'plugin-host:invoke',
  /** 主进程 → 插件渲染端事件推送（payload: PluginEventPayload） */
  PLUGIN_EVENT: 'plugin-host:event',
  /** 主进程 → 渲染端插件集合变更通知（payload: PluginChangedPayload，前端据此增量刷新导航/路由/视图，免整页 reload） */
  PLUGIN_CHANGED: 'plugin-host:changed',
  /** 启用/禁用插件（重启生效） */
  PLUGIN_SET_ENABLED: 'plugin-host:set-enabled',
  /** 删除插件 */
  PLUGIN_DELETE: 'plugin-host:delete',
  /** 导入插件包（zip，含文件选择 + 已安装覆盖/升级处理） */
  PLUGIN_IMPORT: 'plugin-host:import',
  /** 查询插件贡献的对话消息快捷操作清单（供前端渲染按钮） */
  PLUGIN_LIST_MESSAGE_ACTIONS: 'plugin-host:list-message-actions',
  /** 查询插件注册的 UI 视图注入清单（供前端在注入点渲染组件） */
  PLUGIN_LIST_VIEWS: 'plugin-host:list-views',
  /** 查询插件注册的命令清单（供前端斜杠菜单/宿主调用） */
  PLUGIN_LIST_COMMANDS: 'plugin-host:list-commands',
  /** 按文件扩展名解析应路由到的插件 id（无插件声明时返回 null） */
  PLUGIN_RESOLVE_FILE_OWNER: 'plugin-host:resolve-file-owner',
  /** 打开用户插件目录 */
  PLUGIN_OPEN_DIR: 'plugin-host:open-dir',
} as const

/** 插件导航贡献（主进程侧读取 manifest 后透出给渲染端） */
export interface PluginNavItemInfo {
  /** 展示文案或 i18n key（渲染端以插件 namespace 解析） */
  label: string
  /** SVG 图标字符串 */
  icon?: string
  /** 排序权重（内核导航 0-7，插件默认 100） */
  order: number
  /** 是否允许分离为独立窗口 */
  detachable: boolean
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 统一为用户来源（dev 自动安装与导入插件落地后均视为用户插件，可删除） */
  source: 'user'
  enabled: boolean
  /** manifest/engine 校验与激活结果；pending = 已安装未重启激活 */
  status: 'active' | 'disabled' | 'invalid' | 'error' | 'pending'
  statusMessage?: string
  /** 插件依赖（pluginId → semver range），用于设置页展示缺失/不满足原因 */
  dependencies?: Record<string, string>
  nav?: PluginNavItemInfo
  hasRenderer: boolean
}

/** 渲染端加载动态路由所需的插件信息（仅 enabled 且激活成功） */
export interface PluginRendererInfo {
  id: string
  name: string
  /** 插件版本（渲染端据此识别覆盖升级，动态 import 时作为 cache-bust 参数） */
  version: string
  /** 渲染端入口相对路径（渲染端经 plugin://<id>/<entry> 加载） */
  entry: string
  nav?: PluginNavItemInfo
  /** locale 文件内容（宿主代为注册，namespace = 插件 id） */
  locales: Record<string, Record<string, unknown>>
}

/** 插件集合变更广播：携带最新 rendererPlugins 快照，渲染端 diff 后增量加载/卸载 */
export interface PluginChangedPayload {
  rendererPlugins: PluginRendererInfo[]
}

export interface PluginInvokeParams {
  pluginId: string
  channel: string
  payload?: unknown
}

export interface PluginEventPayload {
  pluginId: string
  event: string
  payload?: unknown
}

export interface PluginSetEnabledParams {
  pluginId: string
  enabled: boolean
}

export interface PluginDeleteParams {
  pluginId: string
}

export interface PluginImportParams {
  /** 覆盖已安装的相同 id 插件（删除旧目录后重装/升级），默认 false */
  overwrite?: boolean
}

export interface PluginImportResult {
  ok: boolean
  /** 导入/重装成功的插件 id（最后一个成功项） */
  id?: string
  /** 本次导入的插件版本（最后一个成功项） */
  version?: string
  /** 本次成功导入的插件包数量（多选导入聚合；单文件导入为 1） */
  count?: number
  /** 检测到已安装相同 id 插件且未携带 overwrite：需要前端二次确认是否覆盖 */
  needsUpgradeConfirm?: {
    existingVersion?: string
    newVersion?: string
    /** 本次多选待导入中检测到已安装的插件包数量 */
    count?: number
  }
  message?: string
}

/** 插件贡献的对话消息快捷操作（前端据此渲染按钮） */
export interface PluginMessageActionInfo {
  pluginId: string
  id: string
  title: string
  icon?: string
  target?: string
}
