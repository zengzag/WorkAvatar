import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button, Switch, Popconfirm, Empty, Typography, Space, Card, theme,
  Modal, Input, Checkbox, Tag, Tooltip, App, Select, Spin,
} from 'antd'
import {
  FolderOpenOutlined, PlusOutlined, DeleteOutlined, EditOutlined,
  FileTextOutlined, FileImageOutlined, SafetyOutlined,
} from '@ant-design/icons'

const { Title, Text, Paragraph } = Typography

interface IndexDir {
  id: string
  dir_path: string
  display_name: string
  enabled: number
  recursive: number
  file_extensions: string
  file_count?: number
  created_at: number
  updated_at: number
}

interface ExcludedFile {
  id: string
  fileName: string
  filePath: string
  level: number
}

interface KMSDirPanelProps {
  dirs: IndexDir[]
  onUpdateDir: (id: string, updates: { displayName?: string; enabled?: boolean; recursive?: boolean; fileExtensions?: string[] }) => void
  onDeleteDir: (id: string) => Promise<{ migrated?: number; removed?: number } | undefined>
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
  const [aiExclusionLevel, setAiExclusionLevel] = useState<number>(0)
  const [excludedFiles, setExcludedFiles] = useState<ExcludedFile[]>([])
  const [originalExcluded, setOriginalExcluded] = useState<Record<string, number>>({})
  const [originalDirLevel, setOriginalDirLevel] = useState<number>(0)
  const [loadingExclusions, setLoadingExclusions] = useState(false)

  const parseExts = useCallback((extStr: string): string[] => {
    if (!extStr || !extStr.trim()) return []
    return extStr.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  }, [])

  const levelOptions = [
    { value: 0, label: t('kms.sensitive.level0') },
    { value: 1, label: t('kms.sensitive.level1') },
    { value: 2, label: t('kms.sensitive.level2') },
  ]

  const resetExclusions = useCallback(() => {
    setAiExclusionLevel(0)
    setExcludedFiles([])
    setOriginalExcluded({})
    setOriginalDirLevel(0)
    setLoadingExclusions(false)
  }, [])

  const loadDirExclusions = useCallback(async (dirId: string) => {
    setLoadingExclusions(true)
    try {
      const result = await window.electronAPI.kms.listAiExclusions({ dirId })
      if (result && !result.error) {
        const files: ExcludedFile[] = Array.isArray(result.files) ? result.files : []
        setExcludedFiles(files)
        setOriginalExcluded(Object.fromEntries(files.map(f => [f.id, f.level])))
        const level = Array.isArray(result.dirs) && result.dirs.length > 0 ? result.dirs[0].level : 0
        setAiExclusionLevel(level)
        setOriginalDirLevel(level)
      }
    } catch (err) {
      console.error('Failed to load AI exclusions:', err)
    } finally {
      setLoadingExclusions(false)
    }
  }, [])

  const handleExcludedFileLevelChange = useCallback((fileId: string, level: number) => {
    setExcludedFiles(prev => level === 0
      ? prev.filter(f => f.id !== fileId)
      : prev.map(f => (f.id === fileId ? { ...f, level } : f)))
  }, [])

