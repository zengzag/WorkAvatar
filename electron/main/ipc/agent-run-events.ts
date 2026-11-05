import { IPC_CHANNELS } from '../../shared/ipc-channels'

/** 会话 → webContents 集合：发起窗口 + 后续接入窗口（如在任务页打开小秘书发起的运行中任务） */
const sessionWebContents: Map<string, Set<Electron.WebContents>> = new Map()

/**
 * 会话事件观察者（小秘书面板）：只接收事件用于展示执行进度，
 * 不计入「已有其他窗口接入」判定，因此不会让发起窗口让出收尾落库。
 */
const sessionObservers: Set<Electron.WebContents> = new Set()

export function registerSessionObserver(wc: Electron.WebContents): void {
  if (sessionObservers.has(wc)) return
  sessionObservers.add(wc)
  wc.once('destroyed', () => { sessionObservers.delete(wc) })
}

export function unregisterSessionObserver(wc: Electron.WebContents): void {
  sessionObservers.delete(wc)
}

export interface AgentRunEventPayload {
  parentSessionId: string
  runId: string
  eventType: string
  data: any
  /** 所属主管会话（运行面板按任务分组用） */
  parentConversationId?: string
}

/** 注册会话对应的窗口（chatStream 启动 / 其他窗口接入时调用） */
export function registerSessionWebContents(sessionId: string, wc: Electron.WebContents): void {
  let targets = sessionWebContents.get(sessionId)
  if (!targets) {
    targets = new Set()
    sessionWebContents.set(sessionId, targets)
  }
  targets.add(wc)
}

export function unregisterSessionWebContents(sessionId: string): void {
  flushRunStream(sessionId)
  sessionWebContents.delete(sessionId)
}

/** 向会话所有接入窗口推送事件 */
export function sendToSessionWebContents(sessionId: string, channel: string, payload: unknown): void {
  const targets = sessionWebContents.get(sessionId)
  if (!targets) {
    // 没有接入窗口时观察者仍需要事件（主窗口任务也要在小秘书上显示执行进度）
    sendToObservers(channel, payload, undefined)
    return
  }
  for (const wc of targets) {
    if (wc.isDestroyed()) {
      targets.delete(wc)
      continue
    }
    wc.send(channel, payload)
  }
  sendToObservers(channel, payload, targets)
}

/** 只读观察者：跳过已收到该事件的接入窗口，避免同一窗口重复处理 */
function sendToObservers(channel: string, payload: unknown, sent: Set<Electron.WebContents> | undefined): void {
  for (const wc of sessionObservers) {
    if (wc.isDestroyed()) {
      sessionObservers.delete(wc)
      continue
    }
    if (sent?.has(wc)) continue
    wc.send(channel, payload)
  }
}

/** 会话是否有「除发起窗口之外」的存活接入方（任务页打开运行中任务时将有窗口自行落库） */
export function hasOtherSessionViewer(sessionId: string, owner?: Electron.WebContents): boolean {
  const targets = sessionWebContents.get(sessionId)
  if (!targets) return false
  for (const wc of targets) {
    if (!wc.isDestroyed() && wc !== owner) return true
  }
  return false
}

/** 新通道：AGENT_RUN_EVENT（按 runId 路由的子会话事件） */
export function forwardAgentRunEvent(payload: AgentRunEventPayload): void {
  sendToSessionWebContents(payload.parentSessionId, IPC_CHANNELS.AGENT_RUN_EVENT, payload)
}

// ---- 子会话流式增量合并 ----
// 子员工输出的每个 token 都单发一次 IPC，会让前端对整棵消息树逐 token 重渲染
// （含 markdown 全量解析）。与主管会话保持一致，按时间窗口合并到 ≈16fps。
const STREAM_FLUSH_INTERVAL_MS = 60

interface PendingRunStream {
  parentSessionId: string
  runId: string
  parentConversationId?: string
  thought: string
  chunk: string
  deltas: Map<number, { index: number; id?: string; name?: string; arguments: string }>
  timer: NodeJS.Timeout | null
}

const pendingStreams: Map<string, PendingRunStream> = new Map()

