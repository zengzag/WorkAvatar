/**
 * notes 插件 useNotes hook：封装 store 状态与数据操作（经插件桥 IPC）。
 * 由宿主 hook（src/hooks/useNotes.ts）迁移而来，仅替换数据访问层。
 */
import { useCallback, useEffect, useRef } from 'react'
import { App } from 'antd'
import {
  useNotesStore,
  hostT,
  listTree,
  readNote,
  readExternal,
  writeNote,
  writeExternal,
  getSettings,
  setSettings as persistSettings,
  createNote as createNoteApi,
  createFolder as createFolderApi,
  renameNote as renameNoteApi,
  moveNote as moveNoteApi,
  copyNote as copyNoteApi,
  deleteNote as deleteNoteApi,
  openDiary,
  onDataChanged,
} from './store'
import type { NoteNode, NotesSettings } from './types'

export function useNotes() {
  const { message } = App.useApp()
  const {
    tree, treeLoading, tabs, activeTabId, settings, settingsLoading,
    setTree, setTreeLoading, setSettings, setSettingsLoading, reset,
    createEmptyTab, openNoteInTab, openExternalInTab, switchTab, closeTab, renameTabPath,
    setTabContent, setTabSaved, setTabSaving, setActiveTabLocateText, clearTabLocateText,
  } = useNotesStore()

  const initedRef = useRef(false)

  const activeTab = tabs.find((t) => t.id === activeTabId) || null
  const currentRelPath = activeTab?.relPath || null
  const currentExternalAbsPath = activeTab?.externalAbsPath || null
  const currentContent = activeTab?.content || ''
  const currentMtime = activeTab?.mtime || 0
  const saveStatus = activeTab?.saveStatus || 'saved'
  const locateText = activeTab?.locateText || null

  const refreshTree = useCallback(async () => {
    setTreeLoading(true)
    try {
      const result = await listTree()
      if (Array.isArray(result)) setTree(result as NoteNode[])
    } catch (err: any) {
      message.error(err?.message || hostT('loadTreeFailed'))
    } finally {
      setTreeLoading(false)
    }
  }, [setTree, setTreeLoading, message])

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true)
    try {
      const s = await getSettings()
      if (s) setSettings(s as NotesSettings)
    } catch { /* ignore */ } finally {
      setSettingsLoading(false)
    }
  }, [setSettings, setSettingsLoading])

  const persistTabs = useCallback(async () => {
    const state = useNotesStore.getState()
    // 外部文件标签页为临时打开，不持久化
    const tabPaths = state.tabs
      .map((tab) => tab.relPath)
      .filter((p): p is string => !!p)
    const activeTab = state.activeTabId
      ? state.tabs.find((t) => t.id === state.activeTabId)
      : null
    // 激活的若是外部标签页，保持上一次持久化的激活路径不变（避免把 null 写入覆盖）
    const activeRelPath = activeTab?.relPath || null
    await persistSettings({
      open_tabs: tabPaths,
      active_tab: activeRelPath,
      last_opened: activeRelPath,
    })
  }, [])

  const handleNewTab = useCallback(async () => {
    const id = createEmptyTab()
    await persistTabs()
    return id
  }, [createEmptyTab, persistTabs])

  const saveTabContent = useCallback(async (tabId: string): Promise<boolean> => {
    const state = useNotesStore.getState()
    const tab = state.tabs.find((t) => t.id === tabId)
    if (!tab) return false
    if (!tab.relPath && !tab.externalAbsPath) return false
    if (tab.content === tab.savedContent) return true
    setTabSaving(tabId)
    try {
      let res: any
      if (tab.externalAbsPath) {
        res = await writeExternal(tab.externalAbsPath, tab.content)
      } else {
        res = await writeNote(tab.relPath!, tab.content)
      }
      if (res && (res as any).error) {
        message.error((res as any).error)
        useNotesStore.setState((s) => {
          const t = s.tabs.find((x) => x.id === tabId)
          if (t) t.saveStatus = 'dirty'
        })
        return false
      }
      setTabSaved(tabId, tab.content, (res as any)?.mtime ?? tab.mtime)
      return true
    } catch (err: any) {
      message.error(err?.message || hostT('saveFailed'))
      useNotesStore.setState((s) => {
        const t = s.tabs.find((x) => x.id === tabId)
        if (t) t.saveStatus = 'dirty'
      })
      return false
    }
  }, [setTabSaving, setTabSaved, message])

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    if (!activeTabId) return false
    return saveTabContent(activeTabId)
  }, [activeTabId, saveTabContent])

  const openNote = useCallback(async (relPath: string, tabId?: string) => {
    try {
      // 切换文档前先保存当前激活 Tab 的脏内容，避免自动保存未触发导致编辑丢失
      const st = useNotesStore.getState()
      const active = st.tabs.find((t) => t.id === st.activeTabId)
      if ((active?.relPath || active?.externalAbsPath) && active.relPath !== relPath && active.saveStatus === 'dirty') {
        await saveTabContent(active.id)
      }
      const note = await readNote(relPath)
      if (note && (note as any).error) {
        message.error((note as any).error)
        return
      }
      // 目标 Tab：优先复用传入/激活的空 Tab，否则由 store 新建
      const currentSt = useNotesStore.getState()
      const targetTabId = tabId || currentSt.activeTabId || currentSt.createEmptyTab()
      openNoteInTab(targetTabId, relPath, (note as any).content, (note as any).mtime)
      await persistTabs()
    } catch (err: any) {
      message.error(err?.message || hostT('openFailed'))
    }
  }, [saveTabContent, openNoteInTab, persistTabs, message])

  const openExternal = useCallback(async (absPath: string) => {
    try {
      // 切换文档前先保存当前激活 Tab 的脏内容
      const st = useNotesStore.getState()
      const active = st.tabs.find((t) => t.id === st.activeTabId)
      if (active?.relPath && active.saveStatus === 'dirty') {
        await saveTabContent(active.id)
      }
      const note = await readExternal(absPath)
      if (note && (note as any).error) {
        message.error((note as any).error)
        return
      }
      const currentSt = useNotesStore.getState()
      const currentActive = currentSt.tabs.find((t) => t.id === currentSt.activeTabId)
      // 当前激活 Tab 为空白新标签时复用，否则新建标签打开外部 md 文件
      const isEmptyNewTab = !!currentActive && !currentActive.relPath && !currentActive.externalAbsPath && currentActive.content === ''
      const targetTabId = isEmptyNewTab ? currentActive!.id : currentSt.createEmptyTab()
      openExternalInTab(targetTabId, absPath, (note as any).content, (note as any).mtime)
    } catch (err: any) {
      message.error(err?.message || hostT('openFailed'))
    }
  }, [saveTabContent, openExternalInTab, message])

  const init = useCallback(async () => {
    if (initedRef.current) return
    initedRef.current = true
    await Promise.all([refreshTree(), loadSettings()])
    const s = useNotesStore.getState().settings
    const savedTabs = s.open_tabs && s.open_tabs.length > 0 ? s.open_tabs : (s.last_opened ? [s.last_opened] : [])
    const savedActive = s.active_tab || s.last_opened

    let firstTabId: string | null = null
    let activeTabIdToSet: string | null = null

    if (savedTabs.length > 0) {
      for (const relPath of savedTabs) {
        try {
          const note = await readNote(relPath)
          if (note && !(note as any).error) {
            const state = useNotesStore.getState()
            const existingTab = state.tabs.find((t) => t.relPath === relPath)
            const tabId = existingTab ? existingTab.id : state.createEmptyTab()
            state.openNoteInTab(tabId, relPath, (note as any).content, (note as any).mtime)
            if (!firstTabId) firstTabId = tabId
            if (relPath === savedActive) activeTabIdToSet = tabId
          }
        } catch { /* skip missing */ }
      }
      if (activeTabIdToSet || firstTabId) {
        useNotesStore.getState().switchTab(activeTabIdToSet || firstTabId!)
      }
    }

    if (useNotesStore.getState().tabs.length === 0) {
      useNotesStore.getState().createEmptyTab()
    }
  }, [refreshTree, loadSettings])

  const createNote = useCallback(async (parentRelPath: string, name: string) => {
    try {
      const res = await createNoteApi(parentRelPath, name)
      if (res && (res as any).error) {
        message.error((res as any).error)
        return null
      }
      await refreshTree()
      return res as NoteNode | null
    } catch (err: any) {
      message.error(err?.message || hostT('createFailed'))
      return null
    }
  }, [refreshTree, message])

  const createFolder = useCallback(async (parentRelPath: string, name: string) => {
    try {
      const res = await createFolderApi(parentRelPath, name)
      if (res && (res as any).error) {
        message.error((res as any).error)
        return null
      }
      await refreshTree()
      return res as NoteNode | null
    } catch (err: any) {
      message.error(err?.message || hostT('createFailed'))
      return null
    }
  }, [refreshTree, message])

  const renameItem = useCallback(async (relPath: string, newName: string) => {
    try {
      const res = await renameNoteApi(relPath, newName)
      if (res && (res as any).error) {
        message.error((res as any).error)
        return null
      }
      const newRel = (res as any)?.relPath as string | undefined
      if (newRel) {
        renameTabPath(relPath, newRel)
        await persistTabs()
      }
      await refreshTree()
      return newRel ?? null
    } catch (err: any) {
      message.error(err?.message || hostT('renameFailed'))
      return null
    }
  }, [renameTabPath, persistTabs, refreshTree, message])

  const moveItem = useCallback(async (srcRelPath: string, destParentRelPath: string) => {
    try {
      const res = await moveNoteApi(srcRelPath, destParentRelPath)
      if (res && (res as any).error) {
        message.error((res as any).error)
        return false
      }
      const newRel = (res as any)?.relPath as string | undefined
      if (newRel) {
        renameTabPath(srcRelPath, newRel)
        await persistTabs()
      }
      await refreshTree()
      return true
    } catch (err: any) {
      message.error(err?.message || hostT('moveFailed'))
      return false
    }
  }, [renameTabPath, persistTabs, refreshTree, message])

  const copyItem = useCallback(async (srcRelPath: string, destParentRelPath: string) => {
    try {
      const res = await copyNoteApi(srcRelPath, destParentRelPath)
      if (res && (res as any).error) {
        message.error((res as any).error)
        return false
      }
      await refreshTree()
      return true
    } catch (err: any) {
      message.error(err?.message || hostT('copyFailed'))
      return false
    }
  }, [refreshTree, message])

  const deleteItem = useCallback(async (relPath: string) => {
    try {
      const res = await deleteNoteApi(relPath)
      if (res && (res as any).error) {
        message.error((res as any).error)
        return false
      }
      const state = useNotesStore.getState()
      const tabToClose = state.tabs.find((tab) => tab.relPath === relPath)
      if (tabToClose) {
        state.closeTab(tabToClose.id)
      }
      await persistTabs()
      await refreshTree()
      return true
    } catch (err: any) {
      message.error(err?.message || hostT('deleteFailed'))
      return false
    }
  }, [persistTabs, refreshTree, message])

  const updateSettings = useCallback(async (patch: Partial<NotesSettings>) => {
    try {
      const next = await persistSettings(patch)
      if (next && !(next as any).error) setSettings(next as NotesSettings)
    } catch { /* ignore */ }
  }, [setSettings, persistSettings])

  const handleSwitchTab = useCallback(async (tabId: string) => {
    // 切换 Tab 前先保存当前激活 Tab 的脏内容，避免自动保存未触发导致编辑丢失
    if (tabId !== activeTabId) {
      const st = useNotesStore.getState()
      const active = st.tabs.find((t) => t.id === st.activeTabId)
      if ((active?.relPath || active?.externalAbsPath) && active.saveStatus === 'dirty') {
        await saveTabContent(active.id)
      }
    }
    switchTab(tabId)
    await persistTabs()
  }, [activeTabId, switchTab, persistTabs, saveTabContent])

  const handleCloseTab = useCallback(async (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId)
    if ((tab?.relPath || tab?.externalAbsPath) && tab.saveStatus === 'dirty') {
      await saveTabContent(tabId)
    }
    const result = closeTab(tabId)
    await persistTabs()
    if (useNotesStore.getState().tabs.length === 0) {
      useNotesStore.getState().createEmptyTab()
      await persistTabs()
    }
    return result
  }, [tabs, closeTab, saveTabContent, persistTabs])

  const updateTabContent = useCallback((tabId: string, content: string) => {
    setTabContent(tabId, content)
  }, [setTabContent])

  const setContent = useCallback((content: string) => {
    if (activeTabId) setTabContent(activeTabId, content)
  }, [activeTabId, setTabContent])

  const setLocateText = useCallback((text: string | null) => {
    setActiveTabLocateText(text)
  }, [setActiveTabLocateText])

  // 使用 ref 保存最新值，避免 onDataChanged 回调过期闭包
  const currentRelPathRef = useRef(currentRelPath)
  const saveStatusRef = useRef(saveStatus)
  useEffect(() => { currentRelPathRef.current = currentRelPath }, [currentRelPath])
  useEffect(() => { saveStatusRef.current = saveStatus }, [saveStatus])

  useEffect(() => {
    const unsub = onDataChanged((payload) => {
      if (payload.scope === 'tree') {
        refreshTree()
        const relPath = currentRelPathRef.current
        const status = saveStatusRef.current
        if (!payload.self && relPath && status !== 'dirty') {
          readNote(relPath).then((note: any) => {
            if (note && !note.error && note.relPath === relPath) {
              const state = useNotesStore.getState()
              const tab = state.tabs.find((t) => t.id === state.activeTabId)
              if (tab) {
                setTabSaved(tab.id, note.content, note.mtime)
              }
            }
          }).catch(() => { /* ignore */ })
        }
      }
    })
    return () => { unsub() }
  }, [refreshTree, setTabSaved])

  return {
    tree, treeLoading, currentRelPath, currentExternalAbsPath, currentContent, currentMtime, saveStatus,
    tabs, activeTabId, activeTab, settings, settingsLoading, locateText,
    init, refreshTree, openNote, openExternal, saveCurrent, createNote, createFolder, newTab: handleNewTab,
    renameItem, moveItem, copyItem, deleteItem, updateSettings,
    setContent, setLocateText, reset,
    switchTab: handleSwitchTab,
    closeTab: handleCloseTab,
    updateTabContent,
    saveTabContent,
    clearTabLocateText,
  }
}