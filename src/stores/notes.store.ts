import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  NoteNode,
  NotesSettings,
  NoteEditorMode,
} from '../types/notes'
import { DEFAULT_NOTES_SETTINGS } from '../../electron/shared/channels/notes'

let tabIdCounter = 0
const generateTabId = () => `tab_${Date.now()}_${++tabIdCounter}`

export interface NoteTab {
  id: string
  relPath: string | null
  content: string
  savedContent: string
  mtime: number
  saveStatus: 'saved' | 'saving' | 'dirty'
  locateText: string | null
  title?: string
}

interface NotesState {
  tree: NoteNode[]
  treeLoading: boolean
  tabs: NoteTab[]
  activeTabId: string | null
  settings: NotesSettings
  settingsLoading: boolean

  setTree: (tree: NoteNode[]) => void
  setTreeLoading: (loading: boolean) => void
  setSettings: (settings: NotesSettings) => void
  setSettingsLoading: (loading: boolean) => void
  reset: () => void

  createEmptyTab: () => string
  openNoteInTab: (tabId: string, relPath: string, content: string, mtime: number) => void
  switchTab: (tabId: string) => void
  closeTab: (tabId: string) => { hasDirty: boolean; nextActiveId: string | null }
  renameTabPath: (oldRelPath: string, newRelPath: string) => void
  getTab: (tabId: string) => NoteTab | undefined
  getActiveTab: () => NoteTab | undefined
  setTabContent: (tabId: string, content: string) => void
  setTabSaved: (tabId: string, content: string, mtime: number) => void
  setTabSaving: (tabId: string) => void
  setTabDirty: (tabId: string) => void
  setTabLocateText: (tabId: string, text: string | null) => void
  clearTabLocateText: (tabId: string) => void
  setActiveTabLocateText: (text: string | null) => void
}

export const useNotesStore = create<NotesState>()(
  immer((set, get) => ({
    tree: [],
    treeLoading: false,
    tabs: [],
    activeTabId: null,
    settings: DEFAULT_NOTES_SETTINGS,
    settingsLoading: false,

    setTree: (tree) => set((s) => { s.tree = tree }),
    setTreeLoading: (loading) => set((s) => { s.treeLoading = loading }),
    setSettings: (settings) => set((s) => { s.settings = settings }),
    setSettingsLoading: (loading) => set((s) => { s.settingsLoading = loading }),
    reset: () =>
      set((s) => {
        s.tabs = []
        s.activeTabId = null
      }),

    createEmptyTab: () => {
      const id = generateTabId()
      set((s) => {
        s.tabs.push({
          id,
          relPath: null,
          content: '',
          savedContent: '',
          mtime: 0,
          saveStatus: 'saved',
          locateText: null,
        })
        s.activeTabId = id
      })
      return id
    },

    openNoteInTab: (tabId, relPath, content, mtime) =>
      set((s) => {
        const existingIdx = s.tabs.findIndex((t) => t.relPath === relPath)
        if (existingIdx >= 0) {
          s.activeTabId = s.tabs[existingIdx].id
          return
        }
        const idx = s.tabs.findIndex((t) => t.id === tabId)
        // 复用传入 Tab（openNote 已先保存脏内容，替换安全）；Tab 不存在则新建
        if (idx >= 0) {
          s.tabs[idx] = {
            ...s.tabs[idx],
            relPath,
            content,
            savedContent: content,
            mtime,
            saveStatus: 'saved',
            locateText: null,
          }
          s.activeTabId = tabId
        } else {
          const newId = generateTabId()
          s.tabs.push({
            id: newId,
            relPath,
            content,
            savedContent: content,
            mtime,
            saveStatus: 'saved',
            locateText: null,
          })
          s.activeTabId = newId
        }
      }),

    switchTab: (tabId) =>
      set((s) => {
        s.activeTabId = tabId
      }),

    closeTab: (tabId) => {
      const state = get()
      const tab = state.tabs.find((t) => t.id === tabId)
      const hasDirty = !!(tab && tab.relPath && tab.saveStatus === 'dirty')
      let nextActiveId: string | null = null

      set((s) => {
        const idx = s.tabs.findIndex((t) => t.id === tabId)
        if (idx < 0) return
        s.tabs.splice(idx, 1)
        if (s.activeTabId === tabId) {
          if (s.tabs.length > 0) {
            const nextIdx = Math.min(idx, s.tabs.length - 1)
            nextActiveId = s.tabs[nextIdx].id
            s.activeTabId = nextActiveId
          } else {
            s.activeTabId = null
          }
        }
      })

      return { hasDirty, nextActiveId }
    },

    renameTabPath: (oldRelPath, newRelPath) =>
      set((s) => {
        for (const tab of s.tabs) {
          if (tab.relPath === oldRelPath) {
            tab.relPath = newRelPath
          }
        }
      }),

    getTab: (tabId) => get().tabs.find((t) => t.id === tabId),
    getActiveTab: () => {
      const s = get()
      return s.tabs.find((t) => t.id === s.activeTabId)
    },

    setTabContent: (tabId, content) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (!tab) return
        tab.content = content
        tab.saveStatus = content === tab.savedContent ? 'saved' : 'dirty'
      }),

    setTabSaved: (tabId, content, mtime) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (!tab) return
        tab.savedContent = content
        tab.mtime = mtime
        tab.saveStatus = 'saved'
      }),

    setTabSaving: (tabId) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (tab) tab.saveStatus = 'saving'
      }),

    setTabDirty: (tabId) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (tab) tab.saveStatus = 'dirty'
      }),

    setTabLocateText: (tabId, text) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (tab) tab.locateText = text
      }),

    clearTabLocateText: (tabId) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (tab) tab.locateText = null
      }),

    setActiveTabLocateText: (text) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        if (tab) tab.locateText = text
      }),
  }))
)

export { DEFAULT_NOTES_SETTINGS }
export type { NoteEditorMode }
