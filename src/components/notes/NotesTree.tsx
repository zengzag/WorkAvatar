import { memo, useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { Tree, Input, Tooltip, Dropdown, Modal, Empty, theme, Button, App } from 'antd'
import type { TreeDataNode, MenuProps, InputRef } from 'antd'
import {
  PlusOutlined,
  FolderOutlined,
  FolderOpenOutlined,
  FileTextOutlined,
  SearchOutlined,
  ReloadOutlined,
  FolderAddOutlined,
  FormOutlined,
  DeleteOutlined,
  FileAddOutlined,
  CaretDownOutlined,
  CaretRightOutlined,
  CopyOutlined,
  SnippetsOutlined,
  LinkOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { NoteNode } from '../../types/notes'

interface Props {
  tree: NoteNode[]
  loading: boolean
  currentRelPath: string | null
  expandedFolders: string[]
  settingsLoading: boolean
  onExpandedFoldersChange: (keys: string[]) => void
  onOpen: (relPath: string) => void
  onRefresh: () => void
  onCreateNote: (parentRelPath: string, name: string) => Promise<unknown>
  onCreateFolder: (parentRelPath: string, name: string) => Promise<unknown>
  onRename: (relPath: string, newName: string) => Promise<unknown>
  onDelete: (relPath: string) => Promise<boolean>
  onMove: (srcRelPath: string, destParentRelPath: string) => Promise<boolean>
  onCopy: (srcRelPath: string, destParentRelPath: string) => Promise<boolean>
}

type EditingState =
  | { mode: 'create'; parentRelPath: string; type: 'note' | 'folder'; tempKey: string }
  | { mode: 'rename'; relPath: string; type: 'note' | 'folder' }
  | null

interface ExtendedTreeDataNode extends TreeDataNode {
  noteNode?: NoteNode
  children?: ExtendedTreeDataNode[]
}

function isInSubtree(srcNode: NoteNode, targetRelPath: string): boolean {
  if (!srcNode.children) return false
  for (const child of srcNode.children) {
    if (child.relPath === targetRelPath) return true
    if (isInSubtree(child, targetRelPath)) return true
  }
  return false
}

function collectFolders(nodes: NoteNode[], acc: { label: string; value: string }[] = [], prefix = ''): { label: string; value: string }[] {
  for (const n of nodes) {
    if (n.type === 'folder') {
      const label = prefix ? `${prefix}/${n.name}` : n.name
      acc.push({ label, value: n.relPath })
      if (n.children) collectFolders(n.children, acc, label)
    }
  }
  return acc
}

const TreeNodeTitle = memo(function TreeNodeTitle({
  node,
  isActive,
  isExpanded,
  isEditing,
  editingName,
  inputRef,
  onCommitEdit,
  onCancelEdit,
  onEditingNameChange,
  onTitleClick,
  onContextMenuOpen,
  externalDragOver,
}: {
  node: NoteNode
  isActive: boolean
  isExpanded: boolean
  isEditing: boolean
  editingName: string
  inputRef: React.RefObject<InputRef | null>
  onCommitEdit: () => void
  onCancelEdit: () => void
  onEditingNameChange: (v: string) => void
  onTitleClick: (e: React.MouseEvent, node: NoteNode) => void
  onContextMenuOpen: (node: NoteNode, pos: { x: number; y: number }) => void
  externalDragOver: boolean
}) {
  const { token } = theme.useToken()
  const isFolder = node.type === 'folder'

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        size="small"
        autoFocus
        value={editingName}
        onChange={(e) => onEditingNameChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPressEnter={(e) => { e.stopPropagation(); onCommitEdit() }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancelEdit() } }}
        onBlur={onCommitEdit}
        style={{ width: '100%', height: 22, padding: '0 6px', fontSize: 13 }}
      />
    )
  }

  return (
    <div
      className="notes-tree-row"
      data-relpath={node.relPath}
      data-type={node.type}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        gap: 4,
        color: isActive ? token.colorPrimary : undefined,
        fontWeight: isActive ? 500 : 400,
        overflow: 'hidden',
        ...(externalDragOver ? {
          background: token.colorPrimaryBg,
          boxShadow: `inset 0 0 0 1.5px ${token.colorPrimary}`,
          borderRadius: 4,
        } : {}),
      }}
      title={node.name}
      onClick={(e) => onTitleClick(e, node)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenuOpen(node, { x: e.clientX, y: e.clientY }) }}
    >
      {isFolder ? (
        <span style={{ flex: 'none', display: 'inline-flex', color: token.colorTextTertiary, fontSize: 10 }}>
          {isExpanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
        </span>
      ) : (
        <span style={{ flex: 'none', width: 10 }} />
      )}
      <span style={{ flex: 'none', display: 'inline-flex', fontSize: 14 }}>
        {isFolder
          ? (isExpanded ? <FolderOpenOutlined /> : <FolderOutlined />)
          : <FileTextOutlined />}
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.name}
      </span>
    </div>
  )
})

