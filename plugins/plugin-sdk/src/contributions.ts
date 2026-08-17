/**
 * 激活期贡献点：插件在 activate() 中通过 ctx.contributions 动态注册。
 * 与 manifest 的分工：manifest 只放静态元数据（nav/权限/IPC 范围），
 * 带回调的逻辑贡献一律在此注册，保证 handler 与注册同源。
 */
import type { PluginToolDefinition } from './tool'

export interface PluginFileAssociation {
  /** 文件扩展名（含点，如 '.md'） */
  extension: string
  /** 打开方式描述（系统"打开方式"菜单展示用） */
  description?: string
}

export interface PluginGlobalShortcut {
  /** Electron accelerator，如 'CommandOrControl+Shift+R' */
  accelerator: string
  handler: () => void | Promise<void>
}

export interface PluginContributionsApi {
  /** 注册 agent 工具（进入宿主 ToolRegistry，参与员工三态配置） */
  registerAgentTools(tools: PluginToolDefinition[]): void
  /** 注册 KMS MCP 服务对外暴露的工具 */
  registerMcpTools(tools: PluginToolDefinition[]): void
  /** 声明可打开的文件类型（宿主收到关联文件后路由到本插件渲染端） */
  registerFileAssociations(associations: PluginFileAssociation[]): void
  /** 注册全局快捷键（需 globalShortcuts 权限） */
  registerGlobalShortcuts(shortcuts: PluginGlobalShortcut[]): void
}
