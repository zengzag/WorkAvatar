import { AsyncLocalStorage } from 'async_hooks'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { generateId } from './common-utils'
import type { ThinkingLevel } from '../../shared/types'

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
  /** 目录级授权范围：前端据此展示"始终允许此文件夹"按钮，授权结果由 FilePermissionService 缓存 */
  dirScope?: string
  /** 发起请求的会话 id：前端据此把"本轮任务不再提醒"的高权限状态标记到对应会话 */
  conversationId?: string
}

export interface InteractionResponse {
  id: string
  confirmed?: boolean
  selectedValue?: string
  inputValue?: string
  cancelled: boolean
  allowAlways?: boolean
  /** 用户选择"始终允许此文件夹"：授权 dirScope 目录子树，缓存由 FilePermissionService 管理 */
  allowAlwaysDir?: boolean
  /**
   * 用户选择"本轮任务不再提醒"：为当前会话开启高权限模式（等同 high_permission，但按会话持久），
   * 本轮任务后续所有文件读写/删除（含 shell、javascript 沙箱）不再弹窗确认。
   */
  taskHighPermission?: boolean
  /** 超时触发（非用户主动取消） */
  timedOut?: boolean
}

/** 渲染端开关本轮任务高权限模式的入参（conversationId 优先，无 DB 会话时降级 sessionId） */
export interface SetTaskHighPermissionParams {
  conversationId?: string
  sessionId?: string
  enabled: boolean
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
  highPermission?: boolean
  /** 任务工作区目录（通用对话等无 DB 会话记录时直接注入，供文件/shell 工具作为沙箱边界） */
  workspacePath?: string
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
  enableThinking?: ThinkingLevel
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
  /**
   * "本轮任务不再提醒"高权限模式登记，key 与 allowedSourcesByKey 一致（conversationId 优先，降级 sessionId）。
   * 生命周期同样与 conversation 一致，clearAllowedSources 时一并清理。
   * 作用：用户在区外文件确认弹窗中选择该选项后，本轮任务后续文件操作（含 shell 删除/写入、
   * javascript 沙箱）不再弹窗，等价于把 high_permission 从"单条消息"提升为"整个任务"。
   */
  private taskHighPermissionKeys: Set<string> = new Set()
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
    // conversationId 随请求下发渲染端：用于把"本轮任务不再提醒"状态标记到对应会话（高权限开关同步显示）
    const fullRequest: InteractionRequest = { ...request, id, conversationId: ctx.conversationId || request.conversationId }
    const timeout = request.timeout || INTERACTION_TIMEOUT_MS

    // 主窗口未激活时，通过系统通知告知用户有数字员工询问
    // 避免用户错过权限请求；点击通知会聚焦主窗口显示交互弹窗
    this.maybeNotifyInactiveWindow(request)

    return new Promise<InteractionResponse>((resolve) => {
      const timer = setTimeout(() => {
        session.pendingRequests.delete(id)
        resolve({ id, cancelled: true, timedOut: true })
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
   * 清理指定 conversation（或 sessionId）的 allowAlways 授权缓存与"本轮任务不再提醒"高权限登记。
   * 应在 conversation 删除时调用；文件授权缓存由 FilePermissionService.clearAuthorizations 同步清理。
   */
  clearAllowedSources(allowKey: string): void {
    this.allowedSourcesByKey.delete(allowKey)
    this.taskHighPermissionKeys.delete(allowKey)
  }

  /** 当前会话是否已开启"本轮任务不再提醒"高权限模式（不传 allowKey 时取当前交互上下文） */
  isTaskHighPermission(allowKey?: string): boolean {
    const key = allowKey || this.currentAllowKey()
    if (!key) return false
    return this.taskHighPermissionKeys.has(key)
  }

  /**
   * 开启/关闭指定会话的任务级高权限模式。
   * 开启来源：用户在安全确认弹窗选择"本轮任务不再提醒"（IPC 响应携带 taskHighPermission）；
   * 关闭来源：渲染端高权限开关（ChatInput）点击关闭。
   */
  setTaskHighPermission(allowKey: string, enabled: boolean): void {
    if (!allowKey) return
    if (enabled) {
      this.taskHighPermissionKeys.add(allowKey)
    } else {
      this.taskHighPermissionKeys.delete(allowKey)
    }
  }

  private currentAllowKey(): string | null {
    const ctx = interactionContext.getStore()
    if (!ctx) return null
    return ctx.conversationId || ctx.sessionId || null
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
          // 用户点击"本轮任务不再提醒"：开启任务级高权限模式，本轮任务后续文件操作不再弹窗
          if (response.taskHighPermission && pending.allowKey) {
            this.setTaskHighPermission(pending.allowKey, true)
          }
          pending.resolve(response)
          return { success: true }
        }
      }
      return { success: false, error: 'Request not found' }
    })

    // 渲染端开关任务级高权限模式：ChatInput 高权限按钮关闭该模式时调用（开启走确认弹窗响应）
    ipcMain.handle(IPC_CHANNELS.INTERACTION_SET_TASK_PERMISSION, (_event, params: SetTaskHighPermissionParams) => {
      const key = params?.conversationId || params?.sessionId
      if (!key) return { success: false, error: '缺少会话标识' }
      this.setTaskHighPermission(key, params.enabled === true)
      return { success: true }
    })
  }

  static getContext(): SessionContext | undefined {
    return interactionContext.getStore()
  }
}

export default UnifiedInteractionService
