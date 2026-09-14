import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export interface InteractionOption {
  label: string
  value: string
  description?: string
  danger?: boolean
}

/** 脚本触发确认时的原始脚本内容（主进程按上限截断后下发） */
export interface ScriptDisclosure {
  /** 脚本语言标识（powershell / bash / javascript），仅用于代码块标注 */
  language: string
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
  /** 目录级授权范围：存在时弹窗展示"始终允许此文件夹"按钮 */
  dirScope?: string
  /** 脚本执行确认：弹窗在正文下方以可滚动代码块展示原始脚本内容 */
  script?: ScriptDisclosure
  /** 发起请求的会话 id：弹窗据此把"本轮任务不再提醒"状态标记到对应会话 */
  conversationId?: string
}

interface InteractionState {
  queue: InteractionRequest[]
  currentRequest: InteractionRequest | null
}

interface InteractionActions {
  enqueue: (request: InteractionRequest) => void
  respond: (response: { confirmed?: boolean; selectedValue?: string; inputValue?: string; cancelled: boolean; allowAlways?: boolean; allowAlwaysDir?: boolean; taskHighPermission?: boolean }) => void
  cancelCurrent: () => void
}

export const useInteractionStore = create<InteractionState & InteractionActions>()(
  immer((set, get) => ({
    queue: [],
    currentRequest: null,

    enqueue: (request) => {
      set((state) => {
        if (!state.currentRequest) {
          state.currentRequest = request
        } else {
          state.queue.push(request)
        }
      })
    },

    respond: (response) => {
      const current = get().currentRequest
      if (!current) return

      window.electronAPI.interaction.respond({
        id: current.id,
        ...response,
      })

      set((state) => {
        state.currentRequest = state.queue.length > 0 ? state.queue.shift()! : null
      })
    },

    cancelCurrent: () => {
      const current = get().currentRequest
      if (!current) return

      window.electronAPI.interaction.respond({
        id: current.id,
        cancelled: true,
      })

      set((state) => {
        state.currentRequest = state.queue.length > 0 ? state.queue.shift()! : null
      })
    },
  }))
)
