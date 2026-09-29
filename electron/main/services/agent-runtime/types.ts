import type { GeneratedFileInfo, ThinkingLevel } from '../../../shared/types'

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

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
  error?: string
}

export interface AgentRunEventEntry {
  eventType: string
  data: any
}

export interface ActiveRunInfo extends AgentRun {
  eventLog: AgentRunEventEntry[]
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