import { IPC_CHANNELS } from '../../shared/ipc-channels'

/** 会话 → webContents 映射，供子会话事件转发到主管前端 */
const sessionWebContents: Map<string, Electron.WebContents> = new Map()

export interface AgentRunEventPayload {
  parentSessionId: string
  runId: string
  eventType: string
  data: any
  /** 所属主管会话（运行面板按任务分组用） */
  parentConversationId?: string
}

/** 注册会话对应的窗口（chatStream 启动时调用），并清理旧窗口资源 */
export function registerSessionWebContents(sessionId: string, wc: Electron.WebContents): void {
  const existing = sessionWebContents.get(sessionId)
  if (existing && existing !== wc && !existing.isDestroyed()) {
    // 同 sessionId 重复注册（如 renderer 重载后重建）：保留旧映射会导致事件丢失，仅记录日志
  }
  sessionWebContents.set(sessionId, wc)
}

export function unregisterSessionWebContents(sessionId: string): void {
  flushRunStream(sessionId)
  sessionWebContents.delete(sessionId)
}

/** 新通道：AGENT_RUN_EVENT（按 runId 路由的子会话事件） */
export function forwardAgentRunEvent(payload: AgentRunEventPayload): void {
  const wc = sessionWebContents.get(payload.parentSessionId)
  if (!wc || wc.isDestroyed()) return
  wc.send(IPC_CHANNELS.AGENT_RUN_EVENT, payload)
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
