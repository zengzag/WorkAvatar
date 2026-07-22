import { useMemo, useState, useCallback } from 'react'
import { Tree, Input, Button, Tooltip, Dropdown, Modal, message, theme } from 'antd'
import type { TreeDataNode, MenuProps } from 'antd'
import {
  PlusOutlined,
  FolderOutlined,
  FileTextOutlined,
  SearchOutlined,
  ReloadOutlined,
  FolderAddOutlined,
  FormOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { NoteNode } from '../../types/notes'

interface Props {
  tree: NoteNode[]
  loading: boolean
  currentRelPath: string | null
  onOpen: (relPath: string) => void
  onRefresh: () => void
  onCreateNote: (parentRelPath: string, name: string) => Promise<unknown>
  onCreateFolder: (parentRelPath: string, name: string) => Promise<unknown>
  onRename: (relPath: string, newName: string) => Promise<unknown>
  onDelete: (relPath: string) => Promise<boolean>
  onMove: (srcRelPath: string, destParentRelPath: string) => Promise<boolean>
}

/** 把服务端树转成 antd TreeDataNode，并附带 relPath 在 key 上 */
function toTreeData(nodes: NoteNode[], filter: string): TreeDataNode[] {
  const lower = filter.trim().toLowerCase()
  const build = (list: NoteNode[]): TreeDataNode[] => {
    const result: TreeDataNode[] = []
    for (const n of list) {
      if (n.type === 'folder') {
        const children = n.children ? build(n.children) : []
        // 文件夹在无筛选时始终展示；有筛选时仅当自身或子项命中时展示
        if (!lower || n.name.toLowerCase().includes(lower) || children.length > 0) {
          result.push({
            key: n.relPath,
            title: n.name,
            icon: <FolderOutlined />,
            children,
            isLeaf: false,
          })
        }
      } else {
        if (!lower || n.name.toLowerCase().includes(lower)) {
          result.push({
            key: n.relPath,
            title: n.name,
            icon: <FileTextOutlined />,
            isLeaf: true,
          })
        }
      }
    }
    return result
  }
  return build(nodes)
}

/** 收集所有文件夹 relPath（含根 ""），供移动目标选择 */
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

const ROOT_KEY = '__root__'

const NotesTree: React.FC<Props> = ({
  tree, loading, currentRelPath,
  onOpen, onRefresh, onCreateNote, onCreateFolder, onRename, onDelete, onMove,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [filter, setFilter] = useState('')
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const [renameModal, setRenameModal] = useState<{ relPath: string; name: string } | null>(null)
  const [createModal, setCreateModal] = useState<{ parentRelPath: string; type: 'note' | 'folder' } | null>(null)
  const [moveModal, setMoveModal] = useState<{ srcRelPath: string } | null>(null)
  const [contextNode, setContextNode] = useState<{ relPath: string; name: string; isLeaf: boolean } | null>(null)
  // createModal / renameModal 共用 name 输入
  const [createName, setCreateName] = useState('')

  const treeData = useMemo(() => {
    const data = toTreeData(tree, filter)
    // 虚拟根：让用户可在根级新建
    return [{
      key: ROOT_KEY,
      title: t('notes.vaultRoot'),
      icon: <FolderOutlined />,
      children: data,
      isLeaf: false,
    }]
  }, [tree, filter, t])

  const selectedKeys = useMemo(() => (currentRelPath ? [currentRelPath] : []), [currentRelPath])

  const handleSelect = useCallback((keys: React.Key[]) => {
    const key = keys[0] as string | undefined
    if (key && key !== ROOT_KEY) {
      // 仅文件可打开
      const node = findNode(tree, key)
      if (node && node.type === 'file') onOpen(key)
    }
  }, [tree, onOpen])

  const openCreate = useCallback((parentRelPath: string, type: 'note' | 'folder') => {
    setCreateModal({ parentRelPath, type })
  }, [])

  const handleCreateOk = useCallback(async () => {
    if (!createModal) return
    const name = createModal.type === 'note' ? (createName || t('notes.untitledNote')) : (createName || t('notes.newFolder'))
    if (createModal.type === 'note') {
      await onCreateNote(createModal.parentRelPath, name)
    } else {
      await onCreateFolder(createModal.parentRelPath, name)
    }
    setCreateModal(null)
    setCreateName('')
    // 展开父文件夹
    if (createModal.parentRelPath) {
      setExpandedKeys((prev) => prev.includes(createModal.parentRelPath) ? prev : [...prev, createModal.parentRelPath])
    }
  }, [createModal, createName, onCreateNote, onCreateFolder, t])

  const handleRenameOk = useCallback(async () => {
    if (!renameModal) return
    await onRename(renameModal.relPath, renameModal.name)
    setRenameModal(null)
  }, [renameModal, onRename])

  const handleDelete = useCallback(async (relPath: string) => {
    Modal.confirm({
      title: t('notes.confirmDelete'),
      content: relPath,
      okType: 'danger',
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      onOk: async () => { await onDelete(relPath) },
    })
  }, [t, onDelete])

  // 右键菜单
  const contextMenu: MenuProps = useMemo(() => {
    if (!contextNode) return { items: [] }
    const items: MenuProps['items'] = []
    if (!contextNode.isLeaf) {
      // 文件夹：新建笔记 / 新建文件夹
      items.push({ key: 'new-note', icon: <FileTextOutlined />, label: t('notes.newNote'), onClick: () => openCreate(contextNode.relPath, 'note') })
      items.push({ key: 'new-folder', icon: <FolderAddOutlined />, label: t('notes.newFolder'), onClick: () => openCreate(contextNode.relPath, 'folder') })
      items.push({ type: 'divider' })
    } else {
      items.push({ key: 'open', icon: <FormOutlined />, label: t('common.view'), onClick: () => onOpen(contextNode.relPath) })
    }
    items.push({ key: 'rename', icon: <FormOutlined />, label: t('common.rename'), onClick: () => setRenameModal({ relPath: contextNode.relPath, name: contextNode.name }) })
    items.push({ key: 'move', icon: <FolderOutlined />, label: t('notes.moveTo'), onClick: () => setMoveModal({ srcRelPath: contextNode.relPath }) })
    items.push({ type: 'divider' })
    items.push({ key: 'delete', icon: <DeleteOutlined />, danger: true, label: t('common.delete'), onClick: () => handleDelete(contextNode.relPath) })
    return { items }
  }, [contextNode, t, openCreate, onOpen, handleDelete])

  // 根节点右键菜单（在根级新建）
  const rootContextMenu: MenuProps = useMemo(() => ({
    items: [
      { key: 'new-note', icon: <FileTextOutlined />, label: t('notes.newNote'), onClick: () => openCreate('', 'note') },
      { key: 'new-folder', icon: <FolderAddOutlined />, label: t('notes.newFolder'), onClick: () => openCreate('', 'folder') },
    ],
  }), [t, openCreate])

  const folders = useMemo(() => collectFolders(tree), [tree])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: token.colorBgContainer }}>
      <div style={{ padding: '8px 8px 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
          placeholder={t('notes.searchPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1 }}
        />
        <Tooltip title={t('common.refresh')}>
          <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} loading={loading} />
        </Tooltip>
        <Tooltip title={t('notes.newNote')}>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openCreate('', 'note')} />
        </Tooltip>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 4px' }}>
        <Dropdown menu={rootContextMenu} trigger={['contextMenu']}>
          <div style={{ minHeight: '100%' }}>
            <Tree
              showIcon
              blockNode
              treeData={treeData}
              expandedKeys={expandedKeys}
              onExpand={(keys) => setExpandedKeys(keys)}
              selectedKeys={selectedKeys}
              onSelect={handleSelect}
              titleRender={(node) => {
                const key = String(node.key)
                if (key === ROOT_KEY) return <span>{node.title as any}</span>
                const isLeaf = (node as any).isLeaf
                return (
                  <Dropdown menu={contextMenu} trigger={['contextMenu']} onOpenChange={(open) => {
                    if (open) {
                      const name = typeof node.title === 'string' ? node.title : ''
                      setContextNode({ relPath: key, name, isLeaf: !!isLeaf })
                    }
                  }}>
                    <span style={{ flex: 1 }}>{node.title as any}</span>
                  </Dropdown>
                )
              }}
            />
          </div>
        </Dropdown>
      </div>

      {/* 新建 Modal */}
      <Modal
        title={createModal?.type === 'note' ? t('notes.newNote') : t('notes.newFolder')}
        open={!!createModal}
        onOk={handleCreateOk}
        onCancel={() => { setCreateModal(null); setCreateName('') }}
        okText={t('common.create')}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <Input
          autoFocus
          placeholder={createModal?.type === 'note' ? t('notes.noteNamePlaceholder') : t('notes.folderNamePlaceholder')}
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          onPressEnter={handleCreateOk}
        />
      </Modal>

      {/* 重命名 Modal */}
      <Modal
        title={t('common.rename')}
        open={!!renameModal}
        onOk={handleRenameOk}
        onCancel={() => setRenameModal(null)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <Input
          autoFocus
          value={renameModal?.name || ''}
          onChange={(e) => setRenameModal((prev) => prev ? { ...prev, name: e.target.value } : prev)}
          onPressEnter={handleRenameOk}
        />
      </Modal>

      {/* 移动 Modal */}
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
    </div>
  )
}

function findNode(nodes: NoteNode[], relPath: string): NoteNode | null {
  for (const n of nodes) {
    if (n.relPath === relPath) return n
    if (n.children) {
      const found = findNode(n.children, relPath)
      if (found) return found
    }
  }
  return null
}

// 移动目标选择 Modal
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
        selectedKeys={selected ? [selected] : [ROOT_KEY]}
        onSelect={(keys) => setSelected(String(keys[0] === ROOT_KEY ? '' : keys[0] || ''))}
        treeData={[{
          key: ROOT_KEY,
          title: t('notes.vaultRoot'),
          icon: <FolderOutlined />,
          children: toTreeData(toNoteNodes(options.filter((o) => o.value !== '')), ''),
        }]}
      />
    </Modal>
  )
}

// 辅助：把扁平文件夹列表还原成树（用于移动 Modal 的目标树）
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

export default NotesTree