const streamKey = (parentSessionId: string, runId: string) => `${parentSessionId}\u0000${runId}`

function deliver(parentSessionId: string, runId: string, eventType: string, data: any, parentConversationId?: string): void {
  forwardAgentRunEvent({ parentSessionId, runId, eventType, data, parentConversationId })
}

/** 按「思考 → 正文 → 工具参数」顺序回放，保证窗口内跨类型事件的先后语义（思考结束才出正文、正文结束才出工具参数） */
function flushOne(entry: PendingRunStream): void {
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  if (entry.thought) {
    deliver(entry.parentSessionId, entry.runId, 'thought', entry.thought, entry.parentConversationId)
    entry.thought = ''
  }
  if (entry.chunk) {
    deliver(entry.parentSessionId, entry.runId, 'chunk', entry.chunk, entry.parentConversationId)
    entry.chunk = ''
  }
  if (entry.deltas.size > 0) {
    const deltas = Array.from(entry.deltas.values())
    entry.deltas.clear()
    deliver(entry.parentSessionId, entry.runId, 'tool_call_delta', { deltas }, entry.parentConversationId)
  }
}

/**
 * 立即回放缓冲区。传 parentSessionId 时回放该会话下所有子任务，
 * 用于控制类事件（start/status/tool_call/result…）前保证先后顺序。
 */
export function flushRunStream(parentSessionId?: string): void {
  for (const [key, entry] of pendingStreams) {
    if (parentSessionId !== undefined && entry.parentSessionId !== parentSessionId) continue
    flushOne(entry)
    if (!entry.timer && !entry.thought && !entry.chunk && entry.deltas.size === 0) {
      pendingStreams.delete(key)
    }
  }
}

function enqueueStream(payload: AgentRunEventPayload, apply: (entry: PendingRunStream) => void): void {
  const key = streamKey(payload.parentSessionId, payload.runId)
  let entry = pendingStreams.get(key)
  if (!entry) {
    entry = {
      parentSessionId: payload.parentSessionId,
      runId: payload.runId,
      parentConversationId: payload.parentConversationId,
      thought: '',
      chunk: '',
      deltas: new Map(),
      timer: null,
    }
    pendingStreams.set(key, entry)
  }
  apply(entry)
  if (!entry.timer) {
    const target = entry
    entry.timer = setTimeout(() => {
      target.timer = null
      flushOne(target)
      const k = streamKey(target.parentSessionId, target.runId)
      if (pendingStreams.get(k) === target && !target.thought && !target.chunk && target.deltas.size === 0) {
        pendingStreams.delete(k)
      }
    }, STREAM_FLUSH_INTERVAL_MS)
  }
}

/** 统一广播子会话事件：流式增量合并推送，其余事件先回放缓冲再即时下发 */
export function broadcastRunEvent(parentSessionId: string, runId: string, eventType: string, data: any, parentConversationId?: string): void {
  if (eventType === 'chunk' || eventType === 'thought') {
    const text = typeof data === 'string' ? data : ''
    if (!text) return
    enqueueStream({ parentSessionId, runId, eventType, data, parentConversationId }, (entry) => {
      if (eventType === 'chunk') entry.chunk += text
      else entry.thought += text
    })
    return
  }

  if (eventType === 'tool_call_delta') {
    enqueueStream({ parentSessionId, runId, eventType, data, parentConversationId }, (entry) => {
      const delta = data as { index?: number; id?: string; name?: string; arguments?: string }
      const index = typeof delta?.index === 'number' ? delta.index : 0
      const fragment = delta?.arguments || ''
      const prev = entry.deltas.get(index)
      entry.deltas.set(index, {
        index,
        id: delta?.id || prev?.id,
        name: delta?.name || prev?.name,
        // 增量片段直接拼接；整段快照以新值为准
        arguments: prev && !fragment.startsWith(prev.arguments) ? prev.arguments + fragment : fragment,
      })
    })
    return
  }

  // 其余事件必须看到完整的前序增量，避免"工具调用卡先于正文出现"
  flushRunStream(parentSessionId)
  forwardAgentRunEvent({ parentSessionId, runId, eventType, data, parentConversationId })
}
