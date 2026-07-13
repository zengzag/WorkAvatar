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
  const result: EnrichedHistoryMessage[] = []
  for (const m of msgs) {
    const branch = getActiveBranchData(m)

    // 非助手消息：直接透传
    if (m.role !== 'assistant') {
      result.push({
        role: m.role,
        content: branch.content,
        images: m.images,
        reasoning_content: branch.thought,
      })
      continue
    }

    const segments = branch.segments || []

    // 无 segments 或无 tool_call 段：退化为旧的扁平结构（向后兼容）
    if (segments.length === 0 || !segments.some(s => s.type === 'tool_call')) {
      result.push({
        role: 'assistant',
        content: branch.content,
        images: m.images,
        reasoning_content: branch.thought,
        toolCalls: extractToolCallsFromSegments({ ...m, segments: branch.segments }),
      })
      continue
    }

    // 从 segments 重建多轮对话结构。
    //
    // 一次 agent turn 可能包含多轮 LLM 调用（thinking → answer → tool_calls），
    // 每轮 LLM 调用在 OpenAI API 协议中应表达为独立的 assistant 消息，
    // 后跟 tool 消息。如果把所有轮次的 tool_calls 合并到一条 assistant 消息，
    // 会破坏对话上下文结构，导致 LLM prompt-cache 命中率下降、
    // 工具结果与 tool_call_id 错位等问题。
    //
    // 分组规则：遇到 thinking/answer 段且当前轮已收集 tool_calls 时，
    // 说明新的一轮 LLM 调用开始，先输出当前轮 + 其 tool 结果，再开新轮。
    let currentContent = ''
    let currentReasoning = ''
    let currentToolCalls: NonNullable<EnrichedHistoryMessage['toolCalls']> = []
    let hasToolCalls = false

    const flushTurn = () => {
      result.push({
        role: 'assistant',
        content: currentContent,
        images: m.images,
        reasoning_content: currentReasoning || undefined,
        toolCalls: currentToolCalls.length > 0 ? currentToolCalls : undefined,
      })
      // tool 结果消息由后端 expandFrontendMessages 从 toolCalls 数组展开，
      // 这里不需要单独输出 tool 角色消息，保持与旧格式兼容。
      currentContent = ''
      currentReasoning = ''
      currentToolCalls = []
      hasToolCalls = false
    }

    for (const seg of segments) {
      if (seg.type === 'thinking') {
        if (hasToolCalls) {
          flushTurn()
        }
        currentReasoning += (seg.content || '')
      } else if (seg.type === 'answer') {
        if (hasToolCalls) {
          flushTurn()
        }
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

    // 输出最后一轮（可能没有 tool_calls，即最终回答）
    flushTurn()
  }
  return result
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
