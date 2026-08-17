export const PLUGIN_CHANNELS = {
  /** 渲染端查询插件列表（含启停状态/来源/兼容性/导航贡献） */
  PLUGIN_LIST: 'plugin-host:list',
  /** 通用调用桥：转发到 plugin:<id>:<channel> */
  PLUGIN_INVOKE: 'plugin-host:invoke',
  /** 主进程 → 插件渲染端事件推送（payload: PluginEventPayload） */
  PLUGIN_EVENT: 'plugin-host:event',
  /** 启用/禁用插件（重启生效） */
  PLUGIN_SET_ENABLED: 'plugin-host:set-enabled',
  /** 删除用户插件（内置插件不可删） */
  PLUGIN_DELETE: 'plugin-host:delete',
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
  source: 'builtin' | 'user'
  /** builtin: 只读随包分发；user: 可删除 */
  enabled: boolean
  /** manifest/engine 校验与激活结果 */
  status: 'active' | 'disabled' | 'invalid' | 'error'
  statusMessage?: string
  nav?: PluginNavItemInfo
  hasRenderer: boolean
}

/** 渲染端加载动态路由所需的插件信息（仅 enabled 且激活成功） */
export interface PluginRendererInfo {
  id: string
  name: string
  /** 渲染端入口相对路径（渲染端经 plugin://<id>/<entry> 加载） */
  entry: string
  nav?: PluginNavItemInfo
  /** locale 文件内容（宿主代为注册，namespace = 插件 id） */
  locales: Record<string, Record<string, unknown>>
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
