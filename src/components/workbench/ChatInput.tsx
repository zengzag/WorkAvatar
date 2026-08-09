import { Input, Button, theme, Dropdown, Typography, Popover, Tag, Checkbox, Tooltip } from 'antd'
import { SendOutlined, StopOutlined, ThunderboltOutlined, PaperClipOutlined, CloseOutlined, SwapOutlined, CheckOutlined, RobotOutlined, SearchOutlined, DatabaseOutlined, CompressOutlined, FileTextOutlined, UnlockOutlined, DownOutlined, UnorderedListOutlined, BulbOutlined, BulbFilled, LoadingOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useMemo, useRef, useCallback, useState, useEffect, memo } from 'react'
import { getProviderModels, DOMESTIC_PROVIDERS, LOCAL_PROVIDERS } from '../../utils/llm'
import { isColorDark } from '../../utils/format'
import type { Employee } from '../../types'

const { Text } = Typography

/** 模型选择的最大数量（对比模式上限） */
const MAX_SELECTED_MODELS = 3

export interface AttachedImage {
  id: string
  dataUrl: string
  name: string
}

export interface ModelSelection {
  providerId: string
  modelId: string
}

export interface SendOptions {
  highPermission?: boolean
}

// 已启用的 skill 简要信息，用于斜杠菜单触发
export interface AvailableSkill {
  id: string
  name: string
  description: string
  userInvocable: boolean
}

/** 文件令牌在 HTML 中的标记类名 */
const FILE_TOKEN_CLASS = 'chat-input-file-token'

