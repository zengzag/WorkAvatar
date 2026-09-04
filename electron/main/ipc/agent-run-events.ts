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
  sessionWebContents.delete(sessionId)
}

/** 新通道：AGENT_RUN_EVENT（按 runId 路由的子会话事件） */
export function forwardAgentRunEvent(payload: AgentRunEventPayload): void {
  const wc = sessionWebContents.get(payload.parentSessionId)
  if (!wc || wc.isDestroyed()) return
  wc.send(IPC_CHANNELS.AGENT_RUN_EVENT, payload)
}

/** 统一广播子会话事件（P3 已收敛，仅保留 AGENT_RUN_EVENT 单通道） */
export function broadcastRunEvent(parentSessionId: string, runId: string, eventType: string, data: any, parentConversationId?: string): void {
  forwardAgentRunEvent({ parentSessionId, runId, eventType, data, parentConversationId })
}