  const handleAddDir = useCallback(async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        properties: ['openDirectory'],
      })
      // safeHandle 在主进程异常时返回 { error } 对象，需显式判定
      if (result && (result as any).error) {
        message.error(t('kms.dirPickerFailed') + ((result as any).error ? `: ${(result as any).error}` : ''))
        return
      }
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        const dirPath = result.filePaths[0]
        const defaultName = dirPath.split(/[/\\]/).pop() || dirPath
        setEditingDir(null)
        setPendingDirPath(dirPath)
        setDisplayName(defaultName)
        setRecursive(true)
        setSelectedExts([])
        setAllExts(true)
        resetExclusions()
        setModalOpen(true)
      }
    } catch (err: any) {
      console.error('Failed to open directory picker:', err)
      message.error(t('kms.dirPickerFailed') + (err?.message ? `: ${err.message}` : ''))
    }
  }, [message, t, resetExclusions])

  const handleEditDir = useCallback((dir: IndexDir) => {
    const exts = parseExts(dir.file_extensions)
    setEditingDir(dir)
    setPendingDirPath(dir.dir_path)
    setDisplayName(dir.display_name)
    setRecursive(dir.recursive === 1)
    setSelectedExts(exts)
    setAllExts(exts.length === 0)
    resetExclusions()
    setModalOpen(true)
    loadDirExclusions(dir.id)
  }, [parseExts, resetExclusions, loadDirExclusions])

  const handleSaveDir = useCallback(async () => {
    const finalExts = allExts ? [] : selectedExts
    if (editingDir) {
      onUpdateDir(editingDir.id, {
        displayName: displayName.trim() || undefined,
        recursive,
        fileExtensions: finalExts,
      })
      try {
        if (aiExclusionLevel !== originalDirLevel) {
          await window.electronAPI.kms.setDirAiExclusion({ dirId: editingDir.id, level: aiExclusionLevel as 0 | 1 | 2 })
        }
        const currentMap: Record<string, number> = {}
        for (const f of excludedFiles) currentMap[f.id] = f.level
        const fileIds = Array.from(new Set([...Object.keys(originalExcluded), ...Object.keys(currentMap)]))
        for (const fileId of fileIds) {
          const next = currentMap[fileId] ?? 0
          if (next !== (originalExcluded[fileId] ?? 0)) {
            await window.electronAPI.kms.setFileAiExclusion({ fileId, level: next as 0 | 1 | 2 })
          }
        }
        message.success(t('kms.dirConfigSaved'))
      } catch (err: any) {
        console.error('Failed to save AI exclusions:', err)
        message.error(t('kms.sensitive.saveFailed') + (err?.message ? `: ${err.message}` : ''))
      }
      setModalOpen(false)
    } else {
      try {
        await onAddDir(pendingDirPath, displayName.trim() || undefined, recursive, finalExts)
        message.success(t('kms.dirConfigAdded'))
        setModalOpen(false)
      } catch (err: any) {
        message.error(t('kms.dirAddFailed') + (err?.message ? `: ${err.message}` : ''))
      }
    }
  }, [editingDir, pendingDirPath, displayName, recursive, allExts, selectedExts, aiExclusionLevel, originalDirLevel, excludedFiles, originalExcluded, onUpdateDir, onAddDir, message, t])

  const handleAllExtsChange = useCallback((checked: boolean) => {
    setAllExts(checked)
    if (checked) {
      setSelectedExts([])
    }
  }, [])

  const formatDirExts = useCallback((dir: IndexDir): { text: string; count: number } => {
    const exts = parseExts(dir.file_extensions)
    if (exts.length === 0) {
      return { text: t('kms.allFileTypes'), count: ALL_SUPPORTED_EXTS.length }
    }
    return { text: exts.map(e => `.${e}`).join('  '), count: exts.length }
  }, [parseExts, t])

  const modalTitle = editingDir ? t('kms.editDir') : t('kms.addDir')

  // 标题与"添加目录"按钮同行，左标题右按钮
  const header = (
    <>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Space>
          <FolderOpenOutlined style={{ color: token.colorPrimary }} />
          <Title level={5} style={{ margin: 0 }}>{t('kms.dirs')}</Title>
        </Space>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleAddDir}
        >
          {t('kms.addDir')}
        </Button>
      </div>
      <Paragraph type="secondary" style={{ margin: '0 0 12px', fontSize: 12 }}>
        {t('kms.settingsPanel.dirsDesc')}
      </Paragraph>
    </>
  )

  // 目录配置弹窗（必须始终渲染，否则 dirs 为空时点击"添加目录"按钮后 Modal 不会挂载）
  const dirConfigModal = (
    <Modal
      title={modalTitle}
      open={modalOpen}
      onOk={handleSaveDir}
      onCancel={() => setModalOpen(false)}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      width={560}
      zIndex={1500}
      styles={{ mask: { zIndex: 1499 }, wrapper: { zIndex: 1500 } }}
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {FILE_TYPE_GROUPS.map((group) => (
              <div key={group.labelKey}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  {group.icon}
                  <Text style={{ fontSize: 12, fontWeight: 500 }}>{t(group.labelKey)}</Text>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {group.exts.map(ext => (
                    <Tag.CheckableTag
                      key={ext}
                      checked={selectedExts.includes(ext)}
                      onChange={(checked) => {
                        if (checked) {
                          setSelectedExts(prev => Array.from(new Set([...prev, ext])))
                        } else {
                          setSelectedExts(prev => prev.filter(e => e !== ext))
                        }
                        setAllExts(false)
                      }}
                      style={{ fontSize: 12 }}
                    >
                      .{ext}
                    </Tag.CheckableTag>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 敏感内容控制（AI 排除级别），仅编辑已有目录时可用 */}
        {editingDir && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <SafetyOutlined style={{ color: token.colorWarning }} />
              <Text style={{ fontSize: 13, fontWeight: 500 }}>{t('kms.sensitive.title')}</Text>
            </div>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
              {t('kms.sensitive.desc')}
            </Text>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
              <Text style={{ fontSize: 12 }}>{t('kms.sensitive.dirLevel')}</Text>
              <Select
                size="small"
                style={{ width: 180, flexShrink: 0 }}
                value={aiExclusionLevel}
                onChange={setAiExclusionLevel}
                options={levelOptions}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <Text style={{ fontSize: 12, fontWeight: 500 }}>{t('kms.sensitive.fileLevel')}</Text>
              {excludedFiles.length > 0 && (
                <Tag color="orange" style={{ fontSize: 10, margin: 0, lineHeight: '16px', padding: '0 5px' }}>
                  {excludedFiles.length}
                </Tag>
              )}
            </div>
            {loadingExclusions ? (
              <div style={{ textAlign: 'center', padding: '8px 0' }}><Spin size="small" /></div>
            ) : excludedFiles.length === 0 ? (
              <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.sensitive.noFiles')}</Text>
            ) : (
              <div style={{ maxHeight: 200, overflow: 'auto' }}>
                {excludedFiles.map(file => (
                  <div key={file.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Text style={{ fontSize: 12, minWidth: 0 }} ellipsis={{ tooltip: file.filePath }}>
                      {file.fileName}
                    </Text>
                    <Select
                      size="small"
                      style={{ width: 180, flexShrink: 0 }}
                      value={file.level}
                      onChange={(v) => handleExcludedFileLevelChange(file.id, v)}
                      options={levelOptions}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )

  // 空状态：仅显示 Empty + 标题栏中的添加按钮
  if (dirs.length === 0) {
    return (
      <>
        {header}
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <Empty
            image={<FolderOpenOutlined style={{ fontSize: 48, color: token.colorTextQuaternary }} />}
            description={
              <div>
                <Text style={{ display: 'block', fontSize: 15, fontWeight: 500 }}>
                  {t('kms.noDirs')}
                </Text>
              </div>
            }
          />
        </div>
        {dirConfigModal}
      </>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {header}

      <div style={{ flex: 1, overflow: 'auto' }}>
        <Space orientation="vertical" style={{ width: '100%' }} size={8}>
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
                      <Tag
                        color={dir.file_count ? 'green' : undefined}
                        style={{ fontSize: 11, margin: 0, lineHeight: '18px', padding: '0 6px' }}
                      >
                        {t('kms.dirFileCount', { count: dir.file_count || 0 })}
                      </Tag>
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
                      onConfirm={async () => {
                        const result = await onDeleteDir(dir.id)
                        if (result && (result.removed ?? 0) > 0) {
                          message.info(t('kms.removeDirCleanupHint', { count: result.removed }))
                        }
                      }}
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
      {dirConfigModal}
    </div>
  )
}

export default KMSDirPanel
