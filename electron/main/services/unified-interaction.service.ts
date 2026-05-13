import { AsyncLocalStorage } from 'async_hooks'
import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'

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
}

interface PendingRequest {
  resolve: (response: InteractionResponse) => void
  timer?: NodeJS.Timeout
}

interface SessionInfo {
  webContents: Electron.WebContents
  pendingRequests: Map<string, PendingRequest>
}

export interface SessionContext {
  sessionId: string
  employeeId: string
  projectId: string
}

export const interactionContext = new AsyncLocalStorage<SessionContext>()

class UnifiedInteractionService {
  private static instance: UnifiedInteractionService
  private sessions: Map<string, SessionInfo> = new Map()
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

    const id = randomUUID()
    const fullRequest: InteractionRequest = { ...request, id }
    const timeout = request.timeout || 300000

    return new Promise<InteractionResponse>((resolve) => {
      const timer = setTimeout(() => {
        session.pendingRequests.delete(id)
        resolve({ id, cancelled: true })
      }, timeout)

      session.pendingRequests.set(id, { resolve, timer })

      try {
        session.webContents.send('interaction:request', fullRequest)
      } catch {
        clearTimeout(timer)
        session.pendingRequests.delete(id)
        resolve({ id, cancelled: true })
      }
    })
  }

  handleResponse(response: InteractionResponse): void {
    const ctx = interactionContext.getStore()
    const sessionId = ctx?.sessionId

    if (!sessionId) return

    const session = this.sessions.get(sessionId)
    if (!session) return

    const pending = session.pendingRequests.get(response.id)
    if (!pending) return

    if (pending.timer) clearTimeout(pending.timer)
    session.pendingRequests.delete(response.id)
    pending.resolve(response)
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

    ipcMain.handle('interaction:response', (_event, response: InteractionResponse) => {
      for (const [, session] of this.sessions) {
        const pending = session.pendingRequests.get(response.id)
        if (pending) {
          if (pending.timer) clearTimeout(pending.timer)
          session.pendingRequests.delete(response.id)
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
