/**
 * notes 插件渲染端类型定义。
 * 与主进程 handler（src/main/index.ts）保持同步，不依赖宿主内部类型。
 */

export type NoteNodeType = 'folder' | 'file'

export interface NoteNode {
  name: string
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
  open_tabs: string[]
  active_tab: string | null
  sidebar_collapsed: boolean
  outline_collapsed: boolean
  sidebar_width: number
  outline_width: number
  editor_max_width: number
  editor_font_size: number
  editor_line_height: number
  expanded_folders: string[]
  diary_enabled: boolean
  diary_root: string
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
  diary_enabled: false,
  diary_root: 'diary',
}

export type NoteEditorMode = 'edit' | 'split' | 'preview'

export interface NoteOutlineItem {
  level: number
  text: string
  line: number
}

export interface NotesDataChangedPayload {
  scope: 'tree' | 'settings'
  ts: number
  self?: boolean
}