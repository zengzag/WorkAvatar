import type { GeneratedFileInfo, ThinkingLevel, EphemeralSubAgentSpec } from '../../../shared/types'

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
/** 运行生命周期：ephemeral=临时角色（run 结束下线） / persistent=已有员工（常驻） */
export type AgentRunLifecycle = 'ephemeral' | 'persistent'
/** 运行活性（按最近活动时间派生，供 UI/工具观测）：progressing=推进中 / stalled=停滞 / idle=空闲 */
export type AgentRunLiveness = 'progressing' | 'stalled' | 'idle'

export interface AgentRunTokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}

export interface AgentRunResult {
  summary: string
  generatedFiles: GeneratedFileInfo[]
  autoDetectedFiles: GeneratedFileInfo[]
  references?: string[]
  tokenUsage?: AgentRunTokenUsage
  /** 结构化交付物（output_schema 强制上报，阶段四） */
  structured?: unknown
  /** 完成门超限降级时未收尾的任务项（阶段四） */
  incompleteTasks?: string[]
}

export interface AgentRun {
  runId: string
  parentConversationId: string
  parentSessionId: string
  parentRunId?: string
  employeeId: string
  employeeName: string
  employeeAvatarType?: string
  status: AgentRunStatus
  instruction: string
  contextFiles?: string[]
  summary?: string
  generatedFiles: GeneratedFileInfo[]
  autoDetectedFiles: GeneratedFileInfo[]
  tokenUsage?: AgentRunTokenUsage
  error?: string
  startedAt?: number
  endedAt?: number
  conversationId?: string
  /** 追问轮：本 run 追问所针对的原委托 runId（复用其子会话实现多轮对话） */
  followupOfRunId?: string
  /** 临时子智能体规格（存在时 run 期注册 inline 员工、结束下线，落库支持追问重建） */
  ephemeral?: EphemeralSubAgentSpec
  lifecycle?: AgentRunLifecycle
  /** 最近一次事件时间（Unix ms），供 liveness 派生（运行中才有效） */
  lastActivityAt?: number
  /** 后台派发：立即返回 runId，完成后向主管投递通知消息 */
  runInBackground?: boolean
  /** 结构化输出契约（JSON Schema 对象；提供时子会话强制上报结果，阶段四） */
  outputSchema?: Record<string, unknown>
}

export interface LaunchSubAgentInput {
  parentSessionId: string
  parentEmployeeId: string
  parentConversationId: string
  parentRunId?: string
  targetEmployeeId: string
  instruction: string
  contextFiles?: string[]
  /** 复用指定子会话（如评审节点预建的会话）；不传则新建子会话 */
  conversationId?: string
  delegationDepth: number
  delegationChain: string[]
  parentAbortSignal?: AbortSignal
  enableThinking?: ThinkingLevel
  highPermission?: boolean
  /** 执行事件实时回调（chunk/thought/tool_call/tool_result 等，未经 ring buffer 合并） */
  onEvent?: (eventType: string, data: any) => void
  /** 临时子智能体规格：与 targetEmployeeId 二选一（优先，targetEmployeeId 忽略） */
  ephemeral?: EphemeralSubAgentSpec
  /** 后台派发：立即返回，结束后通知 */
  runInBackground?: boolean
  /** 结构化输出契约（JSON Schema 对象，阶段四） */
  outputSchema?: Record<string, unknown>
}

/** 追问输入：针对已完成委托（run）继续同一子会话的多轮对话 */
export interface LaunchFollowupInput {
  followupOfRunId: string
  parentSessionId: string
  parentEmployeeId: string
  parentConversationId: string
  instruction: string
  delegationDepth: number
  delegationChain: string[]
  parentAbortSignal?: AbortSignal
  enableThinking?: ThinkingLevel
  highPermission?: boolean
}

export interface LaunchSubAgentResult {
  success: boolean
  runId?: string
  targetEmployeeName?: string
  targetEmployeeId?: string
  error?: string
}

export interface AgentRunEventEntry {
  eventType: string
  data: any
}

export interface ActiveRunInfo extends AgentRun {
  eventLog: AgentRunEventEntry[]
  liveness: AgentRunLiveness
}

export interface AgentRunOutcome {
  runId: string
  employeeName?: string
  status: AgentRunStatus
  success: boolean
  output?: string
  error?: string
  tokenUsage?: AgentRunTokenUsage
  result?: AgentRunResult
  /** 本次执行实际使用的子会话 id（新建或复用） */
  conversationId?: string
}
