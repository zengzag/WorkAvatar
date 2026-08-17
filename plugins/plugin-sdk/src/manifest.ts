/**
 * 插件清单（manifest.json）类型定义。
 * manifest 是宿主对插件的唯一信任入口：加载前先做 schema + engine 校验。
 */

/** 插件权限：manifest 声明后宿主才注入 ctx.services 中对应服务 */
export type PluginPermission =
  | 'llm' // 受控 LLM 调用
  | 'agent' // 委派数字员工执行任务
  | 'conversations' // 内核对话只读查询
  | 'notifications' // 系统通知
  | 'scheduler' // 后台定时任务
  | 'globalShortcuts' // 全局快捷键
  | 'windows' // 创建插件窗口（悬浮字幕窗等）
  | 'nativeModules' // 租借宿主原生模块
  | 'legacyMigration' // 只读访问内核主库（仅内置插件数据迁移场景）

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
  permissions?: PluginPermission[]
  nav?: PluginNavContribution
}
