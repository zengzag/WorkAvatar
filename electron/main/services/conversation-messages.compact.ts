/**
 * 大任务会话的显示裁剪与回写合并。
 *
 * 背景：单条会话的 messages_json 可能达到十几 MB（子员工委托的完整执行过程
 * 以 subSegments 内嵌在主管消息里）。任务切换时整份 JSON 经 IPC 进入渲染进程，
 * 会带来明显的主线程卡顿与内存膨胀。
 *
 * 策略（只影响超过阈值的会话）：
 * - 读取：把"已完成委托"的 subSegments 从返回给渲染进程的消息里摘掉，仅保留数量标记；
 * - 回写：渲染进程回传的消息里带 `subSegmentsOmitted` 标记时，从数据库原值中还原，
 *   保证持久化数据不丢失（渲染进程只持有裁剪后的视图）。
 * - 展开某个委托时按需拉取该段的 subSegments（CONVERSATION_GET_DELEGATION_DETAIL）。
 */

/** 小于该体积的会话不做裁剪，保持原有行为 */
export const COMPACT_MIN_MESSAGES_BYTES = 1_000_000
/** 单个委托的子过程超过该体积才外置（避免为小委托增加额外请求） */
const COMPACT_MIN_SUB_SEGMENTS_BYTES = 8 * 1024

export const SUB_SEGMENTS_OMITTED = 'subSegmentsOmitted'
export const SUB_SEGMENT_COUNT = 'subSegmentCount'

type Segment = Record<string, any>
type Message = Record<string, any>

/** 遍历消息下的所有段数组：正文段、分支段、对比分支段 */
function forEachSegmentGroup(msg: Message, visit: (segments: Segment[], groupKey: string) => void): void {
  if (Array.isArray(msg.segments)) visit(msg.segments, String(msg.id))
  if (Array.isArray(msg.branches)) {
    msg.branches.forEach((branch: any, index: number) => {
      if (Array.isArray(branch?.segments)) visit(branch.segments, `${msg.id}|b${branch.id ?? index}`)
    })
  }
  if (Array.isArray(msg._comparisonBranchMsgs)) {
    msg._comparisonBranchMsgs.forEach((branch: any, index: number) => {
      if (Array.isArray(branch?.segments)) visit(branch.segments, `${msg.id}|c${branch.id ?? index}`)
    })
  }
}

const isFinishedDelegation = (seg: Segment): boolean =>
  seg.type === 'delegation' &&
  (seg.delegationStatus === 'completed' || seg.delegationStatus === 'failed' ||
    seg.delegationStatus === 'timed_out' || seg.delegationStatus === 'cancelled')

/** 就地裁剪已完成委托的子过程，返回是否发生裁剪 */
function compactMessagesInPlace(messages: Message[]): boolean {
  let changed = false
  for (const msg of messages) {
    forEachSegmentGroup(msg, (segments) => {
      for (const seg of segments) {
        if (!isFinishedDelegation(seg)) continue
        const sub = seg.subSegments
        if (!Array.isArray(sub) || sub.length === 0) continue
        if (JSON.stringify(sub).length < COMPACT_MIN_SUB_SEGMENTS_BYTES) continue
        seg[SUB_SEGMENT_COUNT] = sub.length
        seg[SUB_SEGMENTS_OMITTED] = true
        delete seg.subSegments
        changed = true
      }
    })
  }
  return changed
}

/**
 * 把数据库中的 messages_json 转换为适合渲染进程的视图。
 * 解析失败或体积未达阈值时原样返回，保证任何异常都不会影响会话打开。
 */
export function compactMessagesJson(raw: string): string {
  if (!raw || raw.length < COMPACT_MIN_MESSAGES_BYTES) return raw
  let messages: Message[]
  try {
    messages = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!Array.isArray(messages)) return raw
  if (!compactMessagesInPlace(messages)) return raw
  return JSON.stringify(messages)
}

/** 收集数据库原值中的委托子过程：`groupKey|segmentId` → subSegments（并保留 segmentId 兜底索引） */
function collectSubSegments(messages: Message[]): { exact: Map<string, Segment[]>; bySegmentId: Map<string, Segment[]> } {
  const exact = new Map<string, Segment[]>()
  const bySegmentId = new Map<string, Segment[]>()
  for (const msg of messages) {
    forEachSegmentGroup(msg, (segments, groupKey) => {
      for (const seg of segments) {
        if (Array.isArray(seg.subSegments) && seg.subSegments.length > 0) {
          exact.set(`${groupKey}|${seg.id}`, seg.subSegments)
          bySegmentId.set(seg.id, seg.subSegments)
        }
      }
    })
  }
  return { exact, bySegmentId }
}

