import { useCallback, useEffect, useRef } from 'react'
import { message } from 'antd'
import { useTranslation } from 'react-i18next'
import { useNotesStore } from '../stores/notes.store'
import type { NoteNode, NoteSearchHit, NotesSettings } from '../types/notes'

/**
 * 笔记模块 Hook：封装所有 IPC 调用，订阅 NOTES_DATA_CHANGED 自动刷新树。
 * 编辑器内容刷新由 self 标记区分，避免外部变更与自身保存冲突。
 */
export function useNotes() {
  const { t } = useTranslation()
  const {
    tree, treeLoading, currentRelPath, currentContent, savedContent, currentMtime, saveStatus,
    searchQuery, searchResults, searching, settings, settingsLoading, locateText,
    setTree, setTreeLoading, setCurrent, setContent, setSaveStatus,
    setSearchQuery, setSearchResults, setSearching, setSettings, setSettingsLoading, setLocateText, reset,
  } = useNotesStore()

  // 防止重复初始化
  const initedRef = useRef(false)

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

  const openNote = useCallback(async (relPath: string, recordLast = true) => {
    try {
      const note = await window.electronAPI.notes.read(relPath)
      if (note && (note as any).error) {
        message.error((note as any).error)
        return
      }
      setCurrent(relPath, (note as any).content, (note as any).mtime)
      setLocateText(null)
      if (recordLast) {
        await window.electronAPI.notes.setSettings({ last_opened: relPath })
      }
    } catch (err: any) {
      message.error(err?.message || t('notes.openFailed'))
    }
  }, [setCurrent, setLocateText, t])

  const init = useCallback(async () => {
    if (initedRef.current) return
    initedRef.current = true
    await Promise.all([refreshTree(), loadSettings()])
    // 恢复最后打开的笔记
    const s = useNotesStore.getState().settings
    if (s.last_opened) {
      await openNote(s.last_opened, false)
    }
  }, [refreshTree, loadSettings, openNote])

  /** 保存当前笔记到磁盘 */
  const saveCurrent = useCallback(async (): Promise<boolean> => {
    if (!currentRelPath) return false
    if (currentContent === savedContent) return true
    setSaveStatus('saving')
    try {
      const res = await window.electronAPI.notes.write({
        relPath: currentRelPath,
        content: currentContent,
      })
      if (res && (res as any).error) {
        message.error((res as any).error)
        setSaveStatus('dirty')
        return false
      }
      // 更新已保存基准，避免 watcher 回环
      useNotesStore.setState((s) => {
        s.savedContent = currentContent
        s.currentMtime = (res as any)?.mtime ?? s.currentMtime
        s.saveStatus = 'saved'
      })
      return true
    } catch (err: any) {
      message.error(err?.message || t('notes.saveFailed'))
      setSaveStatus('dirty')
      return false
    }
  }, [currentRelPath, currentContent, savedContent, setSaveStatus, t])

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
      // 若重命名的是当前打开的笔记，同步 currentRelPath
      if (newRel && relPath === currentRelPath) {
        useNotesStore.setState((s) => { s.currentRelPath = newRel })
        await window.electronAPI.notes.setSettings({ last_opened: newRel })
      }
      await refreshTree()
      return newRel ?? null
    } catch (err: any) {
      message.error(err?.message || t('notes.renameFailed'))
      return null
    }
  }, [currentRelPath, refreshTree, t])

  const moveItem = useCallback(async (srcRelPath: string, destParentRelPath: string) => {
    try {
      const res = await window.electronAPI.notes.move({ srcRelPath, destParentRelPath })
      if (res && (res as any).error) {
        message.error((res as any).error)
        return false
      }
      const newRel = (res as any)?.relPath as string | undefined
      if (newRel && srcRelPath === currentRelPath) {
        useNotesStore.setState((s) => { s.currentRelPath = newRel })
        await window.electronAPI.notes.setSettings({ last_opened: newRel })
      }
      await refreshTree()
      return true
    } catch (err: any) {
      message.error(err?.message || t('notes.moveFailed'))
      return false
    }
  }, [currentRelPath, refreshTree, t])

  const deleteItem = useCallback(async (relPath: string) => {
    try {
      const res = await window.electronAPI.notes.delete(relPath)
      if (res && (res as any).error) {
        message.error((res as any).error)
        return false
      }
      // 删除当前打开的笔记则清空编辑器
      if (relPath === currentRelPath) {
        reset()
        await window.electronAPI.notes.setSettings({ last_opened: null })
      }
      await refreshTree()
      return true
    } catch (err: any) {
      message.error(err?.message || t('notes.deleteFailed'))
      return false
    }
  }, [currentRelPath, reset, refreshTree, t])

  const runSearch = useCallback(async (query: string) => {
    const q = query.trim()
    setSearchQuery(q)
    if (!q) {
      setSearchResults([])
      return
    }
    setSearching(true)
    try {
      const res = await window.electronAPI.notes.search({ query: q })
      setSearchResults((res || []) as NoteSearchHit[])
    } catch {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [setSearchQuery, setSearchResults, setSearching])

  /** 打开搜索结果中的笔记并定位到文本片段 */
  const openSearchHit = useCallback(async (relPath: string, text?: string) => {
    await openNote(relPath)
    if (text) setLocateText(text)
  }, [openNote, setLocateText])

  const updateSettings = useCallback(async (patch: Partial<NotesSettings>) => {
    try {
      const next = await window.electronAPI.notes.setSettings(patch)
      if (next && !(next as any).error) setSettings(next as NotesSettings)
    } catch { /* ignore */ }
  }, [setSettings])

  // 订阅外部文件变更：非自身触发的变更刷新树；若当前笔记被外部修改且本地无未保存改动，则重载
  useEffect(() => {
    const unsub = window.electronAPI.notes.onDataChanged((payload) => {
      if (payload.scope === 'tree') {
        refreshTree()
        // 当前笔记被外部修改且本地无未保存改动 → 重载内容
        if (!payload.self && currentRelPath && saveStatus !== 'dirty') {
          window.electronAPI.notes.read(currentRelPath).then((note: any) => {
            if (note && !note.error && note.relPath === currentRelPath) {
              useNotesStore.setState((s) => {
                s.currentContent = note.content
                s.savedContent = note.content
                s.currentMtime = note.mtime
                s.saveStatus = 'saved'
              })
            }
          }).catch(() => { /* ignore */ })
        }
      }
    })
    return () => { unsub() }
  }, [refreshTree, currentRelPath, saveStatus])

  return {
    // state
    tree, treeLoading, currentRelPath, currentContent, currentMtime, saveStatus,
    searchQuery, searchResults, searching, settings, settingsLoading, locateText,
    // actions
    init, refreshTree, openNote, saveCurrent, createNote, createFolder,
    renameItem, moveItem, deleteItem, runSearch, openSearchHit, updateSettings,
    setContent, setLocateText, reset,
  }
}
