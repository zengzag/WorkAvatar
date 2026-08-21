/** 日志接口（宿主 logger 的插件作用域封装，自动带插件 id 前缀） */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

import type { PluginToolDefinition } from './tool'

export interface PluginNotificationPayload {
  title: string
  body: string
  /** 通知点击目标（如 'calendar' / 'event' / 'todo' / 'automation'），宿主据此聚焦主窗口并回传 clickId */
  clickTarget?: string
  /** 通知点击时回传给插件渲染端的 id（插件自行决定跳转行为） */
  clickId?: string
  /** 静默：不弹系统通知，仅写日志 */
  silent?: boolean
  /** 渲染端可用 t() 本地化的文案键与参数（可选用） */
  i18nKey?: string
  i18nParams?: Record<string, string | number>
}

export interface PluginNotificationService {
  /** 返回是否实际发出（行为与内核 NotificationService 一致：主窗口失焦弹系统通知，激活时推渲染端 antd notification） */
  notify(payload: PluginNotificationPayload): boolean
}

// ====== 数据访问层（services.data） ======

/** 数据访问实体（与 manifest.ts 的 PluginDataEntity 一致） */
export type PluginDataEntity =
  | 'conversations'
  | 'employees'
  | 'llmProviders'
  | 'memories'
  | 'settings'
  | 'messages'

/** 数据写操作类型 */
export type PluginDataOp = 'create' | 'update' | 'delete'

/** 数据查询参数 */
export interface PluginDataQueryParams {
  filter?: Record<string, unknown>
  sort?: string
  limit?: number
  offset?: number
}

/**
 * 通用数据访问服务（需 capabilities.data 授权）。
 * - query：只读查询，entity 必须在 capabilities.data.entities 白名单内
 * - mutate：写操作，entity + access=write 才允许
 * 新增数据实体无需扩接口，宿主注册实体描述即可。
 */
export interface PluginDataService {
  query<T = unknown>(entity: PluginDataEntity, params?: PluginDataQueryParams): Promise<T[]>
  mutate<T = unknown>(entity: PluginDataEntity, op: PluginDataOp, payload: Record<string, unknown>): Promise<T>
}

// ====== 宿主能力层（services.execute） ======

/** 统一执行入口类型（与 manifest.ts 的 PluginExecuteKind 一致） */
export type PluginExecuteKind =
  | 'agent-task'
  | 'agent-chat'
  | 'llm-chat'
  | 'llm-stream'

/** 统一执行请求 */
export interface PluginExecuteRequest {
  kind: PluginExecuteKind
  employeeId?: string
  providerId?: string
  modelId?: string
  prompt?: string
  messages?: Array<{ role: string; content: string; images?: string[] }>
  system?: string
  history?: string[]
  conversationId?: string
  temperature?: number
  maxTokens?: number
  useSkills?: boolean
  enableThinking?: boolean
  minimalMode?: boolean
  highPermission?: boolean
  /** 通用模式（agent-chat 不传 employeeId 时）：自定义工具集 */
  tools?: PluginToolDefinition[]
  /** 通用模式（agent-chat 不传 employeeId 时）：注入宿主内置 shell/文件工具并分配任务工作区 */
  enableBuiltinTools?: boolean
  /** 通用模式：指定任务工作区目录（分配内置文件工具沙箱根目录）；缺省时宿主按会话自动创建 */
  workspacePath?: string
}

/** 统一执行回调 */
export interface PluginExecuteCallbacks {
  onChunk?: (text: string) => void
  onThought?: (thought: string) => void
  onToolCall?: (toolCall: { id?: string; name?: string; arguments?: string }) => void
  /** 工具调用参数流式增量（arguments 为 JSON 字符串增量片段） */
  onToolCallDelta?: (delta: { index: number; id?: string; name?: string; arguments: string }) => void
  /** 工具执行结果 */
  onToolResult?: (toolResult: { name: string; result: any; rawResult?: any; generatedFiles?: any; success?: boolean }) => void
  /** 工具执行中间进度（仅UI展示，不进入LLM上下文） */
  onToolProgress?: (progress: { toolCallId: string; name: string; progress: any }) => void
  onDone?: (metadata?: unknown) => void
  onError?: (error: string) => void
}