const NotesTree: React.FC<Props> = ({
  tree, loading, currentRelPath, expandedFolders, settingsLoading, onExpandedFoldersChange,
  onOpen, onRefresh, onCreateNote, onCreateFolder, onRename, onDelete, onMove, onCopy,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { modal, message } = App.useApp()
  const [filter, setFilter] = useState('')
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const [editing, setEditing] = useState<EditingState>(null)
  const [editingName, setEditingName] = useState('')
  const [contextNode, setContextNode] = useState<NoteNode | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [moveModal, setMoveModal] = useState<{ srcRelPaths: string[] } | null>(null)
  const [dragSrcKey, setDragSrcKey] = useState<string | null>(null)
  const [rootHover, setRootHover] = useState(false)
  const [clipboardRelPath, setClipboardRelPath] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<NoteNode | null>(null)
  const [treeSelectedKeys, setTreeSelectedKeys] = useState<React.Key[]>([])
  // 外部文件拖入时高亮的目标文件夹
  const [externalDragOverKey, setExternalDragOverKey] = useState<string | null>(null)
  const inputRef = useRef<InputRef>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const submittingRef = useRef(false)
  const cancelingRef = useRef(false)
  const initedExpandRef = useRef(false)
  const preFilterKeysRef = useRef<React.Key[] | null>(null)
  // 拖拽时靠近顶部/底部自动滚动
  const dragScrollDirRef = useRef<'up' | 'down' | null>(null)
  const dragScrollRafRef = useRef<number | null>(null)
  // 拖拽时悬停在折叠文件夹上自动展开
  const dragOverKeyRef = useRef<string | null>(null)
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const lowerFilter = filter.trim().toLowerCase()

  // 初始化展开状态：等待 tree 和 settings 都加载完毕
  useEffect(() => {
    if (initedExpandRef.current) return
    if (tree.length === 0) return
    if (settingsLoading) return
    initedExpandRef.current = true
    if (expandedFolders.length > 0) {
      // 仅保留树中实际存在的文件夹
      const folderPaths = new Set<string>()
      const walk = (nodes: NoteNode[]) => {
        for (const n of nodes) {
          if (n.type === 'folder') {
            folderPaths.add(n.relPath)
            if (n.children) walk(n.children)
          }
        }
      }
      walk(tree)
      setExpandedKeys(expandedFolders.filter((p) => folderPaths.has(p)))
    } else {
      // 首次使用：展开根级文件夹
      setExpandedKeys(tree.filter((n) => n.type === 'folder').map((n) => n.relPath))
    }
  }, [tree, expandedFolders, settingsLoading])

  // 过滤时展开全部文件夹，退出过滤时恢复之前的状态
  useEffect(() => {
    if (lowerFilter) {
      if (preFilterKeysRef.current === null) {
        preFilterKeysRef.current = expandedKeys
      }
      const all: string[] = []
      const walk = (nodes: NoteNode[]) => {
        for (const n of nodes) {
          if (n.type === 'folder') {
            all.push(n.relPath)
            if (n.children) walk(n.children)
          }
        }
      }
      walk(tree)
      setExpandedKeys(all)
    } else {
      const saved = preFilterKeysRef.current
      if (saved !== null) {
        preFilterKeysRef.current = null
        setExpandedKeys(saved)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lowerFilter, tree])

  // 持久化展开状态（过滤模式下不持久化）
  useEffect(() => {
    if (!initedExpandRef.current) return
    if (lowerFilter) return
    if (preFilterKeysRef.current !== null) return
    onExpandedFoldersChange(expandedKeys as string[])
  }, [expandedKeys, lowerFilter, onExpandedFoldersChange])

  const autoExpandParent = useCallback((parentRelPath: string) => {
    if (!parentRelPath) return
    setExpandedKeys((prev) => (prev.includes(parentRelPath) ? prev : [...prev, parentRelPath]))
  }, [])

  const handleContextMenuOpen = useCallback((node: NoteNode, pos: { x: number; y: number }) => {
    setContextNode(node)
    setMenuPos(pos)
    // 右击未在当前选中的节点：重置为单选
    if (!treeSelectedKeys.includes(node.relPath)) {
      setTreeSelectedKeys([node.relPath])
    }
  }, [treeSelectedKeys])

  const handleRootContextMenu = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.notes-tree-row')) return
    e.preventDefault()
    setContextNode(null)
    setMenuPos({ x: e.clientX, y: e.clientY })
  }, [])

  const closeContextMenu = useCallback(() => {
    setMenuPos(null)
    setContextNode(null)
  }, [])

  // 右键菜单：点击外部或按 Esc 关闭
  useEffect(() => {
    if (!menuPos) return
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.ant-dropdown')) return
      closeContextMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu()
    }
    document.addEventListener('click', onDocClick, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocClick, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuPos, closeContextMenu])

  const startCreate = useCallback((parentRelPath: string, type: 'note' | 'folder') => {
    const tempKey = `__new_${Date.now()}__`
    setEditing({ mode: 'create', parentRelPath, type, tempKey })
    setEditingName('')
    autoExpandParent(parentRelPath)
  }, [autoExpandParent])

  const startRename = useCallback((node: NoteNode) => {
    setEditing({ mode: 'rename', relPath: node.relPath, type: node.type === 'folder' ? 'folder' : 'note' })
    setEditingName(node.name)
  }, [])

  const commitEdit = useCallback(async () => {
    if (!editing || submittingRef.current) return
    if (cancelingRef.current) return
    submittingRef.current = true
    const current = editing
    // 先把焦点从输入框移走，避免 input 被移除后焦点落到树容器（带 tabIndex）上，
    // 触发 rc-tree 的 onFocus → onActiveChange → scrollTo 链路在 listRef 未就绪时报错
    inputRef.current?.blur()
    setEditing(null)
    const trimmed = editingName.trim()
    const fallback = current.mode === 'create'
      ? (current.type === 'note' ? t('notes.untitledNote') : t('notes.newFolder'))
      : ''
    const finalName = trimmed || fallback
    try {
      if (current.mode === 'create') {
        if (current.type === 'note') {
          const node = await onCreateNote(current.parentRelPath, finalName)
          if (node && (node as NoteNode).relPath) {
            await onOpen((node as NoteNode).relPath)
          }
        } else {
          await onCreateFolder(current.parentRelPath, finalName)
        }
      } else {
        await onRename(current.relPath, finalName)
      }
    } catch { /* ignore */ } finally {
      submittingRef.current = false
      setEditingName('')
    }
  }, [editing, editingName, t, onCreateNote, onCreateFolder, onRename, onOpen])

  const cancelEdit = useCallback(() => {
    // 标记取消中，避免 blur 触发的 commitEdit 把取消变成提交
    cancelingRef.current = true
    inputRef.current?.blur()
    cancelingRef.current = false
    setEditing(null)
    setEditingName('')
  }, [])

  useEffect(() => {
    if (!editing) return
    const id = setTimeout(() => inputRef.current?.focus({ cursor: 'all' }), 50)
    return () => clearTimeout(id)
  }, [editing])

  const nodeMapRef = useRef<Map<string, NoteNode>>(new Map())

  const treeData = useMemo(() => {
    const nodeMap = new Map<string, NoteNode>()
    const build = (list: NoteNode[], parentPath: string): ExtendedTreeDataNode[] => {
      const result: ExtendedTreeDataNode[] = []
      for (const n of list) {
        if (lowerFilter && n.type === 'file' && !n.name.toLowerCase().includes(lowerFilter)) continue
        const isFolder = n.type === 'folder'
        nodeMap.set(n.relPath, n)
        const children = isFolder && n.children ? build(n.children, n.relPath) : undefined
        if (lowerFilter && isFolder && !n.name.toLowerCase().includes(lowerFilter) && (children?.length || 0) === 0) continue
        result.push({
          key: n.relPath,
          title: n.name,
          noteNode: n,
          isLeaf: !isFolder,
          children,
          className: isFolder ? 'notes-tree-folder' : 'notes-tree-file',
        })
      }
      if (editing?.mode === 'create' && editing.parentRelPath === parentPath) {
        result.push({
          key: editing.tempKey,
          title: '',
          isLeaf: editing.type === 'note',
        })
      }
      return result
    }
    const result = build(tree, '')
    nodeMapRef.current = nodeMap
    return result
  }, [tree, lowerFilter, editing])

  // 多选状态与 active 文件分离：selectedKeys 控制背景高亮（多选），
  // currentRelPath 通过 titleRender 控制主色文字（当前打开的文件）
  const selectedKeys = treeSelectedKeys
  const anchorKeyRef = useRef<string | null>(null)

  // 当 currentRelPath 外部变化（如搜索点击、Tab 切换）时，重置为单选
  useEffect(() => {
    setTreeSelectedKeys(currentRelPath ? [currentRelPath] : [])
    anchorKeyRef.current = currentRelPath
  }, [currentRelPath])

  // 当前展开状态下可见节点的 relPath 列表（按渲染顺序），用于 Shift 范围选择
  const getVisibleNodePaths = useCallback((): string[] => {
    const result: string[] = []
    const walk = (nodes: ExtendedTreeDataNode[]) => {
      for (const n of nodes) {
        const key = String(n.key)
        if (key.startsWith('__new_')) continue
        result.push(key)
        if (n.children && expandedKeys.includes(key)) {
          walk(n.children)
        }
      }
    }
    walk(treeData)
    return result
  }, [treeData, expandedKeys])

  const handleSelect = useCallback((keys: React.Key[], info: any) => {
    const e = info?.nativeEvent as MouseEvent | undefined
    const hasCtrl = e?.ctrlKey || e?.metaKey
    const hasShift = e?.shiftKey
    const clickedKey = String(info?.node?.key ?? '')

    // Shift 范围选择：从锚点到当前节点之间所有可见节点
    if (hasShift && anchorKeyRef.current && clickedKey) {
      const visible = getVisibleNodePaths()
      const startIdx = visible.indexOf(anchorKeyRef.current)
      const endIdx = visible.indexOf(clickedKey)
      if (startIdx >= 0 && endIdx >= 0) {
        const [from, to] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
        const rangeKeys = visible.slice(from, to + 1)
        setTreeSelectedKeys(rangeKeys)
        const node = nodeMapRef.current.get(clickedKey)
        if (node) setSelectedNode(node)
      }
      return
    }

    // Ctrl/Cmd 单击 toggle 选中
    if (hasCtrl && clickedKey) {
      setTreeSelectedKeys(keys)
      anchorKeyRef.current = clickedKey
      const node = nodeMapRef.current.get(clickedKey)
      if (node) setSelectedNode(node)
      return
    }

    // 普通点击：单选 + 打开文件（与未启用多选时行为一致）
    setTreeSelectedKeys(clickedKey ? [clickedKey] : [])
    anchorKeyRef.current = clickedKey || null
    if (clickedKey && !clickedKey.startsWith('__new_')) {
      const node = nodeMapRef.current.get(clickedKey)
      if (node) {
        setSelectedNode(node)
        if (node.type === 'file') onOpen(clickedKey)
      }
    }
  }, [onOpen, getVisibleNodePaths])

  const handleTitleClick = useCallback((e: React.MouseEvent, node: NoteNode) => {
    // 修饰键点击交由 Tree onSelect 处理多选，不阻止冒泡，也不切换展开
    if (e.ctrlKey || e.metaKey || e.shiftKey) return
    if (node.type !== 'folder') return
    e.stopPropagation()
    setExpandedKeys((prev) => {
      const k = node.relPath
      return prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]
    })
  }, [])

  const handleAllowDrop = useCallback((opts: any) => {
    const dragNode = opts?.dragNode
    const dropNode = opts?.dropNode
    const dragKey = String(dragNode?.key ?? '')
    const dropKey = String(dropNode?.key ?? '')
    if (dragKey.startsWith('__new_')) return false
    if (!dropKey || dragKey === dropKey) return false
    const dragN = nodeMapRef.current.get(dragKey)
    const dropN = nodeMapRef.current.get(dropKey)
    if (!dragN || !dropN) return false
    // 仅允许拖到文件夹上（任意位置：上方/中间/下方均视为放入该文件夹）
    if (dropN.type !== 'folder') return false
    if (dragN.type === 'folder' && isInSubtree(dragN, dropKey)) return false
    return true
  }, [])

  const handleDrop = useCallback(async (info: any) => {
    const dragKey = String(info.dragNode?.key ?? '')
    const dropKey = String(info.node?.key ?? '')
    if (!dragKey || !dropKey || dragKey === dropKey) return
    if (dragKey.startsWith('__new_')) return
    setDragSrcKey(null)
    const dropNode = nodeMapRef.current.get(dropKey)
    if (!dropNode || dropNode.type !== 'folder') return
    // 无论 dropToGap 与否，目标文件夹即 dropKey
    const destFolder = dropKey
    // 批量拖拽：拖动选中项时移动所有选中项
    const selected = treeSelectedKeys.filter((k) => typeof k === 'string' && !String(k).startsWith('__new_')) as string[]
    const pathsToMove = selected.includes(dragKey) ? selected : [dragKey]
    const validPaths = pathsToMove.filter((p) => {
      if (p === destFolder) return false
      const n = nodeMapRef.current.get(p)
      if (!n) return false
      if (n.type === 'folder' && isInSubtree(n, destFolder)) return false
      return true
    })
    // 去重：移除被其他选中项祖先包含的项
    const dedupedPaths = validPaths.filter((p) =>
      !validPaths.some((other) => other !== p && p.startsWith(other + '/'))
    )
    for (const p of dedupedPaths) {
      try { await onMove(p, destFolder) } catch { /* ignore */ }
    }
    setTreeSelectedKeys([])
  }, [onMove, treeSelectedKeys])

  const handleDragStart = useCallback((info: any) => {
    const key = String(info?.node?.key ?? '')
    if (!key || key.startsWith('__new_')) return
    // Shift+拖拽：导出到系统文件管理器
    const nativeEvent = info?.event as DragEvent
    if (nativeEvent?.shiftKey) {
      nativeEvent.preventDefault()
      const selected = treeSelectedKeys.filter((k) => typeof k === 'string' && !String(k).startsWith('__new_')) as string[]
      const pathsToDrag = selected.includes(key) ? selected : [key]
      Promise.all(pathsToDrag.map((p) => window.electronAPI.notes.getAbsolutePath(p)))
        .then((results) => {
          const absPaths = results
            .filter((r) => r && !(r as any).error)
            .map((r) => (r as any).absPath as string)
          if (absPaths.length > 0) window.electronAPI.notes.startDrag(absPaths)
        })
      return
    }
    setDragSrcKey(key)
  }, [treeSelectedKeys])
  const handleDragEnd = useCallback(() => {
    setDragSrcKey(null)
    setRootHover(false)
    setExternalDragOverKey(null)
    dragOverKeyRef.current = null
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current)
      autoExpandTimerRef.current = null
    }
  }, [])

  // 拖拽进行中：rAF 循环根据 dragScrollDirRef 自动滚动容器
  useEffect(() => {
    if (!dragSrcKey) {
      dragScrollDirRef.current = null
      if (dragScrollRafRef.current) {
        cancelAnimationFrame(dragScrollRafRef.current)
        dragScrollRafRef.current = null
      }
      return
    }
    const STEP = 10
    const tick = () => {
      const el = containerRef.current
      const dir = dragScrollDirRef.current
      if (el && dir) {
        el.scrollTop += dir === 'down' ? STEP : -STEP
      }
      dragScrollRafRef.current = requestAnimationFrame(tick)
    }
    dragScrollRafRef.current = requestAnimationFrame(tick)
    return () => {
      dragScrollDirRef.current = null
      if (dragScrollRafRef.current) {
        cancelAnimationFrame(dragScrollRafRef.current)
        dragScrollRafRef.current = null
      }
    }
  }, [dragSrcKey])

  // 拖拽时根据光标位置决定滚动方向 + 外部文件拖入高亮 + 自动展开
  const handleContainerDragOver = useCallback((e: React.DragEvent) => {
    const el = containerRef.current
    if (!el) { dragScrollDirRef.current = null; return }
    const rect = el.getBoundingClientRect()
    const y = e.clientY - rect.top
    const threshold = 120
    if (y < threshold) {
      dragScrollDirRef.current = 'up'
    } else if (y > rect.height - threshold) {
      dragScrollDirRef.current = 'down'
    } else {
      dragScrollDirRef.current = null
    }

    // 外部文件拖入：高亮目标文件夹 + 自动展开折叠文件夹
    const isExternal = e.dataTransfer.types.includes('Files')
    if (!isExternal) return
    e.preventDefault()
    const rowEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-relpath]') as HTMLElement | null
    const relPath = rowEl?.getAttribute('data-relpath') || ''
    const nodeType = rowEl?.getAttribute('data-type') || ''
    const folderKey = nodeType === 'folder' ? relPath : ''
    setExternalDragOverKey(folderKey || '__root__')

    // 自动展开：悬停在折叠文件夹上 600ms 后展开
    if (folderKey && folderKey !== dragOverKeyRef.current) {
      dragOverKeyRef.current = folderKey
      if (autoExpandTimerRef.current) clearTimeout(autoExpandTimerRef.current)
      autoExpandTimerRef.current = setTimeout(() => {
        setExpandedKeys((prev) => prev.includes(folderKey) ? prev : [...prev, folderKey])
      }, 600)
    } else if (!folderKey) {
      dragOverKeyRef.current = null
      if (autoExpandTimerRef.current) {
        clearTimeout(autoExpandTimerRef.current)
        autoExpandTimerRef.current = null
      }
    }
  }, [])

  const handleContainerDragLeave = useCallback(() => {
    dragScrollDirRef.current = null
    setExternalDragOverKey(null)
    dragOverKeyRef.current = null
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current)
      autoExpandTimerRef.current = null
    }
  }, [])

  // 外部文件拖入：导入到目标文件夹
  const handleContainerDrop = useCallback(async (e: React.DragEvent) => {
    const isExternal = e.dataTransfer.types.includes('Files')
    if (!isExternal) return
    e.preventDefault()
    e.stopPropagation()
    setExternalDragOverKey(null)
    dragOverKeyRef.current = null
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current)
      autoExpandTimerRef.current = null
    }
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const rowEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-relpath]') as HTMLElement | null
    const relPath = rowEl?.getAttribute('data-relpath') || ''
    const nodeType = rowEl?.getAttribute('data-type') || ''
    const destFolder = nodeType === 'folder' ? relPath : ''
    let imported = 0
    for (const file of files) {
      try {
        const srcAbsPath = window.electronAPI.getPathForFile(file)
        const res = await window.electronAPI.notes.importExternal({ srcAbsPath, destParentRelPath: destFolder })
        if (res && !(res as any).error) imported++
      } catch { /* ignore */ }
    }
    if (imported > 0) message.success(t('notes.importSuccess', { count: imported }))
  }, [t, message])

  const showRootDropZone = !!dragSrcKey && dragSrcKey.includes('/')
  const handleRootDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setRootHover(false)
    const key = dragSrcKey
    setDragSrcKey(null)
    if (!key) return
    // 批量拖到根目录：移动所有选中项
    const selected = treeSelectedKeys.filter((k) => typeof k === 'string' && !String(k).startsWith('__new_')) as string[]
    const pathsToMove = selected.includes(key) ? selected : [key]
    // 去重：移除被其他选中项祖先包含的项
    const dedupedPaths = pathsToMove.filter((p) =>
      !pathsToMove.some((other) => other !== p && p.startsWith(other + '/'))
    )
    let anyOk = false
    for (const p of dedupedPaths) {
      try {
        const ok = await onMove(p, '')
        if (ok) anyOk = true
      } catch { /* ignore */ }
    }
    if (anyOk) message.success(t('notes.moveSuccess'))
    setTreeSelectedKeys([])
  }, [dragSrcKey, onMove, t, treeSelectedKeys])

  // 获取节点的父文件夹 relPath
  const getParentRelPath = useCallback((relPath: string): string => {
    const idx = relPath.lastIndexOf('/')
    return idx >= 0 ? relPath.substring(0, idx) : ''
  }, [])

  // 创建副本：在同父文件夹下复制
  const handleCreateCopy = useCallback(async (node: NoteNode) => {
    const parentRelPath = getParentRelPath(node.relPath)
    const ok = await onCopy(node.relPath, parentRelPath)
    if (ok) message.success(t('notes.pasteSuccess'))
  }, [onCopy, getParentRelPath, t, message])

  // 粘贴：将剪贴板中的节点复制到目标父文件夹
  const handlePaste = useCallback(async (destParentRelPath: string) => {
    if (!clipboardRelPath) {
      message.warning(t('notes.nothingToPaste'))
      return
    }
    const ok = await onCopy(clipboardRelPath, destParentRelPath)
    if (ok) message.success(t('notes.pasteSuccess'))
  }, [clipboardRelPath, onCopy, t, message])

  // 在资源管理器中打开
  const handleOpenInExplorer = useCallback(async (relPath: string) => {
    try {
      const res = await window.electronAPI.notes.openInExplorer(relPath)
      if (res && (res as any).error) message.error((res as any).error)
    } catch { /* ignore */ }
  }, [message])

  // 复制路径到剪贴板
  const handleCopyPath = useCallback(async (relPath: string, type: 'relative' | 'absolute') => {
    try {
      let pathValue = relPath
      if (type === 'absolute') {
        const res = await window.electronAPI.notes.getAbsolutePath(relPath)
        if (res && (res as any).error) {
          message.error((res as any).error)
          return
        }
        pathValue = (res as any).absPath || relPath
      }
      await navigator.clipboard.writeText(pathValue)
      message.success(t('notes.pathCopied'))
    } catch {
      message.error(t('notes.copyFailed'))
    }
  }, [t, message])

  // 批量删除
  const handleBatchDelete = useCallback((relPaths: string[]) => {
    if (relPaths.length === 0) return
    modal.confirm({
      title: t('notes.confirmBatchDelete'),
      content: t('notes.batchDeleteDesc', { count: relPaths.length }),
      okType: 'danger',
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        for (const p of relPaths) {
          await onDelete(p)
        }
        setTreeSelectedKeys([])
      },
    })
  }, [modal, t, onDelete])

  // 批量移动
  const handleBatchMove = useCallback((relPaths: string[]) => {
    if (relPaths.length === 0) return
    setMoveModal({ srcRelPaths: relPaths })
  }, [])

  // 获取当前多选路径（仅有效节点）
  const getSelectedPaths = useCallback((): string[] => {
    return treeSelectedKeys
      .filter((k) => typeof k === 'string' && !String(k).startsWith('__new_'))
      .map((k) => String(k))
      .filter((p) => nodeMapRef.current.has(p))
  }, [treeSelectedKeys])

  // 键盘快捷键：Delete 删除、F2 重命名、Ctrl/Cmd+C 复制、Ctrl/Cmd+V 粘贴、Ctrl/Cmd+D 创建副本
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (editing) return
      const container = containerRef.current
      if (!container) return
      const active = document.activeElement
      if (!container.contains(active)) return
      const tag = active?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || (active as HTMLElement)?.isContentEditable) return
      if (!selectedNode) return
      // 校验节点仍存在
      if (!nodeMapRef.current.has(selectedNode.relPath)) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (e.key === 'Delete') {
        e.preventDefault()
        const selectedPaths = getSelectedPaths()
        if (selectedPaths.length > 1) {
          handleBatchDelete(selectedPaths)
        } else {
          const desc = selectedNode.type === 'folder' ? t('notes.deleteFolderDesc') : t('notes.deleteFileDesc')
          modal.confirm({
            title: t('notes.confirmDelete'),
            content: `${selectedNode.relPath}\n\n${desc}`,
            okType: 'danger',
            okText: t('common.delete'),
            cancelText: t('common.cancel'),
            onOk: async () => { await onDelete(selectedNode.relPath) },
          })
        }
      } else if (e.key === 'F2') {
        e.preventDefault()
        startRename(selectedNode)
      } else if (mod && key === 'c' && !e.shiftKey) {
        e.preventDefault()
        setClipboardRelPath(selectedNode.relPath)
      } else if (mod && key === 'v' && !e.shiftKey) {
        e.preventDefault()
        if (!clipboardRelPath) return
        const destParent = selectedNode.type === 'folder' ? selectedNode.relPath : getParentRelPath(selectedNode.relPath)
        handlePaste(destParent)
      } else if (mod && key === 'd' && !e.shiftKey) {
        e.preventDefault()
        handleCreateCopy(selectedNode)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editing, selectedNode, clipboardRelPath, t, modal, message, onDelete, startRename, getParentRelPath, handlePaste, handleCreateCopy, getSelectedPaths, handleBatchDelete])

  const contextMenu: MenuProps = useMemo(() => {
    if (!contextNode) return { items: [] }
    // 多选菜单：右击的节点在当前多选中
    const selectedPaths = treeSelectedKeys
      .filter((k) => typeof k === 'string' && !String(k).startsWith('__new_'))
      .map((k) => String(k))
    const isMulti = selectedPaths.length > 1 && selectedPaths.includes(contextNode.relPath)
    if (isMulti) {
      const items: MenuProps['items'] = [
        { key: 'batch-move', icon: <FolderOutlined />, label: t('notes.batchMoveTo'), onClick: () => { closeContextMenu(); handleBatchMove(selectedPaths) } },
        { type: 'divider' },
        {
          key: 'batch-delete',
          icon: <DeleteOutlined />,
          danger: true,
          label: t('notes.batchDelete'),
          onClick: () => { closeContextMenu(); handleBatchDelete(selectedPaths) },
        },
      ]
      return { items }
    }
    const items: MenuProps['items'] = []
    if (contextNode.type === 'folder') {
      items.push({ key: 'new-note', icon: <FileAddOutlined />, label: t('notes.newNote'), onClick: () => { closeContextMenu(); startCreate(contextNode.relPath, 'note') } })
      items.push({ key: 'new-folder', icon: <FolderAddOutlined />, label: t('notes.newFolder'), onClick: () => { closeContextMenu(); startCreate(contextNode.relPath, 'folder') } })
      items.push({ type: 'divider' })
    } else {
      items.push({ key: 'open', icon: <FormOutlined />, label: t('common.view'), onClick: () => { closeContextMenu(); onOpen(contextNode.relPath) } })
    }
    items.push({ key: 'create-copy', icon: <CopyOutlined />, label: t('notes.createCopy'), onClick: () => { closeContextMenu(); handleCreateCopy(contextNode) } })
    items.push({ key: 'copy', icon: <CopyOutlined />, label: t('notes.copy'), onClick: () => { closeContextMenu(); setClipboardRelPath(contextNode.relPath) } })
    if (contextNode.type === 'folder' && clipboardRelPath) {
      items.push({ key: 'paste', icon: <SnippetsOutlined />, label: t('notes.paste'), onClick: () => { closeContextMenu(); handlePaste(contextNode.relPath) } })
    }
    items.push({ key: 'rename', icon: <FormOutlined />, label: t('common.rename'), onClick: () => { closeContextMenu(); startRename(contextNode) } })
    items.push({ key: 'move', icon: <FolderOutlined />, label: t('notes.moveTo'), onClick: () => { closeContextMenu(); setMoveModal({ srcRelPaths: [contextNode.relPath] }) } })
    items.push({ type: 'divider' })
    items.push({ key: 'open-in-explorer', icon: <FolderOpenOutlined />, label: t('notes.openInExplorer'), onClick: () => { closeContextMenu(); handleOpenInExplorer(contextNode.relPath) } })
    items.push({
      key: 'copy-path',
      icon: <LinkOutlined />,
      label: t('notes.copyPath'),
      children: [
        { key: 'copy-relative', label: t('notes.copyRelativePath'), onClick: () => { closeContextMenu(); handleCopyPath(contextNode.relPath, 'relative') } },
        { key: 'copy-absolute', label: t('notes.copyAbsolutePath'), onClick: () => { closeContextMenu(); handleCopyPath(contextNode.relPath, 'absolute') } },
      ],
    })
    items.push({ type: 'divider' })
    items.push({
      key: 'delete',
      icon: <DeleteOutlined />,
      danger: true,
      label: t('common.delete'),
      onClick: () => {
        closeContextMenu()
        const desc = contextNode.type === 'folder' ? t('notes.deleteFolderDesc') : t('notes.deleteFileDesc')
        modal.confirm({
          title: t('notes.confirmDelete'),
          content: `${contextNode.relPath}\n\n${desc}`,
          okType: 'danger',
          okText: t('common.delete'),
          cancelText: t('common.cancel'),
          onOk: async () => { await onDelete(contextNode.relPath) },
        })
      },
    })
    return { items }
  }, [contextNode, treeSelectedKeys, t, startCreate, startRename, onOpen, onDelete, modal, closeContextMenu, handleCreateCopy, handlePaste, handleOpenInExplorer, handleCopyPath, clipboardRelPath, handleBatchDelete, handleBatchMove])

  const rootContextMenu: MenuProps = useMemo(() => {
    const items: MenuProps['items'] = [
      { key: 'new-note', icon: <FileAddOutlined />, label: t('notes.newNote'), onClick: () => { closeContextMenu(); startCreate('', 'note') } },
      { key: 'new-folder', icon: <FolderAddOutlined />, label: t('notes.newFolder'), onClick: () => { closeContextMenu(); startCreate('', 'folder') } },
    ]
    if (clipboardRelPath) {
      items.push({ type: 'divider' })
      items.push({ key: 'paste', icon: <SnippetsOutlined />, label: t('notes.paste'), onClick: () => { closeContextMenu(); handlePaste('') } })
    }
    return { items }
  }, [t, startCreate, closeContextMenu, clipboardRelPath, handlePaste])

  const folders = useMemo(() => collectFolders(tree), [tree])

  const titleRender = useCallback((nodeData: ExtendedTreeDataNode) => {
    const key = String(nodeData.key)
    const isCreating = editing?.mode === 'create' && key === editing.tempKey
    const isRenaming = editing?.mode === 'rename' && key === editing.relPath
    const n = isCreating ? null : (nodeData.noteNode || nodeMapRef.current.get(key))
    if (isCreating || isRenaming) {
      return (
        <TreeNodeTitle
          node={n || { name: '', relPath: key, type: 'file' as const, mtime: 0, size: 0 }}
          isActive={false}
          isExpanded={false}
          isEditing={true}
          editingName={editingName}
          inputRef={inputRef}
          onCommitEdit={commitEdit}
          onCancelEdit={cancelEdit}
          onEditingNameChange={setEditingName}
          onTitleClick={handleTitleClick}
          onContextMenuOpen={() => {}}
          externalDragOver={false}
        />
      )
    }
    if (!n) return <span>{nodeData.title as any}</span>
    const isActive = key === currentRelPath
    const isExpanded = expandedKeys.includes(key)
    return (
      <TreeNodeTitle
        node={n}
        isActive={isActive}
        isExpanded={isExpanded}
        isEditing={false}
        editingName=""
        inputRef={inputRef}
        onCommitEdit={commitEdit}
        onCancelEdit={cancelEdit}
        onEditingNameChange={setEditingName}
        onTitleClick={handleTitleClick}
        onContextMenuOpen={handleContextMenuOpen}
        externalDragOver={n.type === 'folder' && externalDragOverKey === key}
      />
    )
  }, [editing, editingName, currentRelPath, expandedKeys, externalDragOverKey, commitEdit, cancelEdit, handleTitleClick, handleContextMenuOpen])

  return (
    <div
      className="notes-tree"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: token.colorBgContainer }}
    >
      <div style={{ display: 'flex', gap: 4, padding: '6px 8px', alignItems: 'center' }}>
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
          placeholder={t('notes.searchPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1 }}
        />
        <Tooltip title={t('notes.newNote')}>
          <Button size="small" type="text" icon={<FileAddOutlined />} onClick={() => startCreate('', 'note')} />
        </Tooltip>
        <Tooltip title={t('notes.newFolder')}>
          <Button size="small" type="text" icon={<FolderAddOutlined />} onClick={() => startCreate('', 'folder')} />
        </Tooltip>
        <Tooltip title={t('common.refresh')}>
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onRefresh} loading={loading} />
        </Tooltip>
      </div>

      <div
        ref={containerRef}
        tabIndex={0}
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
        style={{ flex: 1, overflow: 'auto', minHeight: 0, position: 'relative', outline: 'none' }}
      >
        {tree.length === 0 && !loading && !editing ? (
          <Empty
            style={{ padding: '32px 0' }}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>
                {t('notes.emptyVaultDesc')}
              </span>
            }
          >
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => startCreate('', 'note')}>
              {t('notes.createFirstNote')}
            </Button>
          </Empty>
        ) : (
            <div
              onContextMenu={handleRootContextMenu}
              style={{ minHeight: '100%', padding: '4px 4px', width: '100%', boxSizing: 'border-box' }}
            >
              <Tree
                blockNode
                multiple
                draggable={{ icon: false }}
                allowDrop={handleAllowDrop}
                onDrop={handleDrop}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                treeData={treeData}
                expandedKeys={expandedKeys}
                onExpand={(keys) => setExpandedKeys(keys as React.Key[])}
                selectedKeys={selectedKeys}
                onSelect={handleSelect}
                titleRender={titleRender}
                virtual={tree.length > 50}
              />
              {showRootDropZone && (
                <div
                  onDragOver={(e) => { e.preventDefault(); if (!rootHover) setRootHover(true) }}
                  onDragLeave={() => setRootHover(false)}
                  onDrop={handleRootDrop}
                  style={{
                    margin: '6px 4px 4px',
                    padding: '10px 8px',
                    textAlign: 'center',
                    fontSize: 12,
                    borderRadius: 4,
                    border: `1.5px dashed ${rootHover ? token.colorPrimary : token.colorBorder}`,
                    background: rootHover ? token.colorPrimaryBg : 'transparent',
                    color: rootHover ? token.colorPrimary : token.colorTextTertiary,
                    transition: 'all 0.15s',
                  }}
                >
                  {t('notes.dropToRoot')}
                </div>
              )}
            </div>
        )}
      </div>

      <MoveModal
        open={!!moveModal}
        folders={folders}
        srcCount={moveModal?.srcRelPaths.length || 0}
        onCancel={() => setMoveModal(null)}
        onOk={async (destParent) => {
          if (moveModal) {
            let anyOk = false
            for (const src of moveModal.srcRelPaths) {
              try {
                const ok = await onMove(src, destParent)
                if (ok) anyOk = true
              } catch { /* ignore */ }
            }
            if (anyOk) message.success(t('notes.moveSuccess'))
            setTreeSelectedKeys([])
          }
          setMoveModal(null)
        }}
      />

      <Dropdown
        menu={contextNode ? contextMenu : rootContextMenu}
        open={!!menuPos}
        onOpenChange={(open) => { if (!open) closeContextMenu() }}
        trigger={[]}
      >
        <div style={{ position: 'fixed', left: menuPos?.x ?? -100, top: menuPos?.y ?? -100, width: 1, height: 1, pointerEvents: 'none' }} />
      </Dropdown>
    </div>
  )
}

