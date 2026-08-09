import { AsyncLocalStorage } from 'async_hooks'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { generateId } from './common-utils'

/** 用户交互默认超时（5 分钟），工具层 timeoutMs 需大于此值以保证内层先触发 */
export const INTERACTION_TIMEOUT_MS = 300000

export interface InteractionOption {
  label: string
  value: string
  description?: string
  danger?: boolean
}

export interface InteractionRequest {
  id: string
  type: 'confirm' | 'select' | 'input'
  title: string
  message: string
  options?: InteractionOption[]
  defaultValue?: string
  placeholder?: string
  required?: boolean
  danger?: boolean
  timeout?: number
  source?: string
  /** 路径级去重：同一会话内该路径被确认后，后续相同路径自动通过 */
  pathScope?: string
}

export interface InteractionResponse {
  id: string
  confirmed?: boolean
  selectedValue?: string
  inputValue?: string
  cancelled: boolean
  allowAlways?: boolean
  /** 超时触发（非用户主动取消） */
  timedOut?: boolean
}

interface PendingRequest {
  resolve: (response: InteractionResponse) => void
  timer?: NodeJS.Timeout
  source?: string
  /** allowAlways 授权的缓存 key，优先为 conversationId，降级为 sessionId */
  allowKey?: string
  /** 路径级去重缓存 key */
  pathScope?: string
}

interface SessionInfo {
  webContents: Electron.WebContents
  pendingRequests: Map<string, PendingRequest>
}

export interface SessionContext {
  sessionId: string
  employeeId: string
  conversationId?: string
  highPermission?: boolean
  /** 委托链深度（0=顶层会话），上限 3 */
  delegationDepth?: number
  /** 委托链已参与的员工 id 列表，防环 */
  delegationChain?: string[]
  /** 主管会话 id，用于子员工事件回传前端 */
  parentSessionId?: string
  /** 本次委托 id，前端按此路由子员工事件到对应 delegation segment */
  delegationId?: string
  /** 主管会话的 AbortSignal，delegate 工具读取后传给子员工 chatStream 实现 abort 传播 */
  abortSignal?: AbortSignal
  /** 主管会话的思考模式设置，委托时传给子员工保持一致 */
  enableThinking?: boolean
  /** 子员工 token 用量累计（主管会话级），onDone 时合并到 metadata.tokenUsage */
  childTokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number }
}

export const interactionContext = new AsyncLocalStorage<SessionContext>()

class UnifiedInteractionService {
  private static instance: UnifiedInteractionService
  private sessions: Map<string, SessionInfo> = new Map()
  /**
   * allowAlways 授权缓存，key 为 conversationId（优先）或 sessionId（降级）。
   * 生命周期：与 conversation 一致，conversation 删除时需调用 clearAllowedSources 清理。
   * 作用：使"本次任务始终允许"覆盖整个会话的后续消息，而非仅当前一条消息。
   */
  private allowedSourcesByKey: Map<string, Set<string>> = new Map()
  /** 路径级去重缓存，key 为 conversationId（优先）或 sessionId（降级）。用户确认某路径后，同会话内该路径自动通过 */
  private allowedPathsByKey: Map<string, Set<string>> = new Map()
  private ipcRegistered = false

  private constructor() {}

  static getInstance(): UnifiedInteractionService {
    if (!UnifiedInteractionService.instance) {
      UnifiedInteractionService.instance = new UnifiedInteractionService()
    }
    return UnifiedInteractionService.instance
  }

  registerSession(sessionId: string, webContents: Electron.WebContents): void {
    this.sessions.set(sessionId, { webContents, pendingRequests: new Map() })
    this.ensureIpcRegistered()
  }

  unregisterSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      for (const [requestId, pending] of session.pendingRequests) {
        if (pending.timer) clearTimeout(pending.timer)
        pending.resolve({ id: requestId, cancelled: true })
      }
      this.sessions.delete(sessionId)
    }
  }

  async request(request: Omit<InteractionRequest, 'id'>): Promise<InteractionResponse> {
    const ctx = interactionContext.getStore()
    if (!ctx) {
      return this.createDeniedResponse(request, 'No active session context')
    }

    const session = this.sessions.get(ctx.sessionId)
    if (!session || session.webContents.isDestroyed()) {
      return this.createDeniedResponse(request, 'Session not found or window closed')
    }

    // allowAlways 授权缓存 key：优先 conversationId（覆盖整个会话），降级 sessionId（仅当前消息流）
    const allowKey = ctx.conversationId || ctx.sessionId

    if (request.source && this.isSourceAllowed(allowKey, request.source)) {
      return {
        id: '',
        confirmed: true,
        cancelled: false,
        allowAlways: true,
      }
    }

    // 路径级去重：同会话内已确认的路径自动通过
    if (request.pathScope && this.isPathAllowed(allowKey, request.pathScope)) {
      return {
        id: '',
        confirmed: true,
        cancelled: false,
      }
    }

    const id = generateId()
    const fullRequest: InteractionRequest = { ...request, id }
    const timeout = request.timeout || INTERACTION_TIMEOUT_MS

    // 主窗口未激活时，通过系统通知告知用户有数字员工询问
    // 避免用户错过权限请求；点击通知会聚焦主窗口显示交互弹窗
    this.maybeNotifyInactiveWindow(request)

    return new Promise<InteractionResponse>((resolve) => {
      const timer = setTimeout(() => {
        session.pendingRequests.delete(id)
        resolve({ id, cancelled: true, timedOut: true })
      }, timeout)

      session.pendingRequests.set(id, { resolve, timer, source: request.source, allowKey, pathScope: request.pathScope })

      try {
        session.webContents.send(IPC_CHANNELS.INTERACTION_REQUEST, fullRequest)
      } catch {
        clearTimeout(timer)
        session.pendingRequests.delete(id)
        resolve({ id, cancelled: true })
      }
    })
  }

  /**
   * 主窗口未激活时，发送系统通知告知用户有数字员工询问。
   * 复用 NotificationService 的主窗口失焦检测与通知点击聚焦逻辑。
   * 通知 body 截断到 200 字符，避免过长。
   */
  private maybeNotifyInactiveWindow(request: Omit<InteractionRequest, 'id'>): void {
    try {
      const notificationService = require('./notification.service').default.getInstance()
      if (!notificationService.isMainWindowInactive()) return
      const title = request.title || '数字员工需要您的确认'
      const body = (request.message || '').slice(0, 200)
      notificationService.notify({
        title,
        body,
        clickTarget: 'ask_user',
        source: 'ask_user',
      })
    } catch { /* 通知失败不影响主流程 */ }
  }

  /**
   * 清理指定 conversation（或 sessionId）的 allowAlways 授权缓存和路径去重缓存。
   * 应在 conversation 删除时调用，避免内存泄漏与授权残留。
   */
  clearAllowedSources(allowKey: string): void {
    this.allowedSourcesByKey.delete(allowKey)
    this.allowedPathsByKey.delete(allowKey)
  }

  private isSourceAllowed(allowKey: string, source: string): boolean {
    return this.allowedSourcesByKey.get(allowKey)?.has(source) || false
  }

  private allowSource(allowKey: string, source: string): void {
    let set = this.allowedSourcesByKey.get(allowKey)
    if (!set) {
      set = new Set()
      this.allowedSourcesByKey.set(allowKey, set)
    }
    set.add(source)
  }

  private isPathAllowed(allowKey: string, pathScope: string): boolean {
    return this.allowedPathsByKey.get(allowKey)?.has(pathScope) || false
  }

  private allowPath(allowKey: string, pathScope: string): void {
    let set = this.allowedPathsByKey.get(allowKey)
    if (!set) {
      set = new Set()
      this.allowedPathsByKey.set(allowKey, set)
    }
    set.add(pathScope)
  }

  private createDeniedResponse(request: Omit<InteractionRequest, 'id'>, _reason: string): InteractionResponse {
    if (request.type === 'confirm') {
      return { id: '', confirmed: false, cancelled: false }
    }
    return { id: '', cancelled: true }
  }

  private ensureIpcRegistered(): void {
    if (this.ipcRegistered) return
    this.ipcRegistered = true

    ipcMain.handle(IPC_CHANNELS.INTERACTION_RESPONSE, (event, response: InteractionResponse) => {
      for (const [, session] of this.sessions) {
        if (session.webContents !== event.sender) continue
        const pending = session.pendingRequests.get(response.id)
        if (pending) {
          if (pending.timer) clearTimeout(pending.timer)
          session.pendingRequests.delete(response.id)
          // 用户点击"本次任务始终允许"时，缓存授权到 conversation 级别
          if (response.allowAlways && pending.source && pending.allowKey) {
            this.allowSource(pending.allowKey, pending.source)
          }
          // 用户确认后，缓存路径级去重（同会话内该路径后续操作自动通过）
          if (response.confirmed && pending.pathScope && pending.allowKey) {
            this.allowPath(pending.allowKey, pending.pathScope)
          }
          pending.resolve(response)
          return { success: true }
        }
      }
      return { success: false, error: 'Request not found' }
    })
  }

  static getContext(): SessionContext | undefined {
    return interactionContext.getStore()
  }
}

export default UnifiedInteractionService