/**
 * 回写前还原被裁剪的子过程。
 * 仅当传入 JSON 含裁剪标记时才解析，普通会话的写入路径零额外开销。
 */
export function mergeOmittedSubSegments(incomingJson: string, previousJson: string): string {
  if (!incomingJson || !incomingJson.includes(SUB_SEGMENTS_OMITTED)) return incomingJson
  let incoming: Message[]
  let previous: Message[]
  try {
    incoming = JSON.parse(incomingJson)
    previous = JSON.parse(previousJson || '[]')
  } catch {
    return incomingJson
  }
  if (!Array.isArray(incoming) || !Array.isArray(previous)) return incomingJson

  const source = collectSubSegments(previous)
  let touched = false
  for (const msg of incoming) {
    forEachSegmentGroup(msg, (segments, groupKey) => {
      for (const seg of segments) {
        if (!seg[SUB_SEGMENTS_OMITTED]) continue
        touched = true
        // 分支复制会生成新的 groupKey：按段 id 兜底还原，避免复制出的分支丢失子过程
        const sub = source.exact.get(`${groupKey}|${seg.id}`) || source.bySegmentId.get(seg.id)
        if (sub) seg.subSegments = sub
        // 找不到原值（如消息被重写）时移除标记，避免把脏标记写回数据库
        delete seg[SUB_SEGMENTS_OMITTED]
        delete seg[SUB_SEGMENT_COUNT]
      }
    })
  }
  return touched ? JSON.stringify(incoming) : incomingJson
}

/** 裁剪视图缓存：同一会话反复切换时避免重复解析大 JSON（仅缓存命中阈值的会话） */
const VIEW_CACHE_LIMIT = 4
const viewCache = new Map<string, { raw: string; view: string }>()

export function getCompactMessagesJson(conversationId: string, raw: string): string {
  const cached = viewCache.get(conversationId)
  if (cached && cached.raw === raw) return cached.view
  const view = compactMessagesJson(raw)
  if (view === raw) {
    viewCache.delete(conversationId)
    return raw
  }
  viewCache.delete(conversationId)
  viewCache.set(conversationId, { raw, view })
  if (viewCache.size > VIEW_CACHE_LIMIT) {
    const oldest = viewCache.keys().next().value
    if (oldest !== undefined) viewCache.delete(oldest)
  }
  return view
}

export function invalidateCompactViewCache(conversationId: string): void {
  viewCache.delete(conversationId)
}

/** 就地裁剪已完成委托的子过程（无体积阈值，供分页视图使用），返回是否发生裁剪 */
export function compactMessagesForView(messages: Message[]): boolean {
  return compactMessagesInPlace(messages)
}

/**
 * 单条消息回写前还原被外置的子过程（行存储按消息更新时使用）。
 * 直接修改传入对象并返回，避免再走一次整段 JSON 序列化。
 */
export function restoreOmittedInMessage(incoming: Message, previous: Message | undefined): Message {
  if (!incoming || !previous) {
    if (incoming) {
      forEachSegmentGroup(incoming, (segments) => {
        for (const seg of segments) {
          delete seg[SUB_SEGMENTS_OMITTED]
          delete seg[SUB_SEGMENT_COUNT]
        }
      })
    }
    return incoming
  }
  const source = collectSubSegments([previous])
  forEachSegmentGroup(incoming, (segments, groupKey) => {
    for (const seg of segments) {
      if (!seg[SUB_SEGMENTS_OMITTED]) continue
      const sub = source.exact.get(`${groupKey}|${seg.id}`) || source.bySegmentId.get(seg.id)
      if (sub) seg.subSegments = sub
      delete seg[SUB_SEGMENTS_OMITTED]
      delete seg[SUB_SEGMENT_COUNT]
    }
  })
  return incoming
}

/** 从会话消息中找出指定段的完整内容（供委托卡片按需展开） */
export function findSegmentSubSegments(messages: Message[], messageId: string, segmentId: string): Segment[] | null {
  const message = messages.find((m) => m?.id === messageId)
  if (!message) return null
  let found: Segment[] | null = null
  forEachSegmentGroup(message, (segments) => {
    if (found) return
    const seg = segments.find((s) => s?.id === segmentId)
    if (seg && Array.isArray(seg.subSegments)) found = seg.subSegments
  })
  return found
}
