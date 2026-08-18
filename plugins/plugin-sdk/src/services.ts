/** 日志接口（宿主 logger 的插件作用域封装，自动带插件 id 前缀） */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

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

export interface PluginLlmChatRequest {
  prompt: string
  system?: string
  /** 不传则用默认模型 */
  providerId?: string
  modelId?: string
}

/** 流式 LLM 调用回调（对齐宿主 PiAIProvider.chatStream） */
export interface PluginLlmStreamCallbacks {
  onChunk?: (text: string) => void
  onThought?: (thought: string) => void
  onToolCall?: (toolCall: { id?: string; name?: string; arguments?: string }) => void
}

export interface PluginLlmChatStreamRequest {
  /** 用户消息内容（多轮时按顺序追加 role=user 消息） */
  prompt: string
  /** 追加的历史用户消息（可选，按序放在 prompt 之前） */
  history?: string[]
  system?: string
  /** 不传则用默认模型 */
  providerId?: string
  modelId?: string
  temperature?: number
  maxTokens?: number
}

/** 受控 LLM 调用（经宿主 PiAIProvider，自动记 LLM 日志与用量） */
export interface PluginLlmService {
  chat(request: PluginLlmChatRequest): Promise<string>
  /** 流式生成（如会议纪要逐字渲染），回调返回累积文本 */
  chatStream(
    request: PluginLlmChatStreamRequest,
    callbacks?: PluginLlmStreamCallbacks,
    signal?: AbortSignal
  ): Promise<string>
}

export interface PluginAgentTaskParams {
  employeeId: string
  prompt: string
  /** 复用已有会话；不传则新建 */
  conversationId?: string
  /** 任务标题（运行记录展示用） */
  title?: string
}

export interface PluginAgentTaskCallbacks {
  onChunk?: (text: string) => void
  onDone?: (result: { text: string }) => void
  onError?: (error: string) => void
}

export interface PluginAgentTaskResult {
  conversationId?: string
  text: string
}

/** 数字员工委派（需 agent 权限） */
export interface PluginAgentService {
  listEmployees(): Promise<Array<{ id: string; name: string }>>
  runTask(
    params: PluginAgentTaskParams,
    callbacks?: PluginAgentTaskCallbacks,
    signal?: AbortSignal
  ): Promise<PluginAgentTaskResult>
}

export interface PluginConversationSummary {
  id: string
  title: string
  employeeId: string
  updatedAt: string
}

/** 内核对话只读查询（需 conversations 权限） */
export interface PluginConversationReader {
  getTitle(conversationId: string): Promise<string | null>
  listRecent(limit?: number): Promise<PluginConversationSummary[]>
}

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
 * 插件窗口创建（需 windows 权限；应用退出/插件禁用时由宿主统一回收）。
 * 创建后的窗口自动纳入宿主广播目标：ctx.ipc.broadcast 会同时推送到该窗口渲染端。
 */
export interface PluginWindowService {
  create(options: PluginWindowOptions): PluginWindowHandle
}

/** 宿主原生模块租借（需 nativeModules 权限；插件禁止自带 .node 文件） */
export interface PluginNativeService {
  /** 租借模块实例（如 'better-sqlite3'），ABI 与宿主一致 */
  borrow(name: string): unknown
  /** 模块解析路径（供插件 Worker 线程 require） */
  modulePath(name: string): string
}

/** 宿主路径服务（无需权限，随 services 始终注入） */
export interface PluginHostPathsService {
  /** 用户可配置的数据目录（默认 文档/WorkAvatar；用户可在设置中改盘） */
  getDataDir(): string
}

/**
 * 宿主注入的共享服务聚合。
 * 未在 manifest permissions 中声明的服务为 undefined（访问即报错便于发现）。
 */
export interface PluginServices {
  logger: PluginLogger
  /** 宿主路径（始终可用，无权限要求） */
  host: PluginHostPathsService
  notification?: PluginNotificationService
  llm?: PluginLlmService
  agent?: PluginAgentService
  conversations?: PluginConversationReader
  scheduler?: PluginSchedulerService
  windows?: PluginWindowService
  native?: PluginNativeService
}
