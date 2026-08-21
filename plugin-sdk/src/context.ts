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

export interface PluginContext {
  manifest: PluginManifest
  /** 宿主应用版本 */
  hostVersion: string
  paths: PluginPaths
  ipc: PluginIpc
  storage: PluginStorage
  services: PluginServices
  contributions: PluginContributionsApi
}

/** 插件主进程入口（dist/main/index.cjs）须导出的契约 */
export interface PluginMainModule {
  /** 按序执行的数据迁移（内置插件迁出内核数据等），可为空 */
  migrations?: PluginMigration[]
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
