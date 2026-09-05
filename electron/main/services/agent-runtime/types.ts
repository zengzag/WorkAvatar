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
  delegationDepth: number
  delegationChain: string[]
  parentAbortSignal?: AbortSignal
  enableThinking?: ThinkingLevel
  highPermission?: boolean
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
}