import { create } from 'zustand'

/** 小秘书任务：面板自己发起的任务带未读状态；主窗口发起的任务只做只读镜像 */
export type SecretaryTaskStatus = 'running' | 'waiting' | 'done' | 'failed'

/** 任务来源：secretary=面板发起（可继续追问）；main=主窗口发起（只读镜像，不持久化） */
export type SecretaryTaskOrigin = 'secretary' | 'main'

export interface SecretaryEmployeeSnapshot {
  id: string
  name: string
  avatarIcon?: string | null
  avatarColor?: string | null
  avatarImage?: string | null
}

export interface SecretaryTask {
  id: string
  title: string
  /** 完整任务内容（含附件路径），用于把会话消息原样落库 */
  prompt?: string
  employee: SecretaryEmployeeSnapshot
  status: SecretaryTaskStatus
  /** 当前动作（工具名 / 等待确认等） */
  step: string
  startedAt: number
  endedAt?: number
  /** 结果是否已查看（角标只统计未查看的完成项） */
  viewed: boolean
  conversationId?: string
  error?: string
  /** 来源；缺省按 secretary（兼容旧数据） */
  origin?: SecretaryTaskOrigin
  /** 主窗口发起任务当前运行的会话，用于面板内停止 */
  sessionId?: string
}

/** 小秘书承接的宿主通知（日历提醒/自动化完成等），与任务列表并列展示 */
export interface SecretaryNotice {
  id: string
  title: string
  body: string
  source?: string
  clickTarget?: string
  clickId?: string
  createdAt: number
  viewed: boolean
}

const STORAGE_KEY = 'wa.secretary.tasks'
const NOTICES_KEY = 'wa.secretary.notices'
/** 已完成任务改为「点完成才移除」后的一次性迁移标记 */
const DISMISS_MIGRATION_KEY = 'wa.secretary.tasksDismissMigrated'

function load(): SecretaryTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 旧版点开已完成任务即视为已处理（只是隐藏）。升级后这些历史任务不应重新堆回面板；
    // 执行中/等待确认的任务不受影响（它们下面会被标记为中断）
    const migrating = !localStorage.getItem(DISMISS_MIGRATION_KEY)
    if (migrating) localStorage.setItem(DISMISS_MIGRATION_KEY, '1')
    return parsed
      .filter((t: any) => t?.origin !== 'main')
      .slice(0, 30)
      .filter((t: any) => !(migrating && (t?.status === 'done' || t?.status === 'failed') && t?.viewed))
      // 渲染进程重建后原流已断，执行中/等待确认的任务都标记为中断
      .map((t: any) => (
        t?.status === 'running' || t?.status === 'waiting'
          ? { ...t, status: 'failed', error: 'interrupted', endedAt: Date.now(), step: '' }
          : t
      ))
  } catch {
    return []
  }
}

