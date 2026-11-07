import { Input, Button, theme, Dropdown, Typography, Popover, Tag, Checkbox, Tooltip } from 'antd'
import { SendOutlined, StopOutlined, PaperClipOutlined, CloseOutlined, SwapOutlined, CheckOutlined, RobotOutlined, SearchOutlined, DatabaseOutlined, ToolOutlined, FileTextOutlined, UnlockOutlined, SafetyOutlined, MessageOutlined, BulbOutlined, BulbFilled, LoadingOutlined, ScissorOutlined, CopyOutlined, SnippetsOutlined, SelectOutlined, FolderOutlined, FolderOpenOutlined, DownOutlined, EditOutlined, DeleteOutlined, ClockCircleOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useMemo, useRef, useCallback, useState, useEffect, memo } from 'react'
import { getProviderModels, DOMESTIC_PROVIDERS, LOCAL_PROVIDERS, supportsReasoningEffort, supportsThinking } from '../../utils/llm'
import { getDirName } from '../../utils/format'
import { PluginViewSlot } from '../../plugins/view-slot'
import { useTaskPermissionStore } from '../../stores/task-permission.store'
import EmployeeAvatar from '../common/EmployeeAvatar'
import type { Employee, ThinkingLevel } from '../../types'

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
  /** 由待发送队列自动触发时为 true，调用方不要清理当前输入框草稿/附件/模型选择 */
  fromQueue?: boolean
}

/** 排队等待当前回复结束后自动发送的用户消息 */
export interface QueuedChatMessage {
  id: string
  content: string
  images: string[]
  models: ModelSelection[]
  options?: SendOptions
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

/** 零宽字符：contentEditable 聚焦/清空时常会插入，不能当作有效内容 */
const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF]/g

/** 编辑器是否实际为空（忽略纯空白与零宽字符，文件令牌视为有内容） */
const isEditorEffectivelyEmpty = (editor: HTMLElement): boolean => {
  if (editor.querySelectorAll(`.${FILE_TOKEN_CLASS}`).length > 0) return false
  return (editor.textContent || '').replace(ZERO_WIDTH_CHARS, '').trim().length === 0
}

/** 生成文件令牌唯一 id */
const genFileId = () => `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

/** 生成排队消息唯一 id */
const genQueueId = () => `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

/** 按对话缓存待发送队列：切换任务时保留各自的排队消息，切回后可继续展示 */
const _persistentQueues = new Map<string, QueuedChatMessage[]>()

/** 队列预览文本：文件令牌显示为文件名，避免暴露完整路径 */
const formatQueuedPreview = (content: string): string =>
  content
    .replace(/<path>([^<]*)<\/path>/g, (_match, path: string) => path.split(/[\\/]/).pop() || path)
    .trim()

/** 生成图片附件项：data URL 先落盘为主进程附件，消息里以 wa-attachment:// 引用流转（避免 base64 进 DB/localStorage）。
 *  落盘失败（如主进程异常）时保留原 data URL，功能降级不中断。 */
const buildAttachedImage = async (dataUrl: string, name: string): Promise<AttachedImage> => {
  let stored = dataUrl
  try {
    const result = await window.electronAPI?.attachment?.saveDataUrls([dataUrl])
    stored = result?.refs?.[0] || dataUrl
  } catch { /* 降级：保留 dataUrl */ }
  return {
    id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    dataUrl: stored,
    name,
  }
}

/** Blob → data URL（右键粘贴图片时复用图片落盘流程） */
const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

/** XML 转义，避免路径本身含 &、<、> 时破坏 <path> 标签闭合 */
const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

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
          if (path) result += `<path>${xmlEscape(path)}</path>`
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
    const tokenEl = createFileTokenElement(id, name, path, token)
    bindFileTokenElement(tokenEl, token, removeFileById)
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

const FILE_TOKEN_CLOSE_CLASS = 'chat-input-file-token-close'

/** 创建文件令牌 DOM 元素（不含交互事件绑定，绑定见 bindFileTokenElement） */
const createFileTokenElement = (
  id: string,
  name: string,
  path: string,
  token: any
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
  closeBtn.className = FILE_TOKEN_CLOSE_CLASS
  closeBtn.textContent = '×'
  closeBtn.setAttribute(
    'style',
    `margin-left:2px;cursor:pointer;font-size:14px;line-height:1;opacity:0.6;border-radius:50%;` +
      `width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;`
  )
  span.appendChild(closeBtn)

  return span
}

