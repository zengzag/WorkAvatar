import { memo, useEffect, useMemo, useRef, useCallback } from 'react'
import { theme, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import Vditor from 'vditor'
import 'vditor/dist/index.css'
import { useAppearanceStore, getEffectiveTheme } from '../../stores/appearance.store'
import { useTranslation } from 'react-i18next'
import type { NoteEditorMode } from '../../types/notes'

interface Props {
  tabId: string
  content: string
  mode: NoteEditorMode
  saveStatus: 'saved' | 'saving' | 'dirty'
  locateText: string | null
  onContentChange: (content: string) => void
  onSave: () => void
  onLocateHandled: () => void
  onSelectionChange?: (count: number) => void
}

const AUTOSAVE_DELAY = 800
const VDITOR_CDN = import.meta.env.DEV ? '/vditor' : './vditor'

function toVditorMode(mode: NoteEditorMode): 'ir' | 'sv' {
  return mode === 'split' ? 'sv' : 'ir'
}

function cleanWordHtml(html: string): string {
  let cleaned = html
  cleaned = cleaned.replace(/<\!--\[if[\s\S]*?endif\]-->/gi, '')
  cleaned = cleaned.replace(/<\!--[\s\S]*?-->/g, '')
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, '')
  cleaned = cleaned.replace(/<xml[\s\S]*?<\/xml>/gi, '')
  cleaned = cleaned.replace(/<o:[\w]+[^>]*>[\s\S]*?<\/o:[\w]+>/gi, '')
  cleaned = cleaned.replace(/<o:[\w]+[^>]*\/>/gi, '')
  cleaned = cleaned.replace(/<w:[\w]+[^>]*>[\s\S]*?<\/w:[\w]+>/gi, '')
  cleaned = cleaned.replace(/<m:[\w]+[^>]*>[\s\S]*?<\/m:[\w]+>/gi, '')
  cleaned = cleaned.replace(/ class=(['"])(?:Mso|mso)[^'"]*\1/gi, '')
  cleaned = cleaned.replace(/\s+style=(['"])(?:mso-|font-|text-|tab-|margin|padding)[^'"]*\1/gi, '')
  cleaned = cleaned.replace(/<(\w+)(?:\s+xmlns:\w+="[^"]*")+/g, '<$1')
  cleaned = cleaned.replace(/<\/?(?:html|head|body|meta|link|title)[^>]*>/gi, '')
  return cleaned
}

function htmlToMarkdown(html: string): string {
  const cleanedHtml = cleanWordHtml(html)
  const parser = new DOMParser()
  const doc = parser.parseFromString(cleanedHtml, 'text/html')
  let result = nodeToMarkdown(doc.body)
  result = result.replace(/\n{3,}/g, '\n\n')
  result = result.replace(/^\s+|\s+$/g, '')
  return result
}

function getStyle(element: HTMLElement, prop: string): string {
  return element.style.getPropertyValue(prop) || ''
}

function isBold(element: HTMLElement): boolean {
  const tag = element.tagName.toLowerCase()
  if (tag === 'strong' || tag === 'b') return true
  const weight = getStyle(element, 'font-weight')
  return ['bold', 'bolder', '700', '800', '900'].includes(weight)
}

function isItalic(element: HTMLElement): boolean {
  const tag = element.tagName.toLowerCase()
  if (tag === 'em' || tag === 'i') return true
  const style = getStyle(element, 'font-style')
  return style === 'italic' || style === 'oblique'
}

function isStrike(element: HTMLElement): boolean {
  const tag = element.tagName.toLowerCase()
  if (tag === 's' || tag === 'strike' || tag === 'del') return true
  const decoration = getStyle(element, 'text-decoration')
  return decoration.includes('line-through')
}

function isUnderline(element: HTMLElement): boolean {
  const tag = element.tagName.toLowerCase()
  if (tag === 'u') return true
  const decoration = getStyle(element, 'text-decoration')
  return decoration.includes('underline')
}

function nodeToMarkdown(node: Node, listIndent = ''): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || ''
    return text.replace(/\s+/g, ' ')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()

  if (tag === 'script' || tag === 'style' || tag === 'xml' || tag.startsWith('o:') || tag.startsWith('w:') || tag.startsWith('m:')) {
    return ''
  }

  let children = ''
  if (tag === 'ul' || tag === 'ol') {
    const items = Array.from(el.children)
      .filter((li) => li.tagName.toLowerCase() === 'li')
      .map((li, i) => {
        const prefix = tag === 'ol' ? `${i + 1}. ` : '- '
        const content = Array.from(li.childNodes)
          .map((child) => {
            if (child.nodeType === Node.ELEMENT_NODE) {
              const childTag = (child as HTMLElement).tagName.toLowerCase()
              if (childTag === 'ul' || childTag === 'ol') {
                return '\n' + nodeToMarkdown(child, listIndent + '  ')
              }
            }
            return nodeToMarkdown(child, listIndent)
          })
          .join('')
        return `${listIndent}${prefix}${content.trim()}`
      })
      .join('\n')
    return `\n${items}\n\n`
  } else if (tag === 'li') {
    return Array.from(el.childNodes)
      .map((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const childTag = (child as HTMLElement).tagName.toLowerCase()
          if (childTag === 'ul' || childTag === 'ol') {
            return '\n' + nodeToMarkdown(child, listIndent + '  ')
          }
        }
        return nodeToMarkdown(child, listIndent)
      })
      .join('')
  } else {
    children = Array.from(el.childNodes)
      .map((child) => nodeToMarkdown(child, listIndent))
      .join('')
  }

  switch (tag) {
    case 'h1': return `\n# ${children.trim()}\n\n`
    case 'h2': return `\n## ${children.trim()}\n\n`
    case 'h3': return `\n### ${children.trim()}\n\n`
    case 'h4': return `\n#### ${children.trim()}\n\n`
    case 'h5': return `\n##### ${children.trim()}\n\n`
    case 'h6': return `\n###### ${children.trim()}\n\n`
    case 'p': {
      const align = getStyle(el, 'text-align')
      if (align === 'center') return `\n<center>${children.trim()}</center>\n\n`
      return `\n${children}\n\n`
    }
    case 'div': {
      if (children.trim().length === 0) return ''
      return `\n${children}\n\n`
    }
    case 'br':
      return '\n'
    case 'strong':
    case 'b':
      return children ? `**${children.trim()}**` : ''
    case 'em':
    case 'i':
      return children ? `*${children.trim()}*` : ''
    case 'u':
      return children ? `<u>${children}</u>` : ''
    case 's':
    case 'strike':
    case 'del':
      return children ? `~~${children.trim()}~~` : ''
    case 'a': {
      const href = el.getAttribute('href') || ''
      return href ? `[${children}](${href})` : children
    }
    case 'img': {
      const src = el.getAttribute('src') || ''
      const alt = el.getAttribute('alt') || ''
      if (!src) return ''
      return `![${alt || '图片'}](${src})\n`
    }
    case 'blockquote':
      return `\n> ${children.trim().split('\n').join('\n> ')}\n\n`
    case 'code':
      if (el.parentElement?.tagName.toLowerCase() === 'pre') {
        return children
      }
      return children ? `\`${children}\`` : ''
    case 'pre': {
      const codeEl = el.querySelector('code')
      const lang = codeEl?.className.match(/language-(\w+)/)?.[1] || ''
      const code = codeEl ? codeEl.textContent || '' : el.textContent || ''
      return `\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n\n`
    }
    case 'hr':
      return '\n---\n\n'
    case 'table': {
      return convertTableToMarkdown(el)
    }
    case 'thead':
    case 'tbody':
    case 'tfoot':
      return children
    case 'tr':
    case 'td':
    case 'th':
      return children
    case 'span':
    case 'font':
    case 'label':
    case 'sub':
    case 'sup':
    case 'mark': {
      let result = children
      if (isBold(el)) result = `**${result.trim()}**`
      if (isItalic(el)) result = `*${result.trim()}*`
      if (isStrike(el)) result = `~~${result.trim()}~~`
      if (isUnderline(el)) result = `<u>${result}</u>`
      return result
    }
    default:
      return children
  }
}

function convertTableToMarkdown(tableEl: HTMLElement): string {
  const rows: string[][] = []
  const alignments: ('left' | 'center' | 'right' | null)[] = []
  const trs = Array.from(tableEl.querySelectorAll('tr'))

  trs.forEach((tr) => {
    const cells: string[] = []
    const cellAligns: ('left' | 'center' | 'right' | null)[] = []
    tr.querySelectorAll('th, td').forEach((cell, idx) => {
      const cellEl = cell as HTMLElement
      const align = cellEl.getAttribute('align') || getStyle(cellEl, 'text-align')
      let colAlign: 'left' | 'center' | 'right' | null = null
      if (align === 'center') colAlign = 'center'
      else if (align === 'right') colAlign = 'right'
      else if (align === 'left') colAlign = 'left'

      cellAligns[idx] = colAlign
      cells.push((cell.textContent || '').trim().replace(/\|/g, '\\|').replace(/\n/g, ' '))
    })
    if (cells.length > 0) {
      rows.push(cells)
      if (rows.length === 1 || alignments.length === 0) {
        for (let i = 0; i < cells.length; i++) {
          alignments[i] = cellAligns[i] || null
        }
      }
    }
  })

  if (rows.length === 0) return ''

  const colCount = Math.max(...rows.map((r) => r.length))
  const header = rows[0]
  while (header.length < colCount) header.push('')

  const sep = Array(colCount).fill(0).map((_, i) => {
    const a = alignments[i]
    if (a === 'center') return ':---:'
    if (a === 'right') return '---:'
    return '---'
  })

  const body = rows.slice(1).map((row) => {
    while (row.length < colCount) row.push('')
    return `| ${row.join(' | ')} |`
  })

  return `\n| ${header.join(' | ')} |\n| ${sep.join(' | ')} |\n${body.join('\n')}\n\n`
}

const VditorEditorInner: React.FC<Props> = ({
  content, mode, saveStatus, locateText,
  onContentChange, onSave, onLocateHandled, onSelectionChange,
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

  const lastExternalContent = useRef(content)
  const lastInternalContent = useRef(content)
  const onContentChangeRef = useRef(onContentChange)
  const onSaveRef = useRef(onSave)
  const onSelectionChangeRef = useRef(onSelectionChange)
  useEffect(() => { onContentChangeRef.current = onContentChange }, [onContentChange])
  useEffect(() => { onSaveRef.current = onSave }, [onSave])
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange }, [onSelectionChange])

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (saveStatus !== 'dirty') return
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = setTimeout(() => onSaveRef.current(), AUTOSAVE_DELAY)
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    }
  }, [content, saveStatus])

  useEffect(() => {
    if (isReadOnly) return
    const handler = () => {
      const sel = window.getSelection()
      const text = sel?.toString() || ''
      onSelectionChangeRef.current?.(text.length)
    }
    document.addEventListener('selectionchange', handler)
    return () => document.removeEventListener('selectionchange', handler)
  }, [isReadOnly, vditorMode])

  const toolbar = useMemo(() => [
    'headings', 'bold', 'italic', 'strike', '|',
    'line', 'quote', 'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
    'code', 'inline-code', 'link', 'table',
  ], [])

  const lang = locale === 'en-US' ? 'en_US' : 'zh_CN'

  const insertTextAtCursor = useCallback((text: string) => {
    const vditor = vditorRef.current
    if (!vditor) return

    const activeEl = document.activeElement as HTMLElement | null
    const container = containerRef.current

    const irEl = container?.querySelector('.vditor-ir pre.vditor-reset') as HTMLElement | null
    const svTextarea = container?.querySelector('.vditor-sv textarea') as HTMLTextAreaElement | null

    if (svTextarea && document.activeElement === svTextarea) {
      const start = svTextarea.selectionStart
      const end = svTextarea.selectionEnd
      const value = svTextarea.value
      const newValue = value.substring(0, start) + text + value.substring(end)
      svTextarea.value = newValue
      svTextarea.selectionStart = svTextarea.selectionEnd = start + text.length
      const event = new Event('input', { bubbles: true })
      svTextarea.dispatchEvent(event)
      lastInternalContent.current = newValue
      onContentChangeRef.current(newValue)
      return
    }

    if (irEl && container?.contains(activeEl)) {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)
        if (container.contains(range.commonAncestorContainer)) {
          range.deleteContents()
          const lines = text.split('\n')
          const fragment = document.createDocumentFragment()
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) fragment.appendChild(document.createElement('br'))
            fragment.appendChild(document.createTextNode(lines[i]))
          }
          const lastNode = fragment.lastChild
          range.insertNode(fragment)
          if (lastNode) {
            range.setStartAfter(lastNode)
            range.collapse(true)
            sel.removeAllRanges()
            sel.addRange(range)
          }

          const getTextContent = (el: HTMLElement): string => {
            let result = ''
            el.childNodes.forEach((node) => {
              if (node.nodeType === Node.TEXT_NODE) {
                result += node.textContent
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                const elNode = node as HTMLElement
                const tag = elNode.tagName.toLowerCase()
                if (tag === 'br') {
                  result += '\n'
                } else if (tag === 'p' || tag === 'div') {
                  if (result && !result.endsWith('\n')) result += '\n'
                  result += getTextContent(elNode)
                  result += '\n'
                } else {
                  result += getTextContent(elNode)
                }
              }
            })
            return result
          }
          const newValue = getTextContent(irEl).replace(/\n$/, '')
          lastInternalContent.current = newValue
          onContentChangeRef.current(newValue)

          const inputEvent = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
          irEl.dispatchEvent(inputEvent)
          return
        }
      }
    }

    try {
      document.execCommand('insertText', false, text)
      const newVal = vditor.getValue()
      if (newVal) {
        lastInternalContent.current = newVal
        onContentChangeRef.current(newVal)
      }
    } catch {
      const currentVal = vditor.getValue()
      vditor.setValue(currentVal + text)
      lastInternalContent.current = currentVal + text
      onContentChangeRef.current(currentVal + text)
    }
  }, [])

  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (!vditorRef.current) return
    const cbd = e.clipboardData
    if (!cbd) return

    const imageItems = Array.from(cbd.items).filter(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    )
    if (imageItems.length > 0) {
      e.preventDefault()
      e.stopPropagation()
      for (const item of imageItems) {
        const blob = item.getAsFile()
        if (blob) {
          const reader = new FileReader()
          reader.onload = () => {
            const dataUrl = reader.result as string
            insertTextAtCursor(`![图片](${dataUrl})\n`)
          }
          reader.readAsDataURL(blob)
        }
      }
      return
    }

    const html = cbd.getData('text/html')
    const text = cbd.getData('text/plain')
    const rtf = cbd.getData('text/rtf')

    const hasWordContent = html && (
      /class=(['"])(?:Mso|mso)/i.test(html) ||
      /xmlns:o="urn:schemas-microsoft-com/i.test(html) ||
      /<meta[^>]+content=WordDocument/i.test(html) ||
      /mso-/i.test(html) ||
      (rtf && rtf.length > 0)
    )

    const hasTable = html && /<table[\s>]/i.test(html)
    const hasDataImage = html && /<img[^>]+src=["']data:image/i.test(html)

    if (hasWordContent || hasTable || hasDataImage) {
      e.preventDefault()
      e.stopPropagation()

      let md: string
      if (html && html.length > 0) {
        md = htmlToMarkdown(html)
      } else {
        md = text || ''
      }

      if (md && md.trim()) {
        insertTextAtCursor(md)
      }
      return
    }
  }, [insertTextAtCursor])

  useEffect(() => {
    if (isReadOnly || !containerRef.current) return

    const container = containerRef.current
    container.innerHTML = ''

    let vditor: Vditor | null = null
    let cancelled = false
    let rafId1: number
    let rafId2: number
    const resizeTimers: ReturnType<typeof setTimeout>[] = []

    const triggerResize = () => {
      window.dispatchEvent(new Event('resize'))
    }

    const initVditor = () => {
      if (cancelled || !container) return
      vditor = new Vditor(container, {
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
        upload: {
          url: '',
          accept: 'image/*',
          multiple: false,
          base64ToLink: (base64: string) => base64,
          handler: (files: File[]) => {
            for (const file of files) {
              const reader = new FileReader()
              reader.onload = () => {
                const dataUrl = reader.result as string
                insertTextAtCursor(`![${file.name.replace(/\.[^.]+$/, '')}](${dataUrl})\n`)
              }
              reader.readAsDataURL(file)
            }
            return null
          },
        },
        preview: {
          delay: 200,
          actions: [],
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
          if (cancelled) return
          vditor!.setTheme(isDark ? 'dark' : 'classic', isDark ? 'dark' : 'light', isDark ? 'github-dark' : 'github')
          triggerResize()
          resizeTimers.push(setTimeout(triggerResize, 50))
          resizeTimers.push(setTimeout(triggerResize, 150))

          const editorEl = container.querySelector('.vditor-ir, .vditor-sv')
          if (editorEl) {
            editorEl.addEventListener('paste', handlePaste as any, true)
          }
        },
      })
      vditorRef.current = vditor
      lastInternalContent.current = content
    }

    // 失焦时同步最新内容到 store，避免切换文件时编辑未保存
    const handleFocusOut = (e: FocusEvent) => {
      const related = e.relatedTarget as Node | null
      if (related && container.contains(related)) return
      if (!vditor) return
      try {
        const value = vditor.getValue()
        lastInternalContent.current = value
        if (value !== lastExternalContent.current) {
          onContentChangeRef.current(value)
        }
      } catch { /* ignore */ }
    }
    container.addEventListener('focusout', handleFocusOut)

    rafId1 = requestAnimationFrame(() => {
      rafId2 = requestAnimationFrame(initVditor)
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId1)
      cancelAnimationFrame(rafId2)
      resizeTimers.forEach(clearTimeout)
      container.removeEventListener('focusout', handleFocusOut)
      const editorEl = container.querySelector('.vditor-ir, .vditor-sv')
      if (editorEl) {
        editorEl.removeEventListener('paste', handlePaste as any, true)
      }
      if (vditor) {
        try { vditor.destroy() } catch { /* ignore */ }
      }
      vditorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReadOnly, vditorMode])

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

  useEffect(() => {
    if (!vditorRef.current || isReadOnly) return
    if (content === lastInternalContent.current) return
    lastExternalContent.current = content
    try {
      vditorRef.current.setValue(content, true)
      lastInternalContent.current = content
    } catch { /* ignore */ }
  }, [content, isReadOnly])

  useEffect(() => {
    if (!isReadOnly || !previewRef.current) return
    const el = previewRef.current
    Vditor.preview(el, content, {
      cdn: VDITOR_CDN,
      mode: isDark ? 'dark' : 'light',
      hljs: { lineNumber: false, style: isDark ? 'github-dark' : 'github' },
      theme: { current: isDark ? 'dark' : 'light' },
      math: { inlineDigit: true, engine: 'KaTeX' },
    }).catch(() => { /* ignore */ })
    return () => {
      el.innerHTML = ''
    }
  }, [content, isReadOnly, isDark])

  useEffect(() => {
    if (isReadOnly) return
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        e.stopPropagation()
        onSaveRef.current()
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        const vditor = vditorRef.current
        if (!vditor) return
        const editorEl = containerRef.current?.querySelector('.vditor-ir pre.vditor-reset, .vditor-sv pre.vditor-reset') as HTMLElement | null
        if (editorEl && containerRef.current?.contains(document.activeElement)) {
          e.preventDefault()
          e.stopPropagation()
          const range = document.createRange()
          range.selectNodeContents(editorEl)
          const sel = window.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(range)
        }
      }
    }
    const el = containerRef.current
    el?.addEventListener('keydown', handler, true)
    return () => { el?.removeEventListener('keydown', handler, true) }
  }, [isReadOnly, vditorMode])

  useEffect(() => {
    if (!locateText) return
    const root = isReadOnly ? previewRef.current : containerRef.current
    if (root) {
      const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6')
      let target: Element | null = null
      for (const h of Array.from(headings)) {
        if ((h.textContent || '').trim().includes(locateText)) { target = h; break }
      }
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

  const savedRangeRef = useRef<Range | null>(null)
  const handleContextMenu = useCallback(() => {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0)
      const container = containerRef.current
      if (container && container.contains(range.commonAncestorContainer)) {
        savedRangeRef.current = range.cloneRange()
      }
    }
  }, [])

  const restoreSelection = useCallback(() => {
    const sel = window.getSelection()
    if (sel && savedRangeRef.current) {
      sel.removeAllRanges()
      sel.addRange(savedRangeRef.current)
    }
    vditorRef.current?.focus()
  }, [])

  const triggerToolbarItem = useCallback((name: string) => {
    const container = containerRef.current
    if (!container) return
    restoreSelection()
    const btn = container.querySelector<HTMLElement>(`[data-type="${name}"]`)
    btn?.click()
  }, [restoreSelection])

  const triggerHeading = useCallback((tag: string) => {
    const container = containerRef.current
    if (!container) return
    restoreSelection()
    const headingsBtn = container.querySelector<HTMLElement>('[data-type="headings"]')
    const panelBtn = headingsBtn?.parentElement?.querySelector<HTMLElement>(`[data-tag="${tag}"]`)
    panelBtn?.click()
  }, [restoreSelection])

  const contextMenuItems: MenuProps['items'] = useMemo(() => [
    {
      key: 'headings', label: t('notes.ctxHeadings'), children: [
        { key: 'h1', label: 'H1', onClick: () => triggerHeading('h1') },
        { key: 'h2', label: 'H2', onClick: () => triggerHeading('h2') },
        { key: 'h3', label: 'H3', onClick: () => triggerHeading('h3') },
        { key: 'h4', label: 'H4', onClick: () => triggerHeading('h4') },
        { key: 'h5', label: 'H5', onClick: () => triggerHeading('h5') },
        { key: 'h6', label: 'H6', onClick: () => triggerHeading('h6') },
      ],
    },
    { type: 'divider' },
    {
      key: 'format', label: t('notes.ctxFormat'), children: [
        { key: 'bold', label: t('notes.ctxBold'), onClick: () => triggerToolbarItem('bold') },
        { key: 'italic', label: t('notes.ctxItalic'), onClick: () => triggerToolbarItem('italic') },
        { key: 'strike', label: t('notes.ctxStrike'), onClick: () => triggerToolbarItem('strike') },
      ],
    },
    {
      key: 'list', label: t('notes.ctxListGroup'), children: [
        { key: 'list', label: t('notes.ctxList'), onClick: () => triggerToolbarItem('list') },
        { key: 'ordered-list', label: t('notes.ctxOrderedList'), onClick: () => triggerToolbarItem('ordered-list') },
        { key: 'check', label: t('notes.ctxCheck'), onClick: () => triggerToolbarItem('check') },
        { type: 'divider' },
        { key: 'outdent', label: t('notes.ctxOutdent'), onClick: () => triggerToolbarItem('outdent') },
        { key: 'indent', label: t('notes.ctxIndent'), onClick: () => triggerToolbarItem('indent') },
      ],
    },
    {
      key: 'insert', label: t('notes.ctxInsert'), children: [
        { key: 'quote', label: t('notes.ctxQuote'), onClick: () => triggerToolbarItem('quote') },
        { key: 'line', label: t('notes.ctxLine'), onClick: () => triggerToolbarItem('line') },
        { key: 'table', label: t('notes.ctxTable'), onClick: () => triggerToolbarItem('table') },
        { type: 'divider' },
        { key: 'code', label: t('notes.ctxCode'), onClick: () => triggerToolbarItem('code') },
        { key: 'inline-code', label: t('notes.ctxInlineCode'), onClick: () => triggerToolbarItem('inline-code') },
        { key: 'link', label: t('notes.ctxLink'), onClick: () => triggerToolbarItem('link') },
      ],
    },
  ], [t, triggerToolbarItem, triggerHeading])

  const editorContent = (
    <div
      onContextMenu={handleContextMenu}
      style={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        background: token.colorBgContainer,
      }}
    >
      <div
        ref={containerRef}
        className="notes-vditor-container"
        style={{
          position: 'absolute',
          inset: 0,
          visibility: isReadOnly ? 'hidden' : 'visible',
          zIndex: isReadOnly ? 1 : 2,
        }}
      />
      <div
        ref={previewRef}
        className="vditor-reset notes-preview"
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'auto',
          padding: '32px 32px 80px',
          color: token.colorText,
          visibility: isReadOnly ? 'visible' : 'hidden',
          zIndex: isReadOnly ? 2 : 1,
        }}
      />
    </div>
  )

  if (isReadOnly) {
    return editorContent
  }

  return (
    <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
      {editorContent}
    </Dropdown>
  )
}

export const VditorEditor = memo(VditorEditorInner)
export default VditorEditor
