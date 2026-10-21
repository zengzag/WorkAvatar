import { create } from 'zustand'
import type { GeneratedFileInfo } from '../types'

export type TaskPanelTabKind = 'files' | 'terminal' | 'preview'

export interface TaskPanelTab {
  id: string
  kind: TaskPanelTabKind
  /** 预览标签的文件（kind==='preview' 时存在） */
  file?: GeneratedFileInfo
}

interface TaskPanelState {
  open: boolean
  /** 全屏模式：隐藏任务列表与对话栏，侧边栏占满任务页 */
  expanded: boolean
  tabs: TaskPanelTab[]
  /** 当前激活标签；null = 开始页 */
  activeTabId: string | null
  openPreview: (file: GeneratedFileInfo) => void
  openView: (kind: 'files' | 'terminal') => void
  /** 回到开始页（不关闭标签） */
  goStart: () => void
  setActiveTab: (id: string) => void
  closeTab: (id: string) => void
  toggleExpanded: () => void
  openPanel: () => void
  closePanel: () => void
  /** 切换任务时清空标签，避免跨任务展示旧文件/旧终端 */
  reset: () => void
  /** 已展开目录（按绝对路径记录，任务切换/面板开关/重启后仍保留） */
  expandedDirs: Record<string, true>
  toggleDirExpanded: (dirPath: string) => void
}

let tabSeq = 0
const nextTabId = () => `tab_${Date.now().toString(36)}_${(tabSeq++).toString(36)}`

const EXPANDED_DIRS_KEY = 'tasks:workspaceExpandedDirs'

function loadExpandedDirs(): Record<string, true> {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXPANDED_DIRS_KEY) || 'null')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export const useTaskPanelStore = create<TaskPanelState>((set, get) => ({
  open: false,
  expanded: false,
  tabs: [],
  activeTabId: null,
  openPreview: (file) => {
    const existing = get().tabs.find((tab) => tab.kind === 'preview' && tab.file?.path === file.path)
    if (existing) {
      set((s) => ({
        open: true,
        activeTabId: existing.id,
        tabs: s.tabs.map((tab) => (tab.id === existing.id ? { ...tab, file } : tab)),
      }))
      return
    }
    const tab: TaskPanelTab = { id: nextTabId(), kind: 'preview', file }
    set((s) => ({ open: true, tabs: [...s.tabs, tab], activeTabId: tab.id }))
  },
  openView: (kind) => {
    const existing = get().tabs.find((tab) => tab.kind === kind)
    if (existing) {
      set({ open: true, activeTabId: existing.id })
      return
    }
    const tab: TaskPanelTab = { id: nextTabId(), kind }
    set((s) => ({ open: true, tabs: [...s.tabs, tab], activeTabId: tab.id }))
  },
  goStart: () => set({ activeTabId: null }),
  setActiveTab: (id) => set({ activeTabId: id }),
  closeTab: (id) => {
    set((s) => {
      const index = s.tabs.findIndex((tab) => tab.id === id)
      const tabs = s.tabs.filter((tab) => tab.id !== id)
      let activeTabId = s.activeTabId
      if (s.activeTabId === id) {
        // 关闭激活标签后激活右侧，无右侧则最左侧；全部关闭回到开始页
        activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null
      }
      return { tabs, activeTabId }
    })
  },
  toggleExpanded: () => set((s) => ({ expanded: !s.expanded })),
  openPanel: () => set({ open: true, expanded: false }),
  closePanel: () => set({ open: false, expanded: false }),
  reset: () => set({ tabs: [], activeTabId: null }),
  expandedDirs: loadExpandedDirs(),
  toggleDirExpanded: (dirPath) => set((s) => {
    const next = { ...s.expandedDirs }
    if (next[dirPath]) delete next[dirPath]
    else next[dirPath] = true
    try { localStorage.setItem(EXPANDED_DIRS_KEY, JSON.stringify(next)) } catch {}
    return { expandedDirs: next }
  }),
}))
