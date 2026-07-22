import { memo, useEffect, useMemo, useRef } from 'react'
import { theme } from 'antd'
import Vditor from 'vditor'
import 'vditor/dist/index.css'
import { useAppearanceStore, getEffectiveTheme } from '../../stores/appearance.store'
import { useTranslation } from 'react-i18next'
import type { NoteEditorMode } from '../../types/notes'

interface Props {
  content: string
  mode: NoteEditorMode
  saveStatus: 'saved' | 'saving' | 'dirty'
  /** 待定位的文本片段（来自大纲点击或搜索命中），处理后回调清除 */
  locateText: string | null
  onContentChange: (content: string) => void
  onSave: () => void
  onLocateHandled: () => void
}

const AUTOSAVE_DELAY = 800
// dev：Vite 中间件在 http(s)://host/vditor 服务 node_modules/vditor
// prod：Electron 用 file:// 加载 dist/index.html，必须用相对路径才能解析到 dist/vditor/dist/...
const VDITOR_CDN = import.meta.env.DEV ? '/vditor' : './vditor'

/** 把外部 NoteEditorMode 映射到 Vditor 编辑模式；preview 走只读分支 */
function toVditorMode(mode: NoteEditorMode): 'ir' | 'sv' {
  // 'edit' → ir 即时渲染（Obsidian Live Preview 风格）
  // 'split' → sv 分屏预览
  return mode === 'split' ? 'sv' : 'ir'
}

