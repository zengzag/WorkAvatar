import type { MessageWithThought } from '../components/workbench'
import { LRUCache } from '../utils/lru-cache'

export const MESSAGES_CACHE_MAX_SIZE = 60
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
  // 找到最近的压缩分隔符（isCompactSummary）及其紧随的压缩摘要 assistant 消息。
  // 若存在：发给 LLM 的 history = 压缩摘要 + 分隔符之后的消息（分隔符之前的消息对 LLM 不可见）
  // 若不存在：发给 LLM 的 history = 全部消息
  let compactSepIndex = -1
  let compactSummary = ''
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].isCompactSummary) {
      compactSepIndex = i
      // 摘要消息紧随分隔符之后，提取内容后跳过它
      if (i + 1 < msgs.length && msgs[i + 1].id.startsWith('msg_compact_summary_')) {
        compactSummary = (msgs[i + 1].content || '').trim()
      }
      break
    }
  }

  // 分隔符和摘要消息本身不参与 LLM history，从摘要消息之后开始
  const skipCount = compactSepIndex >= 0
    ? (compactSummary ? 2 : 1)  // 有摘要：跳过分隔符+摘要；无摘要：只跳过分隔符
    : 0
  const sourceMsgs = compactSepIndex >= 0 ? msgs.slice(compactSepIndex + skipCount) : msgs
  const subResult: EnrichedHistoryMessage[] = []

  const pushMsg = (m: MessageWithThought) => {
    const branch = getActiveBranchData(m)

    // 非助手消息：直接透传
    if (m.role !== 'assistant') {
      subResult.push({
        role: m.role,
        content: branch.content,
        images: m.images,
        reasoning_content: branch.thought,
      })
      return
    }

    const segments = branch.segments || []

    // 无 segments 或无 tool_call 段：退化为旧的扁平结构（向后兼容）
    if (segments.length === 0 || !segments.some(s => s.type === 'tool_call')) {
      subResult.push({
        role: 'assistant',
        content: branch.content,
        images: m.images,
        reasoning_content: branch.thought,
        toolCalls: extractToolCallsFromSegments({ ...m, segments: branch.segments }),
      })
      return
    }

    let currentContent = ''
    let currentReasoning = ''
    let currentToolCalls: NonNullable<EnrichedHistoryMessage['toolCalls']> = []
    let hasToolCalls = false

    const flushTurn = () => {
      subResult.push({
        role: 'assistant',
        content: currentContent,
        images: m.images,
        reasoning_content: currentReasoning || undefined,
        toolCalls: currentToolCalls.length > 0 ? currentToolCalls : undefined,
      })
      currentContent = ''
      currentReasoning = ''
      currentToolCalls = []
      hasToolCalls = false
    }

    for (const seg of segments) {
      if (seg.type === 'thinking') {
        if (hasToolCalls) flushTurn()
        currentReasoning += (seg.content || '')
      } else if (seg.type === 'answer') {
        if (hasToolCalls) flushTurn()
        currentContent += (seg.content || '')
      } else if (seg.type === 'tool_call') {
        if (!seg.toolName) continue
        currentToolCalls.push({
          id: seg.toolCallId || seg.id,
          name: seg.toolName,
          args: seg.toolArgs,
          result: seg.toolResult,
          isComplete: seg.isToolComplete,
        })
        hasToolCalls = true
      }
    }
    flushTurn()
  }

  for (const m of sourceMsgs) pushMsg(m)

  if (compactSummary) {
    subResult.unshift({
      role: 'system',
      content: `[对话历史摘要]\n${compactSummary}`,
    })
  }
  return subResult
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