/** 为文件令牌绑定关闭按钮交互（幂等，重复调用不会叠加事件） */
const bindFileTokenElement = (el: HTMLElement, token: any, removeFileById: (id: string) => void) => {
  if (el.dataset.bound === '1') return
  el.dataset.bound = '1'
  const closeBtn = el.querySelector(`.${FILE_TOKEN_CLOSE_CLASS}`) as HTMLElement | null
  if (!closeBtn) return
  const id = el.getAttribute('data-id') || ''
  closeBtn.onmouseenter = () => { closeBtn.style.background = token.colorPrimary; closeBtn.style.color = '#fff'; closeBtn.style.opacity = '1' }
  closeBtn.onmouseleave = () => { closeBtn.style.background = 'transparent'; closeBtn.style.color = 'inherit'; closeBtn.style.opacity = '0.6' }
  closeBtn.onclick = (e: MouseEvent) => {
    e.stopPropagation()
    el.remove()
    removeFileById(id)
  }
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
  /** 草稿恢复键：由 null 变为具体值时（如新任务模式员工首次确定）重新恢复草稿 */
  draftRestoreKey?: string | null
  availableSkills?: AvailableSkill[]
  centerMode?: boolean
  showEmployeeSelector?: boolean
  /** 新任务工作区选择器：与数字员工选择器同排展示 */
  workspaceSelector?: {
    /** 当前指定目录；null 表示默认工作区 */
    path: string | null
    /** 用户手动指定过的工作区目录（最近使用优先） */
    recent: Array<{ path: string; label: string }>
    onSelectDefault: () => void
    onSelectPath: (path: string) => void
    onPick: () => void
  }
  employees?: Employee[]
  selectedEmployeeId?: string
  onSelectEmployee?: (id: string) => void
  defaultProviderId?: string
  defaultModelId?: string
  onDefaultModelChange?: (providerId: string, modelId: string) => void
  enableThinking?: ThinkingLevel
  onThinkingChange?: (level: ThinkingLevel) => void
  isCompacting?: boolean
  /** 隐藏高级工具栏（高权限/模型对比/资料库/极简模式/技能下拉），用于轻量对话视图 */
  hideToolbar?: boolean
  /** 输入框上方的附加区域（任务确认卡等），与输入框同宽 */
  approvalSlot?: React.ReactNode
}> = ({ onSend, onStop, isStreaming, placeholder, providers, attachedImages, onImagesChange, selectedModels, onModelsChange, selectedCollectionIds, onSelectedCollectionIdsChange, allCollections, minimalMode, onMinimalModeChange, canToggleMinimalMode, conversationId, getInitialDraft, onDraftChange, draftRestoreKey, availableSkills, centerMode, showEmployeeSelector, workspaceSelector, employees, selectedEmployeeId, onSelectEmployee, defaultProviderId, defaultModelId, onDefaultModelChange, enableThinking, onThinkingChange, isCompacting, hideToolbar, approvalSlot }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const [isDragOver, setIsDragOver] = useState(false)
  /** 任务级完全允许（高权限）：确认弹窗"本轮任务不再提醒"与执行模式选择器共用同一登记，整个任务期间生效 */
  const taskFullAllow = useTaskPermissionStore((s) => (conversationId ? !!s.enabledKeys[conversationId] : false))
  const enableTaskFullAllow = useTaskPermissionStore((s) => s.enable)
  const disableTaskFullAllow = useTaskPermissionStore((s) => s.disable)
  /** 新任务尚未创建会话时的完全允许草稿态；会话创建时由 useEmployeeChat 登记到该会话，此处仅负责新任务视图的显示 */
  const [draftFullAllow, setDraftFullAllow] = useState(false)
  const fullAllow = conversationId ? taskFullAllow : draftFullAllow
  // 会话已存在（新任务已创建或切到既有任务）时，完全允许以任务级登记为准，清掉草稿避免残留到其他新任务
  useEffect(() => {
    if (conversationId) setDraftFullAllow(false)
  }, [conversationId])
  const editorRef = useRef<HTMLDivElement>(null)
  /** 编辑器内容是否为空（控制 placeholder） */
  const [editorEmpty, setEditorEmpty] = useState(true)

  // ---- 待发送队列：回复进行中按 Enter/发送时先排队，回复结束后自动发送 ----
  // 无会话（新任务/插件临时对话）时用实例级 key，避免不同输入框共用同一队列
  const localQueueKeyRef = useRef(`local_${Math.random().toString(36).slice(2)}`)
  const queueKey = conversationId || localQueueKeyRef.current
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>(
    () => (conversationId ? _persistentQueues.get(conversationId) || [] : [])
  )
  /** 当前队列归属的 key，用于切换任务时保存/恢复各自的队列 */
  const queueKeyRef = useRef(queueKey)
  const queueRef = useRef(queuedMessages)
  queueRef.current = queuedMessages
  /** 上一轮是否处于回复/压缩中：用于识别回复结束、自动续发队列 */
  const prevBusyRef = useRef(isStreaming || isCompacting)
  /** 回复结束后是否还有队列待发（编辑队列项时暂缓） */
  const drainArmedRef = useRef(false)
  /** 正在内联编辑的队列项；编辑期间暂停自动发送，避免把用户正在修改的内容发出去 */
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null)
  const [editingQueueText, setEditingQueueText] = useState('')

  useEffect(() => {
    if (queueKeyRef.current !== queueKey) {
      if (!queueKeyRef.current.startsWith('local_')) {
        if (queueRef.current.length > 0) {
          _persistentQueues.set(queueKeyRef.current, queueRef.current)
        } else {
          _persistentQueues.delete(queueKeyRef.current)
        }
      }
      queueKeyRef.current = queueKey
      // 切换任务时重置续发状态：绝不能把上一个任务的队列发到当前任务
      prevBusyRef.current = isStreaming || isCompacting
      drainArmedRef.current = false
      setQueuedMessages(conversationId ? _persistentQueues.get(conversationId) || [] : [])
      setEditingQueueId(null)
      setEditingQueueText('')
      return
    }
    if (conversationId) {
      if (queuedMessages.length > 0) {
        _persistentQueues.set(conversationId, queuedMessages)
      } else {
        _persistentQueues.delete(conversationId)
      }
    }
  }, [queueKey, conversationId, queuedMessages, isStreaming, isCompacting])

  /** 同步：内容变化后通知父组件（草稿），并更新空状态（控制 placeholder 与发送按钮） */
  const emitDraftChange = useCallback(() => {
    if (!editorRef.current) return
    // 仅换行/空格/零宽字符不算有效内容（contentEditable 常残留 <br>），避免空白草稿让 placeholder 永久消失
    const empty = isEditorEffectivelyEmpty(editorRef.current)
    onDraftChange?.(empty ? '' : serializeEditorDraft(editorRef.current))
    // 同步更新空状态（即使未提供 onDraftChange 也必须更新，否则 placeholder 不消失、发送按钮不恢复）
    setEditorEmpty(empty)
  }, [onDraftChange])

  /** 仅用于统计文件令牌数量（供删除回调使用，避免重复状态） */
  const removeFileById = useCallback((_id: string) => {
    emitDraftChange()
  }, [emitDraftChange])

  /** 恢复草稿到 contentEditable 编辑器 */
  const restoreDraft = useCallback((draftStr: string) => {
    const editor = editorRef.current
    if (!editor) return
    deserializeDraftToEditor(editor, draftStr || '', token, removeFileById)
    // 以恢复后的真实内容判断是否为空：空白字符/孤立 <br> 一律清空，保证 placeholder 可见
    const empty = isEditorEffectivelyEmpty(editor)
    if (empty) {
      editor.innerHTML = ''
      // 草稿里只有空白时顺手清掉缓存，避免每次进入都恢复出一段"看不见的内容"
      if (draftStr) onDraftChange?.('')
    }
    setEditorEmpty(empty)
  }, [token, removeFileById, onDraftChange])

  // restoreDraft / getInitialDraft 的 ref 镜像：useEffect 通过 ref 读取最新实现，
  // 避免其引用变化（如主题 token 变化、onDraftChange 重建）触发恢复草稿覆盖编辑器内容
  const restoreDraftRef = useRef(restoreDraft)
  restoreDraftRef.current = restoreDraft
  const getInitialDraftRef = useRef(getInitialDraft)
  getInitialDraftRef.current = getInitialDraft

  /** 在当前光标位置插入文件令牌（如果没有选区，则定位到末尾） */
  const insertFileTokenAtCursor = useCallback((files: Array<{ id: string; name: string; path: string }>) => {
    const editor = editorRef.current
    if (!editor) return

    editor.focus()
    // 确保光标位于编辑器内，否则把光标移到内容末尾
    const sel = window.getSelection()
    const currentRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
    if (sel && (!currentRange || !editor.contains(currentRange.startContainer))) {
      const endRange = document.createRange()
      endRange.selectNodeContents(editor)
      endRange.collapse(false)
      sel.removeAllRanges()
      sel.addRange(endRange)
    }

    for (const f of files) {
      const tokenEl = createFileTokenElement(f.id, f.name, f.path, token)
      // 交由浏览器编辑管线插入（末尾补零宽空格便于继续输入）：
      // 手动 range.insertNode 会破坏 Chromium 内部光标状态，导致后续输入字符重复。
      // 注意：Chromium 对含 contenteditable="false" 的 HTML 调用 insertHTML 会返回 false
      // 但仍完成插入，因此不能依据返回值做回退，否则令牌会被插入两次（文件显示成两份）。
      document.execCommand('insertHTML', false, `${tokenEl.outerHTML}\u200B`)
    }

    // execCommand 插入的是全新的 DOM 节点，需重新绑定令牌交互事件
    editor.querySelectorAll(`.${FILE_TOKEN_CLASS}`).forEach(node => {
      bindFileTokenElement(node as HTMLElement, token, removeFileById)
    })

    // Chromium 插入不可编辑节点后不会自动把光标置于其后，需显式移动，
    // 否则继续输入会插到令牌前方（粘贴文件后光标停在文件前面）
    const lastFile = files[files.length - 1]
    const lastTokenEl = editor.querySelector<HTMLElement>(`.${FILE_TOKEN_CLASS}[data-id="${lastFile.id}"]`)
    if (lastTokenEl) {
      const range = document.createRange()
      const next = lastTokenEl.nextSibling
      // 优先落在令牌后紧跟的零宽空格文本节点内，保持可继续输入
      if (next && next.nodeType === Node.TEXT_NODE) {
        range.setStart(next, 0)
      } else {
        range.setStartAfter(lastTokenEl)
      }
      range.collapse(true)
      const sel = window.getSelection()
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }

    emitDraftChange()
  }, [token, removeFileById, emitDraftChange])

  // 仅在 conversationId / 草稿恢复键变化（切换对话、首次挂载、新任务员工首次确定）时恢复草稿；
  // restoreDraft / getInitialDraft 通过 ref 读取最新实现，避免其引用变化（如主题 token 变化）触发覆盖。
  const prevDraftRestoreKeyRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const getDraft = getInitialDraftRef.current
    if (!getDraft) return
    const prevKey = prevDraftRestoreKeyRef.current
    prevDraftRestoreKeyRef.current = draftRestoreKey ?? null
    // 新任务模式下员工之间切换：保留当前编辑内容，不被目标员工的旧草稿覆盖
    if (prevKey && draftRestoreKey && prevKey !== draftRestoreKey) return
    restoreDraftRef.current(getDraft())
  }, [conversationId, draftRestoreKey])

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
      // 压缩期间禁止发送（流式回复期间允许排队，由 handleSend 入队）
      if (isCompacting) return
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
  }, [getPlainText, currentSlashItems, emitDraftChange, isCompacting])

  // 把 `/<skill-name> <args>` 转换为对 LLM 的明确工具调用指令
  // skill 激活统一通过 activate_skill 工具；一条消息内可含多个技能命令，逐个转换
  const convertSkillCommand = useCallback((raw: string): string => {
    const validSkillNames = new Set(invocableSkills.map(s => s.name))
    return raw.replace(/(^|\s)\/([a-z0-9-]+)/g, (m, pre, name) => {
      if (!validSkillNames.has(name)) return m
      return `${pre}${t('workbench.skillCommand', { name })}`
    })
  }, [invocableSkills, t])

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
    return !isEditorEffectivelyEmpty(editorRef.current)
  }, [])

  const clearComposer = useCallback(() => {
    if (editorRef.current) editorRef.current.innerHTML = ''
    emitDraftChange()
    onDraftChange?.('')
  }, [emitDraftChange, onDraftChange])

  const handleSend = useCallback(() => {
    // 压缩期间禁止发送，避免消息被下游丢弃后输入框仍被清空
    if (isCompacting) return
    if (!hasEditorContent() && attachedImages.length === 0) return
    const imageUrls = attachedImages.map(img => img.dataUrl)
    let content = editorRef.current ? extractContentFromEditor(editorRef.current).replace(/\u200B/g, '') : ''
    content = content.trim()
    // 斜杠命令转换仅适用于以 / 开头且后跟 skill 名的情况
    if (content.startsWith('/') && invocableSkills.some(s => content.slice(1).startsWith(s.name))) {
      content = convertSkillCommand(content)
    }
    // 仅附加文件令牌、没有文字时，extractContentFromEditor 会把令牌路径写入 content，仍可正常发送；
    // 若 content 为空且无图片，上面的 hasEditorContent 已提前返回。
    if (isStreaming) {
      // 回复进行中：消息进入待发送队列，回复结束后自动发出
      const item: QueuedChatMessage = {
        id: genQueueId(),
        content,
        images: imageUrls,
        models: [...selectedModels],
        options: { highPermission: fullAllow },
      }
      const next = [...queueRef.current, item]
      queueRef.current = next
      setQueuedMessages(next)
      // 队列项已完整保存内容/附件/模型，清空当前输入区，避免重复展示
      clearComposer()
      onImagesChange([])
      onModelsChange([])
      return
    }
    onSend(content, imageUrls, selectedModels, { highPermission: fullAllow })
    clearComposer()
  }, [hasEditorContent, attachedImages, selectedModels, fullAllow, onSend, invocableSkills, convertSkillCommand, clearComposer, onImagesChange, onModelsChange, isStreaming, isCompacting])

  // 每次渲染都同步最新 handleSend 到 ref，供 handleKeyDown 的 Enter 键调用：
  //  - 避免 TS2448/TS2454 前向声明报错
  //  - 确保 handleKeyDown 调用时捕获的是最新闭包（含最新 attachedImages / content）
  handleSendRef.current = handleSend

  /** 从队列取出并发送（默认队首；指定 id 时只发该条），供自动续发与「立即发送」复用 */
  const takeQueuedAndSend = useCallback((targetId?: string) => {
    const current = queueRef.current
    const item = targetId ? current.find(q => q.id === targetId) : current[0]
    if (!item) return false
    const next = current.filter(q => q.id !== item.id)
    queueRef.current = next
    setQueuedMessages(next)
    onSend(item.content, item.images, item.models, { ...item.options, fromQueue: true })
    return true
  }, [onSend])

  /** 流式结束后自动续发：排队期间用户可能正在编辑，编辑完成/取消后再继续 */
  useEffect(() => {
    const busy = isStreaming || isCompacting
    if (busy) {
      prevBusyRef.current = true
      return
    }
    if (prevBusyRef.current) {
      prevBusyRef.current = false
      drainArmedRef.current = queueRef.current.length > 0
    }
    if (drainArmedRef.current && !editingQueueId && queueRef.current.length > 0) {
      drainArmedRef.current = false
      takeQueuedAndSend()
    }
  }, [isStreaming, isCompacting, editingQueueId, queuedMessages, takeQueuedAndSend])

  /** 立即发送：把目标项提到队首；正在回复时先停止当前回复，结束后优先发送该条 */
  const handleSendQueuedNow = useCallback((id: string) => {
    if (isCompacting) return
    const current = queueRef.current
    const item = current.find(q => q.id === id)
    if (!item) return
    setEditingQueueId(null)
    setEditingQueueText('')
    const next = [item, ...current.filter(q => q.id !== id)]
    queueRef.current = next
    setQueuedMessages(next)
    if (isStreaming) {
      drainArmedRef.current = true
      void Promise.resolve(onStop()).catch(() => { /* 停止失败时保持当前回复 */ })
      return
    }
    // 编辑暂停或上游未真正发起流式时兜底直接发送
    takeQueuedAndSend(id)
  }, [isCompacting, isStreaming, onStop, takeQueuedAndSend])

  const startEditQueued = useCallback((item: QueuedChatMessage) => {
    setEditingQueueId(item.id)
    setEditingQueueText(item.content)
  }, [])

  const cancelEditQueued = useCallback(() => {
    setEditingQueueId(null)
    setEditingQueueText('')
  }, [])

  const saveEditQueued = useCallback(() => {
    if (!editingQueueId) return
    const current = queueRef.current
    const target = current.find(q => q.id === editingQueueId)
    if (!target) {
      cancelEditQueued()
      return
    }
    const content = editingQueueText.trim()
    if (!content && target.images.length === 0) return
    const next = current.map(q => (q.id === editingQueueId ? { ...q, content } : q))
    queueRef.current = next
    setQueuedMessages(next)
    cancelEditQueued()
  }, [editingQueueId, editingQueueText, cancelEditQueued])

  const deleteQueued = useCallback((id: string) => {
    const next = queueRef.current.filter(q => q.id !== id)
    queueRef.current = next
    setQueuedMessages(next)
    if (editingQueueId === id) cancelEditQueued()
  }, [editingQueueId, cancelEditQueued])

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
        reader.onload = async (ev) => {
          const dataUrl = ev.target?.result as string
          loadedImages.push(await buildAttachedImage(dataUrl, file.name || 'pasted-image.png'))
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
    // 使用 execCommand('insertText') 由浏览器负责插入与选区维护，
    // 避免手动 insertNode 破坏光标状态，导致后续手动输入出现重复字符（Chromium bug）
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    document.execCommand('insertText', false, normalized)
    emitDraftChange()
  }, [emitDraftChange])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    // 收集剪贴板中的全部图片项，支持多图同时粘贴
    const imageFiles: File[] = []
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault()
      const loadedImages: AttachedImage[] = []
      let loadedCount = 0
      for (const file of imageFiles) {
        const reader = new FileReader()
        reader.onload = async (ev) => {
          const dataUrl = ev.target?.result as string
          loadedImages.push(await buildAttachedImage(dataUrl, file.name || 'pasted-image.png'))
          loadedCount++
          if (loadedCount === imageFiles.length) {
            onImagesChange([...attachedImagesRef.current, ...loadedImages])
          }
        }
        reader.readAsDataURL(file)
      }
      return
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

  /** 编辑器右键菜单：记录弹出位置、当前选区（供剪切/复制恢复）与选区是否存在 */
  const [editorContextMenu, setEditorContextMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null)
  const editorMenuRef = useRef<HTMLDivElement>(null)
  const editorMenuRangeRef = useRef<Range | null>(null)

  const handleEditorContextMenu = useCallback((e: React.MouseEvent) => {
    const editor = editorRef.current
    if (!editor || isCompacting) return
    e.preventDefault()
    const sel = window.getSelection()
    let range: Range | null = null
    let hasSelection = false
    if (sel && sel.rangeCount > 0) {
      const current = sel.getRangeAt(0)
      if (editor.contains(current.commonAncestorContainer)) {
        hasSelection = !current.collapsed
        range = current.cloneRange()
      }
    }
    editorMenuRangeRef.current = range
    setEditorContextMenu({ x: e.clientX, y: e.clientY, hasSelection })
  }, [isCompacting])

  /** 恢复右键时的选区：点击菜单项会使编辑器失焦并丢失选区，剪切/复制前需还原 */
  const restoreEditorSelection = useCallback((): boolean => {
    const editor = editorRef.current
    const range = editorMenuRangeRef.current
    if (!editor || !range) return false
    editor.focus()
    const sel = window.getSelection()
    if (!sel) return false
    sel.removeAllRanges()
    sel.addRange(range)
    return true
  }, [])

  // 菜单打开时，点击菜单外 / 滚动 / 再次右键 / ESC 均关闭
  useEffect(() => {
    if (!editorContextMenu) return
    const closeOnOutside = (e: Event) => {
      if (editorMenuRef.current?.contains(e.target as Node)) return
      setEditorContextMenu(null)
    }
    const closeOnEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditorContextMenu(null) }
    const opts = { capture: true } as AddEventListenerOptions
    document.addEventListener('mousedown', closeOnOutside, opts)
    document.addEventListener('wheel', closeOnOutside, opts)
    document.addEventListener('contextmenu', closeOnOutside, opts)
    document.addEventListener('keydown', closeOnEscape, opts)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside, opts)
      document.removeEventListener('wheel', closeOnOutside, opts)
      document.removeEventListener('contextmenu', closeOnOutside, opts)
      document.removeEventListener('keydown', closeOnEscape, opts)
    }
  }, [editorContextMenu])

  // 菜单打开后按实际尺寸做视口边界钳制，避免光标靠近右缘/底部时菜单溢出屏幕
  useEffect(() => {
    const menu = editorMenuRef.current
    if (!editorContextMenu || !menu) return
    const { width, height } = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(editorContextMenu.x, window.innerWidth - width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(editorContextMenu.y, window.innerHeight - height - 8))}px`
  }, [editorContextMenu])

  const handleMenuCut = useCallback(() => {
    setEditorContextMenu(null)
    if (!restoreEditorSelection()) return
    document.execCommand('cut')
    emitDraftChange()
  }, [restoreEditorSelection, emitDraftChange])

  const handleMenuCopy = useCallback(() => {
    setEditorContextMenu(null)
    if (!restoreEditorSelection()) return
    document.execCommand('copy')
  }, [restoreEditorSelection])

  const handleMenuSelectAll = useCallback(() => {
    setEditorContextMenu(null)
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const sel = window.getSelection()
    if (!sel) return
    const range = document.createRange()
    range.selectNodeContents(editor)
    sel.removeAllRanges()
    sel.addRange(range)
  }, [])

  /** 右键粘贴：优先读取剪贴板富内容（图片走附件落盘、文本插入光标处），失败降级为纯文本 */
  const handleMenuPaste = useCallback(async () => {
    setEditorContextMenu(null)
    const editor = editorRef.current
    if (!editor) return
    const images: AttachedImage[] = []
    const texts: string[] = []
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imageType = item.types.find(type => type.startsWith('image/'))
        if (imageType) {
          const blob = await item.getType(imageType)
          images.push(await buildAttachedImage(await blobToDataUrl(blob), 'pasted-image.png'))
        } else if (item.types.includes('text/plain')) {
          texts.push(await (await item.getType('text/plain')).text())
        }
      }
    } catch {
      // 富内容读取不可用，降级为纯文本
      try {
        const text = await navigator.clipboard.readText()
        if (text) texts.push(text)
      } catch { /* 忽略剪贴板读取失败 */ }
    }
    if (images.length > 0) onImagesChange([...attachedImagesRef.current, ...images])
    if (texts.length > 0) {
      // 有选区时按选区替换插入，否则回到编辑器光标处追加
      if (!restoreEditorSelection()) editor.focus()
      insertPlainTextAtCursor(texts.join('\n'))
    }
  }, [onImagesChange, insertPlainTextAtCursor, restoreEditorSelection])

  const editorContextMenuItems = useMemo(() => {
    const noSelection = !editorContextMenu?.hasSelection
    return [
      { key: 'cut', icon: <ScissorOutlined />, label: t('common.cut'), disabled: noSelection, onClick: handleMenuCut },
      { key: 'copy', icon: <CopyOutlined />, label: t('common.copy'), disabled: noSelection, onClick: handleMenuCopy },
      { key: 'paste', icon: <SnippetsOutlined />, label: t('common.paste'), disabled: false, onClick: handleMenuPaste },
      { key: 'selectAll', icon: <SelectOutlined />, label: t('common.selectAll'), disabled: false, onClick: handleMenuSelectAll },
    ]
  }, [editorContextMenu?.hasSelection, t, handleMenuCut, handleMenuCopy, handleMenuPaste, handleMenuSelectAll])

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
        reader.onload = async (ev) => {
          const dataUrl = ev.target?.result as string
          loadedImages.push(await buildAttachedImage(dataUrl, file.name))
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
  const [showModePicker, setShowModePicker] = useState(false)

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
    <div style={{ width: 192, maxHeight: 420, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                <RobotOutlined style={{ fontSize: 11, flexShrink: 0 }} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{provider.name}</span>
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
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [workspaceSearch, setWorkspaceSearch] = useState('')

  const defaultModelLabel = useMemo(() => {
    if (!defaultProviderId || !defaultModelId) return ''
    const p = providers.find((p: any) => p.id === defaultProviderId)
    if (!p) return defaultModelId
    const models = getProviderModels(p)
    const m = models.find((m: any) => m.model === defaultModelId)
    return m?.name || defaultModelId
  }, [defaultProviderId, defaultModelId, providers])

  // 当前 provider 的思考能力：决定灯泡按钮是否显示及菜单项
  const thinkingCapability = useMemo(() => {
    const p = providers.find((p: any) => p.id === defaultProviderId)
    const providerType = p?.provider_type as string | undefined
    const effortSupported = supportsReasoningEffort(providerType)
    const thinkingSupported = supportsThinking(providerType)
    if (effortSupported) {
      // 支持 reasoning_effort：4 级
      return { visible: true, levels: [false, 'low', 'medium', 'high'] as ThinkingLevel[], effortSupported: true }
    }
    if (thinkingSupported) {
      // 仅支持思考开关：2 级（off / on→'high'）
      return { visible: true, levels: [false, 'high'] as ThinkingLevel[], effortSupported: false }
    }
    return { visible: false, levels: [] as ThinkingLevel[], effortSupported: false }
  }, [defaultProviderId, providers])

  const thinkingLevelLabel = useCallback((level?: ThinkingLevel) => t(
    !level
      ? 'workbench.thinkingLevelOff'
      : level === 'low' ? 'workbench.thinkingLevelLow'
      : level === 'medium' ? 'workbench.thinkingLevelMedium'
      : 'workbench.thinkingLevelHigh'
  ), [t])

  const thinkingTrigger = (
    <Tooltip title={thinkingCapability.effortSupported
      ? `${t('workbench.thinkingLevel')}: ${thinkingLevelLabel(enableThinking)}`
      : enableThinking ? t('workbench.thinkingEnabled') : t('workbench.thinkingDisabled')}>
      <Button type="text" size="small"
        onClick={onThinkingChange && !thinkingCapability.effortSupported
          ? () => onThinkingChange(enableThinking ? false : 'high')
          : undefined}
        style={{
          color: token.colorTextSecondary,
          padding: '0 4px 0 0', height: 18, minWidth: 18, borderRadius: 4,
        }}>
        {enableThinking ? <BulbFilled style={{ fontSize: 12 }} /> : <BulbOutlined style={{ fontSize: 12 }} />}
      </Button>
    </Tooltip>
  )

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
    <div style={{ width: 180, maxHeight: 420, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                <RobotOutlined style={{ fontSize: 11, flexShrink: 0 }} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{provider.name}</span>
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

  // 数字员工弹层的过滤结果
  const filteredEmployees = useMemo(() => {
    const list = employees || []
    if (!employeeSearch.trim()) return list
    const search = employeeSearch.toLowerCase()
    return list.filter(e =>
      e.name.toLowerCase().includes(search) ||
      (e.description || '').toLowerCase().includes(search)
    )
  }, [employees, employeeSearch])

  // 当前数字员工名称（选择器触发器展示）
  const activeEmployeeName = useMemo(
    () => (employees || []).find(e => e.id === selectedEmployeeId)?.name,
    [employees, selectedEmployeeId]
  )

  // 工作区触发器文案：指定目录取目录名，否则为默认工作区
  const workspaceLabel = workspaceSelector?.path
    ? getDirName(workspaceSelector.path)
    : t('tasks.defaultWorkspace')

  // 工作区弹层的过滤结果
  const filteredWorkspaces = useMemo(() => {
    const list = workspaceSelector?.recent || []
    if (!workspaceSearch.trim()) return list
    const search = workspaceSearch.toLowerCase()
    return list.filter(ws => ws.label.toLowerCase().includes(search) || ws.path.toLowerCase().includes(search))
  }, [workspaceSelector?.recent, workspaceSearch])

  /** 选择器触发器样式：无边框文字按钮，悬停/展开时高亮 */
  const selectorTriggerStyle = (open: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '3px 8px', borderRadius: 6, maxWidth: 200, minWidth: 0,
    border: '1px solid transparent', background: open ? token.colorFillTertiary : 'transparent',
    color: open ? token.colorPrimary : token.colorText,
    cursor: 'pointer', userSelect: 'none', fontFamily: 'inherit',
    fontSize: 13, lineHeight: '20px',
    transition: 'background 0.15s ease, color 0.15s ease',
  })

  // 执行模式：纯对话（原极简模式）/ 手动审批（默认）/ 完全允许（任务级高权限），三者互斥
  const executionMode: 'pureChat' | 'manual' | 'fullAllow' =
    minimalMode ? 'pureChat' : (fullAllow ? 'fullAllow' : 'manual')
  // 任务已有内容时模式已冻结（主进程按任务首条消息固定工具与系统提示词），不允许再切换
  const modeLocked = !canToggleMinimalMode

  /** 关闭完全允许：有会话时撤销任务级登记，新任务模式回落到草稿态 */
  const clearFullAllow = useCallback(() => {
    if (conversationId) disableTaskFullAllow(conversationId)
    setDraftFullAllow(false)
  }, [conversationId, disableTaskFullAllow])

  const selectExecutionMode = useCallback((mode: 'pureChat' | 'manual' | 'fullAllow') => {
    setShowModePicker(false)
    if (mode === executionMode) return
    // 从纯对话切出需要解除极简模式，受任务冻结限制
    if (minimalMode && modeLocked) return
    if (mode === 'pureChat') {
      if (modeLocked) return
      onMinimalModeChange(true)
      clearFullAllow()
      return
    }
    if (mode === 'fullAllow') {
      if (minimalMode) onMinimalModeChange(false)
      if (conversationId) enableTaskFullAllow(conversationId)
      else setDraftFullAllow(true)
      return
    }
    if (minimalMode) onMinimalModeChange(false)
    clearFullAllow()
  }, [executionMode, minimalMode, modeLocked, conversationId, onMinimalModeChange, enableTaskFullAllow, clearFullAllow])

  const modeLabel = executionMode === 'pureChat'
    ? t('workbench.modePureChat')
    : executionMode === 'fullAllow' ? t('workbench.modeFullAllow') : t('workbench.modeManualApproval')
  const modeDesc = executionMode === 'pureChat'
    ? t('workbench.modePureChatDesc')
    : executionMode === 'fullAllow' ? t('workbench.modeFullAllowDesc') : t('workbench.modeManualApprovalDesc')

  const modePickerContent = useMemo(() => {
    const options: Array<{
      key: 'pureChat' | 'manual' | 'fullAllow'
      icon: React.ReactNode
      title: string
      desc: string
      disabled: boolean
    }> = [
      {
        key: 'pureChat',
        icon: <MessageOutlined />,
        title: t('workbench.modePureChat'),
        desc: t('workbench.modePureChatDesc'),
        disabled: executionMode !== 'pureChat' && modeLocked,
      },
      {
        key: 'manual',
        icon: <SafetyOutlined />,
        title: t('workbench.modeManualApproval'),
        desc: t('workbench.modeManualApprovalDesc'),
        disabled: minimalMode && modeLocked,
      },
      {
        key: 'fullAllow',
        icon: <UnlockOutlined />,
        title: t('workbench.modeFullAllow'),
        desc: t('workbench.modeFullAllowDesc'),
        disabled: minimalMode && modeLocked,
      },
    ]
    return (
      <div style={{ width: 208, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ padding: '2px 8px 6px', fontSize: 11, color: token.colorTextQuaternary }}>
          {t('workbench.executionMode')}
        </div>
        {options.map(opt => {
          const selected = executionMode === opt.key
          return (
            <div
              key={opt.key}
              title={opt.disabled ? t('workbench.modeLockedTip') : undefined}
              onClick={() => { if (!opt.disabled) selectExecutionMode(opt.key) }}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px',
                borderRadius: 6,
                cursor: opt.disabled ? 'not-allowed' : 'pointer',
                opacity: opt.disabled ? 0.45 : 1,
                background: selected ? token.colorPrimaryBg : 'transparent',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { if (!opt.disabled && !selected) e.currentTarget.style.background = token.colorBgTextHover }}
              onMouseLeave={(e) => { e.currentTarget.style.background = selected ? token.colorPrimaryBg : 'transparent' }}
            >
              <span style={{ fontSize: 13, marginTop: 2, color: selected ? token.colorPrimary : token.colorTextSecondary }}>{opt.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: selected ? token.colorPrimary : token.colorText }}>{opt.title}</div>
                <div style={{ fontSize: 11, lineHeight: 1.5, color: token.colorTextTertiary }}>{opt.desc}</div>
              </div>
              {selected && <CheckOutlined style={{ fontSize: 11, marginTop: 3, color: token.colorPrimary }} />}
            </div>
          )
        })}
      </div>
    )
  }, [t, token, executionMode, modeLocked, minimalMode, selectExecutionMode])

  return (
    <div style={centerMode
      ? { padding: '0 16px', flexShrink: 0, maxWidth: 720, width: '100%', margin: '0 auto' }
      // 与消息区共用同一个内容列：24px 内边距 + 820px 内容宽（868 = 820 + 左右内边距）
      : { padding: '8px 24px 12px', flexShrink: 0, maxWidth: 868, width: '100%', margin: '0 auto' }
    }>
      {(workspaceSelector || (showEmployeeSelector && employees && employees.length > 0)) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingTop: 6, paddingBottom: 6, maxWidth: '100%' }}>
          {/* 工作区选择：搜索 + 最近使用目录，底部提供默认工作区 / 选择目录 */}
          {workspaceSelector && (
            <Popover
              open={workspacePickerOpen}
              onOpenChange={(o) => { setWorkspacePickerOpen(o); if (!o) setWorkspaceSearch('') }}
              content={
                <div style={{ width: 180 }}>
                  <Input
                    placeholder={t('tasks.searchWorkspace')}
                    prefix={<SearchOutlined style={{ color: token.colorTextQuaternary, fontSize: 12 }} />}
                    value={workspaceSearch}
                    onChange={(e) => setWorkspaceSearch(e.target.value)}
                    allowClear
                    size="small"
                    variant="borderless"
                    style={{ padding: '2px 8px', marginBottom: 4 }}
                  />
                  {/* 单行 34px + 间距 2px：默认展示 4 个，其余滚动 */}
                  <div style={{ maxHeight: 144, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {filteredWorkspaces.length === 0 && (
                      <div style={{ padding: '20px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12 }}>
                        {workspaceSearch ? t('tasks.noMatchingWorkspace') : t('tasks.noRecentWorkspace')}
                      </div>
                    )}
                    {filteredWorkspaces.map(ws => {
                      const selected = workspaceSelector.path === ws.path
                      return (
                        <div
                          key={ws.path}
                          title={ws.path}
                          onClick={() => {
                            setWorkspacePickerOpen(false)
                            setWorkspaceSearch('')
                            workspaceSelector.onSelectPath(ws.path)
                          }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '7px 8px', borderRadius: 6, cursor: 'pointer',
                            fontSize: 13,
                            background: selected ? token.colorPrimaryBg : 'transparent',
                            color: selected ? token.colorPrimary : token.colorText,
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = token.colorBgTextHover }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = selected ? token.colorPrimaryBg : 'transparent' }}
                        >
                          <FolderOutlined style={{ fontSize: 14 }} />
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.label}</span>
                          {selected && <CheckOutlined style={{ fontSize: 11 }} />}
                        </div>
                      )
                    })}
                  </div>
                  <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, marginTop: 4, paddingTop: 4 }}>
                    <div
                      onClick={() => { setWorkspacePickerOpen(false); setWorkspaceSearch(''); workspaceSelector.onSelectDefault() }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '7px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                        color: workspaceSelector.path ? token.colorText : token.colorPrimary,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = token.colorBgTextHover }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                    >
                      <FolderOutlined style={{ fontSize: 14 }} />
                      <span style={{ flex: 1 }}>{t('tasks.defaultWorkspace')}</span>
                      {!workspaceSelector.path && <CheckOutlined style={{ fontSize: 11 }} />}
                    </div>
                    <div
                      onClick={() => { setWorkspacePickerOpen(false); setWorkspaceSearch(''); workspaceSelector.onPick() }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '7px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                        color: token.colorText,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = token.colorBgTextHover }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                    >
                      <FolderOpenOutlined style={{ fontSize: 14 }} />
                      <span style={{ flex: 1 }}>{t('tasks.chooseWorkspaceDir')}</span>
                    </div>
                  </div>
                </div>
              }
              trigger="click"
              placement="bottomLeft"
              arrow={false}
              styles={{ container: { padding: 8 } }}
            >
              <button
                type="button"
                title={workspaceSelector.path || workspaceLabel}
                style={selectorTriggerStyle(workspacePickerOpen)}
                onMouseEnter={(e) => {
                  if (workspacePickerOpen) return
                  e.currentTarget.style.background = token.colorFillTertiary
                }}
                onMouseLeave={(e) => {
                  if (workspacePickerOpen) return
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <FolderOutlined style={{ fontSize: 14 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workspaceLabel}</span>
                <DownOutlined style={{ fontSize: 10, opacity: 0.5 }} />
              </button>
            </Popover>
          )}
          {/* 数字员工选择：搜索 + 员工列表 */}
          {showEmployeeSelector && employees && employees.length > 0 && (
            <Popover
              open={employeePickerOpen}
              onOpenChange={(o) => { setEmployeePickerOpen(o); if (!o) setEmployeeSearch('') }}
              content={
                <div style={{ width: 170, display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                  {/* 单行 34px + 间距 2px：默认展示 5 个，其余滚动 */}
                  <div style={{ maxHeight: 178, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {filteredEmployees.length === 0 && (
                      <div style={{ padding: '24px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12 }}>
                        {employeeSearch ? t('workbench.noMatchingEmployee') : t('digitalEmployees.noEmployees')}
                      </div>
                    )}
                    {filteredEmployees.map(emp => {
                      const empActive = emp.id === selectedEmployeeId
                      return (
                        <div
                          key={emp.id}
                          onClick={() => { onSelectEmployee?.(emp.id); setEmployeePickerOpen(false); setEmployeeSearch('') }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '7px 8px', borderRadius: 6, cursor: 'pointer',
                            fontSize: 13,
                            background: empActive ? token.colorPrimaryBg : 'transparent',
                            color: empActive ? token.colorPrimary : token.colorText,
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={(e) => { if (!empActive) e.currentTarget.style.background = token.colorBgTextHover }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = empActive ? token.colorPrimaryBg : 'transparent' }}
                        >
                          <EmployeeAvatar
                            employeeId={emp.id}
                            avatarType={emp.avatar_type}
                            avatarIcon={emp.avatar_icon}
                            avatarColor={emp.avatar_color}
                            avatarImage={emp.avatar_image}
                            source={emp.source}
                            size={20}
                            active={empActive}
                          />
                          <span style={{
                            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            fontWeight: empActive ? 500 : 400,
                          }}>
                            {emp.name}
                          </span>
                          {empActive && <CheckOutlined style={{ fontSize: 11 }} />}
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
              <button
                type="button"
                title={activeEmployeeName || t('nav.employees')}
                style={selectorTriggerStyle(employeePickerOpen)}
                onMouseEnter={(e) => {
                  if (employeePickerOpen) return
                  e.currentTarget.style.background = token.colorFillTertiary
                }}
                onMouseLeave={(e) => {
                  if (employeePickerOpen) return
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <RobotOutlined style={{ fontSize: 14 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeEmployeeName || t('nav.employees')}
                </span>
                <DownOutlined style={{ fontSize: 10, opacity: 0.5 }} />
              </button>
            </Popover>
          )}
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
      {!centerMode && approvalSlot}
      {queuedMessages.length > 0 && (
        <div style={{
          marginBottom: 8,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 12,
          background: token.colorFillQuaternary,
          overflowX: 'hidden',
          overflowY: 'auto',
          maxHeight: 250,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
            fontSize: 12, color: token.colorTextTertiary,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            position: 'sticky', top: 0, zIndex: 1,
            background: token.colorFillQuaternary,
          }}>
            <ClockCircleOutlined style={{ fontSize: 12 }} />
            <span style={{ fontWeight: 500, color: token.colorTextSecondary }}>
              {t('workbench.queueTitle', { count: queuedMessages.length })}
            </span>
            <span style={{ marginLeft: 'auto', textAlign: 'right' }}>{t('workbench.queueAutoSendHint')}</span>
          </div>
          {queuedMessages.map((item, index) => {
            const isItemEditing = editingQueueId === item.id
            const preview = formatQueuedPreview(item.content)
            return (
              <div
                key={item.id}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  padding: '7px 10px',
                  borderTop: index > 0 ? `1px solid ${token.colorBorderSecondary}` : undefined,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {isItemEditing ? (
                    <Input.TextArea
                      autoSize={{ minRows: 1, maxRows: 4 }}
                      value={editingQueueText}
                      onChange={(e) => setEditingQueueText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          saveEditQueued()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelEditQueued()
                        }
                      }}
                      autoFocus
                      variant="borderless"
                      style={{
                        background: token.colorBgContainer,
                        border: `1px solid ${token.colorBorder}`,
                        borderRadius: 6,
                        fontSize: 12,
                        lineHeight: 1.5,
                        padding: '4px 8px',
                      }}
                    />
                  ) : (
                    preview && (
                      <div
                        title={preview}
                        style={{
                          fontSize: 12.5,
                          lineHeight: 1.5,
                          color: token.colorText,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}>
                        {preview}
                      </div>
                    )
                  )}
                  {item.images.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                      {item.images.slice(0, 5).map((src, imageIndex) => (
                        <img
                          key={`${src}_${imageIndex}`}
                          src={src}
                          alt=""
                          style={{
                            width: 26, height: 26, objectFit: 'cover', display: 'block',
                            borderRadius: 4, border: `1px solid ${token.colorBorderSecondary}`,
                          }}
                        />
                      ))}
                      {item.images.length > 5 && (
                        <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
                          +{item.images.length - 5}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                  {isItemEditing ? (
                    <>
                      <Tooltip title={t('workbench.queueSave')}>
                        <Button type="text" size="small" icon={<CheckOutlined style={{ fontSize: 12 }} />}
                          aria-label={t('workbench.queueSave')}
                          disabled={!editingQueueText.trim() && item.images.length === 0}
                          onClick={saveEditQueued}
                          style={{ color: token.colorPrimary, width: 24, height: 24, minWidth: 24 }} />
                      </Tooltip>
                      <Tooltip title={t('workbench.queueCancel')}>
                        <Button type="text" size="small" icon={<CloseOutlined style={{ fontSize: 12 }} />}
                          aria-label={t('workbench.queueCancel')}
                          onClick={cancelEditQueued}
                          style={{ color: token.colorTextTertiary, width: 24, height: 24, minWidth: 24 }} />
                      </Tooltip>
                    </>
                  ) : (
                    <>
                      <Tooltip title={t('workbench.queueSendNow')}>
                        <Button type="text" size="small" icon={<SendOutlined style={{ fontSize: 12 }} />}
                          aria-label={t('workbench.queueSendNow')}
                          disabled={isCompacting || editingQueueId !== null}
                          onClick={() => handleSendQueuedNow(item.id)}
                          style={{ color: token.colorTextSecondary, width: 24, height: 24, minWidth: 24 }} />
                      </Tooltip>
                      <Tooltip title={t('workbench.queueEdit')}>
                        <Button type="text" size="small" icon={<EditOutlined style={{ fontSize: 12 }} />}
                          aria-label={t('workbench.queueEdit')}
                          disabled={editingQueueId !== null}
                          onClick={() => startEditQueued(item)}
                          style={{ color: token.colorTextSecondary, width: 24, height: 24, minWidth: 24 }} />
                      </Tooltip>
                      <Tooltip title={t('workbench.queueDelete')}>
                        <Button type="text" size="small" icon={<DeleteOutlined style={{ fontSize: 12 }} />}
                          aria-label={t('workbench.queueDelete')}
                          danger
                          onClick={() => deleteQueued(item.id)}
                          style={{ width: 24, height: 24, minWidth: 24 }} />
                      </Tooltip>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      <div className="wa-composer" style={{ position: 'relative', display: 'flex', gap: 10, alignItems: 'flex-end', borderRadius: 14, padding: '8px 8px 8px 14px', border: `1px solid ${isDragOver ? token.colorPrimary : token.colorBorder}`, transition: 'border-color 0.2s, box-shadow 0.2s' }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onFocusCapture={(e) => { if (!isDragOver) (e.currentTarget as HTMLElement).style.borderColor = token.colorPrimary }}
        onBlurCapture={(e) => { if (!isDragOver) (e.currentTarget as HTMLElement).style.borderColor = token.colorBorder }}>
        {isDragOver && (
          <div style={{
            position: 'absolute', inset: 0,
            borderRadius: 13,
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
        <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* contentEditable 输入框，支持在光标位置嵌入文件令牌 */}
          <div
            ref={editorRef}
            contentEditable={!isCompacting}
            suppressContentEditableWarning
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onContextMenu={handleEditorContextMenu}
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
                zIndex: 1,
                pointerEvents: 'none',
                color: token.colorTextTertiary,
                fontSize: 13,
                lineHeight: 1.6,
                padding: '4px 0',
                left: 0,
                right: 0,
                top: 0,
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
                zIndex: 1,
                pointerEvents: 'none',
                color: token.colorTextTertiary,
                fontSize: 13,
                lineHeight: 1.6,
                padding: '4px 0',
                left: 0,
                top: 0,
              }}
            >
              {t('workbench.compactingPlaceholder')}
            </div>
          )}
          {/* 插件视图注入点：对话输入框上方快捷建议区 */}
          <PluginViewSlot view="chat.quick" />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 0 2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              {!hideToolbar && (
                <Popover
                  content={modePickerContent}
                  trigger="click"
                  placement="topLeft"
                  arrow={false}
                  styles={{ container: { padding: 8 } }}
                  open={showModePicker}
                  onOpenChange={setShowModePicker}
                >
                  <Button type="text" size="small"
                    title={`${modeLabel}\n${modeDesc}`}
                    icon={executionMode === 'pureChat'
                      ? <MessageOutlined style={{ fontSize: 12 }} />
                      : executionMode === 'fullAllow'
                        ? <UnlockOutlined style={{ fontSize: 12 }} />
                        : <SafetyOutlined style={{ fontSize: 12 }} />}
                    style={{
                      color: executionMode === 'pureChat'
                        ? token.colorPrimary
                        : executionMode === 'fullAllow' ? token.colorWarning : token.colorTextQuaternary,
                      padding: '0 6px', height: 20, gap: 4,
                      background: executionMode === 'fullAllow' ? token.colorWarningBg : 'transparent',
                    }}>
                    <span style={{ fontSize: 11 }}>{modeLabel}</span>
                  </Button>
                </Popover>
              )}
              {/* 统一的上传文件按钮（图片 + 普通文件二合一，按类型分流） */}
              <Tooltip title={t('workbench.attachFile')}>
                <Button type="text" size="small" icon={<PaperClipOutlined style={{ fontSize: 12 }} />}
                  onClick={() => fileInputRef.current?.click()}
                  style={{ color: token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20 }} />
              </Tooltip>
              {/* 插件视图注入点：对话输入框工具栏 */}
              <PluginViewSlot view="chat.toolbar" />
              {!hideToolbar && (
                <>
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
                  <Tooltip title={t('workbench.selectSkillToExecute')}>
                    <Dropdown menu={{ items: slashCommands.map(cmd => ({ key: cmd.key, label: <Text strong style={{ fontSize: 12 }}>{cmd.label}</Text>, onClick: () => handleSlashSelect(cmd) })) }} trigger={['click']}>
                      <Button type="text" size="small" icon={<ToolOutlined style={{ fontSize: 12 }} />}
                        style={{ color: token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20 }} />
                    </Dropdown>
                  </Tooltip>
                </>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center' }}>
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
                    title={defaultModelLabel || undefined}
                    style={{
                      color: token.colorTextSecondary,
                      padding: '0 5px', height: 18, minWidth: 18, borderRadius: 4,
                    }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 11 }}>
                      {defaultModelLabel ? (
                        <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{defaultModelLabel}</span>
                      ) : (
                        <RobotOutlined style={{ fontSize: 11 }} />
                      )}
                    </span>
                  </Button>
                </Popover>
              )}
              {onThinkingChange && thinkingCapability.visible && (
                thinkingCapability.effortSupported ? (
                  <Dropdown trigger={['click']} placement="topRight" menu={{
                    items: thinkingCapability.levels.map(level => ({
                      key: String(level),
                      label: <span style={{ fontSize: 12 }}>{thinkingLevelLabel(level)}</span>,
                      icon: enableThinking === level ? <CheckOutlined style={{ fontSize: 11 }} /> : <span style={{ display: 'inline-block', width: 11 }} />,
                    })),
                    onClick: ({ key }) => {
                      const next = key === 'false' ? false : key as ThinkingLevel
                      onThinkingChange(next)
                    },
                    selectable: true,
                    selectedKeys: [String(enableThinking)],
                  }}>
                    {thinkingTrigger}
                  </Dropdown>
                ) : thinkingTrigger
              )}
            </div>
          </div>
        </div>
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
        {isStreaming || isCompacting ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {isStreaming && (
              <Tooltip title={t('workbench.queueSendHint')}>
                <Button icon={<SendOutlined />} type="primary" onClick={handleSend}
                  disabled={isCompacting || (!hasEditorContent() && attachedImages.length === 0)}
                  size="middle" />
              </Tooltip>
            )}
            <Button icon={isCompacting ? <LoadingOutlined /> : <StopOutlined />} danger={isStreaming} disabled={isCompacting} onClick={onStop} size="middle" />
          </div>
        ) : (
          <Button icon={<SendOutlined />} type="primary" onClick={handleSend}
            disabled={!hasEditorContent() && attachedImages.length === 0}
            size="middle" style={{ flexShrink: 0 }} />
        )}
      </div>
      {editorContextMenu && (
        <div
          ref={editorMenuRef}
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: 'fixed',
            left: editorContextMenu.x,
            top: editorContextMenu.y,
            zIndex: 1060,
            minWidth: 136,
            padding: 4,
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 8,
            boxShadow: token.boxShadowSecondary,
          }}
        >
          {editorContextMenuItems.map(item => (
            <div
              key={item.key}
              onClick={() => { if (!item.disabled) item.onClick() }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 6,
                fontSize: 13,
                cursor: item.disabled ? 'not-allowed' : 'pointer',
                color: item.disabled ? token.colorTextQuaternary : token.colorText,
              }}
              onMouseEnter={(e) => { if (!item.disabled) e.currentTarget.style.background = token.colorBgTextHover }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{ fontSize: 12, color: item.disabled ? token.colorTextQuaternary : token.colorTextSecondary }}>{item.icon}</span>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default memo(ChatInput)
