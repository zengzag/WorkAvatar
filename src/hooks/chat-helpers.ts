import type { MessageSegment, MessageWithThought } from '../components/workbench'
import { LRUCache } from '../utils/lru-cache'
import {
  CHECKPOINT_PREAMBLE,
  COMPACTED_CHECKPOINT_OPEN,
  COMPACTED_CHECKPOINT_CLOSE,
} from '../../electron/shared/checkpoint-format'

/**
 * 单个员工内存中保留的会话消息上限。
 * 单条会话的 messages_json 可达数 MB（工具结果/文件内容），解析后体积更大；
 * 缓存过多会让渲染进程随使用时长持续膨胀，这里只保留最近切换的几个会话。
 */
export const MESSAGES_CACHE_MAX_SIZE = 8
export const MIN_LOADING_DISPLAY_MS = 120
export const CONVERSATION_PAGE_SIZE = 20
export const SCROLL_BOTTOM_THRESHOLD_PX = 10
export const DEFAULT_TEMPERATURE = 0.7

/** 段是否命中指定 runId（delegation 段用 runId/delegationId 关联后端运行） */
function isRunSegment(s: MessageSegment, runId: string): boolean {
  return s.type === 'delegation' && (s.runId === runId || s.delegationId === runId)
}

/**
 * 在段树中递归查找指定 runId 的委托段（含父委托卡 subSegments 内的嵌套子任务）。
 * 嵌套层级的 run 事件与顶层共用同一会话路由，必须递归查找才能落到正确的卡片。
 */
export function findRunSegment(segs: MessageSegment[], runId: string): MessageSegment | null {
  for (const s of segs) {
    if (isRunSegment(s, runId)) return s
    if (s.type === 'delegation' && s.subSegments?.length) {
      const hit = findRunSegment(s.subSegments, runId)
      if (hit) return hit
    }
  }
  return null
}

/** 在段树中按 runId 不可变更新委托段；未命中返回 null（调用方保持原状态） */
export function patchRunSegment(
  segs: MessageSegment[],
  runId: string,
  updater: (seg: MessageSegment) => MessageSegment,
): MessageSegment[] | null {
  let hit = false
  const walk = (list: MessageSegment[]): MessageSegment[] =>
    list.map(s => {
      if (hit) return s
      if (isRunSegment(s, runId)) {
        hit = true
        return updater(s)
      }
      if (s.type === 'delegation' && s.subSegments?.length) {
        const nextSub = walk(s.subSegments)
        if (hit) return { ...s, subSegments: nextSub }
      }
      return s
    })
  const out = walk(segs)
  return hit ? out : null
}

/** 把嵌套子任务的委托段追加到发起方委托段（runId=parentRunId）的 subSegments 末尾；未命中返回 null */
export function appendNestedDelegation(
  segs: MessageSegment[],
  parentRunId: string,
  nested: MessageSegment,
): MessageSegment[] | null {
  let hit = false
  const walk = (list: MessageSegment[]): MessageSegment[] =>
    list.map(s => {
      if (hit) return s
      if (isRunSegment(s, parentRunId)) {
        hit = true
        return { ...s, subSegments: [...(s.subSegments || []), nested] }
      }
      if (s.type === 'delegation' && s.subSegments?.length) {
        const nextSub = walk(s.subSegments)
        if (hit) return { ...s, subSegments: nextSub }
      }
      return s
    })
  const out = walk(segs)
  return hit ? out : null
}

/** 递归映射段树（含 delegation.subSegments），用于统一收尾/清理 */
export function mapSegmentsTree(
  segs: MessageSegment[],
  fn: (seg: MessageSegment) => MessageSegment,
): MessageSegment[] {
  return segs.map(s => {
    const expanded = s.type === 'delegation' && s.subSegments?.length
      ? { ...s, subSegments: mapSegmentsTree(s.subSegments, fn) }
      : s
    return fn(expanded)
  })
}

/**
 * 递归切换段树中指定 id 段的折叠态（含 delegation.subSegments 内任意嵌套层级）；
 * 未命中返回 null。用于委托卡（含嵌套子任务卡）的展开/收起。
 */
export function toggleSegmentInTree(segs: MessageSegment[], segId: string): MessageSegment[] | null {
  let hit = false
  const walk = (list: MessageSegment[]): MessageSegment[] =>
    list.map(s => {
      if (hit) return s
      if (s.id === segId) {
        hit = true
        return { ...s, collapsed: !s.collapsed }
      }
      if (s.type === 'delegation' && s.subSegments?.length) {
        const next = walk(s.subSegments)
        if (hit) return { ...s, subSegments: next }
      }
      return s
    })
  const out = walk(segs)
  return hit ? out : null
}

