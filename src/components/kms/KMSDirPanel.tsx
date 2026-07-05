import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button, Switch, Popconfirm, Empty, Typography, Space, Card, theme,
  Modal, Input, Checkbox, Tag, Tooltip, App,
} from 'antd'
import {
  FolderOpenOutlined, PlusOutlined, DeleteOutlined, EditOutlined,
  FileTextOutlined, FileImageOutlined, CheckCircleOutlined,
} from '@ant-design/icons'

const { Text } = Typography

interface IndexDir {
  id: string
  dir_path: string
  display_name: string
  enabled: number
  recursive: number
  file_extensions: string
  created_at: number
  updated_at: number
}

interface KMSDirPanelProps {
  dirs: IndexDir[]
  onUpdateDir: (id: string, updates: { displayName?: string; enabled?: boolean; recursive?: boolean; fileExtensions?: string[] }) => void
  onDeleteDir: (id: string) => void
  onAddDir: (dirPath: string, displayName?: string, recursive?: boolean, fileExtensions?: string[]) => void
}

/** 支持的文件扩展名分组 */
const FILE_TYPE_GROUPS: { labelKey: string; icon: React.ReactNode; exts: string[] }[] = [
  { labelKey: 'kms.fileGroupDocuments', icon: <FileTextOutlined />, exts: ['pdf', 'doc', 'docx', 'xlsx', 'xls', 'csv', 'pptx'] },
  { labelKey: 'kms.fileGroupText', icon: <FileTextOutlined />, exts: ['txt', 'md', 'html', 'htm'] },
  { labelKey: 'kms.fileGroupImages', icon: <FileImageOutlined />, exts: ['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'] },
]

/** 所有支持的扩展名 */
const ALL_SUPPORTED_EXTS = FILE_TYPE_GROUPS.flatMap(g => g.exts)

