import { useCallback, useEffect, useRef } from 'react'
import { App } from 'antd'
import { useTranslation } from 'react-i18next'
import { useNotesStore } from '../stores/notes.store'
import type { NoteNode, NotesSettings } from '../types/notes'

export function useNotes() {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const {
    tree, treeLoading, tabs, activeTabId, settings, settingsLoading,
    setTree, setTreeLoading, setSettings, setSettingsLoading, reset,
    createEmptyTab, openNoteInTab, switchTab, closeTab, renameTabPath,
    setTabContent, setTabSaved, setTabSaving, setActiveTabLocateText, clearTabLocateText,
  } = useNotesStore()

  const initedRef = useRef(false)

  const activeTab = tabs.find((t) => t.id === activeTabId) || null
  const currentRelPath = activeTab?.relPath || null
  const currentContent = activeTab?.content || ''
  const currentMtime = activeTab?.mtime || 0
  const saveStatus = activeTab?.saveStatus || 'saved'
  const locateText = activeTab?.locateText || null

  const refreshTree = useCallback(async () => {
    setTreeLoading(true)
    try {
      const result = await window.electronAPI.notes.listTree()
      if (Array.isArray(result)) setTree(result as NoteNode[])
    } catch (err: any) {
      message.error(err?.message || t('notes.loadTreeFailed'))
    } finally {
      setTreeLoading(false)
    }
  }, [setTree, setTreeLoading, t])

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true)
    try {
      const s = await window.electronAPI.notes.getSettings()
      if (s) setSettings(s as NotesSettings)
    } catch { /* ignore */ } finally {
      setSettingsLoading(false)
    }
  }, [setSettings, setSettingsLoading])

  const persistTabs = useCallback(async () => {
    const state = useNotesStore.getState()
    const tabPaths = state.tabs
      .map((tab) => tab.relPath)
      .filter((p): p is string => !!p)
    await window.electronAPI.notes.setSettings({
      open_tabs: tabPaths,
      active_tab: state.activeTabId
        ? (state.tabs.find((t) => t.id === state.activeTabId)?.relPath || null)
        : null,
      last_opened: state.activeTabId
        ? (state.tabs.find((t) => t.id === state.activeTabId)?.relPath || null)
        : null,
    })
  }, [])

  const handleNewTab = useCallback(async () => {
    const id = createEmptyTab()
    await persistTabs()
    return id
  }, [createEmptyTab, persistTabs])

  const openNote = useCallback(async (relPath: string, tabId?: string) => {
    try {
      const note = await window.electronAPI.notes.read(relPath)
      if (note && (note as any).error) {
        message.error((note as any).error)
        return
      }
      const targetTabId = tabId || activeTabId || createEmptyTab()
      openNoteInTab(targetTabId, relPath, (note as any).content, (note as any).mtime)
      await persistTabs()
    } catch (err: any) {
      message.error(err?.message || t('notes.openFailed'))
    }
  }, [activeTabId, createEmptyTab, openNoteInTab, persistTabs, t])

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
          const note = await window.electronAPI.notes.read(relPath)
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

  const saveTabContent = useCallback(async (tabId: string): Promise<boolean> => {
    const state = useNotesStore.getState()
    const tab = state.tabs.find((t) => t.id === tabId)
    if (!tab || !tab.relPath) return false
    if (tab.content === tab.savedContent) return true
    setTabSaving(tabId)
    try {
      const res = await window.electronAPI.notes.write({ relPath: tab.relPath, content: tab.content })
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
      message.error(err?.message || t('notes.saveFailed'))
      useNotesStore.setState((s) => {
        const t = s.tabs.find((x) => x.id === tabId)
        if (t) t.saveStatus = 'dirty'
      })
      return false
    }
  }, [setTabSaving, setTabSaved, t])

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    if (!activeTabId) return false
    return saveTabContent(activeTabId)
  }, [activeTabId, saveTabContent])

  const createNote = useCallback(async (parentRelPath: string, name: string) => {
    try {
      const res = await window.electronAPI.notes.createNote({ parentRelPath, name })
      if (res && (res as any).error) {
        message.error((res as any).error)
        return null
      }
      await refreshTree()
      return res as NoteNode | null
    } catch (err: any) {
      message.error(err?.message || t('notes.createFailed'))
      return null
    }
  }, [refreshTree, t])

  const createFolder = useCallback(async (parentRelPath: string, name: string) => {
    try {
      const res = await window.electronAPI.notes.createFolder({ parentRelPath, name })
      if (res && (res as any).error) {
        message.error((res as any).error)
        return null
      }
      await refreshTree()
      return res as NoteNode | null
    } catch (err: any) {
      message.error(err?.message || t('notes.createFailed'))
      return null
    }
  }, [refreshTree, t])

  const renameItem = useCallback(async (relPath: string, newName: string) => {
    try {
      const res = await window.electronAPI.notes.rename({ relPath, newName })
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
      message.error(err?.message || t('notes.renameFailed'))
      return null
    }
  }, [renameTabPath, persistTabs, refreshTree, t])

  const moveItem = useCallback(async (srcRelPath: string, destParentRelPath: string) => {
    try {
      const res = await window.electronAPI.notes.move({ srcRelPath, destParentRelPath })
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
      message.error(err?.message || t('notes.moveFailed'))
      return false
    }
  }, [renameTabPath, persistTabs, refreshTree, t])

  const deleteItem = useCallback(async (relPath: string) => {
    try {
      const res = await window.electronAPI.notes.delete(relPath)
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
      message.error(err?.message || t('notes.deleteFailed'))
      return false
    }
  }, [persistTabs, refreshTree, t])

  const updateSettings = useCallback(async (patch: Partial<NotesSettings>) => {
    try {
      const next = await window.electronAPI.notes.setSettings(patch)
      if (next && !(next as any).error) setSettings(next as NotesSettings)
    } catch { /* ignore */ }
  }, [setSettings])

  const handleSwitchTab = useCallback(async (tabId: string) => {
    switchTab(tabId)
    await persistTabs()
  }, [switchTab, persistTabs])

  const handleCloseTab = useCallback(async (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab?.relPath && tab.saveStatus === 'dirty') {
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

  useEffect(() => {
    const unsub = window.electronAPI.notes.onDataChanged((payload) => {
      if (payload.scope === 'tree') {
        refreshTree()
        if (!payload.self && currentRelPath && saveStatus !== 'dirty') {
          window.electronAPI.notes.read(currentRelPath).then((note: any) => {
            if (note && !note.error && note.relPath === currentRelPath) {
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
  }, [refreshTree, currentRelPath, saveStatus, setTabSaved])

  return {
    tree, treeLoading, currentRelPath, currentContent, currentMtime, saveStatus,
    tabs, activeTabId, activeTab, settings, settingsLoading, locateText,
    init, refreshTree, openNote, saveCurrent, createNote, createFolder, newTab: handleNewTab,
    renameItem, moveItem, deleteItem, updateSettings,
    setContent, setLocateText, reset,
    switchTab: handleSwitchTab,
    closeTab: handleCloseTab,
    updateTabContent,
    saveTabContent,
    clearTabLocateText,
  }
}