/**
 * 统一执行服务（需 capabilities.execute 授权）。
 * 用 kind 区分执行形态，插件无需理解底层是 agent 还是 llm。
 */
export interface PluginExecuteService {
  execute<T = unknown>(
    request: PluginExecuteRequest,
    callbacks?: PluginExecuteCallbacks,
    signal?: AbortSignal
  ): Promise<T>
}

// ====== 系统集成层（services.events） ======

/**
 * 事件总线服务（需 capabilities.events 授权）。
 * - subscribe：订阅事件（白名单），返回取消订阅函数
 * - publish：发布事件（需 publish 能力），事件名强制 plugin:<id>: 前缀
 * 插件间可协作：A 插件发布，B 插件订阅响应。
 */
export interface PluginEventService {
  subscribe(event: string, callback: (payload: unknown) => void): () => void
  publish(event: string, payload?: unknown): void
}

// ====== 系统集成层（services.scheduler / windows / native） ======

export interface PluginSchedulerService {
  /** 固定间隔任务，返回 jobId */
  every(intervalMs: number, fn: () => void | Promise<void>): string
  /** cron 表达式任务（5 段式） */
  cron(expression: string, fn: () => void | Promise<void>): string
  cancel(jobId: string): void
}

export interface PluginWindowOptions {
  width: number
  height: number
  title?: string
  /** 置顶悬浮窗（如语音字幕） */
  alwaysOnTop?: boolean
  frame?: boolean
  /** 透明窗口（悬浮字幕等场景） */
  transparent?: boolean
  /** 不显示在任务栏 */
  skipTaskbar?: boolean
  /** 不可聚焦（悬浮字幕） */
  focusable?: boolean
  /** 无阴影 */
  hasShadow?: boolean
  resizable?: boolean
  /** 初始位置（默认居中） */
  x?: number
  y?: number
  /** 窗口内容：插件目录下相对路径的 HTML；与 url 二选一 */
  contentPath?: string
  /** 加载远程 URL（如 OAuth 登录页）；与 contentPath 二选一 */
  url?: string
  /** 窗口加载完成后发送给渲染端的事件（渲染端经插件桥 onEvent 接收） */
  readyEvent?: string
}

export interface PluginWindowHandle {
  id: string
  close(): void
  /** 向窗口渲染端发送消息（渲染端经插件桥 onEvent 接收） */
  send(event: string, payload?: unknown): void
  onClosed(callback: () => void): void
  /** 窗口尺寸（宽高像素） */
  setSize(width: number, height: number): void
  /** 窗口显示状态 */
  show(): void
  hide(): void
  isVisible(): boolean
}

/**
 * 插件窗口创建（需 windows 能力；应用退出/插件禁用时由宿主统一回收）。
 * 创建后的窗口自动纳入宿主广播目标：ctx.ipc.broadcast 会同时推送到该窗口渲染端。
 */
export interface PluginWindowService {
  create(options: PluginWindowOptions): PluginWindowHandle
}

/**
 * 宿主原生模块租借（需 native 能力；插件禁止自带 .node 文件）。
 * 可租借的模块为宿主「原生依赖白名单」中的固定集合（见 host-native-dependencies.json，
 * 运行时也可经 ctx.services.host.listNativeModules() 查询）；不在白名单中的模块借用会被拒绝。
 */
export interface PluginNativeService {
  /** 租借模块实例（如 'better-sqlite3'），须在宿主原生白名单内；ABI 与宿主一致 */
  borrow(name: string): unknown
  /** 模块解析路径（供插件 Worker 线程 require），须在宿主原生白名单内 */
  modulePath(name: string): string
}

