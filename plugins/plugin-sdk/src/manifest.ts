/**
 * 插件清单（manifest.json）类型定义（v2 协议）。
 * manifest 是宿主对插件的唯一信任入口：加载前先做 schema + engine 校验。
 * v2 用 capabilities（能力域授权）取代 v1 的 permissions（布尔开关）。
 */

/** 数据访问实体（services.data.query/mutate 可访问的宿主数据） */
export type PluginDataEntity =
  | 'conversations' // 对话
  | 'employees' // 数字员工
  | 'llmProviders' // 模型供应商
  | 'memories' // 员工记忆
  | 'settings' // 宿主设置（仅只读）

/** 数据访问权限：read 只读 / write 读写 */
export type PluginDataAccess = 'read' | 'write'

/** 统一执行入口类型（services.execute 的 kind） */
export type PluginExecuteKind =
  | 'agent-task' // 委派数字员工执行任务
  | 'agent-chat' // 底层对话流式执行
  | 'llm-chat' // 受控 LLM 单次调用
  | 'llm-stream' // 受控 LLM 流式调用

/** 系统能力特性（capabilities.system.features） */
export type PluginSystemFeature =
  | 'notification' // 系统通知
  | 'scheduler' // 后台定时任务
  | 'windows' // 创建插件窗口
  | 'native' // 租借宿主原生模块
  | 'globalShortcuts' // 全局快捷键

/** UI 注入点（capabilities.ui.views） */
export type PluginViewPoint =
  | 'chat.toolbar' // 对话输入框工具栏
  | 'sidebar.footer' // 侧边栏底部
  | 'settings.tab' // 设置页 Tab
  | 'message.menu' // 对话消息操作菜单

/** 能力域声明（manifest.capabilities 数组元素） */
export type PluginCapability =
  | { domain: 'data'; entities: PluginDataEntity[]; access: PluginDataAccess }
  | { domain: 'execute'; kinds: PluginExecuteKind[] }
  | { domain: 'events'; subscribe?: string[]; publish?: boolean }
  | { domain: 'ui'; views: PluginViewPoint[] }
  | { domain: 'system'; features: PluginSystemFeature[] }

export interface PluginNavContribution {
  /** 导航标签文案或 i18n key（由插件 locale 提供） */
  label: string
  /** SVG 图标字符串（16x16 单色，宿主侧渲染） */
  icon?: string
  /** 排序权重，默认 100（内核任务/员工在前、设置固定在尾） */
  order?: number
  /** 是否允许分离为独立窗口，默认 false */
  detachable?: boolean
}

export interface PluginManifest {
  /** 唯一 id：/^[a-z][a-z0-9-]{1,63}$/，不可用保留字 settings/tasks/employees */
  id: string
  name: string
  /** semver */
  version: string
  /** 宿主协议兼容范围（semver range），不满足则拒绝加载并提示 */
  engine: string
  description?: string
  author?: string
  /** 主进程入口（相对插件根目录，cjs），须导出 activate */
  main: string
  /** 渲染端入口（ESM），纯后台插件可省略 */
  renderer?: string
  /** locale 目录（相对根目录），含 zh-CN.json / en-US.json */
  locale?: string
  /** 允许注册的 IPC 通道名列表（通配 '*'）；宿主强制 plugin:<id>: 前缀并做范围校验 */
  ipc?: string[]
  /** 能力域授权声明（v2，取代 v1 permissions 的多数能力） */
  capabilities?: PluginCapability[]
  /** 迁移专用权限（v2 仅保留 legacyMigration，用于数据迁出场景） */
  permissions?: Array<'legacyMigration'>
  nav?: PluginNavContribution
}