const KMSDirPanel: React.FC<KMSDirPanelProps> = ({ dirs, onUpdateDir, onDeleteDir, onAddDir }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()

  const [modalOpen, setModalOpen] = useState(false)
  const [editingDir, setEditingDir] = useState<IndexDir | null>(null)
  const [pendingDirPath, setPendingDirPath] = useState<string>('')
  const [displayName, setDisplayName] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [selectedExts, setSelectedExts] = useState<string[]>([])
  const [allExts, setAllExts] = useState(true)

  const parseExts = useCallback((extStr: string): string[] => {
    if (!extStr || !extStr.trim()) return []
    return extStr.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  }, [])

  const handleAddDir = useCallback(async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        properties: ['openDirectory'],
      })
      if (result && !result.canceled && result.filePaths.length > 0) {
        const dirPath = result.filePaths[0]
        const defaultName = dirPath.split(/[/\\]/).pop() || dirPath
        setEditingDir(null)
        setPendingDirPath(dirPath)
        setDisplayName(defaultName)
        setRecursive(true)
        setSelectedExts([])
        setAllExts(true)
        setModalOpen(true)
      }
    } catch (err) {
      console.error('Failed to open directory picker:', err)
    }
  }, [])

  const handleEditDir = useCallback((dir: IndexDir) => {
    const exts = parseExts(dir.file_extensions)
    setEditingDir(dir)
    setPendingDirPath(dir.dir_path)
    setDisplayName(dir.display_name)
    setRecursive(dir.recursive === 1)
    setSelectedExts(exts)
    setAllExts(exts.length === 0)
    setModalOpen(true)
  }, [parseExts])

  const handleSaveDir = useCallback(() => {
    const finalExts = allExts ? [] : selectedExts
    if (editingDir) {
      onUpdateDir(editingDir.id, {
        displayName: displayName.trim() || undefined,
        recursive,
        fileExtensions: finalExts,
      })
      message.success(t('kms.dirConfigSaved'))
    } else {
      onAddDir(pendingDirPath, displayName.trim() || undefined, recursive, finalExts)
      message.success(t('kms.dirConfigAdded'))
    }
    setModalOpen(false)
  }, [editingDir, pendingDirPath, displayName, recursive, allExts, selectedExts, onUpdateDir, onAddDir, message, t])

  const handleAllExtsChange = useCallback((checked: boolean) => {
    setAllExts(checked)
    if (checked) {
      setSelectedExts([])
    }
  }, [])

  const handleExtChange = useCallback((ext: string, checked: boolean) => {
    setAllExts(false)
    setSelectedExts(prev => {
      if (checked) {
        const next = [...prev, ext]
        if (next.length === ALL_SUPPORTED_EXTS.length) {
          setAllExts(true)
          return []
        }
        return next
      }
      return prev.filter(e => e !== ext)
    })
  }, [])

  const isExtSelected = useCallback((ext: string): boolean => {
    return allExts || selectedExts.includes(ext)
  }, [allExts, selectedExts])

  const formatDirExts = useCallback((dir: IndexDir): { text: string; count: number } => {
    const exts = parseExts(dir.file_extensions)
    if (exts.length === 0) {
      return { text: t('kms.allFileTypes'), count: ALL_SUPPORTED_EXTS.length }
    }
    return { text: exts.map(e => `.${e}`).join('  '), count: exts.length }
  }, [parseExts, t])

  const modalTitle = editingDir ? t('kms.editDir') : t('kms.addDir')

  if (dirs.length === 0) {
    return (
      <div style={{ padding: '60px 20px', textAlign: 'center' }}>
        <Empty
          image={<FolderOpenOutlined style={{ fontSize: 48, color: token.colorTextQuaternary }} />}
          description={
            <div>
              <Text style={{ display: 'block', marginBottom: 8, fontSize: 15, fontWeight: 500 }}>
                {t('kms.noDirs')}
              </Text>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={handleAddDir}
              >
                {t('kms.addDir')}
              </Button>
            </div>
          }
        />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '0 0 16px 0', display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleAddDir}
        >
          {t('kms.addDir')}
        </Button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          {dirs.map((dir) => {
            const extInfo = formatDirExts(dir)
            return (
              <Card
                key={dir.id}
                size="small"
                style={{
                  borderLeft: `3px solid ${dir.enabled ? token.colorPrimary : token.colorTextQuaternary}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <FolderOpenOutlined style={{ color: dir.enabled ? token.colorPrimary : token.colorTextQuaternary }} />
                      <Text strong style={{ fontSize: 14 }}>
                        {dir.display_name || dir.dir_path.split(/[/\\]/).pop()}
                      </Text>
                      <Switch
                        size="small"
                        checked={dir.enabled === 1}
                        onChange={(checked) => onUpdateDir(dir.id, { enabled: checked })}
                      />
                    </div>
                    <Text
                      type="secondary"
                      style={{ fontSize: 12, display: 'block' }}
                      ellipsis={{ tooltip: dir.dir_path }}
                    >
                      {dir.dir_path}
                    </Text>
                    <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                      {dir.recursive === 1 && (
                        <Tag style={{ fontSize: 11, margin: 0, lineHeight: '18px', padding: '0 6px' }}>
                          {t('kms.dirRecursive')}
                        </Tag>
                      )}
                      <Tooltip title={extInfo.text}>
                        <Tag
                          color={extInfo.count === ALL_SUPPORTED_EXTS.length ? 'blue' : undefined}
                          style={{ fontSize: 11, margin: 0, lineHeight: '18px', padding: '0 6px' }}
                        >
                          {t('kms.fileTypes')}: {extInfo.count === ALL_SUPPORTED_EXTS.length
                            ? t('kms.allFileTypes')
                            : `${extInfo.count} ${t('kms.typesUnit')}`}
                        </Tag>
                      </Tooltip>
                    </div>
                  </div>
                  <Space size={2}>
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => handleEditDir(dir)}
                    />
                    <Popconfirm
                      title={t('kms.removeDirConfirm')}
                      onConfirm={() => onDeleteDir(dir.id)}
                      okText={t('common.confirm')}
                      cancelText={t('common.cancel')}
                    >
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                      />
                    </Popconfirm>
                  </Space>
                </div>
              </Card>
            )
          })}
        </Space>
      </div>

      {/* 目录配置弹窗 */}
      <Modal
        title={modalTitle}
        open={modalOpen}
        onOk={handleSaveDir}
        onCancel={() => setModalOpen(false)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        width={560}
        destroyOnClose
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 8 }}>
          {/* 目录路径（只读） */}
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              {t('kms.dirPath')}
            </Text>
            <Input value={pendingDirPath} readOnly size="small" />
          </div>

          {/* 显示名称 */}
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              {t('kms.dirDisplayName')}
            </Text>
            <Input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder={t('kms.dirDisplayNamePlaceholder')}
              size="small"
            />
          </div>

          {/* 递归扫描 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <Text style={{ fontSize: 13 }}>{t('kms.dirRecursive')}</Text>
              <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                {t('kms.dirRecursiveDesc')}
              </Text>
            </div>
            <Switch checked={recursive} onChange={setRecursive} size="small" />
          </div>

          {/* 文件类型选择 */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={{ fontSize: 13 }}>{t('kms.fileTypes')}</Text>
              <Checkbox checked={allExts} onChange={e => handleAllExtsChange(e.target.checked)}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.allFileTypes')}</Text>
              </Checkbox>
            </div>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
              {t('kms.fileTypesDesc')}
            </Text>
            <div style={{
              maxHeight: 240,
              overflow: 'auto',
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: 6,
              padding: 8,
            }}>
              {FILE_TYPE_GROUPS.map((group) => (
                <div key={group.labelKey} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ color: token.colorTextTertiary, fontSize: 13 }}>{group.icon}</span>
                    <Text type="secondary" style={{ fontSize: 12, fontWeight: 500 }}>{t(group.labelKey)}</Text>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingLeft: 22 }}>
                    {group.exts.map(ext => (
                      <Tag.CheckableTag
                        key={ext}
                        checked={isExtSelected(ext)}
                        onChange={checked => handleExtChange(ext, checked)}
                        style={{ fontSize: 12 }}
                      >
                        .{ext}
                      </Tag.CheckableTag>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {/* 已选统计 */}
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
              <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: 12 }} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {allExts
                  ? t('kms.allFileTypesSelected', { count: ALL_SUPPORTED_EXTS.length })
                  : t('kms.fileTypesSelected', { count: selectedExts.length })}
              </Text>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default KMSDirPanel
