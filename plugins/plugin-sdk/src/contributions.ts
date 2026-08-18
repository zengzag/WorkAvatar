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

/** 对话消息快捷操作（如"保存到笔记"）的执行上下文 */
export interface PluginMessageActionContext {
  /** 消息文案 */
  content: string
  /** 消息 id（可选用作幂等/定位） */
  messageId?: string
}

export interface PluginMessageActionResult {
  /** 成功提示：文案或插件命名空间 i18n key（缺省不提示） */
  success?: string
  /** 失败提示：文案或插件命名空间 i18n key */
  error?: string
}

/** 对话消息上由插件贡献的快捷操作按钮（通用插件能力，非某插件特殊实现） */
export interface PluginMessageAction {
  /** 动作 id（插件内唯一），宿主自动挂 plugin:<id>:message-action:<id> IPC */
  id: string
  /** 按钮标题：文案或插件命名空间 i18n key */
  title: string
  /** 按钮图标：16x16 SVG 字符串（可选） */
  icon?: string
  /** 可用消息角色，默认 'assistant' */
  target?: 'assistant' | 'user' | 'all'
  /** 执行逻辑 */
  handler(ctx: PluginMessageActionContext): PluginMessageActionResult | void | Promise<PluginMessageActionResult | void>
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
  /** 注册对话消息快捷操作按钮（无权限要求；宿主自动暴露列出清单 + 调用 IPC） */
  registerMessageActions(actions: PluginMessageAction[]): void
}
