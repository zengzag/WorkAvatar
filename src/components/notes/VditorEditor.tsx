import { memo, useEffect, useMemo, useRef, useCallback, useState } from 'react'
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

// 表格区域选择辅助：计算矩形范围内所有单元格
function computeTableCells(start: HTMLTableCellElement, end: HTMLTableCellElement): HTMLTableCellElement[] {
  const table = start.closest('table')
  if (!table || !table.contains(end)) return [start]
  const rows = Array.from(table.querySelectorAll('tr'))
  const startRow = start.closest('tr')
  const endRow = end.closest('tr')
  if (!startRow || !endRow) return [start]
  const startRowIndex = rows.indexOf(startRow)
  const endRowIndex = rows.indexOf(endRow)
  if (startRowIndex < 0 || endRowIndex < 0) return [start]
  const minRow = Math.min(startRowIndex, endRowIndex)
  const maxRow = Math.max(startRowIndex, endRowIndex)
  const minCol = Math.min(start.cellIndex, end.cellIndex)
  const maxCol = Math.max(start.cellIndex, end.cellIndex)
  const cells: HTMLTableCellElement[] = []
  for (let r = minRow; r <= maxRow; r++) {
    const row = rows[r]
    if (!row) continue
    const rowCells = Array.from(row.querySelectorAll('td, th'))
    for (let c = minCol; c <= maxCol; c++) {
      const cell = rowCells[c] as HTMLTableCellElement | undefined
      if (cell) cells.push(cell)
    }
  }
  return cells
}

// 表格区域选择辅助：将矩形区域转为 TSV（可粘贴到 Excel）
function tableCellsToTSV(start: HTMLTableCellElement, end: HTMLTableCellElement): string {
  const table = start.closest('table')
  if (!table || !table.contains(end)) return (start.textContent || '').trim()
  const rows = Array.from(table.querySelectorAll('tr'))
  const startRow = start.closest('tr')!
  const endRow = end.closest('tr')!
  const startRowIndex = rows.indexOf(startRow)
  const endRowIndex = rows.indexOf(endRow)
  const minRow = Math.min(startRowIndex, endRowIndex)
  const maxRow = Math.max(startRowIndex, endRowIndex)
  const minCol = Math.min(start.cellIndex, end.cellIndex)
  const maxCol = Math.max(start.cellIndex, end.cellIndex)
  const lines: string[] = []
  for (let r = minRow; r <= maxRow; r++) {
    const row = rows[r]
    if (!row) continue
    const rowCells = Array.from(row.querySelectorAll('td, th'))
    const parts: string[] = []
    for (let c = minCol; c <= maxCol; c++) {
      const cell = rowCells[c] as HTMLTableCellElement | undefined
      parts.push(cell ? (cell.textContent || '').replace(/\t/g, ' ').replace(/\n/g, ' ').trim() : '')
    }
    lines.push(parts.join('\t'))
  }
  return lines.join('\n')
}