/** 宿主路径服务（无需权限，随 services 始终注入） */
export interface PluginHostPathsService {
  /** 用户可配置的数据目录（默认 文档/WorkAvatar；用户可在设置中改盘） */
  getDataDir(): string
  /** 宿主可租借的原生模块白名单（name → semver 范围），供插件运行时感知宿主能力 */
  listNativeModules(): Record<string, string>
}

// ====== KMS 数据访问层（services.kms，需 capabilities.kms 授权） ======

/** KMS 数据查询服务：只读查询资料库，不触发索引/晋升等副作用 */
export interface PluginKmsService {
  /**
   * 检索资料库（关键字混合检索）
   * @returns SearchResult[]：{ file_id, file_name, file_path, text, match_type, score?, modified_time }
   */
  search<T = unknown>(
    query: string,
    options?: { limit?: number; collectionIds?: string[]; fileExtensions?: string[] }
  ): Promise<T[]>
  /** 列出资料库合集 */
  listCollections(): Promise<Array<{ id: string; name: string; description: string; file_count: number }>>
  /**
   * 读取文件内容（文本抽取）
   * @param options.paragraphId 指定段落；options.maxChars 截断长度
   */
  getContent<T = unknown>(fileId: string, options?: { paragraphId?: string; maxChars?: number }): Promise<T>
}

// ====== 插件协作层（services.shared / bus，需 capabilities.collaboration 授权） ======

/** 跨插件共享 KV：写仅限本插件命名空间；读本插件 + 受权读其他插件 */
export interface PluginSharedStore {
  /** 写入本插件命名空间下的 key（host 自动加 pluginId 前缀），同 key 覆盖 */
  set(key: string, value: unknown): Promise<void>
  /** 读取本插件命名空间下的 key */
  get<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined>
  /** 读取指定插件的共享数据（需 collaboration.shared.read 能力） */
  getFrom<T = unknown>(pluginId: string, key: string, defaultValue?: T): Promise<T | undefined>
  /** 删除本插件命名空间下的 key */
  delete(key: string): Promise<void>
  /** 列出本插件命名空间所有 key */
  keys(): Promise<string[]>
  /** 列出所有插件命名空间的 key（需 collaboration.shared.read 能力） */
  keysAll(): Promise<string[]>
}

/** 跨插件 RPC：方法名统一为 '目标插件id:方法名'，host 路由到目标插件注册的 responder */
export interface PluginBusService {
  /** 注册可被其他插件调用的方法（host 自动加本插件 id 前缀），返回取消注册函数 */
  respond(method: string, handler: (payload: unknown) => unknown | Promise<unknown>): () => void
  /**
   * 调用目标插件方法（需 collaboration.call 白名单包含 '目标插件id:方法名'）。
   * 目标未注册该方法返回 rejected promise。
   */
  call<T = unknown>(targetMethod: string, payload?: unknown): Promise<T>
}

/**
 * 宿主注入的共享服务聚合。
 * 未在 manifest capabilities 中声明的服务为 undefined（访问即报错便于发现）。
 */
export interface PluginServices {
  logger: PluginLogger
  /** 宿主路径（始终可用，无能力要求） */
  host: PluginHostPathsService
  /** 通用数据访问（需 capabilities.data 授权） */
  data?: PluginDataService
  /** KMS 数据查询（需 capabilities.kms 授权） */
  kms?: PluginKmsService
  /** 统一执行入口（需 capabilities.execute 授权） */
  execute?: PluginExecuteService
  /** 事件总线（需 capabilities.events 授权） */
  events?: PluginEventService
  /** 插件协作：共享 KV + 跨插件 RPC（需 capabilities.collaboration 授权） */
  shared?: PluginSharedStore
  bus?: PluginBusService
  notification?: PluginNotificationService
  scheduler?: PluginSchedulerService
  windows?: PluginWindowService
  native?: PluginNativeService
}
