import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'

export interface ComposerFile {
  name: string
  path: string
}

export interface ComposerHandle {
  /** 把文件作为行内令牌插入编辑器末尾（重复路径自动忽略） */
  insertFiles: (files: ComposerFile[]) => void
  clear: () => void
  focus: () => void
  /** 触发发送（与 Enter 同一条路径） */
  submit: () => void
}

interface SecretaryComposerProps {
  placeholder: string
  onSend: (text: string, files: ComposerFile[]) => void
  onDirtyChange?: (dirty: boolean) => void
}

const TOKEN_CLASS = 'secretary-token'

/** 递归读取可编辑区文本：跳过文件令牌，<br> 记为换行，块级元素结尾补换行 */
function readText(node: Node): string {
  let out = ''
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent || ''
      return
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return
    const el = child as HTMLElement
    if (el.classList.contains(TOKEN_CLASS)) return
    if (el.tagName === 'BR') {
      out += '\n'
      return
    }
    out += readText(el)
    if (el.tagName === 'DIV' || el.tagName === 'P') out += '\n'
  })
  return out
}

/** 与主窗口编辑器一致：文件以行内令牌显示，路径参与发送 */
const SecretaryComposer = forwardRef<ComposerHandle, SecretaryComposerProps>(({
  placeholder,
  onSend,
  onDirtyChange,
}, ref) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend

  const refreshEmpty = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    const empty = el.querySelectorAll(`.${TOKEN_CLASS}`).length === 0
      && (el.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().length === 0
    el.dataset.empty = empty ? 'true' : 'false'
    onDirtyChange?.(!empty)
  }, [onDirtyChange])

  const readContent = useCallback(() => {
    const el = editorRef.current
    if (!el) return { text: '', files: [] as ComposerFile[] }
    const files = Array.from(el.querySelectorAll<HTMLElement>(`.${TOKEN_CLASS}`))
      .map((node) => ({ name: node.dataset.name || '', path: node.dataset.path || '' }))
      .filter((f) => !!f.path)
    const text = readText(el).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\n{3,}/g, '\n\n').trim()
    return { text, files }
  }, [])

  const createToken = useCallback((file: ComposerFile) => {
    const el = document.createElement('span')
    el.className = TOKEN_CLASS
    el.contentEditable = 'false'
    el.dataset.name = file.name
    el.dataset.path = file.path
    el.title = file.path

    const label = document.createElement('span')
    label.className = 'secretary-token-name'
    label.textContent = file.name

    const remove = document.createElement('span')
    remove.className = 'secretary-token-x'
    remove.innerHTML = '<svg viewBox="0 0 20 20" width="10" height="10"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>'
    remove.addEventListener('mousedown', (e) => e.preventDefault())
    remove.addEventListener('click', (e) => {
      e.stopPropagation()
      el.remove()
      refreshEmpty()
    })

    el.appendChild(label)
    el.appendChild(remove)
    return el
  }, [refreshEmpty])

  const focusToEnd = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [])

  const doSend = useCallback(() => {
    const { text, files } = readContent()
    if (!text && files.length === 0) return
    onSendRef.current(text, files)
  }, [readContent])

  const insertFiles = useCallback((files: ComposerFile[]) => {
    const el = editorRef.current
    if (!el) return
    const existing = new Set(
      Array.from(el.querySelectorAll<HTMLElement>(`.${TOKEN_CLASS}`)).map((n) => n.dataset.path || ''),
    )
    let added = false
    for (const file of files) {
      if (!file.path || existing.has(file.path)) continue
      existing.add(file.path)
      el.appendChild(createToken(file))
      el.appendChild(document.createTextNode('\u00A0'))
      added = true
    }
    if (added) {
      refreshEmpty()
      focusToEnd()
    }
  }, [createToken, focusToEnd, refreshEmpty])

  useImperativeHandle(ref, () => ({
    insertFiles,
    clear: () => {
      const el = editorRef.current
      if (!el) return
      el.innerHTML = ''
      refreshEmpty()
    },
    focus: focusToEnd,
    submit: doSend,
  }), [insertFiles, doSend, focusToEnd, refreshEmpty])

  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    const onInput = () => refreshEmpty()
    el.addEventListener('input', onInput)
    return () => el.removeEventListener('input', onInput)
  }, [refreshEmpty])

  useEffect(() => { refreshEmpty() }, [refreshEmpty])

  return (
    <div
      ref={editorRef}
      className="secretary-editor"
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      data-empty="true"
      role="textbox"
      aria-multiline="true"
      onPaste={(e) => {
        // 剪贴板里带真实文件路径（从系统文件管理器复制）时，按文件令牌插入
        const pastedFiles = Array.from(e.clipboardData?.files || [])
          .map((file) => {
            let path = ''
            try { path = window.electronAPI?.getPathForFile?.(file) || '' } catch { /* ignore */ }
            return { path, name: file.name }
          })
          .filter((file) => !!file.path)
        if (pastedFiles.length > 0) {
          e.preventDefault()
          insertFiles(pastedFiles)
          return
        }
        // 其余情况统一转纯文本，避免把外部 HTML/样式带进编辑器
        e.preventDefault()
        const text = e.clipboardData.getData('text/plain')
        if (text) document.execCommand('insertText', false, text)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          doSend()
        }
      }}
    />
  )
})

SecretaryComposer.displayName = 'SecretaryComposer'

export default SecretaryComposer
