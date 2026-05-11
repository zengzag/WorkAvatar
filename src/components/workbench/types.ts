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
  content?: string
  isStreaming?: boolean
  collapsed?: boolean
  toolName?: string
  toolArgs?: any
  toolResult?: any
  isToolComplete?: boolean
}

export interface MessageWithThought extends Message {
  thought?: string
  isStreamingThought?: boolean
  thoughtCollapsed?: boolean
  toolCalls?: ToolCallInfo[]
  segments?: MessageSegment[]
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
