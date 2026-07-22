export type {
  NoteNodeType,
  NoteNode,
  NoteContent,
  NoteSearchSnippet,
  NoteSearchHit,
  NotesSettings,
  NotesDataChangedPayload,
} from '../../electron/shared/ipc-channels'

export type NoteEditorMode = 'edit' | 'split' | 'preview'

export interface NoteOutlineItem {
  level: number
  text: string
  /** 标题在原文中的行号（0 基） */
  line: number
}
