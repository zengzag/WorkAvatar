import type { Message, GeneratedFileInfo } from '../../types'

export interface ToolCallInfo {
  id: string
  name: string
  args: any
  result?: any
  isComplete?: boolean
}

export interface MessageSegment {
  type: 'thinking' | 'answer' | 'tool_call' | 'delegation'
  id: string
  timestamp?: number
  completedAt?: number
  content?: string
  isStreaming?: boolean
  collapsed?: boolean
  toolName?: string
  toolArgs?: any
  toolResult?: any
  isToolComplete?: boolean
  toolCallId?: string
  /** LLM 正在流式生成工具参数（arguments JSON 尚未完成） */
  isToolArgsStreaming?: boolean
  /** 流式生成中的原始参数文本（JSON 字符串，可能不完整） */
  toolArgsRaw?: string
  /** 工具调用被中断/取消/失败时的状态描述（用户停止生成、LLM 中断等场景）。
   *  设置后 UI 以错误色展示，优先级高于 isToolArgsStreaming / isToolComplete */
  toolError?: string
  /** 工具执行中间进度步骤（仅UI展示，不进入LLM上下文） */
  toolProgress?: any[]
  /** 工具生成的文件列表（office_exec 等），用于弹窗预览 */
  generatedFiles?: GeneratedFileInfo[]
  // ---- delegation 段专用字段 ----
  /** 委托 id（路由子员工事件用；与后端 runId 一致） */
  delegationId?: string
  /** 后端子会话运行 id（v2，贯穿 launch→await→渲染） */
  runId?: string
  /** 并行组 id（一次 launch_agents 派发的一组 run 共享） */
  groupRunId?: string
  /** 并行组内序号（用于组内定位/首卡展示组信息） */
  runGroupIndex?: number
  /** 并行组内总数 */
  parallelTotal?: number
  /** 目标员工 id */
  targetEmployeeId?: string
  /** 目标员工名 */
  targetEmployeeName?: string
  /** 目标员工头像类型 */
  targetAvatarType?: string
  /** 委托指令 */
  instruction?: string
  /** 委托状态 */
  delegationStatus?: 'queued' | 'streaming' | 'completed' | 'failed' | 'timed_out' | 'cancelled'
  /** 子员工完整执行流（递归渲染） */
  subSegments?: MessageSegment[]
  /** 子员工 token 消耗 */
  delegationTokenUsage?: TokenUsage
  /** 折叠态展示的结果摘要 */
  resultSummary?: string
  /** 结构化运行结果（v2，含产物文件清单） */
  runResult?: {
    summary?: string
    generatedFiles?: GeneratedFileInfo[]
    autoDetectedFiles?: GeneratedFileInfo[]
    references?: string[]
  }
}

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
  totalChars?: number
}

export interface MessageBranch {
  content: string
  segments?: MessageSegment[]
  thought?: string
  tokenUsage?: TokenUsage
  isError?: boolean
  comparisonProviderId?: string
  comparisonModelId?: string
}

export interface MessageWithThought extends Message {
  thought?: string
  isStreamingThought?: boolean
  thoughtCollapsed?: boolean
  toolCalls?: ToolCallInfo[]
  segments?: MessageSegment[]
  tokenUsage?: TokenUsage
  branches?: MessageBranch[]
  activeBranchIndex?: number
  comparisonProviderId?: string
  comparisonModelId?: string
  images?: string[]
  _comparisonBranchMsgs?: MessageWithThought[]
  isCompactSummary?: boolean
  /** 本次生成被中止（用户停止/切换/异常中断），UI 展示中断提醒 */
  isAborted?: boolean
}

export function ensureSegments(msg: MessageWithThought): MessageWithThought {
  if (msg.role !== 'assistant') return msg
  if (msg.segments && msg.segments.length > 0) return msg

  const segments: MessageSegment[] = []
  let segIdx = 0

  if (msg.thought) {
    segments.push({
      type: 'thinking',
      id: `${msg.id}_seg_${segIdx++}`,
      content: msg.thought,
      collapsed: msg.thoughtCollapsed ?? true,
    })
  }

  if (msg.content) {
    segments.push({
      type: 'answer',
      id: `${msg.id}_seg_${segIdx++}`,
      content: msg.content,
    })
  }

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      segments.push({
        type: 'tool_call',
        id: `${msg.id}_tool_${segIdx++}`,
        toolName: tc.name,
        toolArgs: tc.args,
        toolResult: tc.result,
        isToolComplete: tc.isComplete,
        collapsed: true,
      })
    }
  }

  return { ...msg, segments }
}

function isSegmentComplete(s: MessageSegment): boolean {
  if (s.type === 'tool_call') return !!s.isToolComplete
  if (s.type === 'delegation') return s.delegationStatus === 'completed' || s.delegationStatus === 'failed' || s.delegationStatus === 'timed_out' || s.delegationStatus === 'cancelled'
  return s.isStreaming === false
}

function patchSegmentsArr(segs: MessageSegment[]): { result: MessageSegment[]; patched: boolean } {
  let patched = false
  const result = segs.map(s => {
    if (s.completedAt || !s.timestamp) return s
    if (!isSegmentComplete(s)) return s
    patched = true
    return { ...s, completedAt: Date.now() }
  })
  return { result: patched ? result : segs, patched }
}

export function patchMissingCompletedAt(msg: MessageWithThought): MessageWithThought {
  if (msg.role !== 'assistant') return msg

  let anyPatched = false
  const newMsg = { ...msg }

  if (msg.segments) {
    const { result, patched } = patchSegmentsArr(msg.segments)
    if (patched) {
      newMsg.segments = result
      anyPatched = true
    }
  }

  if (msg.branches) {
    let branchesPatched = false
    const newBranches = msg.branches.map(b => {
      if (!b.segments) return b
      const { result, patched } = patchSegmentsArr(b.segments)
      if (patched) {
        branchesPatched = true
        return { ...b, segments: result }
      }
      return b
    })
    if (branchesPatched) {
      newMsg.branches = newBranches
      anyPatched = true
    }
  }

  return anyPatched ? newMsg : msg
}