const VditorEditorInner: React.FC<Props> = ({
  content, mode, saveStatus, locateText,
  onContentChange, onSave, onLocateHandled,
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const locale = useAppearanceStore((s) => s.locale)
  const effectiveTheme = getEffectiveTheme(themeMode)
  const isDark = effectiveTheme === 'dark'

  const containerRef = useRef<HTMLDivElement | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const vditorRef = useRef<Vditor | null>(null)
  const isReadOnly = mode === 'preview'
  const vditorMode = toVditorMode(mode)

  // 外部最新值缓存，避免 Vditor input 回调触发 setValue 死循环
  const lastExternalContent = useRef(content)
  // 内部最新值缓存，用于判断是否需要 setValue 同步外部变更
  const lastInternalContent = useRef(content)
  // 回调稳定引用，避免 Vditor 初始化后回调变更导致重复创建
  const onContentChangeRef = useRef(onContentChange)
  const onSaveRef = useRef(onSave)
  useEffect(() => { onContentChangeRef.current = onContentChange }, [onContentChange])
  useEffect(() => { onSaveRef.current = onSave }, [onSave])

  // 自动保存防抖
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (saveStatus !== 'dirty') return
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = setTimeout(() => onSaveRef.current(), AUTOSAVE_DELAY)
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    }
  }, [content, saveStatus])

  // Vditor 工具栏：精简专业，覆盖常用 Markdown 操作
  const toolbar = useMemo(() => [
    'headings', 'bold', 'italic', 'strike', '|',
    'line', 'quote', 'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
    'code', 'inline-code', 'link', 'table', '|',
    'undo', 'redo', '|',
    'edit-mode', 'fullscreen', 'preview',
  ], [])

  const lang = locale === 'en-US' ? 'en_US' : 'zh_CN'

  // 初始化 Vditor 实例（只在非只读模式下创建）
  // 依赖 vditorMode：ir ↔ sv 切换时重建实例，保证模式切换的可靠性
  useEffect(() => {
    if (isReadOnly || !containerRef.current) return

    const vditor = new Vditor(containerRef.current, {
      value: content,
      mode: vditorMode,
      theme: isDark ? 'dark' : 'classic',
      icon: 'ant',
      lang,
      cdn: VDITOR_CDN,
      toolbar,
      height: '100%',
      minHeight: 200,
      placeholder: t('notes.placeholder'),
      cache: { enable: false },
      counter: { enable: false },
      toolbarConfig: { pin: true },
      preview: {
        delay: 200,
        hljs: { lineNumber: false, style: isDark ? 'github-dark' : 'github' },
        theme: { current: isDark ? 'dark' : 'light' },
        math: { inlineDigit: true, engine: 'KaTeX' },
      },
      outline: { enable: false, position: 'right' },
      hint: { delay: 200 },
      input: (value: string) => {
        lastInternalContent.current = value
        if (value !== lastExternalContent.current) {
          onContentChangeRef.current(value)
        }
      },
      after: () => {
        vditor.setTheme(isDark ? 'dark' : 'classic', isDark ? 'dark' : 'light', isDark ? 'github-dark' : 'github')
      },
    })
    vditorRef.current = vditor
    lastInternalContent.current = content

    return () => {
      try { vditor.destroy() } catch { /* ignore */ }
      vditorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReadOnly, vditorMode])

  // 主题切换
  useEffect(() => {
    if (!vditorRef.current) return
    try {
      vditorRef.current.setTheme(
        isDark ? 'dark' : 'classic',
        isDark ? 'dark' : 'light',
        isDark ? 'github-dark' : 'github',
      )
    } catch { /* ignore */ }
  }, [isDark])

  // 外部内容变更同步到 Vditor（切换文件、外部 watcher 重载等）
  useEffect(() => {
    if (!vditorRef.current || isReadOnly) return
    if (content === lastInternalContent.current) return
    lastExternalContent.current = content
    try {
      vditorRef.current.setValue(content, true)
      lastInternalContent.current = content
    } catch { /* ignore */ }
  }, [content, isReadOnly])

  // 只读模式：用 Vditor.preview 静态渲染
  useEffect(() => {
    if (!isReadOnly || !previewRef.current) return
    Vditor.preview(previewRef.current, content, {
      cdn: VDITOR_CDN,
      mode: isDark ? 'dark' : 'light',
      hljs: { lineNumber: false, style: isDark ? 'github-dark' : 'github' },
      theme: { current: isDark ? 'dark' : 'light' },
      math: { inlineDigit: true, engine: 'KaTeX' },
    }).catch(() => { /* ignore */ })
  }, [content, isReadOnly, isDark])

  // Ctrl/Cmd+S 手动保存（捕获阶段拦截，避免被 Vditor 内部处理）
  useEffect(() => {
    if (isReadOnly) return
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        e.stopPropagation()
        onSaveRef.current()
      }
    }
    const el = containerRef.current
    el?.addEventListener('keydown', handler, true)
    return () => { el?.removeEventListener('keydown', handler, true) }
  }, [isReadOnly, vditorMode])

  // 大纲/搜索跳转：在编辑器 DOM 中找到对应文本并滚动
  useEffect(() => {
    if (!locateText) return
    const root = isReadOnly ? previewRef.current : containerRef.current
    if (root) {
      // 优先匹配标题元素
      const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6')
      let target: Element | null = null
      for (const h of Array.from(headings)) {
        if ((h.textContent || '').trim().includes(locateText)) { target = h; break }
      }
      // 退化为全文匹配（IR 模式下的段落、SV 模式下的代码行）
      if (!target) {
        const all = root.querySelectorAll('p, li, td, th, pre, span, div')
        for (const el of Array.from(all)) {
          if ((el.textContent || '').trim().includes(locateText)) { target = el; break }
        }
      }
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    onLocateHandled()
  }, [locateText, isReadOnly, vditorMode, onLocateHandled])

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgContainer,
      }}
    >
      {isReadOnly ? (
        <div
          ref={previewRef}
          className="vditor-reset notes-preview"
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '16px 32px 80px',
            fontSize: 15,
            lineHeight: 1.7,
            color: token.colorText,
            background: token.colorBgContainer,
          }}
        />
      ) : (
        <div
          ref={containerRef}
          style={{ flex: 1, minHeight: 0 }}
          className="notes-vditor-container"
        />
      )}
    </div>
  )
}

export const VditorEditor = memo(VditorEditorInner)
export default VditorEditor
