import type { MessageWithThought } from '../components/workbench'
import { LRUCache } from '../utils/lru-cache'

export const MESSAGES_CACHE_MAX_SIZE = 20
export const MIN_LOADING_DISPLAY_MS = 120
export const CONVERSATION_PAGE_SIZE = 20
export const SCROLL_BOTTOM_THRESHOLD_PX = 10
export const DEFAULT_TEMPERATURE = 0.7

export interface ConversationStreamState {
  isStreaming: boolean
  conversationId: string
  assistantMessageId: string | null
  segCounter: number
  toolCallCounter: number
}

export const yieldToBrowser = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

export const getActiveBranchData = (m: MessageWithThought): {
  content: string
  thought?: string
  segments?: MessageWithThought['segments']
} => {
  if (m.role === 'assistant' && m.branches && m.branches.length > 0) {
    const branchIndex = m.activeBranchIndex ?? m.branches.length
    if (branchIndex < m.branches.length) {
      const branch = m.branches[branchIndex]
      return {
        content: branch.content,
        thought: branch.thought,
        segments: branch.segments,
      }
    }
  }
  return {
    content: m.content,
    thought: m.thought,
    segments: m.segments,
  }
}

export const extractToolCallsFromSegments = (m: MessageWithThought): Array<{
  id: string
  name: string
  args: any
  result?: any
  isComplete?: boolean
}> | undefined => {
  if (m.role !== 'assistant' || !m.segments) return undefined
  const toolSegs = m.segments.filter(s => s.type === 'tool_call' && s.toolName)
  if (toolSegs.length === 0) return undefined
  return toolSegs.map(s => ({
    id: s.toolCallId || s.id,
    name: s.toolName!,
    args: s.toolArgs,
    result: s.toolResult,
    isComplete: s.isToolComplete,
  }))
}

export interface EnrichedHistoryMessage {
  role: string
  content: string
  images?: string[]
  reasoning_content?: string
  toolCalls?: Array<{
    id: string
    name: string
    args: any
    result?: any
    isComplete?: boolean
  }>
  toolCallId?: string
}

export const buildEnrichedHistory = (msgs: MessageWithThought[]): EnrichedHistoryMessage[] => {
  return msgs.map(m => {
    const branch = getActiveBranchData(m)
    return {
      role: m.role,
      content: branch.content,
      images: m.images,
      reasoning_content: branch.thought,
      toolCalls: extractToolCallsFromSegments({ ...m, segments: branch.segments }),
    }
  })
}

export const calcTotalOutputChars = (segs: any[], content?: string): number => {
  let total = (content || '').length
  for (const s of segs || []) {
    if (s.type === 'answer' && s.content) {
      total += (typeof s.content === 'string' ? s.content.length : 0)
    }
  }
  return total
}

export const createPersistentMessagesCache = (): LRUCache<string, MessageWithThought[]> =>
  new LRUCache<string, MessageWithThought[]>(MESSAGES_CACHE_MAX_SIZE)

export type { MessageWithThought }
