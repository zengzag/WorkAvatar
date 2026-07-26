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
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        gap: 4,
        color: isActive ? token.colorPrimary : undefined,
        fontWeight: isActive ? 500 : 400,
        overflow: 'hidden',
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
  onOpen, onRefresh, onCreateNote, onCreateFolder, onRename, onDelete, onMove,
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
  const [moveModal, setMoveModal] = useState<{ srcRelPath: string } | null>(null)
  const [dragSrcKey, setDragSrcKey] = useState<string | null>(null)
  const [rootHover, setRootHover] = useState(false)
  const inputRef = useRef<InputRef>(null)
  const submittingRef = useRef(false)
  const cancelingRef = useRef(false)
  const initedExpandRef = useRef(false)
  const preFilterKeysRef = useRef<React.Key[] | null>(null)

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
  }, [])

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

  const selectedKeys = useMemo(() => (currentRelPath ? [currentRelPath] : []), [currentRelPath])

  const handleSelect = useCallback((keys: React.Key[]) => {
    const key = keys[0] as string | undefined
    if (!key) return
    if (editing?.mode === 'create' && key === editing.tempKey) return
    const node = nodeMapRef.current.get(key)
    if (node && node.type === 'file') onOpen(key)
  }, [onOpen, editing])

  const handleTitleClick = useCallback((e: React.MouseEvent, node: NoteNode) => {
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
    const dropPosition = opts?.dropPosition
    const dragKey = String(dragNode?.key ?? '')
    const dropKey = String(dropNode?.key ?? '')
    if (dragKey.startsWith('__new_')) return false
    if (dropPosition !== 0) return false
    if (!dropKey || dragKey === dropKey) return false
    const dragN = nodeMapRef.current.get(dragKey)
    const dropN = nodeMapRef.current.get(dropKey)
    if (!dragN || !dropN) return false
    if (dropN.type !== 'folder') return false
    if (dragN.type === 'folder' && isInSubtree(dragN, dropKey)) return false
    return true
  }, [])

  const handleDrop = useCallback(async (info: any) => {
    const dragKey = String(info.dragNode?.key ?? '')
    const dropKey = String(info.node?.key ?? '')
    if (info.dropToGap) return
    if (!dragKey || !dropKey || dragKey === dropKey) return
    if (dragKey.startsWith('__new_')) return
    setDragSrcKey(null)
    try {
      await onMove(dragKey, dropKey)
    } catch { /* ignore */ }
  }, [onMove])

  const handleDragStart = useCallback((info: any) => {
    const key = String(info?.node?.key ?? '')
    if (key && !key.startsWith('__new_')) setDragSrcKey(key)
  }, [])
  const handleDragEnd = useCallback(() => {
    setDragSrcKey(null)
    setRootHover(false)
  }, [])

  const showRootDropZone = !!dragSrcKey && dragSrcKey.includes('/')
  const handleRootDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setRootHover(false)
    const key = dragSrcKey
    setDragSrcKey(null)
    if (!key) return
    try {
      const ok = await onMove(key, '')
      if (ok) message.success(t('notes.moveSuccess'))
    } catch { /* ignore */ }
  }, [dragSrcKey, onMove, t])

  const contextMenu: MenuProps = useMemo(() => {
    if (!contextNode) return { items: [] }
    const items: MenuProps['items'] = []
    if (contextNode.type === 'folder') {
      items.push({ key: 'new-note', icon: <FileAddOutlined />, label: t('notes.newNote'), onClick: () => { closeContextMenu(); startCreate(contextNode.relPath, 'note') } })
      items.push({ key: 'new-folder', icon: <FolderAddOutlined />, label: t('notes.newFolder'), onClick: () => { closeContextMenu(); startCreate(contextNode.relPath, 'folder') } })
      items.push({ type: 'divider' })
    } else {
      items.push({ key: 'open', icon: <FormOutlined />, label: t('common.view'), onClick: () => { closeContextMenu(); onOpen(contextNode.relPath) } })
    }
    items.push({ key: 'rename', icon: <FormOutlined />, label: t('common.rename'), onClick: () => { closeContextMenu(); startRename(contextNode) } })
    items.push({ key: 'move', icon: <FolderOutlined />, label: t('notes.moveTo'), onClick: () => { closeContextMenu(); setMoveModal({ srcRelPath: contextNode.relPath }) } })
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
  }, [contextNode, t, startCreate, startRename, onOpen, onDelete, modal, closeContextMenu])

  const rootContextMenu: MenuProps = useMemo(() => ({
    items: [
      { key: 'new-note', icon: <FileAddOutlined />, label: t('notes.newNote'), onClick: () => { closeContextMenu(); startCreate('', 'note') } },
      { key: 'new-folder', icon: <FolderAddOutlined />, label: t('notes.newFolder'), onClick: () => { closeContextMenu(); startCreate('', 'folder') } },
    ],
  }), [t, startCreate, closeContextMenu])

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
      />
    )
  }, [editing, editingName, currentRelPath, expandedKeys, commitEdit, cancelEdit, handleTitleClick, handleContextMenuOpen])

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

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, position: 'relative' }}>
        {tree.length === 0 && !loading ? (
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
        onCancel={() => setMoveModal(null)}
        onOk={async (destParent) => {
          if (moveModal) {
            const ok = await onMove(moveModal.srcRelPath, destParent)
            if (ok) message.success(t('notes.moveSuccess'))
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
  onCancel: () => void
  onOk: (destParent: string) => void
}> = ({ open, folders, onCancel, onOk }) => {
  const { t } = useTranslation()
  const [selected, setSelected] = useState('')
  const options = useMemo(() => [
    { label: t('notes.vaultRoot'), value: '' },
    ...folders,
  ], [folders, t])
  return (
    <Modal
      title={t('notes.moveTo')}
      open={open}
      onOk={() => onOk(selected)}
      onCancel={onCancel}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      destroyOnClose
    >
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