function loadNotices(): SecretaryNotice[] {
  try {
    const raw = localStorage.getItem(NOTICES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.slice(0, 30) : []
  } catch {
    return []
  }
}

interface SecretaryStore {
  tasks: SecretaryTask[]
  /** 主窗口发起的任务镜像：只读展示，不持久化，每次从会话列表重建 */
  remoteTasks: SecretaryTask[]
  notices: SecretaryNotice[]
  addTask: (task: SecretaryTask) => void
  patchTask: (id: string, patch: Partial<SecretaryTask>) => void
  markViewed: (id: string) => void
  removeTask: (id: string) => void
  setRemoteTasks: (tasks: SecretaryTask[]) => void
  patchRemoteTask: (id: string, patch: Partial<SecretaryTask>) => void
  removeRemoteTask: (id: string) => void
  addNotice: (notice: SecretaryNotice) => void
  markNoticeViewed: (id: string) => void
  removeNotice: (id: string) => void
}

export const useSecretaryStore = create<SecretaryStore>((set) => ({
  tasks: load(),
  remoteTasks: [],
  notices: loadNotices(),
  addTask: (task) => set((s) => ({ tasks: [task, ...s.tasks].slice(0, 30) })),
  patchTask: (id, patch) => set((s) => ({
    tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  })),
  markViewed: (id) => set((s) => ({
    tasks: s.tasks.map((t) => (t.id === id ? { ...t, viewed: true } : t)),
  })),
  removeTask: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  setRemoteTasks: (tasks) => set({ remoteTasks: tasks }),
  patchRemoteTask: (id, patch) => set((s) => ({
    remoteTasks: s.remoteTasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  })),
  removeRemoteTask: (id) => set((s) => ({ remoteTasks: s.remoteTasks.filter((t) => t.id !== id) })),
  addNotice: (notice) => set((s) => ({ notices: [notice, ...s.notices].slice(0, 30) })),
  markNoticeViewed: (id) => set((s) => ({
    notices: s.notices.map((n) => (n.id === id ? { ...n, viewed: true } : n)),
  })),
  removeNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}))

useSecretaryStore.subscribe((state, prev) => {
  // 主窗口任务镜像每次轮询都会变，只有本地任务真正变化时才落盘
  if (state.tasks === prev.tasks) return
  try {
    // 头像图片是 data URL，30 条任务会把 localStorage 撑满；落盘只保留配色
    const persisted = state.tasks.map((t) => ({
      ...t,
      employee: { ...t.employee, avatarImage: undefined },
    }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
  } catch { /* ignore */ }
})

useSecretaryStore.subscribe((state) => {
  try {
    localStorage.setItem(NOTICES_KEY, JSON.stringify(state.notices))
  } catch { /* ignore */ }
})

export function selectRunningTasks(tasks: SecretaryTask[]): SecretaryTask[] {
  return tasks.filter((t) => t.status === 'running' || t.status === 'waiting')
}

export function selectUnreadTasks(tasks: SecretaryTask[]): SecretaryTask[] {
  return tasks.filter((t) => (t.status === 'done' || t.status === 'failed') && !t.viewed)
}

export function selectUnreadNotices(notices: SecretaryNotice[]): SecretaryNotice[] {
  return notices.filter((n) => !n.viewed)
}

/** 面板「已完成」区：已结束的任务要等用户点「完成」才从面板消失（与角标的未读数无关） */
export function selectFinishedTasks(tasks: SecretaryTask[]): SecretaryTask[] {
  return tasks.filter((t) => t.status === 'done' || t.status === 'failed')
}

export interface SecretaryBusSummary {
  status: SecretaryTaskStatus | 'idle'
  /** 最近一条执行中任务（气泡文案取自它的当前动作） */
  latest?: SecretaryTask
  /** 正在等待用户确认的任务（优先展示，任意一条都会让挂件进入等待态） */
  waiting?: SecretaryTask
  /** 未查看结果的第一条（空闲时用于展示结果身份与配色） */
  unreadFirst?: SecretaryTask
  runningCount: number
  unreadCount: number
}

/** 挂件状态汇总：等待确认 > 执行中 > 未查看结果 > 空闲；未读通知计入角标 */
export function selectBusSummary(tasks: SecretaryTask[], notices: SecretaryNotice[] = []): SecretaryBusSummary {
  const running = selectRunningTasks(tasks)
  const unread = selectUnreadTasks(tasks)
  const unreadNoticeCount = selectUnreadNotices(notices).length
  const waiting = running.find((t) => t.status === 'waiting')
  const latest = running[0]
  let status: SecretaryTaskStatus | 'idle' = 'idle'
  if (waiting) status = 'waiting'
  else if (latest) status = 'running'
  else if (unread.length > 0) status = unread[0].status === 'failed' ? 'failed' : 'done'
  return {
    status,
    latest,
    waiting,
    unreadFirst: unread[0],
    runningCount: running.length,
    unreadCount: unread.length + unreadNoticeCount,
  }
}
