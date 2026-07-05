import { AsyncLocalStorage } from 'async_hooks'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { generateId } from './common-utils'

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
}

export interface InteractionResponse {
  id: string
  confirmed?: boolean
  selectedValue?: string
  inputValue?: string
  cancelled: boolean
  allowAlways?: boolean
}

interface PendingRequest {
  resolve: (response: InteractionResponse) => void
  timer?: NodeJS.Timeout
  source?: string
  /** allowAlways 授权的缓存 key，优先为 conversationId，降级为 sessionId */
  allowKey?: string
}

interface SessionInfo {
  webContents: Electron.WebContents
  pendingRequests: Map<string, PendingRequest>
}

export interface SessionContext {
  sessionId: string
  employeeId: string
  conversationId?: string
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

    const id = generateId()
    const fullRequest: InteractionRequest = { ...request, id }
    const timeout = request.timeout || 300000

    return new Promise<InteractionResponse>((resolve) => {
      const timer = setTimeout(() => {
        session.pendingRequests.delete(id)
        resolve({ id, cancelled: true })
      }, timeout)

      session.pendingRequests.set(id, { resolve, timer, source: request.source, allowKey })

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
   * 清理指定 conversation（或 sessionId）的 allowAlways 授权缓存。
   * 应在 conversation 删除时调用，避免内存泄漏与授权残留。
   */
  clearAllowedSources(allowKey: string): void {
    this.allowedSourcesByKey.delete(allowKey)
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
