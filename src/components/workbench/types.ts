import type { Message } from '../../types'

export interface ToolCallInfo {
  id: string
  name: string
  args: any
  result?: any
  isComplete?: boolean
}

export interface MessageSegment {
  type: 'thinking' | 'answer' | 'tool_call'
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
