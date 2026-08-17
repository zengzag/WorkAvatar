/**
 * notes 插件共享状态与宿主桥接。
 * - bridge：宿主注入的通用 IPC 桥（invoke 携带 notes 插件 id 前缀）
 * - hostI18n：宿主受控 i18n（namespace=notes 已注册）
 * - disposeCallbacks：入口 dispose 时统一清理订阅
 * - 主题/语言从宿主 DOM 标记（data-theme / data-locale）读取并订阅
 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { PluginBridge } from '../../../plugin-sdk/src/renderer'
import type {
  NoteNode,
  NotesSettings,
  NoteEditorMode,
  NoteSearchHit,
  NoteContent,
  NotesDataChangedPayload,
} from './types'
import { DEFAULT_NOTES_SETTINGS } from './types'

export type { NoteEditorMode }

let bridge: PluginBridge | null = null
let hostI18n: ((key: string, options?: Record<string, unknown>) => string) | null = null
/** 宿主能力：订阅"打开方式"传入的外部 .md 文件 */
let subscribeExternalFilesCapability: ((cb: (absPath: string) => void) => () => void) | null = null
/** 宿主能力：注册关闭守卫（tab 独立窗口未保存内容确认） */
let registerCloseGuardCapability: ((check: () => boolean) => () => void) | null = null

export function setBridge(b: PluginBridge): void {
  bridge = b
}
export function setHostI18n(t: (key: string, options?: Record<string, unknown>) => string): void {
  hostI18n = t
}
export function setHostCapabilities(caps?: {
  subscribeExternalFiles(callback: (absPath: string) => void): () => void
  registerCloseGuard(check: () => boolean): () => void
}): void {
  subscribeExternalFilesCapability = caps?.subscribeExternalFiles ?? null
  registerCloseGuardCapability = caps?.registerCloseGuard ?? null
}
export function hostT(key: string, options?: Record<string, unknown>): string {
  if (hostI18n) return hostI18n(key, options)
  return key
}

export function invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  if (!bridge) return Promise.reject(new Error('插件桥未就绪'))
  return bridge.invoke<T>(channel, payload)
}

/** 宿主能力：订阅"打开方式"传入的外部 .md 文件；返回取消订阅函数 */
export function subscribeExternalFiles(cb: (absPath: string) => void): () => void {
  if (subscribeExternalFilesCapability) return subscribeExternalFilesCapability(cb)
  return () => {}
}

/** 宿主能力：注册关闭守卫（有脏内容时宿主在关闭独立窗口前弹确认框）；返回取消注册函数 */
export function registerCloseGuard(check: () => boolean): () => void {
  if (registerCloseGuardCapability) return registerCloseGuardCapability(check)
  return () => {}
}

/** 宿主能力：File → 绝对路径（拖拽导入/拖放打开用） */
export function getPathForFile(file: File): string {
  const p = (file as File & { path?: string }).path
  return typeof p === 'string' ? p : ''
}

// ====== DOM 主题 / 语言 ======

export function isDarkTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark'
}

export function getAppLocale(): 'zh-CN' | 'en-US' {
  const l = document.documentElement.getAttribute('data-locale')
  return l === 'en-US' ? 'en-US' : 'zh-CN'
}

/** 订阅 DOM 主题/语言变化（宿主 appearance.store 变更时写入），返回取消订阅 */
export function subscribeAppearance(cb: () => void): () => void {
  const observer = new MutationObserver(() => cb())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-locale'] })
  return () => observer.disconnect()
}

/** React 响应式主题/语言（替代宿主 appearance.store 订阅，DOM 变化自动刷新） */
export function useAppearance(): { isDark: boolean; locale: 'zh-CN' | 'en-US' } {
  const [state, setState] = useState(() => ({ isDark: isDarkTheme(), locale: getAppLocale() }))
  useEffect(() => {
    const unsub = subscribeAppearance(() => {
      setState({ isDark: isDarkTheme(), locale: getAppLocale() })
    })
    return unsub
  }, [])
  return state
}

// ====== 状态 ======

let tabIdCounter = 0
const generateTabId = () => `tab_${Date.now()}_${++tabIdCounter}`

export interface NoteTab {
  id: string
  relPath: string | null
  /** 外部文件绝对路径（vault 之外，临时打开的 .md 文件）；与 relPath 互斥 */
  externalAbsPath: string | null
  content: string
  savedContent: string
  mtime: number
  saveStatus: 'saved' | 'saving' | 'dirty'
  locateText: string | null
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
  openExternalInTab: (tabId: string, absPath: string, content: string, mtime: number) => void
  switchTab: (tabId: string) => void
  closeTab: (tabId: string) => { hasDirty: boolean; nextActiveId: string | null }
  renameTabPath: (oldRelPath: string, newRelPath: string) => void
  setTabContent: (tabId: string, content: string) => void
  setTabSaved: (tabId: string, content: string, mtime: number) => void
  setTabSaving: (tabId: string) => void
  setActiveTabLocateText: (text: string | null) => void
  clearTabLocateText: (tabId: string) => void
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
          externalAbsPath: null,
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
        if (idx >= 0) {
          s.tabs[idx] = {
            ...s.tabs[idx],
            relPath,
            externalAbsPath: null,
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
            externalAbsPath: null,
            content,
            savedContent: content,
            mtime,
            saveStatus: 'saved',
            locateText: null,
          })
          s.activeTabId = newId
        }
      }),

    openExternalInTab: (tabId, absPath, content, mtime) =>
      set((s) => {
        const existingIdx = s.tabs.findIndex((t) => t.externalAbsPath === absPath)
        if (existingIdx >= 0) {
          s.activeTabId = s.tabs[existingIdx].id
          return
        }
        const idx = s.tabs.findIndex((t) => t.id === tabId)
        if (idx >= 0) {
          s.tabs[idx] = {
            ...s.tabs[idx],
            relPath: null,
            externalAbsPath: absPath,
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
            relPath: null,
            externalAbsPath: absPath,
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

    setActiveTabLocateText: (text) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        if (tab) tab.locateText = text
      }),

    clearTabLocateText: (tabId) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (tab) tab.locateText = null
      }),
  }))
)

