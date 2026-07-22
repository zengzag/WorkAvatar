import { memo, useEffect, useMemo, useRef, useCallback } from 'react'
import { theme } from 'antd'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { useAppearanceStore, getEffectiveTheme } from '../../stores/appearance.store'
import NotesMarkdownPreview from './NotesMarkdownPreview'
import type { NoteEditorMode } from '../../types/notes'

interface Props {
  content: string
  mode: NoteEditorMode
  showLineNumbers: boolean
  saveStatus: 'saved' | 'saving' | 'dirty'
  /** 待定位的行号（0 基），处理后回调清除 */
  locateLine: number | null
  onContentChange: (content: string) => void
  onSave: () => void
  onLocateHandled: () => void
}

const AUTOSAVE_DELAY = 800

const MarkdownEditorInner: React.FC<Props> = ({
  content, mode, showLineNumbers, saveStatus, locateLine,
  onContentChange, onSave, onLocateHandled,
}) => {
  const { token } = theme.useToken()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const effectiveTheme = getEffectiveTheme(themeMode)
  const isDark = effectiveTheme === 'dark'

  const viewRef = useRef<EditorView | null>(null)
  const previewScrollRef = useRef<HTMLDivElement | null>(null)
  const syncLock = useRef<'editor' | 'preview' | null>(null)

  // 自动保存：内容变化后防抖
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (saveStatus !== 'dirty') return
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = setTimeout(() => {
      onSave()
    }, AUTOSAVE_DELAY)
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    }
  }, [content, saveStatus, onSave])

  const handleChange = useCallback((val: string) => {
    onContentChange(val)
  }, [onContentChange])

  // Ctrl+S 手动保存
  const saveKeymap = useMemo(() => keymap.of([{
    key: 'Mod-s',
    preventDefault: true,
    run: () => { onSave(); return true },
  }]), [onSave])

  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    saveKeymap,
    EditorView.theme({
      '&': { fontSize: '14px', height: '100%' },
      '.cm-scroller': { fontFamily: "'Cascadia Code','Fira Code','Consolas',monospace", lineHeight: '1.7' },
      '.cm-content': { padding: '16px 0' },
      '.cm-gutters': { borderRight: `1px solid ${token.colorBorderSecondary}` },
    }),
  ], [saveKeymap, token.colorBorderSecondary])

  // 行定位：滚动编辑器到指定行
  useEffect(() => {
    if (locateLine == null) return
    const view = viewRef.current
    if (view) {
      try {
        const lineCount = view.state.doc.lines
        const targetLine = Math.min(locateLine + 1, lineCount)
        const pos = view.state.doc.line(targetLine).from
        view.dispatch({
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
          selection: EditorSelection.single(pos),
        })
        view.focus()
      } catch { /* ignore */ }
    }
    onLocateHandled()
  }, [locateLine, onLocateHandled])

  // 滚动同步（split 模式）：编辑器侧通过 CodeMirror 的 scrollDOM 监听
  const syncFromEditor = useCallback(() => {
    if (mode !== 'split' || syncLock.current === 'preview') return
    syncLock.current = 'editor'
    const src = viewRef.current?.scrollDOM
    const dst = previewScrollRef.current
    if (src && dst && src.scrollHeight > src.clientHeight) {
      const ratio = src.scrollTop / (src.scrollHeight - src.clientHeight)
      dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight)
    }
    requestAnimationFrame(() => { syncLock.current = null })
  }, [mode])

  const handlePreviewScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (mode !== 'split' || syncLock.current === 'editor') return
    syncLock.current = 'preview'
    const src = e.currentTarget
    const dst = viewRef.current?.scrollDOM
    if (dst && src.scrollHeight > src.clientHeight) {
      const ratio = src.scrollTop / (src.scrollHeight - src.clientHeight)
      dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight)
    }
    requestAnimationFrame(() => { syncLock.current = null })
  }, [mode])

  const handleCreateEditor = useCallback((view: EditorView) => {
    viewRef.current = view
    view.scrollDOM.addEventListener('scroll', syncFromEditor)
  }, [syncFromEditor])

  // 模式切换或卸载时清理旧监听
  useEffect(() => {
    return () => {
      const v = viewRef.current
      if (v) {
        try {
          v.scrollDOM.removeEventListener('scroll', syncFromEditor)
        } catch { /* view 已销毁 */ }
      }
    }
  }, [syncFromEditor])

  const showEditor = mode === 'edit' || mode === 'split'
  const showPreview = mode === 'preview' || mode === 'split'

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, background: token.colorBgContainer }}>
      {showEditor && (
        <div
          style={{
            flex: mode === 'split' ? 1 : 2,
            minWidth: 0,
            overflow: 'hidden',
            borderRight: mode === 'split' ? `1px solid ${token.colorBorderSecondary}` : 'none',
            background: token.colorBgContainer,
          }}
        >
          <CodeMirror
            value={content}
            onChange={handleChange}
            theme={isDark ? 'dark' : 'light'}
            extensions={extensions}
            basicSetup={{
              lineNumbers: showLineNumbers,
              foldGutter: false,
              highlightActiveLine: true,
              highlightActiveLineGutter: showLineNumbers,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: false,
              searchKeymap: true,
            }}
            onCreateEditor={handleCreateEditor}
            style={{ height: '100%' }}
          />
        </div>
      )}
      {showPreview && (
        <NotesMarkdownPreview
          content={content}
          containerRef={previewScrollRef}
          onScroll={handlePreviewScroll}
        />
      )}
    </div>
  )
}

export const MarkdownEditor = memo(MarkdownEditorInner)
export default MarkdownEditor
