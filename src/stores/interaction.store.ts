import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export interface InteractionOption {
  label: string
  value: string
  description?: string
  danger?: boolean
}

/** 文件改动预览（unified diff），按行首 +/-/@@ 前缀着色展示 */
export interface DiffDisclosure {
  content: string
  /** 内容是否已截断 */
  truncated: boolean
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
  /** 目录级授权范围：存在时展示"始终允许此目录"选项 */
  dirScope?: string
  /** 文件改动预览：确认卡正文下方展示 unified diff */
  diff?: DiffDisclosure
  /** 强制确认（不可逆/敏感文件）：隐藏"始终允许"类选项，仅允许一次性确认或拒绝 */
  forced?: boolean
  /** 模型申请本轮任务完整访问：确认后开启任务级高权限并回传 taskHighPermission */
  taskFullAccess?: boolean
  /** 发起请求的会话 id：任务对话据此内联展示确认卡 */
  conversationId?: string
}

export interface InteractionResponse {
  confirmed?: boolean
  selectedValue?: string
  inputValue?: string
  cancelled: boolean
  allowAlways?: boolean
  allowAlwaysDir?: boolean
  taskHighPermission?: boolean
}

interface InteractionState {
  /** 全部待处理请求（按到达顺序），由任务对话内联卡或全局弹窗按需消费 */
  requests: InteractionRequest[]
  /**
   * 已被用户收起（自动隐藏）的请求：仍保留在 requests 里等待响应，
   * 但不再自动弹出，需从通知列表点击后显式恢复。
   */
  suppressedIds: string[]
  /**
   * 任务页当前作为内联宿主：带 conversationId 的请求由任务对话内的确认卡承接，
   * 全局弹窗跳过；无会话归属的请求（通用对话等）仍走弹窗。
   */
  taskInlineHost: boolean
}

interface InteractionActions {
  enqueue: (request: InteractionRequest) => void
  respondById: (id: string, response: InteractionResponse) => void
  /** 主进程侧请求已失效（超时/会话结束）：按 id 移除，不上报响应 */
  dismiss: (id: string) => void
  /** 收起指定请求的弹窗（自动隐藏），请求保留可稍后从通知恢复 */
  suppress: (id: string) => void
  /** 取消收起：点击通知后重新展示确认框 */
  unsuppress: (id: string) => void
  setTaskInlineHost: (active: boolean) => void
}

/** 响应上报主进程，失败仅告警不阻塞确认流程 */
function reportResponse(payload: { id: string; cancelled: boolean } & Record<string, unknown>) {
  Promise.resolve(window.electronAPI.interaction.respond(payload)).catch((err) => {
    console.warn('[interaction] respond IPC failed:', payload.id, err)
  })
}

export const useInteractionStore = create<InteractionState & InteractionActions>()(
  immer((set, get) => ({
    requests: [],
    suppressedIds: [],
    taskInlineHost: false,

    enqueue: (request) => {
      set((state) => {
        // 按 request.id 去重：重复入队会形成幽灵确认卡
        if (state.requests.some((r) => r.id === request.id)) return
        state.requests.push(request)
      })
    },

    respondById: (id, response) => {
      const exists = get().requests.some((r) => r.id === id)
      if (!exists) return

      reportResponse({ id, ...response })

      set((state) => {
        const index = state.requests.findIndex((r) => r.id === id)
        if (index >= 0) state.requests.splice(index, 1)
        state.suppressedIds = state.suppressedIds.filter((item) => item !== id)
      })
    },

    dismiss: (id) => {
      set((state) => {
        const index = state.requests.findIndex((r) => r.id === id)
        if (index >= 0) state.requests.splice(index, 1)
        state.suppressedIds = state.suppressedIds.filter((item) => item !== id)
      })
    },

    suppress: (id) => {
      set((state) => {
        if (!state.suppressedIds.includes(id)) state.suppressedIds.push(id)
      })
    },

    unsuppress: (id) => {
      set((state) => {
        state.suppressedIds = state.suppressedIds.filter((item) => item !== id)
      })
    },

    setTaskInlineHost: (active) => {
      set((state) => {
        state.taskInlineHost = active
      })
    },
  }))
)

/** 全局弹窗应展示的请求：跳过已收起与任务页内联承接的请求 */
export function selectModalRequest(state: InteractionState): InteractionRequest | null {
  return state.requests.find((r) => (
    !state.suppressedIds.includes(r.id)
    && !(state.taskInlineHost && r.conversationId)
  )) ?? null
}