const MoveModal: React.FC<{
  open: boolean
  folders: { label: string; value: string }[]
  srcCount?: number
  onCancel: () => void
  onOk: (destParent: string) => void
}> = ({ open, folders, srcCount, onCancel, onOk }) => {
  const { t } = useTranslation()
  const [selected, setSelected] = useState('')
  const options = useMemo(() => [
    { label: t('notes.vaultRoot'), value: '' },
    ...folders,
  ], [folders, t])
  const title = srcCount && srcCount > 1
    ? `${t('notes.batchMoveTo')} (${srcCount})`
    : t('notes.moveTo')
  return (
    <Modal
      title={title}
      open={open}
      onOk={() => onOk(selected)}
      onCancel={onCancel}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      destroyOnClose
    >
      <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
        <Tree
          showIcon
          blockNode
          defaultExpandAll
          selectedKeys={selected ? [selected] : ['__root__']}
          onSelect={(keys) => setSelected(String(keys[0] === '__root__' ? '' : keys[0] || ''))}
          treeData={[{
            key: '__root__',
            title: t('notes.vaultRoot'),
            icon: <FolderOutlined />,
            children: toTreeData(toNoteNodes(options.filter((o) => o.value !== ''))),
          }]}
        />
      </div>
    </Modal>
  )
}

function toNoteNodes(folders: { label: string; value: string }[]): NoteNode[] {
  const root: NoteNode[] = []
  const map = new Map<string, NoteNode>()
  for (const f of folders) {
    const parts = f.value.split('/')
    const name = parts[parts.length - 1]
    const node: NoteNode = { name, relPath: f.value, type: 'folder', mtime: 0, size: 0, children: [] }
    map.set(f.value, node)
  }
  for (const f of folders) {
    const parts = f.value.split('/')
    const node = map.get(f.value)!
    if (parts.length === 1) {
      root.push(node)
    } else {
      const parentPath = parts.slice(0, -1).join('/')
      const parent = map.get(parentPath)
      if (parent) parent.children!.push(node)
      else root.push(node)
    }
  }
  return root
}

function toTreeData(nodes: NoteNode[]): TreeDataNode[] {
  return nodes.map((n) => ({
    key: n.relPath,
    title: n.name,
    icon: <FolderOutlined />,
    children: n.children ? toTreeData(n.children) : undefined,
    isLeaf: false,
  }))
}

export default memo(NotesTree)