/** 从 File 对象生成唯一 id */
const genFileId = () => `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

/**
 * 将包含文件令牌的编辑器内容，转换为最终发送给 LLM 的纯文本（文件令牌替换为绝对路径）
 *
 * 采用递归 DFS：
 *   - 遇到 FILE_TOKEN_CLASS 元素：追加 data-path（不进入 childNodes，避免把关闭按钮"×"写入）
 *   - 遇到 <br>：追加 '\n'
 *   - 遇到文本节点：追加 nodeValue
 *   - 其他元素：继续深入 childNodes
 */
const extractContentFromEditor = (editor: HTMLElement): string => {
  let result = ''
  const walk = (nodes: NodeListOf<ChildNode> | ArrayLike<ChildNode>) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.nodeValue || ''
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement
        if (el.classList?.contains(FILE_TOKEN_CLASS)) {
          const path = el.getAttribute('data-path') || ''
          if (path) result += path
          // 跳过子节点（图标、文件名、×按钮等内容不参与 prompt 拼接）
          continue
        }
        if (el.tagName === 'BR') {
          result += '\n'
          continue
        }
        if (el.tagName === 'DIV' || el.tagName === 'P') {
          if (result && !result.endsWith('\n')) result += '\n'
        }
        walk(el.childNodes)
      }
    }
  }
  walk(editor.childNodes)
  return result
}

/**
 * 从编辑器 HTML 中获取"草稿值"——用于持久化（文本 + 文件令牌占位符序列化）
 * 文件令牌用 [[file:id|name|path]] 表示，其余保留纯文本；草稿存为简单字符串，恢复时再解析重建。
 *
 * 同样递归 DFS，遇到令牌时绝不进入子节点（避免把 "×" 写进草稿字符串）。
 */
const serializeEditorDraft = (editor: HTMLElement): string => {
  let result = ''
  const walk = (nodes: NodeListOf<ChildNode> | ArrayLike<ChildNode>) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.nodeValue || ''
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement
        if (el.classList?.contains(FILE_TOKEN_CLASS)) {
          const id = el.getAttribute('data-id') || ''
          const name = el.getAttribute('data-name') || ''
          const path = el.getAttribute('data-path') || ''
          result += `[[file:${id}|${name}|${path}]]`
          continue
        }
        if (el.tagName === 'BR') {
          result += '\n'
          continue
        }
        if (el.tagName === 'DIV' || el.tagName === 'P') {
          if (result && !result.endsWith('\n')) result += '\n'
        }
        walk(el.childNodes)
      }
    }
  }
  walk(editor.childNodes)
  return result
}

/**
 * 解析草稿字符串，将 [[file:id|name|path]] 占位符恢复为文件令牌节点
 */
const deserializeDraftToEditor = (editor: HTMLElement, draft: string, token: any, removeFileById: (id: string) => void) => {
  editor.innerHTML = ''
  const regex = /\[\[file:([^|]*)\|([^|]*)\|([^\]]*)\]\]/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  const insertTextNode = (text: string) => {
    if (!text) return
    // 把 \n 转换为 <br>
    const parts = text.split('\n')
    parts.forEach((part, i) => {
      if (part) editor.appendChild(document.createTextNode(part))
      if (i < parts.length - 1) editor.appendChild(document.createElement('br'))
    })
  }

  while ((match = regex.exec(draft))) {
    insertTextNode(draft.slice(lastIndex, match.index))
    lastIndex = regex.lastIndex

    const [, id, name, path] = match
    const tokenEl = createFileTokenElement(id, name, path, token, removeFileById)
    editor.appendChild(tokenEl)
  }
  insertTextNode(draft.slice(lastIndex))
}

/**
 * 选中编辑器中开头第一个斜杠命令 /xxx 的范围（跳过文件令牌内部文本节点，
 * 避免误选文件名中的 /）。返回是否成功选中。
 */
const selectSlashCommandRange = (editor: HTMLElement, fileTokenClass: string): boolean => {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      let parent: Node | null = node.parentNode
      while (parent && parent !== editor) {
        if (parent.nodeType === Node.ELEMENT_NODE && (parent as HTMLElement).classList?.contains(fileTokenClass)) {
          return NodeFilter.FILTER_REJECT
        }
        parent = parent.parentNode
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let textNode: Node | null
  while ((textNode = walker.nextNode())) {
    const tn = textNode as Text
    const match = (tn.nodeValue || '').match(/\/[A-Za-z0-9-]*/)
    if (match && match.index !== undefined && match[0].length > 0) {
      const sel = window.getSelection()
      if (!sel) return false
      const range = document.createRange()
      range.setStart(tn, match.index)
      range.setEnd(tn, match.index + match[0].length)
      sel.removeAllRanges()
      sel.addRange(range)
      return true
    }
  }
  return false
}

/**
 * 插入斜杠命令文本到 contentEditable 编辑器，保留 undo 历史与已有内容（含文件令牌）。
 * - replaceSlash=true：选中开头已有的 /xxx 并替换为 insertText（斜杠菜单自动补全）
 * - replaceSlash=false：在编辑器开头插入 insertText，使已有内容作为 skill 参数（下拉按钮触发）
 * 使用 execCommand('insertText') 以保留 ctrl+z 撤销能力。
 */
const insertSlashCommand = (editor: HTMLElement, insertText: string, replaceSlash: boolean, fileTokenClass: string): void => {
  editor.focus()
  const sel = window.getSelection()
  if (!sel) return
  if (replaceSlash && selectSlashCommandRange(editor, fileTokenClass)) {
    // 已选中 /xxx 范围，下方 execCommand 会替换选中内容
  } else {
    // 在编辑器开头插入
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  document.execCommand('insertText', false, insertText)
}

/** 创建文件令牌 DOM 元素 */
const createFileTokenElement = (
  id: string,
  name: string,
  path: string,
  token: any,
  removeFileById: (id: string) => void
): HTMLElement => {
  const span = document.createElement('span')
  span.className = FILE_TOKEN_CLASS
  span.contentEditable = 'false'
  span.setAttribute('data-id', id)
  span.setAttribute('data-name', name)
  span.setAttribute('data-path', path)
  span.setAttribute(
    'style',
    `display:inline-flex;align-items:center;gap:4px;padding:1px 6px;margin:0 2px;border-radius:6px;` +
      `background:${token.colorPrimaryBg};border:1px solid ${token.colorPrimaryBorder};` +
      `color:${token.colorPrimary};font-size:12px;line-height:1.4;cursor:default;user-select:none;`
  )
  span.title = path

  // 图标
  const icon = document.createElement('span')
  icon.innerHTML = `<svg viewBox="64 64 896 896" width="1em" height="1em" fill="currentColor"><path d="M832 384H576V128H192v768h640V384zm-64 384H256V192h256v256h256v320zM704 672H320v-64h384v64zm0-128H320v-64h384v64z"/></svg>`
  span.appendChild(icon)

  // 文件名
  const nameSpan = document.createElement('span')
  nameSpan.textContent = name
  nameSpan.style.maxWidth = '180px'
  nameSpan.style.overflow = 'hidden'
  nameSpan.style.textOverflow = 'ellipsis'
  nameSpan.style.whiteSpace = 'nowrap'
  span.appendChild(nameSpan)

  // 关闭按钮
  const closeBtn = document.createElement('span')
  closeBtn.textContent = '×'
  closeBtn.setAttribute(
    'style',
    `margin-left:2px;cursor:pointer;font-size:14px;line-height:1;opacity:0.6;border-radius:50%;` +
      `width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;`
  )
  closeBtn.onmouseenter = () => { closeBtn.style.background = token.colorPrimary; closeBtn.style.color = '#fff'; closeBtn.style.opacity = '1' }
  closeBtn.onmouseleave = () => { closeBtn.style.background = 'transparent'; closeBtn.style.color = 'inherit'; closeBtn.style.opacity = '0.6' }
  closeBtn.onclick = (e: MouseEvent) => {
    e.stopPropagation()
    span.remove()
    removeFileById(id)
  }
  span.appendChild(closeBtn)

  return span
}

const ChatInput: React.FC<{
  onSend: (content: string, images: string[], models: ModelSelection[], options?: SendOptions) => void
  onStop: () => void
  isStreaming: boolean
  placeholder: string
  providers: any[]
  attachedImages: AttachedImage[]
  onImagesChange: (images: AttachedImage[]) => void
  selectedModels: ModelSelection[]
  onModelsChange: (models: ModelSelection[]) => void
  selectedCollectionIds: string[]
  onSelectedCollectionIdsChange: (ids: string[]) => void
  allCollections: any[]
  minimalMode: boolean
  onMinimalModeChange: (enabled: boolean) => void
  canToggleMinimalMode: boolean
  conversationId?: string | null
  getInitialDraft?: () => string
  onDraftChange?: (value: string) => void
  availableSkills?: AvailableSkill[]
  centerMode?: boolean
  showEmployeeSelector?: boolean
  employees?: Employee[]
  selectedEmployeeId?: string
  onSelectEmployee?: (id: string) => void
  defaultProviderId?: string
  defaultModelId?: string
  onDefaultModelChange?: (providerId: string, modelId: string) => void
  enableThinking?: boolean
  onThinkingChange?: (enabled: boolean) => void
  /** 草稿重置 key：当此值变化时强制从 getInitialDraft 重新读取草稿，用于新任务模式下切换员工等场景 */
  draftResetKey?: string
  isCompacting?: boolean
}> = ({ onSend, onStop, isStreaming, placeholder, providers, attachedImages, onImagesChange, selectedModels, onModelsChange, selectedCollectionIds, onSelectedCollectionIdsChange, allCollections, minimalMode, onMinimalModeChange, canToggleMinimalMode, conversationId, getInitialDraft, onDraftChange, availableSkills, centerMode, showEmployeeSelector, employees, selectedEmployeeId, onSelectEmployee, defaultProviderId, defaultModelId, onDefaultModelChange, enableThinking, onThinkingChange, draftResetKey, isCompacting }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const [isDragOver, setIsDragOver] = useState(false)
  const [highPermission, setHighPermission] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)
  /** 跟踪草稿是否已初始化，避免 effect 反复恢复 */
  const draftInitializedRef = useRef(false)
  /** 编辑器内容是否为空（控制 placeholder） */
  const [editorEmpty, setEditorEmpty] = useState(true)

  /** 同步：内容变化后通知父组件（草稿） */
  const emitDraftChange = useCallback(() => {
    if (!editorRef.current || !onDraftChange) return
    const draftStr = serializeEditorDraft(editorRef.current)
    onDraftChange(draftStr)
    // 同步更新空状态
    setEditorEmpty(!editorRef.current.textContent && editorRef.current.querySelectorAll(`.${FILE_TOKEN_CLASS}`).length === 0)
  }, [onDraftChange])

  /** 仅用于统计文件令牌数量（供删除回调使用，避免重复状态） */
  const removeFileById = useCallback((_id: string) => {
    emitDraftChange()
  }, [emitDraftChange])

  /** 恢复草稿到 contentEditable 编辑器 */
  const restoreDraft = useCallback((draftStr: string) => {
    if (!editorRef.current) return
    deserializeDraftToEditor(editorRef.current, draftStr || '', token, removeFileById)
    setEditorEmpty(!draftStr)
  }, [token, removeFileById])

  /** 在当前光标位置插入文件令牌（如果没有选区，则在末尾追加） */
  const insertFileTokenAtCursor = useCallback((files: Array<{ id: string; name: string; path: string }>) => {
    const editor = editorRef.current
    if (!editor) return

    editor.focus()
    const sel = window.getSelection()
    let range: Range | null = null
    if (sel && sel.rangeCount > 0) {
      range = sel.getRangeAt(0)
      // 确保 range 在 editor 内
      if (!editor.contains(range.startContainer)) {
        range = null
      }
    }

    for (const f of files) {
      const tokenEl = createFileTokenElement(f.id, f.name, f.path, token, removeFileById)
      if (range) {
        range.deleteContents()
        range.insertNode(tokenEl)
        // 在令牌后插入一个零宽空格，便于光标继续输入
        const spaceNode = document.createTextNode('\u200B')
        tokenEl.after(spaceNode)
        range.setStartAfter(spaceNode)
        range.setEndAfter(spaceNode)
      } else {
        editor.appendChild(tokenEl)
        editor.appendChild(document.createTextNode('\u200B'))
      }
    }
    if (range && sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
    emitDraftChange()
  }, [token, removeFileById, emitDraftChange])

  // 对话切换 / draftResetKey 变化时，从外部恢复草稿（不触发顶层重渲染，仅在此处同步）
  useEffect(() => {
    if (getInitialDraft) {
      restoreDraft(getInitialDraft())
    }
    // 第一次初始化 / 切换对话时都重置标记
    draftInitializedRef.current = true
  }, [conversationId, getInitialDraft, draftResetKey, restoreDraft])

  // attachedImages 的 ref 镜像，用于异步回调（FileReader.onload）中读取最新值，
  // 避免闭包捕获旧快照导致用户中途新增的图片被覆盖（M1/M2 修复）
  const attachedImagesRef = useRef(attachedImages)
  attachedImagesRef.current = attachedImages

  /**
   * handleSend 最新引用 ref：
   * 解决 handleKeyDown（定义在前）依赖 handleSend（定义在后）导致的 TS2448/TS2454 前向引用报错，
   * 同时避免 Enter 键触发时捕获旧闭包丢失 attachedImages。
   */
  const handleSendRef = useRef<() => void>(() => {})

  // 可通过斜杠菜单触发的 skills：user-invocable 即可
  // skill 激活统一走 activate_skill 工具，不再依赖 skill_<name> 工具注册
  const invocableSkills = useMemo(() => {
    return (availableSkills || []).filter(s => s.userInvocable)
  }, [availableSkills])

  // 斜杠命令：已启用 skills（仅显示名称）
  // skill 命令 key 为 `/<skill-name>`，选中后填充输入框让用户继续输入参数
  const slashCommands = useMemo(() => {
    return invocableSkills.map(s => ({
      key: `/${s.name}`,
      label: `/${s.name}`,
    }))
  }, [invocableSkills])

  /** 从 contentEditable 读取纯文本（不包含文件令牌的 name/path，仅提取实际文字和 \n），用于斜杠匹配等逻辑 */
  const getPlainText = useCallback((): string => {
    if (!editorRef.current) return ''
    return serializeEditorDraft(editorRef.current).replace(/\[\[file:[^\]]*\]\]/g, '')
  }, [])

  const currentSlashItems = useMemo(() => {
    const plain = getPlainText()
    if (!plain.startsWith('/')) return []
    const lower = plain.toLowerCase()
    // 精确控制：仅当输入恰好是 / 或 /xxx（无空格）时才提示命令
    const hasSpace = plain.includes(' ')
    if (hasSpace) return []
    return slashCommands.filter(cmd => cmd.key.startsWith(lower))
  }, [getPlainText, slashCommands])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const plain = getPlainText()
      // skill 命令唯一匹配且无参数：替换 /xxx 为 `/<name> ` 让用户继续输入参数
      if (plain.startsWith('/') && !plain.includes(' ') && currentSlashItems.length === 1) {
        const skillName = currentSlashItems[0].key.slice(1)
        if (editorRef.current) {
          insertSlashCommand(editorRef.current, `/${skillName} `, true, FILE_TOKEN_CLASS)
          emitDraftChange()
        }
        return
      }
      handleSendRef.current()
    }
  }, [getPlainText, currentSlashItems, emitDraftChange])

  // 把 `/<skill-name> <args>` 转换为对 LLM 的明确工具调用指令
  // skill 激活统一通过 activate_skill 工具
  const convertSkillCommand = useCallback((raw: string): string => {
    const match = raw.match(/^\/([a-z0-9-]+)(?:\s+(.*))?$/i)
    if (!match) return raw
    const skillName = match[1]
    const args = (match[2] || '').trim()
    // 校验该 name 是否属于已启用 skill
    const skill = invocableSkills.find(s => s.name === skillName)
    if (!skill) return raw
    if (args) {
      return `用户要求使用 ${skillName} skill 处理：\n${args}`
    }
    return `用户要求使用 ${skillName} skill 处理。`
  }, [invocableSkills])

  // 斜杠菜单 / 下拉按钮选中处理：插入 `/<name> `，保留已有内容与 undo 历史
  const handleSlashSelect = useCallback((cmd: { key: string }) => {
    const skillName = cmd.key.slice(1)
    const editor = editorRef.current
    if (!editor) return
    const plain = getPlainText()
    // 已输入 /xxx 且是所选 skill 的前缀 → 替换（自动补全）；否则在开头插入，已有内容作为 skill 参数
    const replaceSlash = plain.startsWith('/')
      && !plain.includes(' ')
      && cmd.key.toLowerCase().startsWith(plain.toLowerCase())
    insertSlashCommand(editor, `/${skillName} `, replaceSlash, FILE_TOKEN_CLASS)
    emitDraftChange()
  }, [getPlainText, emitDraftChange])

  /** 编辑器是否有内容（文字 或 文件令牌） */
  const hasEditorContent = useCallback((): boolean => {
    if (!editorRef.current) return false
    const tokens = editorRef.current.querySelectorAll(`.${FILE_TOKEN_CLASS}`)
    if (tokens.length > 0) return true
    const text = (editorRef.current.textContent || '').replace(/\u200B/g, '').trim()
    return text.length > 0
  }, [])

  const handleSend = useCallback(() => {
    if (!hasEditorContent() && attachedImages.length === 0) return
    const imageUrls = attachedImages.map(img => img.dataUrl)
    let content = editorRef.current ? extractContentFromEditor(editorRef.current).replace(/\u200B/g, '') : ''
    content = content.trim()
    // 斜杠命令转换仅适用于以 / 开头且后跟 skill 名的情况
    if (content.startsWith('/') && invocableSkills.some(s => content.slice(1).startsWith(s.name))) {
      content = convertSkillCommand(content)
    }
    // 重要兜底：用户可能只附加了文件令牌没输文字
    // 此时 content.trim() 非空（因为文件令牌的 path 被写入了），但如果某种异常导致 content 为空但编辑器有令牌，
    // 这里仍然允许发送（因为有图片），但对"只有令牌没图片"的场景，若 extract 得到的 content 是空，说明令牌提取失败——
    // 目前递归 DFS 已正确处理第一层子节点中的文件令牌，这里不再兜底。
    const sendHighPermission = highPermission
    onSend(content, imageUrls, selectedModels, { highPermission: sendHighPermission })
    // 清空编辑器
    if (editorRef.current) editorRef.current.innerHTML = ''
    emitDraftChange()
    onDraftChange?.('')
    setHighPermission(false)
  }, [hasEditorContent, attachedImages, selectedModels, highPermission, onSend, onDraftChange, invocableSkills, convertSkillCommand, emitDraftChange])

  // 每次渲染都同步最新 handleSend 到 ref，供 handleKeyDown 的 Enter 键调用：
  //  - 避免 TS2448/TS2454 前向声明报错
  //  - 确保 handleKeyDown 调用时捕获的是最新闭包（含最新 attachedImages / content）
  handleSendRef.current = handleSend

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current++
    setIsDragOver(true)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current--
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return
    e.preventDefault()
    dragDepthRef.current = 0
    setIsDragOver(false)
    const dropped = Array.from(e.dataTransfer.files)
    // 区分图片和非图片：图片继续走 attachedImages 顶部显示；非图片作为令牌插入编辑器
    const imgFiles = dropped.filter(f => f.type.startsWith('image/'))
    const otherFiles = dropped.filter(f => !f.type.startsWith('image/'))

    if (imgFiles.length > 0) {
      const loadedImages: AttachedImage[] = []
      let loadedCount = 0
      for (const file of imgFiles) {
        const reader = new FileReader()
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result as string
          loadedImages.push({
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            dataUrl,
            name: file.name || 'pasted-image.png',
          })
          loadedCount++
          if (loadedCount === imgFiles.length) {
            onImagesChange([...attachedImagesRef.current, ...loadedImages])
          }
        }
        reader.onerror = () => {
          loadedCount++
          if (loadedCount === imgFiles.length && loadedImages.length > 0) {
            onImagesChange([...attachedImagesRef.current, ...loadedImages])
          }
        }
        reader.readAsDataURL(file)
      }
    }

    if (otherFiles.length > 0) {
      const tokens = otherFiles.map(f => ({
        id: genFileId(),
        path: window.electronAPI?.getPathForFile?.(f) || (f as any).path || f.name,
        name: f.name,
      }))
      insertFileTokenAtCursor(tokens)
    }
  }, [insertFileTokenAtCursor, onImagesChange])

  /** 在当前光标位置插入纯文本（\n 转 <br>），用于去除 Word 等复制的富文本格式 */
  const insertPlainTextAtCursor = useCallback((text: string) => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const sel = window.getSelection()
    let range: Range | null = null
    if (sel && sel.rangeCount > 0) {
      range = sel.getRangeAt(0)
      if (!editor.contains(range.startContainer)) range = null
    }
    if (range) {
      range.deleteContents()
      const parts = text.split('\n')
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) {
          const node = document.createTextNode(parts[i])
          range.insertNode(node)
          range.setStartAfter(node)
          range.setEndAfter(node)
        }
        if (i < parts.length - 1) {
          const br = document.createElement('br')
          range.insertNode(br)
          range.setStartAfter(br)
          range.setEndAfter(br)
        }
      }
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
    } else {
      editor.appendChild(document.createTextNode(text))
    }
    emitDraftChange()
  }, [emitDraftChange])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result as string
          // 通过 ref 读取最新 attachedImages，避免闭包捕获旧快照导致图片覆盖
          onImagesChange([...attachedImagesRef.current, {
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            dataUrl,
            name: file.name || 'pasted-image.png',
          }])
        }
        reader.readAsDataURL(file)
        return
      }
    }

    const files = e.clipboardData?.files
    if (files && files.length > 0) {
      e.preventDefault()
      const pasted = Array.from(files)
      // 过滤非图片文件，作为令牌插入编辑器
      const nonImgFiles = pasted
        .filter(f => !f.type.startsWith('image/'))
        .map(f => ({
          id: genFileId(),
          path: window.electronAPI?.getPathForFile?.(f) || (f as any).path || f.name,
          name: f.name,
        }))
      if (nonImgFiles.length > 0) {
        insertFileTokenAtCursor(nonImgFiles)
      }
      return
    }

    // 非图片/文件场景：拦截默认粘贴，仅插入纯文本，去除 Word 等复制的富文本格式
    const text = e.clipboardData?.getData('text/plain')
    if (text != null) {
      e.preventDefault()
      insertPlainTextAtCursor(text)
    }
  }, [onImagesChange, insertFileTokenAtCursor, insertPlainTextAtCursor])

  /** 统一的文件选择（PaperClip 按钮）：同时支持图片与普通文件，按类型自动分流
   * - image/*：走原图片逻辑（FileReader→dataUrl→顶部缩略图→images 数组发消息）
   * - 其他类型：作为文件令牌插入编辑器光标位置，发送时替换为绝对路径
   */
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    const all = Array.from(files)
    const imageFiles = all.filter(f => f.type.startsWith('image/'))
    const otherFiles = all.filter(f => !f.type.startsWith('image/'))

    // 1) 图片：逐个 FileReader → onImagesChange
    if (imageFiles.length > 0) {
      const loadedImages: AttachedImage[] = []
      let loadedCount = 0
      const total = imageFiles.length
      const maybeFlush = () => {
        loadedCount++
        if (loadedCount === total && loadedImages.length > 0) {
          onImagesChange([...attachedImagesRef.current, ...loadedImages])
        }
      }
      for (const file of imageFiles) {
        const reader = new FileReader()
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result as string
          loadedImages.push({
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            dataUrl,
            name: file.name,
          })
          maybeFlush()
        }
        reader.onerror = maybeFlush
        reader.readAsDataURL(file)
      }
    }

    // 2) 非图片文件：构造令牌插入光标位置
    if (otherFiles.length > 0) {
      const tokens = otherFiles.map(f => ({
        id: genFileId(),
        path: window.electronAPI?.getPathForFile?.(f) || (f as any).path || f.name,
        name: f.name,
      }))
      insertFileTokenAtCursor(tokens)
    }

    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [onImagesChange, insertFileTokenAtCursor])

  const removeImage = useCallback((id: string) => {
    onImagesChange(attachedImages.filter(img => img.id !== id))
  }, [attachedImages, onImagesChange])

  const [showModelPicker, setShowModelPicker] = useState(false)
  const [modelSearchText, setModelSearchText] = useState('')
  const [showKbPicker, setShowKbPicker] = useState(false)

  const modelTags = useMemo(() => selectedModels.map((sel, i) => {
    const p = providers.find((p: any) => p.id === sel.providerId)
    const models = p ? getProviderModels(p) : []
    const m = models.find((m: any) => m.model === sel.modelId)
    const label = m?.name || sel.modelId
    return { key: i, label, providerName: p?.name || '' }
  }), [selectedModels, providers])

  const isModelSelected = useCallback((providerId: string, modelId: string) => {
    return selectedModels.some(s => s.providerId === providerId && s.modelId === modelId)
  }, [selectedModels])

  const toggleModel = useCallback((providerId: string, modelId: string) => {
    if (isModelSelected(providerId, modelId)) {
      onModelsChange(selectedModels.filter(s => !(s.providerId === providerId && s.modelId === modelId)))
    } else if (selectedModels.length < MAX_SELECTED_MODELS) {
      onModelsChange([...selectedModels, { providerId, modelId }])
    }
  }, [selectedModels, onModelsChange, isModelSelected])

  const filteredProviderModels = useMemo(() => {
    const search = modelSearchText.toLowerCase()
    return providers.map((provider: any) => {
      const models = getProviderModels(provider).filter(m => (m.category || 'chat') === 'chat')
      const filtered = search
        ? models.filter(m =>
            m.name.toLowerCase().includes(search) ||
            m.model.toLowerCase().includes(search) ||
            provider.name.toLowerCase().includes(search)
          )
        : models
      return { provider, models: filtered }
    }).filter(group => group.models.length > 0)
  }, [providers, modelSearchText])

  const modelPickerContent = useMemo(() => (
    <div style={{ width: 320, maxHeight: 420, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Input
        placeholder={t('workbench.searchModel')}
        prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
        value={modelSearchText}
        onChange={(e) => setModelSearchText(e.target.value)}
        allowClear
        variant="borderless"
        size="small"
        style={{ background: token.colorFillQuaternary, borderRadius: 6 }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: token.colorTextTertiary }}>
        <span>{t('workbench.selectedModelCount', { count: selectedModels.length, max: MAX_SELECTED_MODELS })}</span>
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {filteredProviderModels.map(({ provider, models }) => {
          const isDomestic = DOMESTIC_PROVIDERS.has(provider.provider_type)
          const isLocal = LOCAL_PROVIDERS.has(provider.provider_type)
          return (
            <div key={provider.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', fontSize: 11, fontWeight: 600, color: token.colorTextSecondary }}>
                <RobotOutlined style={{ fontSize: 11 }} />
                <span>{provider.name}</span>
                {isDomestic && <Tag color="red" style={{ fontSize: 8, lineHeight: '12px', padding: '0 2px', margin: 0 }}>{t('llmSelector.domestic')}</Tag>}
                {isLocal && <Tag color="green" style={{ fontSize: 8, lineHeight: '12px', padding: '0 2px', margin: 0 }}>{t('llmSelector.local')}</Tag>}
              </div>
              {models.map((model) => {
                const selected = isModelSelected(provider.id, model.model)
                const disabled = !selected && selectedModels.length >= MAX_SELECTED_MODELS
                return (
                  <div
                    key={`${provider.id}-${model.model}`}
                    onClick={() => { if (!disabled) toggleModel(provider.id, model.model) }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 6px 4px 20px',
                      borderRadius: 4,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      opacity: disabled ? 0.4 : 1,
                      background: selected ? token.colorPrimaryBg : 'transparent',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => { if (!disabled && !selected) e.currentTarget.style.background = token.colorBgTextHover }}
                    onMouseLeave={(e) => { if (!disabled && !selected) e.currentTarget.style.background = selected ? token.colorPrimaryBg : 'transparent' }}
                  >
                    <Checkbox checked={selected} style={{ pointerEvents: 'none' }} />
                    <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.name}</span>
                    {selected && <CheckOutlined style={{ fontSize: 11, color: token.colorPrimary }} />}
                  </div>
                )
              })}
            </div>
          )
        })}
        {filteredProviderModels.length === 0 && (
          <div style={{ padding: '16px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12 }}>
            {t('workbench.noMatchingModel')}
          </div>
        )}
      </div>
    </div>
  ), [t, token, modelSearchText, selectedModels, filteredProviderModels, isModelSelected, toggleModel])

  const collectionPickerContent = useMemo(() => (
    <div style={{ width: 280, maxHeight: 360, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: token.colorTextTertiary }}>
        <span>{t('workbench.selectedKbCount', { count: selectedCollectionIds.length })}</span>
        {allCollections.length > 0 && (
          <>
            <Button type="link" size="small" style={{ fontSize: 11, padding: 0, height: 'auto' }}
              onClick={() => onSelectedCollectionIdsChange(allCollections.map((c: any) => c.id))}>
              {t('common.selectAll')}
            </Button>
            <Button type="link" size="small" style={{ fontSize: 11, padding: 0, height: 'auto' }}
              onClick={() => onSelectedCollectionIdsChange([])}>
              {t('common.clearAll')}
            </Button>
          </>
        )}
      </div>
      <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {allCollections.map((c: any) => {
          const selected = selectedCollectionIds.includes(c.id)
          return (
            <div
              key={c.id}
              onClick={() => {
                if (selected) {
                  onSelectedCollectionIdsChange(selectedCollectionIds.filter((id: string) => id !== c.id))
                } else {
                  onSelectedCollectionIdsChange([...selectedCollectionIds, c.id])
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 4,
                cursor: 'pointer',
                background: selected ? token.colorPrimaryBg : 'transparent',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = token.colorBgTextHover }}
              onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = selected ? token.colorPrimaryBg : 'transparent' }}
            >
              <Checkbox checked={selected} style={{ pointerEvents: 'none' }} />
              <DatabaseOutlined style={{ fontSize: 12, color: token.colorPrimary }} />
              <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
              {selected && <CheckOutlined style={{ fontSize: 11, color: token.colorPrimary }} />}
            </div>
          )
        })}
        {allCollections.length === 0 && (
          <div style={{ padding: '16px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12 }}>
            {t('creationWizard.noKbAvailable')}
          </div>
        )}
      </div>
    </div>
  ), [t, token, selectedCollectionIds, allCollections, onSelectedCollectionIdsChange])

  const [showDefaultModelPicker, setShowDefaultModelPicker] = useState(false)
  const [defaultModelSearch, setDefaultModelSearch] = useState('')
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false)
  const [employeeSearch, setEmployeeSearch] = useState('')

  // 滑动高亮指示器状态
  const pillContainerRef = useRef<HTMLDivElement>(null)
  const pillItemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({ left: 0, width: 0, opacity: 0 })

  const defaultModelLabel = useMemo(() => {
    if (!defaultProviderId || !defaultModelId) return ''
    const p = providers.find((p: any) => p.id === defaultProviderId)
    if (!p) return defaultModelId
    const models = getProviderModels(p)
    const m = models.find((m: any) => m.model === defaultModelId)
    return m?.name || defaultModelId
  }, [defaultProviderId, defaultModelId, providers])

  const filteredDefaultModels = useMemo(() => {
    const search = defaultModelSearch.toLowerCase()
    return providers.map((provider: any) => {
      const models = getProviderModels(provider).filter(m => (m.category || 'chat') === 'chat')
      const filtered = search
        ? models.filter(m =>
            m.name.toLowerCase().includes(search) ||
            m.model.toLowerCase().includes(search) ||
            provider.name.toLowerCase().includes(search)
          )
        : models
      return { provider, models: filtered }
    }).filter(group => group.models.length > 0)
  }, [providers, defaultModelSearch])

  const defaultModelPickerContent = useMemo(() => (
    <div style={{ width: 300, maxHeight: 420, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Input
        placeholder={t('workbench.searchModel')}
        prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
        value={defaultModelSearch}
        onChange={(e) => setDefaultModelSearch(e.target.value)}
        allowClear
        variant="borderless"
        size="small"
        style={{ background: token.colorFillQuaternary, borderRadius: 6 }}
      />
      <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {filteredDefaultModels.map(({ provider, models }) => {
          const isDomestic = DOMESTIC_PROVIDERS.has(provider.provider_type)
          const isLocal = LOCAL_PROVIDERS.has(provider.provider_type)
          return (
            <div key={provider.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', fontSize: 11, fontWeight: 600, color: token.colorTextSecondary }}>
                <RobotOutlined style={{ fontSize: 11 }} />
                <span>{provider.name}</span>
                {isDomestic && <Tag color="red" style={{ fontSize: 8, lineHeight: '12px', padding: '0 2px', margin: 0 }}>{t('llmSelector.domestic')}</Tag>}
                {isLocal && <Tag color="green" style={{ fontSize: 8, lineHeight: '12px', padding: '0 2px', margin: 0 }}>{t('llmSelector.local')}</Tag>}
              </div>
              {models.map((model) => {
                const selected = defaultProviderId === provider.id && defaultModelId === model.model
                return (
                  <div
                    key={`${provider.id}-${model.model}`}
                    onClick={() => {
                      onDefaultModelChange?.(provider.id, model.model)
                      setShowDefaultModelPicker(false)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 6px 4px 20px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      background: selected ? token.colorPrimaryBg : 'transparent',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = token.colorBgTextHover }}
                    onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = selected ? token.colorPrimaryBg : 'transparent' }}
                  >
                    {selected ? <CheckOutlined style={{ fontSize: 11, color: token.colorPrimary }} /> : <div style={{ width: 11 }} />}
                    <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.name}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
        {filteredDefaultModels.length === 0 && (
          <div style={{ padding: '16px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12 }}>
            {t('workbench.noMatchingModel')}
          </div>
        )}
      </div>
    </div>
  ), [t, token, defaultModelSearch, filteredDefaultModels, defaultProviderId, defaultModelId, onDefaultModelChange])

  // 常用数字员工：固定前4个是最近使用的（后端按last_active_at倒序）
  const top4Employees = useMemo(() => {
    const list = employees || []
    return list.slice(0, Math.min(4, list.length))
  }, [employees])

  // 第5个位置：如果当前选中员工不在前4个，则显示选中员工；否则为null（显示更多按钮）
  const fifthSlotEmployee = useMemo(() => {
    if (!selectedEmployeeId) return null
    if (top4Employees.some(e => e.id === selectedEmployeeId)) return null
    return (employees || []).find(e => e.id === selectedEmployeeId) || null
  }, [employees, selectedEmployeeId, top4Employees])

  // 需要显示在tab上的员工：前4个 + （如果有）第5个位置的选中员工
  const visibleEmployees = useMemo(() => {
    return fifthSlotEmployee ? [...top4Employees, fifthSlotEmployee] : top4Employees
  }, [top4Employees, fifthSlotEmployee])

  // 下拉菜单中的剩余数字员工：排除所有显示在tab上的员工
  const dropdownEmployees = useMemo(() => {
    const visibleIds = new Set(visibleEmployees.map(e => e.id))
    return (employees || []).filter(e => !visibleIds.has(e.id))
  }, [employees, visibleEmployees])

  const filteredDropdownEmployees = useMemo(() => {
    if (!employeeSearch.trim()) return dropdownEmployees
    const search = employeeSearch.toLowerCase()
    return dropdownEmployees.filter(e =>
      e.name.toLowerCase().includes(search) ||
      (e.description || '').toLowerCase().includes(search)
    )
  }, [dropdownEmployees, employeeSearch])

  // 更新滑动指示器位置
  const updateIndicator = useCallback(() => {
    const container = pillContainerRef.current
    if (!container) return
    // 确定当前选中项的key
    let targetKey: string | null = null
    if (selectedEmployeeId) {
      if (top4Employees.some(e => e.id === selectedEmployeeId)) {
        targetKey = selectedEmployeeId
      } else if (fifthSlotEmployee && fifthSlotEmployee.id === selectedEmployeeId) {
        targetKey = selectedEmployeeId
      }
    }
    if (!targetKey && dropdownEmployees.length > 0) {
      // 默认选中更多按钮位置（无选中项时）
      targetKey = '__more__'
    }
    if (!targetKey) {
      setIndicatorStyle(prev => ({ ...prev, opacity: 0 }))
      return
    }
    // 使用requestAnimationFrame确保DOM已渲染
    requestAnimationFrame(() => {
      const targetEl = pillItemRefs.current.get(targetKey!)
      if (!targetEl || !container) {
        setIndicatorStyle(prev => ({ ...prev, opacity: 0 }))
        return
      }
      const containerRect = container.getBoundingClientRect()
      const targetRect = targetEl.getBoundingClientRect()
      setIndicatorStyle({
        left: targetRect.left - containerRect.left,
        width: targetRect.width,
        opacity: 1,
      })
    })
  }, [selectedEmployeeId, top4Employees, fifthSlotEmployee, dropdownEmployees.length])

  useEffect(() => {
    updateIndicator()
  }, [updateIndicator])

  useEffect(() => {
    const handleResize = () => updateIndicator()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [updateIndicator])

  // 胶囊分段选择器样式
  const isDark = isColorDark(token.colorBgContainer)
  const pillContainerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    background: token.colorBgElevated,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: 999,
    padding: 3,
    gap: 0,
    boxShadow: isDark
      ? '0 0 16px rgba(0,0,0,0.25)' 
      : '0 2px 6px rgba(0,0,0,0.06)',
  }

  const pillIndicatorStyle: React.CSSProperties = {
    position: 'absolute',
    top: 3,
    bottom: 3,
    borderRadius: 999,
    background: token.colorPrimary,
    boxShadow: `0 0 14px ${token.colorPrimary}30, 0 2px 8px ${token.colorPrimary}25`,
    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    zIndex: 0,
    pointerEvents: 'none',
  }

  const getPillItemStyle = (active: boolean): React.CSSProperties => ({
    position: 'relative',
    zIndex: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    padding: '4px 13px',
    borderRadius: 999,
    cursor: 'pointer',
    userSelect: 'none',
    transition: 'color 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    background: 'transparent',
    color: active ? '#fff' : token.colorTextSecondary,
    fontWeight: active ? 600 : 400,
    fontSize: 13,
    whiteSpace: 'nowrap',
  })

  return (
    <div style={centerMode
      ? { padding: '0 16px', flexShrink: 0, maxWidth: 680, width: '100%', margin: '0 auto' }
      : { padding: '8px 6% 12px 6%', flexShrink: 0 }
    }>
      {showEmployeeSelector && employees && employees.length > 0 && (
        <div style={{ paddingTop: 8, paddingBottom: 4, display: 'flex', justifyContent: 'center' }}>
          <div ref={pillContainerRef} style={pillContainerStyle}>
            {/* 滑动高亮指示器 */}
            <div style={{ ...pillIndicatorStyle, ...indicatorStyle }} />

            {/* 前4个固定的常用员工 */}
            {top4Employees.map((emp) => {
              const active = emp.id === selectedEmployeeId
              return (
                <div
                  key={emp.id}
                  ref={(el) => { if (el) pillItemRefs.current.set(emp.id, el); else pillItemRefs.current.delete(emp.id) }}
                  onClick={() => onSelectEmployee?.(emp.id)}
                  style={getPillItemStyle(active)}
                  onMouseEnter={(e) => {
                    if (active) return
                    e.currentTarget.style.color = token.colorText
                  }}
                  onMouseLeave={(e) => {
                    if (active) return
                    e.currentTarget.style.color = token.colorTextSecondary
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100 }}>{emp.name}</span>
                </div>
              )
            })}

            {/* 下拉Popover：第4个位置或更多按钮 */}
            {dropdownEmployees.length > 0 && (
              <Popover
                open={employeePickerOpen}
                onOpenChange={(o) => { setEmployeePickerOpen(o); if (!o) setEmployeeSearch('') }}
                content={
                  <div style={{ width: 220, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Input
                      placeholder={t('workbench.searchEmployee')}
                      prefix={<SearchOutlined style={{ color: token.colorTextQuaternary, fontSize: 12 }} />}
                      value={employeeSearch}
                      onChange={(e) => setEmployeeSearch(e.target.value)}
                      allowClear
                      size="small"
                      variant="borderless"
                      style={{ padding: '2px 8px', marginBottom: 2 }}
                    />
                    <div style={{ maxHeight: 264, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {filteredDropdownEmployees.length === 0 && (
                        <div style={{ padding: '24px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12 }}>
                          {employeeSearch ? t('workbench.noMatchingEmployee') : t('digitalEmployees.noEmployees')}
                        </div>
                      )}
                      {filteredDropdownEmployees.map(emp => {
                        const empActive = emp.id === selectedEmployeeId
                        return (
                          <div
                            key={emp.id}
                            onClick={() => { onSelectEmployee?.(emp.id); setEmployeePickerOpen(false); setEmployeeSearch('') }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                              background: empActive ? token.colorPrimaryBg : 'transparent',
                              transition: 'background 0.15s',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = empActive ? token.colorPrimaryBg : token.colorBgTextHover }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = empActive ? token.colorPrimaryBg : 'transparent' }}
                          >
                            <div style={{
                              width: 28, height: 28, borderRadius: '50%',
                              background: empActive ? token.colorPrimary : `${token.colorPrimary}15`,
                              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                            }}>
                              <RobotOutlined style={{ fontSize: 14, color: empActive ? '#fff' : token.colorPrimary }} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <Text strong={empActive} style={{ fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: empActive ? token.colorPrimary : 'inherit' }}>{emp.name}</Text>
                              {emp.description && (
                                <Text style={{ fontSize: 11, color: token.colorTextTertiary, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emp.description}</Text>
                              )}
                            </div>
                            {empActive && <CheckOutlined style={{ fontSize: 12, color: token.colorPrimary }} />}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                }
                trigger="click"
                placement="bottomLeft"
                arrow={false}
                styles={{ container: { padding: 8 } }}
              >
                {fifthSlotEmployee ? (
                  <div
                    ref={(el) => { if (el) pillItemRefs.current.set(fifthSlotEmployee.id, el); else pillItemRefs.current.delete(fifthSlotEmployee.id) }}
                    style={getPillItemStyle(true)}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = 'rgba(255,255,255,0.9)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = '#fff'
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100 }}>{fifthSlotEmployee.name}</span>
                    <DownOutlined style={{ fontSize: 8 }} />
                  </div>
                ) : (
                  <div
                    ref={(el) => { if (el) pillItemRefs.current.set('__more__', el); else pillItemRefs.current.delete('__more__') }}
                    style={{
                      ...getPillItemStyle(false),
                      gap: 5,
                      padding: '4px 10px',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = token.colorText
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = token.colorTextSecondary
                    }}
                  >
                    <UnorderedListOutlined style={{ fontSize: 12 }} />
                    <span style={{ fontSize: 12, fontWeight: 500 }}>{dropdownEmployees.length}</span>
                    <DownOutlined style={{ fontSize: 8 }} />
                  </div>
                )}
              </Popover>
            )}
          </div>
        </div>
      )}
      {attachedImages.length > 0 && (
        <div style={{ display: 'flex', gap: 6, padding: '4px 0 6px', flexWrap: 'wrap' }}>
          {attachedImages.map(img => (
            <div key={img.id} style={{ position: 'relative', borderRadius: 6, overflow: 'hidden', border: `1px solid ${token.colorBorderSecondary}` }}>
              <img src={img.dataUrl} alt={img.name} style={{ width: 72, height: 72, objectFit: 'cover', display: 'block' }} />
              <Button type="text" size="small" icon={<CloseOutlined style={{ fontSize: 10 }} />}
                onClick={() => removeImage(img.id)}
                style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.5)', color: '#fff', borderRadius: 3, padding: 0, width: 16, height: 16, minWidth: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }} />
            </div>
          ))}
        </div>
      )}
      {modelTags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, padding: '4px 0 8px', flexWrap: 'wrap' }}>
          {modelTags.map(tag => (
            <div key={tag.key} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, background: token.colorPrimaryBg, border: `1px solid ${token.colorPrimaryBorder}`, fontSize: 12, color: token.colorPrimary }}>
              <span>@</span>
              <span>{tag.providerName} / {tag.label}</span>
              <CloseOutlined style={{ fontSize: 10, cursor: 'pointer' }} onClick={() => onModelsChange(selectedModels.filter((_, i) => i !== tag.key))} />
            </div>
          ))}
        </div>
      )}
      {selectedCollectionIds.length > 0 && (
        <div style={{ display: 'flex', gap: 6, padding: '4px 0 8px', flexWrap: 'wrap' }}>
          {selectedCollectionIds.map(colId => {
            const col = allCollections.find((c: any) => c.id === colId)
            if (!col) return null
            return (
              <div key={colId} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, background: `${token.colorSuccessBg}`, border: `1px solid ${token.colorSuccessBorder}`, fontSize: 12, color: token.colorSuccess }}>
                <DatabaseOutlined style={{ fontSize: 10 }} />
                <span>{col.name}</span>
                <CloseOutlined style={{ fontSize: 10, cursor: 'pointer' }} onClick={() => onSelectedCollectionIdsChange(selectedCollectionIds.filter((id: string) => id !== colId))} />
              </div>
            )
          })}
        </div>
      )}
      {currentSlashItems.length > 0 && (
        <div style={{ display: 'flex', gap: 4, padding: '4px 0', flexWrap: 'wrap' }}>
          {currentSlashItems.map(cmd => (
            <div key={cmd.key} onClick={() => handleSlashSelect(cmd)}
              style={{ padding: '4px 10px', borderRadius: 6, background: token.colorBgTextHover, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${token.colorBorderSecondary}`, transition: 'all 0.2s' }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = token.colorPrimary; e.currentTarget.style.background = token.colorPrimaryBg }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = token.colorBorderSecondary; e.currentTarget.style.background = token.colorBgTextHover }}>
              <Text strong style={{ fontSize: 12, color: token.colorPrimary }}>{cmd.label}</Text>
            </div>
          ))}
        </div>
      )}
      <div style={{ position: 'relative', display: 'flex', gap: 8, alignItems: 'flex-end', background: token.colorBgContainer, borderRadius: 10, padding: '4px 4px 4px 12px', border: `1px solid ${isDragOver ? token.colorPrimary : token.colorBorderSecondary}`, transition: 'border-color 0.2s' }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onFocusCapture={(e) => { if (!isDragOver) (e.currentTarget as HTMLElement).style.borderColor = token.colorPrimary }}
        onBlurCapture={(e) => { if (!isDragOver) (e.currentTarget as HTMLElement).style.borderColor = token.colorBorderSecondary }}>
        {isDragOver && (
          <div style={{
            position: 'absolute', inset: 0,
            borderRadius: 9,
            background: token.colorPrimaryBg,
            border: `2px dashed ${token.colorPrimary}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 10,
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <FileTextOutlined style={{ fontSize: 28, color: token.colorPrimary }} />
              <Text style={{ color: token.colorPrimary, fontWeight: 500, fontSize: 13 }}>{t('workbench.dropFileHint')}</Text>
            </div>
          </div>
        )}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* contentEditable 输入框，支持在光标位置嵌入文件令牌 */}
          <div
            ref={editorRef}
            contentEditable={!isCompacting}
            suppressContentEditableWarning
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onInput={emitDraftChange}
            spellCheck={false}
            className="workbench-input"
            style={{
              position: 'relative',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              fontSize: 13,
              lineHeight: 1.6,
              padding: '4px 0',
              minHeight: centerMode ? (5 * 1.6 * 13) : (2 * 1.6 * 13),
              maxHeight: 8 * 1.6 * 13,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              userSelect: 'text',
            }}
          />
          {/* placeholder 覆盖层 */}
          {editorEmpty && !isCompacting && (
            <div
              aria-hidden
              onClick={() => editorRef.current?.focus()}
              style={{
                position: 'absolute',
                pointerEvents: 'none',
                color: token.colorTextQuaternary,
                fontSize: 13,
                lineHeight: 1.6,
                padding: '4px 0',
                left: 12,
                right: 40,
                top: 4,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {placeholder}
            </div>
          )}
          {isCompacting && (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                pointerEvents: 'none',
                color: token.colorTextQuaternary,
                fontSize: 13,
                lineHeight: 1.6,
                padding: '4px 0',
                left: 12,
                top: 4,
              }}
            >
              {t('workbench.compactingPlaceholder', { defaultValue: '正在压缩对话上下文，请稍候...' })}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 0 2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Tooltip title={highPermission ? t('workbench.highPermissionOn') : t('workbench.highPermissionOff')}>
                <Button type="text" size="small" icon={<UnlockOutlined style={{ fontSize: 12 }} />}
                  onClick={() => setHighPermission(!highPermission)}
                  style={{
                    color: highPermission ? token.colorWarning : token.colorTextQuaternary,
                    padding: '0 2px', height: 20, minWidth: 20,
                    background: highPermission ? token.colorWarningBg : 'transparent',
                  }} />
              </Tooltip>
              {/* 统一的上传文件按钮（图片 + 普通文件二合一，按类型分流） */}
              <Tooltip title={t('workbench.attachFile', { defaultValue: '上传文件' })}>
                <Button type="text" size="small" icon={<PaperClipOutlined style={{ fontSize: 12 }} />}
                  onClick={() => fileInputRef.current?.click()}
                  style={{ color: token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20 }} />
              </Tooltip>
              <Popover
                content={modelPickerContent}
                trigger="click"
                placement="topLeft"
                arrow={false}
                styles={{ container: { padding: 8 } }}
                onOpenChange={(open) => {
                  setShowModelPicker(open)
                  if (open) setModelSearchText('')
                }}
                open={showModelPicker}
              >
                <Button type="text" size="small" icon={<SwapOutlined style={{ fontSize: 12 }} />}
                  style={{ color: selectedModels.length > 0 ? token.colorPrimary : token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20 }}
                  title={t('workbench.compareModels')} />
              </Popover>
              <Popover
                content={collectionPickerContent}
                trigger="click"
                placement="topLeft"
                arrow={false}
                styles={{ container: { padding: 8 } }}
                onOpenChange={setShowKbPicker}
                open={showKbPicker}
              >
                <Button type="text" size="small" icon={<DatabaseOutlined style={{ fontSize: 12 }} />}
                  style={{ color: selectedCollectionIds.length > 0 ? token.colorPrimary : token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20 }}
                  title={t('workbench.knowledgeBase')} />
              </Popover>
              <Tooltip title={canToggleMinimalMode ? t('workbench.minimalModeTooltip') : t('workbench.minimalModeDisabledTooltip')}>
                <Button type="text" size="small" icon={<ThunderboltOutlined style={{ fontSize: 12 }} />}
                  onClick={() => { if (canToggleMinimalMode) onMinimalModeChange(!minimalMode) }}
                  style={{ color: minimalMode ? token.colorPrimary : token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20, opacity: canToggleMinimalMode ? 1 : 0.4, cursor: canToggleMinimalMode ? 'pointer' : 'not-allowed' }} />
              </Tooltip>
              <Tooltip title={t('workbench.selectSkillToExecute')}>
                <Dropdown menu={{ items: slashCommands.map(cmd => ({ key: cmd.key, label: <Text strong style={{ fontSize: 12 }}>{cmd.label}</Text>, onClick: () => handleSlashSelect(cmd) })) }} trigger={['click']}>
                  <Button type="text" size="small" icon={<CompressOutlined style={{ fontSize: 12 }} />}
                    style={{ color: token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20 }} />
                </Dropdown>
              </Tooltip>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {onDefaultModelChange && (
                <Popover
                  content={defaultModelPickerContent}
                  trigger="click"
                  placement="topRight"
                  arrow={false}
                  styles={{ container: { padding: 8 } }}
                  onOpenChange={(open) => {
                    setShowDefaultModelPicker(open)
                    if (open) setDefaultModelSearch('')
                  }}
                  open={showDefaultModelPicker}
                >
                  <Button type="text" size="small"
                    style={{ color: defaultModelLabel ? token.colorPrimary : token.colorTextQuaternary, padding: '0 6px', height: 20, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {defaultModelLabel ? (
                      <span style={{ fontSize: 11, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{defaultModelLabel}</span>
                    ) : (
                      <RobotOutlined style={{ fontSize: 12 }} />
                    )}
                  </Button>
                </Popover>
              )}
              {onThinkingChange && (
                <Tooltip title={enableThinking ? t('workbench.thinkingEnabled') : t('workbench.thinkingDisabled')}>
                  <Button type="text" size="small"
                    icon={enableThinking ? <BulbFilled /> : <BulbOutlined />}
                    onClick={() => onThinkingChange(!enableThinking)}
                    style={{
                      color: enableThinking ? token.colorPrimary : token.colorTextQuaternary,
                      padding: '0 2px', height: 20, minWidth: 20,
                    }} />
                </Tooltip>
              )}
            </div>
          </div>
        </div>
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
        {isStreaming || isCompacting ? (
          <Button icon={isCompacting ? <LoadingOutlined /> : <StopOutlined />} danger={isStreaming} disabled={isCompacting} onClick={onStop} size="middle" />
        ) : (
          <Button icon={<SendOutlined />} type="primary" onClick={handleSend}
            disabled={!hasEditorContent() && attachedImages.length === 0}
            size="middle" style={{ flexShrink: 0 }} />
        )}
      </div>
    </div>
  )
}

export default memo(ChatInput)
