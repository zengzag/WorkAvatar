import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  NoteNode,
  NoteSearchHit,
  NotesSettings,
  NoteEditorMode,
} from '../types/notes'
import { DEFAULT_NOTES_SETTINGS } from '../../electron/shared/channels/notes'

interface NotesState {
  tree: NoteNode[]
  treeLoading: boolean
  currentRelPath: string | null
  currentContent: string
  /** 磁盘上最后一次已保存的内容，用于判断是否有未保存修改 */
  savedContent: string
  currentMtime: number
  /** 保存状态：saved / saving / dirty */
  saveStatus: 'saved' | 'saving' | 'dirty'
  searchQuery: string
  searchResults: NoteSearchHit[]
  searching: boolean
  settings: NotesSettings
  settingsLoading: boolean
  /** 定位锚点：打开文件后滚动到的文本片段（标题或搜索命中行） */
  locateText: string | null

  setTree: (tree: NoteNode[]) => void
  setTreeLoading: (loading: boolean) => void
  setCurrent: (relPath: string | null, content: string, mtime: number) => void
  setContent: (content: string) => void
  setSaveStatus: (status: 'saved' | 'saving' | 'dirty') => void
  setSearchQuery: (query: string) => void
  setSearchResults: (results: NoteSearchHit[]) => void
  setSearching: (searching: boolean) => void
  setSettings: (settings: NotesSettings) => void
  setSettingsLoading: (loading: boolean) => void
  setLocateText: (text: string | null) => void
  reset: () => void
}

export const useNotesStore = create<NotesState>()(
  immer((set) => ({
    tree: [],
    treeLoading: false,
    currentRelPath: null,
    currentContent: '',
    savedContent: '',
    currentMtime: 0,
    saveStatus: 'saved',
    searchQuery: '',
    searchResults: [],
    searching: false,
    settings: DEFAULT_NOTES_SETTINGS,
    settingsLoading: false,
    locateText: null,

    setTree: (tree) => set((s) => { s.tree = tree }),
    setTreeLoading: (loading) => set((s) => { s.treeLoading = loading }),
    setCurrent: (relPath, content, mtime) =>
      set((s) => {
        s.currentRelPath = relPath
        s.currentContent = content
        s.savedContent = content
        s.currentMtime = mtime
        s.saveStatus = 'saved'
      }),
    setContent: (content) =>
      set((s) => {
        s.currentContent = content
        s.saveStatus = content === s.savedContent ? 'saved' : 'dirty'
      }),
    setSaveStatus: (status) => set((s) => { s.saveStatus = status }),
    setSearchQuery: (query) => set((s) => { s.searchQuery = query }),
    setSearchResults: (results) => set((s) => { s.searchResults = results }),
    setSearching: (searching) => set((s) => { s.searching = searching }),
    setSettings: (settings) => set((s) => { s.settings = settings }),
    setSettingsLoading: (loading) => set((s) => { s.settingsLoading = loading }),
    setLocateText: (text) => set((s) => { s.locateText = text }),
    reset: () =>
      set((s) => {
        s.currentRelPath = null
        s.currentContent = ''
        s.savedContent = ''
        s.currentMtime = 0
        s.saveStatus = 'saved'
        s.locateText = null
      }),
  }))
)

export { DEFAULT_NOTES_SETTINGS }
export type { NoteEditorMode }
