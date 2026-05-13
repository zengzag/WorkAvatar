import { useState, useEffect, useCallback } from 'react'
import {
  Button,
  Table,
  Space,
  Breadcrumb,
  Modal,
  Input,
  message,
  Popconfirm,
  Tooltip,
  Typography,
  Tag,
  theme,
  Dropdown,
  Empty,
} from 'antd'
import {
  FolderOutlined,
  FileOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  UploadOutlined,
  FolderAddOutlined,
  FileAddOutlined,
  ArrowUpOutlined,
  ReloadOutlined,
  EyeOutlined,
  DownloadOutlined,
  MoreOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

interface WorkspaceItem {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  modified?: number
}

interface ProjectWorkspaceProps {
  projectId: string
  projectPath: string
}

const formatFileSize = (bytes?: number): string => {
  if (bytes === undefined || bytes === null) return '-'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

const formatTimestamp = (ts?: number): string => {
  if (!ts) return '-'
  return new Date(ts * 1000).toLocaleString()
}

const ProjectWorkspace: React.FC<ProjectWorkspaceProps> = ({ projectId, projectPath }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [items, setItems] = useState<WorkspaceItem[]>([])
  const [currentPath, setCurrentPath] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [createFolderModalOpen, setCreateFolderModalOpen] = useState(false)
  const [createFileModalOpen, setCreateFileModalOpen] = useState(false)
  const [renameModalOpen, setRenameModalOpen] = useState(false)
  const [viewFileModalOpen, setViewFileModalOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFileName, setNewFileName] = useState('')
  const [renameName, setRenameName] = useState('')
  const [renameItem, setRenameItem] = useState<WorkspaceItem | null>(null)
  const [viewContent, setViewContent] = useState<{ name: string; path: string; content: string } | null>(null)
  const [viewLoading, setViewLoading] = useState(false)

  const loadItems = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.workspace.listFiles({
        project_id: projectId,
        sub_path: currentPath || undefined,
        recursive: false,
      })
      if (result.success && result.items) {
        setItems(result.items)
      } else {
        message.error(result.error || t('workspace.loadFailed'))
      }
    } catch {
      message.error(t('workspace.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [projectId, currentPath, t])

  useEffect(() => {
    loadItems()
  }, [loadItems])

  const handleNavigate = (itemPath: string, type: 'file' | 'dir') => {
    if (type === 'dir') {
      setCurrentPath(itemPath)
    }
  }

  const handleNavigateUp = () => {
    if (!currentPath) return
    const parts = currentPath.split('/')
    parts.pop()
    setCurrentPath(parts.join('/'))
  }

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) {
      message.warning(t('workspace.folderNameRequired'))
      return
    }
    const folderPath = currentPath ? `${currentPath}/${newFolderName.trim()}` : newFolderName.trim()
    const result = await window.electronAPI.workspace.createFolder({
      project_id: projectId,
      folder_path: folderPath,
    })
    if (result.success) {
      message.success(t('workspace.createFolderSuccess'))
      setCreateFolderModalOpen(false)
      setNewFolderName('')
      loadItems()
    } else {
      message.error(result.error || t('workspace.createFolderFailed'))
    }
  }

  const handleCreateFile = async () => {
    if (!newFileName.trim()) {
      message.warning(t('workspace.fileNameRequired'))
      return
    }
    const filePath = currentPath ? `${currentPath}/${newFileName.trim()}` : newFileName.trim()
    const result = await window.electronAPI.workspace.writeFile({
      project_id: projectId,
      file_path: filePath,
      content: '',
    })
    if (result.success) {
      message.success(t('workspace.createFileSuccess'))
      setCreateFileModalOpen(false)
      setNewFileName('')
      loadItems()
    } else {
      message.error(result.error || t('workspace.createFileFailed'))
    }
  }

  const handleDelete = async (item: WorkspaceItem) => {
    const result = await window.electronAPI.workspace.deleteItem({
      project_id: projectId,
      item_path: item.path,
    })
    if (result.success) {
      message.success(t('workspace.deleteSuccess'))
      loadItems()
    } else {
      message.error(result.error || t('workspace.deleteFailed'))
    }
  }

  const handleRename = async () => {
    if (!renameItem || !renameName.trim()) return
    const result = await window.electronAPI.workspace.renameItem({
      project_id: projectId,
      item_path: renameItem.path,
      new_name: renameName.trim(),
    })
    if (result.success) {
      message.success(t('workspace.renameSuccess'))
      setRenameModalOpen(false)
      setRenameItem(null)
      setRenameName('')
      loadItems()
    } else {
      message.error(result.error || t('workspace.renameFailed'))
    }
  }

  const handleViewFile = async (item: WorkspaceItem) => {
    setViewLoading(true)
    setViewFileModalOpen(true)
    try {
      const result = await window.electronAPI.workspace.readFile({
        project_id: projectId,
        file_path: item.path,
      })
      if (result.success) {
        setViewContent({ name: item.name, path: item.path, content: result.content || '' })
      } else {
        message.error(result.error || t('workspace.readFileFailed'))
        setViewFileModalOpen(false)
      }
    } catch {
      message.error(t('workspace.readFileFailed'))
      setViewFileModalOpen(false)
    } finally {
      setViewLoading(false)
    }
  }

  const handleImportFiles = async () => {
    const result = await window.electronAPI.app.showOpenDialog({
      title: t('workspace.importFiles'),
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled || !result.filePaths.length) return

    const importResult = await window.electronAPI.workspace.importFiles({
      project_id: projectId,
      source_paths: result.filePaths,
      target_folder: currentPath || undefined,
    })
    if (importResult.success) {
      message.success(t('workspace.importSuccess', { count: importResult.imported?.length || 0 }))
      loadItems()
    }
    if (importResult.errors?.length) {
      for (const err of importResult.errors) {
        if (err.error) message.error(`${err.path}: ${err.error}`)
      }
    }
  }

  const handleOpenInExplorer = async () => {
    const subPath = currentPath || undefined
    await window.electronAPI.app.showOpenDialog({
      title: t('workspace.openInExplorer'),
      defaultPath: subPath ? `${projectPath}\\${subPath.replace(/\//g, '\\')}` : projectPath,
      properties: ['openDirectory'],
    })
  }

  const pathParts = currentPath ? currentPath.split('/').filter(Boolean) : []

  const columns = [
    {
      title: t('workspace.name'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: WorkspaceItem) => (
        <Space>
          {record.type === 'dir' ? (
            <FolderOutlined style={{ color: '#faad14', fontSize: 18 }} />
          ) : (
            <FileOutlined style={{ color: token.colorTextSecondary, fontSize: 18 }} />
          )}
          <a
            onClick={() => handleNavigate(record.path, record.type)}
            style={{ cursor: record.type === 'dir' ? 'pointer' : 'default' }}
          >
            {name}
          </a>
        </Space>
      ),
      sorter: (a: WorkspaceItem, b: WorkspaceItem) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      },
      defaultSortOrder: 'ascend' as const,
    },
    {
      title: t('workspace.size'),
      dataIndex: 'size',
      key: 'size',
      width: 120,
      render: (size: number, record: WorkspaceItem) =>
        record.type === 'file' ? formatFileSize(size) : '-',
    },
    {
      title: t('workspace.modified'),
      dataIndex: 'modified',
      key: 'modified',
      width: 180,
      render: (modified: number) => formatTimestamp(modified),
    },
    {
      title: t('workspace.actions'),
      key: 'actions',
      width: 120,
      render: (_: any, record: WorkspaceItem) => (
        <Space size={4}>
          {record.type === 'file' && (
            <Tooltip title={t('workspace.view')}>
              <Button
                type="text"
                size="small"
                icon={<EyeOutlined />}
                onClick={() => handleViewFile(record)}
              />
            </Tooltip>
          )}
          <Tooltip title={t('workspace.rename')}>
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setRenameItem(record)
                setRenameName(record.name)
                setRenameModalOpen(true)
              }}
            />
          </Tooltip>
          <Popconfirm
            title={t('workspace.confirmDelete')}
            description={
              record.type === 'dir'
                ? t('workspace.deleteFolderDesc')
                : t('workspace.deleteFileDesc')
            }
            onConfirm={() => handleDelete(record)}
          >
            <Tooltip title={t('workspace.delete')}>
              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <Breadcrumb
          items={[
            {
              title: (
                <a onClick={() => setCurrentPath('')}>
                  <FolderOutlined /> {t('workspace.root')}
                </a>
              ),
            },
            ...pathParts.map((part, index) => ({
              title: (
                <a
                  onClick={() => setCurrentPath(pathParts.slice(0, index + 1).join('/'))}
                >
                  {part}
                </a>
              ),
            })),
          ]}
        />
        <Space size={4}>
          {currentPath && (
            <Button
              icon={<ArrowUpOutlined />}
              size="small"
              onClick={handleNavigateUp}
            >
              {t('workspace.up')}
            </Button>
          )}
          <Button
            icon={<ReloadOutlined />}
            size="small"
            onClick={loadItems}
          />
        </Space>
      </div>

      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <Space size={4}>
          <Button
            icon={<FolderAddOutlined />}
            size="small"
            onClick={() => setCreateFolderModalOpen(true)}
          >
            {t('workspace.newFolder')}
          </Button>
          <Button
            icon={<FileAddOutlined />}
            size="small"
            onClick={() => setCreateFileModalOpen(true)}
          >
            {t('workspace.newFile')}
          </Button>
          <Button
            icon={<UploadOutlined />}
            size="small"
            onClick={handleImportFiles}
          >
            {t('workspace.import')}
          </Button>
        </Space>
        <Dropdown
          menu={{
            items: [
              {
                key: 'open-explorer',
                icon: <DownloadOutlined />,
                label: t('workspace.openInExplorer'),
                onClick: handleOpenInExplorer,
              },
            ],
          }}
        >
          <Button icon={<MoreOutlined />} size="small" />
        </Dropdown>
      </div>

      <Table
        dataSource={items}
        columns={columns}
        rowKey="path"
        loading={loading}
        size="small"
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('workspace.empty')}
            >
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateFileModalOpen(true)}>
                {t('workspace.newFile')}
              </Button>
            </Empty>
          ),
        }}
        onRow={(record) => ({
          onDoubleClick: () => handleNavigate(record.path, record.type),
        })}
      />

      <Modal
        title={t('workspace.newFolder')}
        open={createFolderModalOpen}
        onOk={handleCreateFolder}
        onCancel={() => { setCreateFolderModalOpen(false); setNewFolderName('') }}
        okText={t('common.create')}
        cancelText={t('common.cancel')}
      >
        <Input
          placeholder={t('workspace.folderNamePlaceholder')}
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
          onPressEnter={handleCreateFolder}
          autoFocus
        />
      </Modal>

      <Modal
        title={t('workspace.newFile')}
        open={createFileModalOpen}
        onOk={handleCreateFile}
        onCancel={() => { setCreateFileModalOpen(false); setNewFileName('') }}
        okText={t('common.create')}
        cancelText={t('common.cancel')}
      >
        <Input
          placeholder={t('workspace.fileNamePlaceholder')}
          value={newFileName}
          onChange={(e) => setNewFileName(e.target.value)}
          onPressEnter={handleCreateFile}
          autoFocus
        />
      </Modal>

      <Modal
        title={t('workspace.renameTitle', { name: renameItem?.name })}
        open={renameModalOpen}
        onOk={handleRename}
        onCancel={() => { setRenameModalOpen(false); setRenameItem(null); setRenameName('') }}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <Input
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          onPressEnter={handleRename}
          autoFocus
        />
      </Modal>

      <Modal
        title={viewContent?.name || ''}
        open={viewFileModalOpen}
        onCancel={() => { setViewFileModalOpen(false); setViewContent(null) }}
        footer={null}
        width={700}
        loading={viewLoading}
      >
        {viewContent && (
          <div>
            <div style={{ marginBottom: 8 }}>
              <Tag>{viewContent.path}</Tag>
              <Text type="secondary">
                {formatFileSize(new Blob([viewContent.content]).size)}
              </Text>
            </div>
            <Input.TextArea
              value={viewContent.content}
              readOnly
              autoSize={{ minRows: 10, maxRows: 25 }}
              style={{ fontFamily: 'monospace', fontSize: 13 }}
            />
          </div>
        )}
      </Modal>
    </div>
  )
}

export default ProjectWorkspace
