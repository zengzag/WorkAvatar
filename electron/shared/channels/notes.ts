/**
 * 笔记模块 IPC 通道。
 *
 * 基于 vault（{dataDir}/notes）的真实 .md 文件存储。
 * 包含树读取、笔记读写、新建、重命名、移动、删除、搜索、设置共 9 类操作通道，
 * 以及主进程 → 渲染进程的 DATA_CHANGED 事件推送通道（外部文件变更时触发）。
 */
export const NOTES_CHANNELS = {
  NOTES_LIST_TREE: 'notes:list-tree',
  NOTES_READ: 'notes:read',
  NOTES_WRITE: 'notes:write',
  NOTES_CREATE_NOTE: 'notes:create-note',
  NOTES_CREATE_FOLDER: 'notes:create-folder',
  NOTES_RENAME: 'notes:rename',
  NOTES_MOVE: 'notes:move',
  NOTES_COPY: 'notes:copy',
  NOTES_DELETE: 'notes:delete',
  NOTES_SEARCH: 'notes:search',
  NOTES_GET_SETTINGS: 'notes:get-settings',
  NOTES_SET_SETTINGS: 'notes:set-settings',
  NOTES_GET_ABS_PATH: 'notes:get-abs-path',
  NOTES_OPEN_IN_EXPLORER: 'notes:open-in-explorer',
  NOTES_IMPORT_EXTERNAL: 'notes:import-external',

  // 事件推送（主进程 → 渲染进程）
  NOTES_DATA_CHANGED: 'notes:data-changed',
} as const

// ====== 类型 ======

export type NoteNodeType = 'folder' | 'file'

export interface NoteNode {
  name: string
  /** 相对 vault 根的 POSIX 风格路径，如 "folder/sub.md" */
  relPath: string
  type: NoteNodeType
  mtime: number
  size: number
  children?: NoteNode[]
}

export interface NoteContent {
  relPath: string
  content: string
  mtime: number
  size: number
}

export interface NoteSearchSnippet {
  /** 命中行在原文中的行号（0 基） */
  line: number
  text: string
}

export interface NoteSearchHit {
  relPath: string
  snippets: NoteSearchSnippet[]
}

export interface NotesSettings {
  editor_mode: 'edit' | 'split' | 'preview'
  last_opened: string | null
  /** 多标签：已打开的笔记 relPath 列表 */
  open_tabs: string[]
  /** 多标签：当前激活的标签 relPath */
  active_tab: string | null
  sidebar_collapsed: boolean
  outline_collapsed: boolean
  /** 左侧文件导航栏宽度（像素） */
  sidebar_width: number
  /** 右侧大纲面板宽度（像素） */
  outline_width: number
  /** 编辑区/阅读区内容最大宽度（像素），0 表示不限 */
  editor_max_width: number
  /** 编辑区/阅读区字号（px） */
  editor_font_size: number
  /** 编辑区/阅读区行高 */
  editor_line_height: number
  /** 文件树展开的文件夹 relPath 列表 */
  expanded_folders: string[]
}

export const DEFAULT_NOTES_SETTINGS: NotesSettings = {
  editor_mode: 'edit',
  last_opened: null,
  open_tabs: [],
  active_tab: null,
  sidebar_collapsed: false,
  outline_collapsed: false,
  sidebar_width: 260,
  outline_width: 260,
  editor_max_width: 820,
  editor_font_size: 15,
  editor_line_height: 1.7,
  expanded_folders: [],
}

export interface NoteWriteParams {
  relPath: string
  content: string
}

export interface NoteCreateParams {
  /** 父文件夹 relPath，空串表示 vault 根 */
  parentRelPath: string
  name: string
}

export interface NoteRenameParams {
  relPath: string
  newName: string
}

export interface NoteMoveParams {
  srcRelPath: string
  destParentRelPath: string
}

export interface NoteCopyParams {
  srcRelPath: string
  /** 目标父文件夹 relPath，空串表示 vault 根 */
  destParentRelPath: string
}

export interface NoteImportExternalParams {
  /** 源文件 / 文件夹的绝对路径（vault 外部） */
  srcAbsPath: string
  /** 目标父文件夹 relPath，空串表示 vault 根 */
  destParentRelPath: string
}

export interface NoteSearchParams {
  query: string
  maxResults?: number
}

export interface NotesDataChangedPayload {
  scope: 'tree' | 'settings'
  ts: number
  /** 是否由本应用自身的写操作触发（前端可静默刷新，不强制重载编辑器） */
  self?: boolean
}
