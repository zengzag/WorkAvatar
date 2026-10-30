import { create } from 'zustand'

/** 小秘书任务：面板自己发起的任务，带未读状态；其他窗口发起的运行中任务只做只读展示 */
export type SecretaryTaskStatus = 'running' | 'waiting' | 'done' | 'failed'

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
}

const STORAGE_KEY = 'wa.secretary.tasks'

function load(): SecretaryTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 渲染进程重建后原流已断，运行中的任务标记为中断
    return parsed.slice(0, 30).map((t: any) => (
      t?.status === 'running'
        ? { ...t, status: 'failed', error: 'interrupted', endedAt: Date.now(), step: '' }
        : t
    ))
  } catch {
    return []
  }
}

interface SecretaryStore {
  tasks: SecretaryTask[]
  addTask: (task: SecretaryTask) => void
  patchTask: (id: string, patch: Partial<SecretaryTask>) => void
  markViewed: (id: string) => void
  removeTask: (id: string) => void
}

export const useSecretaryStore = create<SecretaryStore>((set) => ({
  tasks: load(),
  addTask: (task) => set((s) => ({ tasks: [task, ...s.tasks].slice(0, 30) })),
  patchTask: (id, patch) => set((s) => ({
    tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  })),
  markViewed: (id) => set((s) => ({
    tasks: s.tasks.map((t) => (t.id === id ? { ...t, viewed: true } : t)),
  })),
  removeTask: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
}))

useSecretaryStore.subscribe((state) => {
  try {
    // 头像图片是 data URL，30 条任务会把 localStorage 撑满；落盘只保留配色
    const persisted = state.tasks.map((t) => ({
      ...t,
      employee: { ...t.employee, avatarImage: undefined },
    }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
  } catch { /* ignore */ }
})

export function selectRunningTasks(tasks: SecretaryTask[]): SecretaryTask[] {
  return tasks.filter((t) => t.status === 'running' || t.status === 'waiting')
}

export function selectUnreadTasks(tasks: SecretaryTask[]): SecretaryTask[] {
  return tasks.filter((t) => (t.status === 'done' || t.status === 'failed') && !t.viewed)
}
