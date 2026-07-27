/**
 * 笔记模块 IPC handlers。
 *
 * 暴露树读取、笔记读写、新建、重命名、移动、复制、删除、搜索、设置、路径相关、外部导入共 15 个通道。
 * 所有操作经 NotesService 落到 vault 真实文件；外部文件变更由 watcher 广播 DATA_CHANGED。
 */

import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  NoteWriteParams,
  NoteCreateParams,
  NoteRenameParams,
  NoteMoveParams,
  NoteCopyParams,
  NoteImportExternalParams,
  NoteSearchParams,
  NotesSettings,
} from '../../shared/ipc-channels'
import NotesService from '../services/notes/notes.service'
import { safeHandle } from './_shared'

export function registerNotesHandlers(): void {
  const service = NotesService.getInstance()

  safeHandle(IPC_CHANNELS.NOTES_LIST_TREE, () => {
    return service.listTree()
  })

  safeHandle(IPC_CHANNELS.NOTES_READ, (relPath: string) => {
    if (!relPath) return { error: 'relPath 必填' }
    return service.readNote(relPath)
  })

  safeHandle(IPC_CHANNELS.NOTES_WRITE, (params: NoteWriteParams) => {
    if (!params?.relPath || typeof params.content !== 'string') {
      return { error: 'relPath 和 content 必填' }
    }
    return service.writeNote(params.relPath, params.content)
  })

  safeHandle(IPC_CHANNELS.NOTES_CREATE_NOTE, (params: NoteCreateParams) => {
    if (!params?.name) return { error: 'name 必填' }
    return service.createNote(params.parentRelPath || '', params.name)
  })

  safeHandle(IPC_CHANNELS.NOTES_CREATE_FOLDER, (params: NoteCreateParams) => {
    if (!params?.name) return { error: 'name 必填' }
    return service.createFolder(params.parentRelPath || '', params.name)
  })

  safeHandle(IPC_CHANNELS.NOTES_RENAME, (params: NoteRenameParams) => {
    if (!params?.relPath || !params.newName) return { error: 'relPath 和 newName 必填' }
    return service.renameItem(params.relPath, params.newName)
  })

  safeHandle(IPC_CHANNELS.NOTES_MOVE, (params: NoteMoveParams) => {
    if (!params?.srcRelPath) return { error: 'srcRelPath 必填' }
    return service.moveItem(params.srcRelPath, params.destParentRelPath || '')
  })

  safeHandle(IPC_CHANNELS.NOTES_COPY, (params: NoteCopyParams) => {
    if (!params?.srcRelPath) return { error: 'srcRelPath 必填' }
    return service.copyItem(params.srcRelPath, params.destParentRelPath || '')
  })

  safeHandle(IPC_CHANNELS.NOTES_DELETE, async (relPath: string) => {
    if (!relPath) return { error: 'relPath 必填' }
    return await service.deleteItem(relPath)
  })

  safeHandle(IPC_CHANNELS.NOTES_SEARCH, (params: NoteSearchParams) => {
    if (!params?.query) return []
    return service.search(params.query, params.maxResults)
  })

  safeHandle(IPC_CHANNELS.NOTES_GET_SETTINGS, () => {
    return service.getSettings()
  })

  safeHandle(IPC_CHANNELS.NOTES_SET_SETTINGS, (params: Partial<NotesSettings>) => {
    return service.setSettings(params || {})
  })

  safeHandle(IPC_CHANNELS.NOTES_GET_ABS_PATH, (relPath: string) => {
    if (!relPath) return { error: 'relPath 必填' }
    try {
      return { absPath: service.getAbsolutePath(relPath) }
    } catch (err: any) {
      return { error: err?.message || '获取路径失败' }
    }
  })

  safeHandle(IPC_CHANNELS.NOTES_OPEN_IN_EXPLORER, (relPath: string) => {
    if (!relPath) return { error: 'relPath 必填' }
    try {
      service.openInExplorer(relPath)
      return { success: true }
    } catch (err: any) {
      return { error: err?.message || '打开失败' }
    }
  })

  safeHandle(IPC_CHANNELS.NOTES_IMPORT_EXTERNAL, async (params: NoteImportExternalParams) => {
    if (!params?.srcAbsPath) return { error: 'srcAbsPath 必填' }
    try {
      return await service.importExternal(params.srcAbsPath, params.destParentRelPath || '')
    } catch (err: any) {
      return { error: err?.message || '导入失败' }
    }
  })
}