// ====== 数据操作（经插件桥） ======

export async function listTree(): Promise<NoteNode[]> {
  const res = await invoke<NoteNode[] | { error: string }>('list-tree')
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return (res as NoteNode[]) || []
}

export async function readNote(relPath: string): Promise<NoteContent> {
  const res = await invoke<NoteContent | { error: string }>('read', relPath)
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return res as NoteContent
}

export async function readExternal(absPath: string): Promise<NoteContent> {
  const res = await invoke<NoteContent | { error: string }>('read-external', absPath)
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return res as NoteContent
}

export async function writeNote(relPath: string, content: string): Promise<NoteContent> {
  const res = await invoke<NoteContent | { error: string }>('write', { relPath, content })
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return res as NoteContent
}

export async function writeExternal(absPath: string, content: string): Promise<NoteContent> {
  const res = await invoke<NoteContent | { error: string }>('write-external', { absPath, content })
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return res as NoteContent
}

export async function getSettings(): Promise<NotesSettings> {
  const res = await invoke<NotesSettings | { error: string }>('get-settings')
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return res as NotesSettings
}

/** 数据变更订阅（watcher 广播 data-changed） */
export function onDataChanged(cb: (payload: NotesDataChangedPayload) => void): () => void {
  if (!bridge) return () => {}
  return bridge.onEvent('data-changed', (payload) => cb(payload as NotesDataChangedPayload))
}

export async function setSettings(patch: Partial<NotesSettings>): Promise<NotesSettings> {
  const res = await invoke<NotesSettings | { error: string }>('set-settings', patch)
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return res as NotesSettings
}

export async function createNote(parentRelPath: string, name: string): Promise<NoteNode | null> {
  const res = await invoke<NoteNode | { error: string }>('create-note', { parentRelPath, name })
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return res as NoteNode | null
}

export async function createFolder(parentRelPath: string, name: string): Promise<NoteNode | null> {
  const res = await invoke<NoteNode | { error: string }>('create-folder', { parentRelPath, name })
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return res as NoteNode | null
}

export async function renameNote(relPath: string, newName: string): Promise<{ relPath: string } | null> {
  const res = await invoke<{ relPath: string } | { error: string }>('rename', { relPath, newName })
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return res as { relPath: string } | null
}

export async function moveNote(srcRelPath: string, destParentRelPath: string): Promise<{ relPath: string } | null> {
  const res = await invoke<{ relPath: string } | { error: string }>('move', { srcRelPath, destParentRelPath })
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return res as { relPath: string } | null
}

export async function copyNote(srcRelPath: string, destParentRelPath: string): Promise<{ relPath: string } | null> {
  const res = await invoke<{ relPath: string } | { error: string }>('copy', { srcRelPath, destParentRelPath })
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return res as { relPath: string } | null
}

export async function deleteNote(relPath: string): Promise<boolean> {
  const res = await invoke<{ success: boolean } | { error: string }>('delete', relPath)
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return true
}

export async function importExternal(srcAbsPath: string, destParentRelPath: string): Promise<boolean> {
  const res = await invoke<{ relPath: string } | { error: string }>('import-external', { srcAbsPath, destParentRelPath })
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return true
}

export async function getAbsolutePath(relPath: string): Promise<string> {
  const res = await invoke<{ absPath: string } | { error: string }>('get-abs-path', relPath)
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return (res as { absPath: string }).absPath
}

export async function openInExplorer(relPath: string): Promise<void> {
  const res = await invoke<{ success: boolean } | { error: string }>('open-in-explorer', relPath)
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
}

export async function openVault(): Promise<void> {
  const res = await invoke<{ success: boolean } | { error: string }>('open-vault')
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
}

export async function saveImage(buffer: ArrayBuffer, fileName: string): Promise<string> {
  const res = await invoke<{ relPath: string } | { error: string }>('save-image', { buffer, fileName })
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return (res as { relPath: string }).relPath
}

export async function openDiary(): Promise<{ relPath: string; created: boolean } | null> {
  const res = await invoke<{ relPath: string; created: boolean } | { error: string }>('open-diary')
  if (res && typeof res === 'object' && 'error' in (res as any)) {
    throw new Error((res as any).error)
  }
  return res as { relPath: string; created: boolean } | null
}

export { DEFAULT_NOTES_SETTINGS }
export type { NoteSearchHit }