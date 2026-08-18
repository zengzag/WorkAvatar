/**
 * 插件渲染端入口契约（dist/renderer/index.js，ESM default export）。
 * 宿主启动时经 plugin:// 协议动态 import，注册路由/导航后挂载路由表。
 */
import type { ComponentType } from 'react'
import type { PluginViewPoint } from './manifest'

export interface PluginRouteDefinition {
  /** 相对路径，挂载到 /plugin/<id>/ 命名空间下；'' 或 '/' 为插件首页 */
  path: string
  component: ComponentType
  /** 路由级 keepAlive（对应宿主 KeepAliveOutlet），默认 true */
  keepAlive?: boolean
}

/** 渲染端视图注入：在宿主界面指定注入点渲染组件（组件在渲染端，天然可用） */
export interface PluginViewDefinition {
  /** 注入点 id，须在 capabilities.ui.views 白名单内 */
  view: PluginViewPoint
  /** 注入点渲染的组件 */
  component: ComponentType<{ context?: unknown }>
}

export interface PluginBridge {
  /** 调用主进程插件 handler（自动携带 pluginId 与 plugin:<id>: 前缀） */
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>
  /**
   * 订阅主进程 broadcast 事件，返回取消订阅函数。
   * 回调仅收到匹配 event 名的 payload（宿主已按 event 过滤）。
   */
  onEvent(event: string, callback: (payload: unknown) => void): () => void
}

/**
 * 渲染端宿主能力（可选）：插件页面/视图可用的通用宿主能力。
 * 宿主按能力提供；无此能力时字段为 undefined。
 */
export interface PluginHostCapabilities {
  /** 订阅宿主外部文件打开事件（绝对路径，系统"打开方式"传入），返回取消订阅函数 */
  subscribeExternalFiles(callback: (absPath: string) => void): () => void
  /**
   * 注册"关闭守卫"：tab 独立窗口点击关闭时，任一守卫返回 true 则弹"未保存"确认框；
   * 返回取消注册函数。
   */
  registerCloseGuard(check: () => boolean): () => void
  /** 打开文件选择框，返回选中路径数组（取消返回空数组） */
  showOpenDialog(options?: { filters?: Array<{ name: string; extensions: string[] }> }): Promise<string[]>
  /** 打开文件保存框，返回目标路径（取消返回空字符串） */
  showSaveDialog(options?: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string>
  /** 剪贴板文本读写（基于 navigator.clipboard） */
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
  }
  /** 读取当前明文/暗色主题（'light' | 'dark'） */
  getTheme(): 'light' | 'dark'
  /** 订阅主题变化，返回取消订阅函数 */
  onThemeChange(callback: (isDark: boolean) => void): () => void
  /** 读取当前语言（'zh-CN' | 'en-US' 等） */
  getLocale(): string
  /** 订阅语言切换，返回取消订阅函数 */
  onLocaleChange(callback: (locale: string) => void): () => void
}

export interface PluginRendererHost {
  bridge: PluginBridge
  /** 宿主 i18n 受控封装（插件 locale 文件已由宿主代为注册） */
  i18n: { t(key: string, options?: Record<string, unknown>): string }
  /** 宿主通用能力（可选字段按需提供） */
  hostCapabilities?: PluginHostCapabilities
}

/** 渲染端入口 default export 契约 */
export interface PluginRendererEntry {
  /** 插件页面路由（纯后台插件无渲染端入口） */
  routes: PluginRouteDefinition[]
  /** 动态导航图标（如录音状态变色）；静态图标用 manifest.nav.icon */
  navIcon?: ComponentType<{ active: boolean }>
  /** 视图注入（在宿主界面指定注入点渲染组件，需 capabilities.ui.views 授权） */
  views?: PluginViewDefinition[]
  /** 路由挂载前调用一次（订阅事件、初始化 store 等） */
  init?(host: PluginRendererHost): void | Promise<void>
  /** 宿主卸载本插件路由时调用（清理订阅） */
  dispose?(): void
}
