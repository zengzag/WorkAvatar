import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

/**
 * 任务级高权限模式（确认弹窗中"本轮任务不再提醒"）的渲染端状态：
 * - 开启：用户在区外文件确认弹窗中选择该选项，主进程登记由响应中的 taskHighPermission 完成，此处仅同步界面状态
 * - 关闭：ChatInput 高权限按钮点击关闭，同时通知主进程撤销登记
 * - key 为 conversationId（主进程侧 conversationId 优先、sessionId 降级）；仅内存，删除会话即失效
 */

/** 同步主进程登记，失败/无该 API（测试、旧版 preload）时忽略，不影响界面状态 */
function syncTaskHighPermission(conversationId: string, enabled: boolean): void {
  try {
    void window.electronAPI.interaction
      .setTaskHighPermission({ conversationId, enabled })
      .catch(() => {})
  } catch { /* ignore */ }
}

interface TaskPermissionState {
  /** 已开启任务级高权限的会话 id 集合 */
  enabledKeys: Record<string, boolean>
  /** 标记会话已开启（弹窗确认后调用，主进程登记随确认响应完成） */
  enable: (conversationId?: string | null) => void
  /** 关闭会话的任务级高权限：本地状态 + 主进程登记同时撤销 */
  disable: (conversationId?: string | null) => void
}

export const useTaskPermissionStore = create<TaskPermissionState>()(
  immer((set) => ({
    enabledKeys: {},

    enable: (conversationId) => {
      if (!conversationId) return
      set((state) => {
        state.enabledKeys[conversationId] = true
      })
      // 兜底同步：正常情况下主进程在确认响应处理中已登记，此处保证两侧一致
      syncTaskHighPermission(conversationId, true)
    },

    disable: (conversationId) => {
      if (!conversationId) return
      set((state) => {
        delete state.enabledKeys[conversationId]
      })
      syncTaskHighPermission(conversationId, false)
    },
  }))
)
