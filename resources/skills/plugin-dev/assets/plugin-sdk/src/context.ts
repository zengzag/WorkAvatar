/**
 * 插件主进程入口契约。
 * 宿主加载流程：manifest 校验 → migrations（如有未应用）→ activate(ctx)。
 * deactivate 在插件禁用/应用退出时调用，插件应在此释放资源。
 */
import type { PluginContributionsApi } from './contributions'
import type { PluginManifest } from './manifest'
import type { PluginServices } from './services'
import type { PluginMigration, PluginStorage } from './storage'

export interface PluginPaths {
  /** 插件安装根目录 */
  root: string
  /** 数据目录 userData/plugin-data/<id>/ */
  data: string
  /** 资源目录 <root>/resources（模型文件等，只读） */
  resources: string
}

export interface PluginIpc {
  /**
   * 注册 IPC handler。通道自动加 plugin:<id>: 前缀，
   * 通道名须在 manifest.ipc 声明范围内（未声明则抛错）。
   */
  handle(channel: string, handler: (payload: unknown) => Promise<unknown> | unknown): void
  /** 主进程 → 本插件所有渲染端（主窗口 + 独立窗口）广播事件 */
  broadcast(event: string, payload?: unknown): void
}

export interface PluginWebviewApi {
  /**
   * 声明本插件在运行时允许内嵌的主机名（如用户自定义网页的域名）。
   *
   * - 需 manifest `capabilities.webview.allowUserOrigins === true`，否则调用抛错；
   * - 每项必须是精确主机名（不支持通配 / 协议 / 端口 / 路径），宿主恒按 https 放行；
   * - 每次调用**整体替换**本插件的运行时白名单，插件下线 / 禁用时自动清空。
   */
  allowOrigins(hosts: string[]): void
}

/**
 * 插件设置访问（manifest.settings 声明，宿主设置页渲染表单并落库）。
 * 无界面插件的主要配置入口；未声明 settings 时返回空对象。
 */
export interface PluginSettingsApi {
  /** 全部设置项当前值（已合并默认值） */
  getAll(): Record<string, unknown>
  /** 读取单个设置项（不存在时返回 undefined） */
  get<T = unknown>(key: string): T | undefined
  /** 订阅设置变更（用户在宿主设置页修改后触发），返回取消订阅函数 */
  onChanged(callback: (values: Record<string, unknown>) => void): () => void
}

export interface PluginContext {
  manifest: PluginManifest
  /** 宿主应用版本 */
  hostVersion: string
  paths: PluginPaths
  ipc: PluginIpc
  storage: PluginStorage
  settings: PluginSettingsApi
  services: PluginServices
  contributions: PluginContributionsApi
  webview: PluginWebviewApi
}

/** 插件主进程入口（dist/main/index.cjs）须导出的契约 */
export interface PluginMainModule {
  /** 按序执行的数据迁移（内置插件迁出内核数据等），可为空 */
  migrations?: PluginMigration[]
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
  /** 宿主设置页保存后回调（可选）：在此热应用新配置，无需重启插件 */
  onSettingsChanged?(values: Record<string, unknown>): void
}