export interface ConversationStreamState {
  isStreaming: boolean
  conversationId: string
  assistantMessageId: string | null
  segCounter: number
  toolCallCounter: number
  /** delegation/run 段 id 计数器 */
  runCounter: number
  /** 并行组自增号（生成 groupRunId） */
  groupSeq: number
}

export const getActiveBranchData = (m: MessageWithThought): {
  content: string
  thought?: string
  segments?: MessageWithThought['segments']
} => {
  if (m.role === 'assistant' && m.branches && m.branches.length > 0) {
    const branchIndex = m.activeBranchIndex ?? m.branches.length
    // 下限保护：负数索引虽小于 length，但 branches[-1] 为 undefined，读取其 content 会抛 TypeError
    if (branchIndex >= 0 && branchIndex < m.branches.length) {
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

/**
 * delegation 段的 tool_result 文本：结果摘要 + 生成文件清单（摘要缺失时用兜底文案）。
 * 扁平分支与段循环分支共用，避免同一次委托因消息里有无 tool_call 段而给出不同结果（文件清单丢失）。
 */
const buildDelegationResultText = (seg: MessageSegment): string => {
  const runFiles = (seg.runResult?.generatedFiles || []).concat(seg.runResult?.autoDetectedFiles || [])
  const fileLines = runFiles.length > 0
    ? `\n生成的成果文件：\n${runFiles.map(f => `- ${f.path}`).join('\n')}`
    : ''
  return `${seg.resultSummary || '(子员工已完成)'}${fileLines}`
}

/** 是否为 LLM 调用失败的提示段（兼容旧数据里按 id 约定生成的错误段） */
export const isErrorNoticeSegment = (seg: MessageSegment): boolean =>
  seg.isErrorNotice === true || /_(start_)?err_\d+$/.test(seg.id)

/**
 * 每次模型请求开始时的段数量（内存态）：请求失败后据此回滚这次请求的残缺输出。
 * key 为助手消息 id，按消息隔离（续写/重试只影响自己）。
 */
const _llmRequestSegStart = new Map<string, number>()

export const markLlmRequestStart = (msgId: string, segCount: number): void => {
  _llmRequestSegStart.set(msgId, segCount)
}

export const peekLlmRequestSegStart = (msgId: string): number | undefined => _llmRequestSegStart.get(msgId)

export const clearLlmRequestSegStart = (msgId: string): void => {
  _llmRequestSegStart.delete(msgId)
}

/**
 * 重试前回滚失败请求的残缺输出：段裁剪到失败请求开始时，
 * 正文按保留的 answer 段重算（content 是流式累加值，无法按段切分）。
 */
export const rollbackFailedAttempt = (
  segments: MessageSegment[] = [],
  segStart?: number,
): { segments: MessageSegment[]; content: string } => {
  const bounded = segStart !== undefined && segStart >= 0 && segStart <= segments.length
  const cut = bounded ? (segStart as number) : segments.length
  const head = segments.slice(0, cut)
  // 失败请求期间到达的子任务卡属于仍在运行的委托：保留，否则其后续事件无处落位
  const liveDelegations = segments.slice(cut).filter(s => s.type === 'delegation')
  const kept = [...head, ...liveDelegations].filter(s => !isErrorNoticeSegment(s))
  return {
    segments: kept,
    content: kept.filter(s => s.type === 'answer').map(s => s.content || '').join(''),
  }
}

/**
 * 原地续写的段 id 起始计数：新段 id 必须避开消息内已有段，
 * 否则 React key 重复、折叠态会命中错段。
 */
export const nextStreamCounters = (msgId: string, segments: MessageSegment[] = []) => {
  const counters = { segCounter: 0, toolCallCounter: 0, runCounter: 0, groupSeq: 0 }
  const bump = (id: string | undefined, prefix: string, key: keyof typeof counters) => {
    if (!id || !id.startsWith(prefix)) return
    const n = Number(id.slice(prefix.length))
    if (Number.isInteger(n) && n + 1 > counters[key]) counters[key] = n + 1
  }
  const walk = (list: MessageSegment[]) => {
    for (const s of list) {
      bump(s.id, `${msgId}_seg_`, 'segCounter')
      bump(s.id, `${msgId}_tool_`, 'toolCallCounter')
      bump(s.id, `${msgId}_run_`, 'runCounter')
      bump(s.id, `grp_${msgId}_`, 'groupSeq')
      if (s.subSegments?.length) walk(s.subSegments)
    }
  }
  walk(segments)
  return counters
}

export const extractToolCallsFromSegments = (m: MessageWithThought): Array<{
  id: string
  name: string
  args: any
  result?: any
  resultRaw?: string
  isError?: boolean
  images?: string[]
  isComplete?: boolean
}> | undefined => {
  if (m.role !== 'assistant' || !m.segments) return undefined
  const toolSegs = m.segments.filter(s => (s.type === 'tool_call' && s.toolName) || s.type === 'delegation')
  if (toolSegs.length === 0) return undefined
  return toolSegs.map(s => {
    if (s.type === 'delegation') {
      return {
        id: s.toolCallId || s.delegationId || s.id,
        name: s.toolName || 'delegate_to_employee',
        args: s.toolArgs ?? { target_employee_id: s.targetEmployeeId, instruction: s.instruction || '' },
        result: s.toolResult ?? buildDelegationResultText(s),
        resultRaw: s.toolResultRaw,
        isError: s.toolIsError,
        isComplete: s.delegationStatus === 'completed' || s.delegationStatus === 'failed' || s.delegationStatus === 'timed_out' || s.delegationStatus === 'cancelled',
      }
    }
    return {
      id: s.toolCallId || s.id,
      name: s.toolName!,
      args: s.toolArgs,
      result: s.toolResult,
      resultRaw: s.toolResultRaw,
      isError: s.toolIsError,
      images: s.toolResultImages,
      isComplete: s.isToolComplete,
    }
  })
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
    resultRaw?: string
    isError?: boolean
    images?: string[]
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
    /** 当前正在累积的 assistant 消息所属的模型请求轮次（用于还原消息边界） */
    let currentIteration: number | undefined

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
      currentIteration = undefined
    }

    // 换迭代即换一条 assistant 消息：连续「只调工具、没有正文」的轮次会被合并成一条，
    // 与真实 transcript 不一致，下一轮重建历史时前缀从合并点起全部失效。
    const switchTurnIfNewIteration = (iteration?: number) => {
      if (iteration === undefined) return
      if (currentIteration !== undefined && iteration !== currentIteration) flushTurn()
      currentIteration = iteration
    }

    for (const seg of segments) {
      if (seg.type === 'thinking') {
        // 工具调用之后出现的思考必然属于下一条 assistant 消息
        if (hasToolCalls) flushTurn()
        currentReasoning += (seg.content || '')
      } else if (seg.type === 'answer') {
        if (hasToolCalls) flushTurn()
        currentContent += (seg.content || '')
      } else if (seg.type === 'tool_call') {
        if (!seg.toolName) continue
        switchTurnIfNewIteration(seg.iteration)
        currentToolCalls.push({
          id: seg.toolCallId || seg.id,
          name: seg.toolName,
          args: seg.toolArgs,
          result: seg.toolResult,
          resultRaw: seg.toolResultRaw,
          isError: seg.toolIsError,
          images: seg.toolResultImages,
          isComplete: seg.isToolComplete,
        })
        hasToolCalls = true
      } else if (seg.type === 'delegation') {
        // 只回放真实发生过的 delegate_to_employee 调用（由 onToolCall 建卡，带 toolCallId）。
        // run 事件创建的并行子任务卡（launch_agents）没有 toolCallId，其真实调用已由
        // launch_agents 的 tool_call 段表示；再补一条会伪造出模型从未发起的调用。
        if (!seg.toolCallId) continue
        // 委托段等价于一次真实工具调用：id / args / result 一律取真实值（缺失时才用展示信息兜底），
        // 否则重建出的 assistant.tool_calls 与 tool result 与上一轮实际请求不一致
        if (seg.iteration === undefined) {
          // 旧数据没有 iteration 标记：沿用旧启发式（委托单独成轮）
          if (hasToolCalls) flushTurn()
        } else {
          switchTurnIfNewIteration(seg.iteration)
        }
        currentToolCalls.push({
          id: seg.toolCallId,
          name: seg.toolName || 'delegate_to_employee',
          args: seg.toolArgs ?? {
            target_employee_id: seg.targetEmployeeId,
            instruction: seg.instruction || '',
          },
          result: seg.toolResult ?? buildDelegationResultText(seg),
          resultRaw: seg.toolResultRaw,
          isError: seg.toolIsError,
          isComplete: seg.delegationStatus === 'completed' || seg.delegationStatus === 'failed' || seg.delegationStatus === 'timed_out' || seg.delegationStatus === 'cancelled',
        })
        hasToolCalls = true
      }
    }
    flushTurn()
  }

  for (const m of sourceMsgs) pushMsg(m)

  if (compactSummary) {
    // 手动压缩摘要以 user 角色的 checkpoint 注入历史头部（而非 system）：
    // 后端会合并所有 system 消息进系统提示词，role=system 会击穿字节稳定的前缀缓存。
    // 格式常量与后端自动压缩（agent/memory/checkpoint.ts）共用 shared 定义，保证字节级一致。
    subResult.unshift({
      role: 'user',
      content: [
        CHECKPOINT_PREAMBLE,
        COMPACTED_CHECKPOINT_OPEN,
        compactSummary.trim(),
        COMPACTED_CHECKPOINT_CLOSE,
      ].join('\n'),
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