// 解析 TSV 为二维数组（去掉 Excel 尾随空行）
function parseTSV(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines.map(line => line.split('\t'))
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

  // 表格矩形选区状态：拖动 td/th 生成，仅在 IR 模式生效
  const tableSelRef = useRef<{ start: HTMLTableCellElement; end: HTMLTableCellElement } | null>(null)
  // 右键命中的表格单元格，用于行/列操作
  const [tableCell, setTableCell] = useState<HTMLTableCellElement | null>(null)

  const clearTableSelection = useCallback(() => {
    // 编辑器容器与预览容器都可能存在选中单元格，需同时清理
    ;[containerRef.current, previewRef.current].forEach((c) => {
      if (!c) return
      c.querySelectorAll('.vditor-table-selected').forEach((el) => {
        el.classList.remove('vditor-table-selected')
      })
    })
    tableSelRef.current = null
  }, [])

  const updateTableHighlight = useCallback((start: HTMLTableCellElement, end: HTMLTableCellElement) => {
    ;[containerRef.current, previewRef.current].forEach((c) => {
      if (!c) return
      c.querySelectorAll('.vditor-table-selected').forEach((el) => {
        el.classList.remove('vditor-table-selected')
      })
    })
    const cells = computeTableCells(start, end)
    cells.forEach((cell) => cell.classList.add('vditor-table-selected'))
  }, [])

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

  // 表格矩形选区：在 td/th 上按下并拖动超过阈值进入选区模式，
  // 单击不触发（编辑模式保留 Vditor 原生光标编辑，预览模式不干扰文本选择）。
  // 编辑模式（IR）与预览模式均生效。根容器随模式切换：IR→编辑器，预览→预览容器。
  useEffect(() => {
    if (vditorMode === 'sv') return // SV 源码模式不生效
    const root = isReadOnly ? previewRef.current : containerRef.current
    if (!root) return

    let dragStarted = false
    let startCell: HTMLTableCellElement | null = null
    let startX = 0
    let startY = 0

    const onMouseMove = (me: MouseEvent) => {
      if (!startCell) return
      const dx = Math.abs(me.clientX - startX)
      const dy = Math.abs(me.clientY - startY)
      if (!dragStarted && (dx > 4 || dy > 4)) {
        dragStarted = true
        const sel = window.getSelection()
        sel?.removeAllRanges()
        const table = startCell.closest('table')
        if (table) table.style.userSelect = 'none'
      }
      if (dragStarted) {
        me.preventDefault()
        const elem = document.elementFromPoint(me.clientX, me.clientY) as HTMLElement | null
        const newEnd = elem?.closest('td, th') as HTMLTableCellElement | null
        if (newEnd && root.contains(newEnd) && startCell.closest('table') === newEnd.closest('table')) {
          updateTableHighlight(startCell, newEnd)
          tableSelRef.current = { start: startCell, end: newEnd }
        }
      }
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      if (startCell) {
        const table = startCell.closest('table')
        if (table) table.style.userSelect = ''
      }
      if (dragStarted) {
        // 拖拽选区后恢复编辑器焦点与一个折叠光标位，保证后续 Ctrl+C/V 落在编辑器上，
        // 也避免 Vditor 自身 paste 处理器因 selection 为空而抛 getRangeAt 错误。
        const editorEl = containerRef.current?.querySelector('.vditor-ir pre.vditor-reset') as HTMLElement | null
        if (editorEl && startCell) {
          editorEl.focus()
          const range = document.createRange()
          range.setStart(startCell, 0)
          range.collapse(true)
          const sel = window.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(range)
        }
      } else {
        // 单击未拖动：清除选区
        clearTableSelection()
      }
      startCell = null
      dragStarted = false
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      const cell = target.closest('td, th') as HTMLTableCellElement | null
      if (!cell || !root.contains(cell) || !cell.closest('table')) {
        clearTableSelection()
        return
      }
      startCell = cell
      startX = e.clientX
      startY = e.clientY
      dragStarted = false
      tableSelRef.current = { start: cell, end: cell }
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    }

    root.addEventListener('mousedown', onMouseDown, true)
    return () => {
      root.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [isReadOnly, vditorMode, clearTableSelection, updateTableHighlight])

  // 表格选区复制：通过隐藏 textarea + execCommand 主动写入剪贴板。
  // 拖拽选区会清空文本选区，浏览器默认 copy 事件不会触发，故用 keydown 拦截。
  const copyTableSelectionToClipboard = useCallback(() => {
    const sel = tableSelRef.current
    if (!sel) return false
    const tsv = tableCellsToTSV(sel.start, sel.end)
    if (!tsv) return false
    const activeEl = document.activeElement as HTMLElement | null
    const textarea = document.createElement('textarea')
    textarea.value = tsv
    textarea.style.position = 'fixed'
    textarea.style.top = '-9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { /* ignore */ }
    document.body.removeChild(textarea)
    if (activeEl && typeof activeEl.focus === 'function') {
      activeEl.focus()
    }
    return ok
  }, [])

  // 表格行/列操作：基于右键命中的单元格生成操作上下文，
  // 若存在同表矩形选区则作用于整个选中区域。
  const getTableOpContext = useCallback(() => {
    const cell = tableCell
    if (!cell || !cell.isConnected) return null
    const table = cell.closest('table')!
    const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr'))
    let startCell = cell
    let endCell = cell
    const sel = tableSelRef.current
    if (sel && sel.start.closest('table') === table) {
      startCell = sel.start
      endCell = sel.end
    }
    const startRowIdx = rows.indexOf(startCell.closest('tr')!)
    const endRowIdx = rows.indexOf(endCell.closest('tr')!)
    if (startRowIdx < 0 || endRowIdx < 0) return null
    return {
      table,
      rows,
      minRow: Math.min(startRowIdx, endRowIdx),
      maxRow: Math.max(startRowIdx, endRowIdx),
      minCol: Math.min(startCell.cellIndex, endCell.cellIndex),
      maxCol: Math.max(startCell.cellIndex, endCell.cellIndex),
    }
  }, [tableCell])

  // 表格 DOM 变更后同步到 Vditor 内容与 store
  const commitTableChange = useCallback((table: HTMLTableElement) => {
    table.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }))
    clearTableSelection()
    setTableCell(null)
    try {
      const value = vditorRef.current?.getValue() || ''
      lastInternalContent.current = value
      if (value !== lastExternalContent.current) {
        onContentChangeRef.current(value)
      }
    } catch { /* ignore */ }
  }, [clearTableSelection])

  const insertRow = useCallback((where: 'above' | 'below') => {
    const ctx = getTableOpContext()
    if (!ctx) return
    const src = where === 'above' ? ctx.rows[ctx.minRow] : ctx.rows[ctx.maxRow]
    if (!src) return
    const newTr = src.cloneNode(true) as HTMLTableRowElement
    newTr.querySelectorAll('td, th').forEach((c) => { c.textContent = '' })
    if (where === 'above') {
      src.before(newTr)
    } else {
      src.after(newTr)
    }
    commitTableChange(ctx.table)
  }, [getTableOpContext, commitTableChange])

  const insertColumn = useCallback((where: 'left' | 'right') => {
    const ctx = getTableOpContext()
    if (!ctx) return
    const colIndex = where === 'left' ? ctx.minCol : ctx.maxCol
    ctx.rows.forEach((tr) => {
      const refCell = tr.cells[colIndex]
      if (!refCell) return
      const newCell = document.createElement(refCell.tagName)
      if (where === 'left') {
        refCell.before(newCell)
      } else {
        refCell.after(newCell)
      }
    })
    commitTableChange(ctx.table)
  }, [getTableOpContext, commitTableChange])

  const deleteRow = useCallback(() => {
    const ctx = getTableOpContext()
    if (!ctx) return
    for (let r = ctx.maxRow; r >= ctx.minRow; r--) {
      ctx.rows[r]?.remove()
    }
    if (ctx.table.querySelectorAll('tr').length === 0) ctx.table.remove()
    commitTableChange(ctx.table)
  }, [getTableOpContext, commitTableChange])

  const deleteColumn = useCallback(() => {
    const ctx = getTableOpContext()
    if (!ctx) return
    ctx.rows.forEach((tr) => {
      for (let c = ctx.maxCol; c >= ctx.minCol; c--) {
        tr.cells[c]?.remove()
      }
    })
    if (ctx.table.querySelectorAll('tr').length === 0) ctx.table.remove()
    commitTableChange(ctx.table)
  }, [getTableOpContext, commitTableChange])

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

  // 表格选区内粘贴：将剪贴板 TSV 填充到选区起始位置（Excel 风格"贴入"）。
  // 返回是否已处理，供 document 级 paste 拦截（拖拽选区后编辑器失焦，需全局兜底）。
  const pasteTableSelection = useCallback((e: ClipboardEvent): boolean => {
    const tableSel = tableSelRef.current
    if (!tableSel) return false
    const cbd = e.clipboardData
    if (!cbd) return false
    const text = cbd.getData('text/plain') || ''
    if (!text) return false
    const tsvRows = parseTSV(text)
    const table = tableSel.start.closest('table')
    if (!table) return false
    const rows = Array.from(table.querySelectorAll('tr'))
    const startRow = tableSel.start.closest('tr')!
    const startRowIndex = rows.indexOf(startRow)
    const startCol = tableSel.start.cellIndex
    let endRowIdx = startRowIndex
    let endColIdx = startCol
    for (let r = 0; r < tsvRows.length; r++) {
      // 行数不足时自动插入新行（Excel 风格"贴入"）
      let rowIndex = startRowIndex + r
      if (rowIndex >= rows.length) {
        const template = rows[rows.length - 1]
        if (!template) break
        const newTr = template.cloneNode(true) as HTMLTableRowElement
        newTr.querySelectorAll('td, th').forEach((c) => { c.textContent = '' })
        table.appendChild(newTr)
        rows.push(newTr)
        rowIndex = rows.length - 1
      }
      const rowCells = Array.from(rows[rowIndex].querySelectorAll<HTMLTableCellElement>('td, th'))
      for (let c = 0; c < tsvRows[r].length; c++) {
        const colIndex = startCol + c
        // 列数不足时自动追加单元格
        let cell = rowCells[colIndex]
        if (!cell) {
          cell = document.createElement((rows[rowIndex] as HTMLTableRowElement).cells[0]?.tagName || 'td') as HTMLTableCellElement
          rows[rowIndex].appendChild(cell)
          rowCells.push(cell)
        }
        cell.textContent = tsvRows[r][c]
        endRowIdx = rowIndex
        endColIdx = Math.max(endColIdx, colIndex)
      }
    }
    table.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }))
    // 更新选区为粘贴范围
    const newEndRow = rows[endRowIdx]
    const newEndCells = Array.from(newEndRow.querySelectorAll('td, th'))
    const newEnd = newEndCells[endColIdx] as HTMLTableCellElement | undefined
    if (newEnd) {
      updateTableHighlight(tableSel.start, newEnd)
      tableSelRef.current = { start: tableSel.start, end: newEnd }
    }
    // 同步内容到 store
    try {
      const value = vditorRef.current?.getValue() || ''
      lastInternalContent.current = value
      if (value !== lastExternalContent.current) {
        onContentChangeRef.current(value)
      }
    } catch { /* ignore */ }
    return true
  }, [updateTableHighlight])

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
          // 保存图片到 vault/attachments，避免 data URL 导致文件体积膨胀
          blob.arrayBuffer().then(async (arrayBuffer) => {
            try {
              const res = await window.electronAPI.notes.saveImage({
                buffer: arrayBuffer,
                fileName: blob.name || 'pasted-image.png',
              })
              if (res && (res as any).error) {
                console.error('Save image failed:', (res as any).error)
                return
              }
              const relPath = (res as any)?.relPath as string
              if (relPath) {
                insertTextAtCursor(`![${blob.name?.replace(/\.[^.]+$/, '') || '图片'}](${relPath})\n`)
              }
            } catch (err) {
              console.error('Save image error:', err)
            }
          })
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

  // 表格选区粘贴：拖拽选区后编辑器失焦，编辑器级 paste 监听收不到事件，
  // 用 document 级 capture 拦截兜底；命中表格选区贴入则阻止默认行为。
  useEffect(() => {
    if (isReadOnly || vditorMode === 'sv') return
    const handler = (e: ClipboardEvent) => {
      if (pasteTableSelection(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('paste', handler, true)
    return () => document.removeEventListener('paste', handler, true)
  }, [isReadOnly, vditorMode, pasteTableSelection])

  // 表格选区复制兜底：拖拽选区后若焦点未完全恢复，container 级 keydown 可能收不到，
  // 用 document 级 capture 拦截 Ctrl/Cmd+C，命中表格选区则主动写入 TSV。
  useEffect(() => {
    if (isReadOnly || vditorMode === 'sv') return
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        if (copyTableSelectionToClipboard()) {
          e.preventDefault()
          e.stopPropagation()
        }
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [isReadOnly, vditorMode, copyTableSelectionToClipboard])

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
              file.arrayBuffer().then(async (arrayBuffer) => {
                try {
                  const res = await window.electronAPI.notes.saveImage({
                    buffer: arrayBuffer,
                    fileName: file.name || 'upload-image.png',
                  })
                  if (res && (res as any).error) {
                    console.error('Save image failed:', (res as any).error)
                    return
                  }
                  const relPath = (res as any)?.relPath as string
                  if (relPath) {
                    insertTextAtCursor(`![${file.name.replace(/\.[^.]+$/, '')}](${relPath})\n`)
                  }
                } catch (err) {
                  console.error('Save image error:', err)
                }
              })
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
      // 表格选区清空：Delete/Backspace 清空选中单元格内容（仅多格选区）
      if ((e.key === 'Delete' || e.key === 'Backspace') && vditorMode === 'ir') {
        const sel = tableSelRef.current
        if (sel && sel.start !== sel.end) {
          e.preventDefault()
          e.stopPropagation()
          const cells = computeTableCells(sel.start, sel.end)
          cells.forEach((cell) => { cell.textContent = '' })
          const table = sel.start.closest('table')
          if (table) {
            table.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }))
          }
          clearTableSelection()
          try {
            const value = vditorRef.current?.getValue() || ''
            lastInternalContent.current = value
            if (value !== lastExternalContent.current) {
              onContentChangeRef.current(value)
            }
          } catch { /* ignore */ }
        }
      }
      // 表格选区复制：Ctrl/Cmd+C 主动写入 TSV 到剪贴板（仅 IR 编辑模式）
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && vditorMode === 'ir') {
        if (copyTableSelectionToClipboard()) {
          e.preventDefault()
          e.stopPropagation()
        }
      }
    }
    const el = containerRef.current
    el?.addEventListener('keydown', handler, true)
    return () => { el?.removeEventListener('keydown', handler, true) }
  }, [isReadOnly, vditorMode, clearTableSelection, copyTableSelectionToClipboard])

  // 预览模式表格选区复制：预览容器非可编辑元素无 keydown 焦点，
  // 用 document 级别 keydown 监听 Ctrl/Cmd+C，通过 execCommand 主动写入剪贴板。
  useEffect(() => {
    if (!isReadOnly || vditorMode === 'sv') return
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        if (copyTableSelectionToClipboard()) {
          e.preventDefault()
          e.stopPropagation()
        }
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [isReadOnly, vditorMode, copyTableSelectionToClipboard])

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
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const cell = target.closest('td, th') as HTMLTableCellElement | null
    setTableCell(cell && cell.closest('table') ? cell : null)
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

  const contextMenuItems: MenuProps['items'] = useMemo(() => {
    const tableSection: MenuProps['items'] = tableCell
      ? [
        { type: 'divider' },
        {
          key: 'table-ops', label: t('notes.ctxTableOps'), children: [
            { key: 'row-above', label: t('notes.ctxRowAbove'), onClick: () => insertRow('above') },
            { key: 'row-below', label: t('notes.ctxRowBelow'), onClick: () => insertRow('below') },
            { key: 'col-left', label: t('notes.ctxColLeft'), onClick: () => insertColumn('left') },
            { key: 'col-right', label: t('notes.ctxColRight'), onClick: () => insertColumn('right') },
            { type: 'divider' },
            { key: 'del-row', label: t('notes.ctxDelRow'), onClick: () => deleteRow() },
            { key: 'del-col', label: t('notes.ctxDelCol'), onClick: () => deleteColumn() },
          ],
        },
      ]
      : []
    const items: MenuProps['items'] = [
      ...tableSection,
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
    ]
    return items
  }, [t, triggerToolbarItem, triggerHeading, tableCell, insertRow, insertColumn, deleteRow, deleteColumn])

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
