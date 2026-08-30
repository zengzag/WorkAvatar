import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button, Switch, Popconfirm, Empty, Typography, Space, Card, theme,
  Modal, Input, Tag, Tooltip, App,
} from 'antd'
import {
  FileSearchOutlined, PlusOutlined, DeleteOutlined, EditOutlined,
} from '@ant-design/icons'

const { Title, Text, Paragraph } = Typography

interface SearchDir {
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

interface KMSSearchDirPanelProps {
  dirs: SearchDir[]
  onUpdateDir: (id: string, updates: { displayName?: string; enabled?: boolean; recursive?: boolean; fileExtensions?: string[] }) => void
  onDeleteDir: (id: string) => void
  onAddDir: (dirPath: string, displayName?: string, recursive?: boolean, fileExtensions?: string[]) => Promise<void> | void
}

const KMSSearchDirPanel: React.FC<KMSSearchDirPanelProps> = ({ dirs, onUpdateDir, onDeleteDir, onAddDir }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()

  const [modalOpen, setModalOpen] = useState(false)
  const [editingDir, setEditingDir] = useState<SearchDir | null>(null)
  const [pendingDirPath, setPendingDirPath] = useState<string>('')
  const [displayName, setDisplayName] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [extInput, setExtInput] = useState('')
  const [saving, setSaving] = useState(false)

  const parseExts = useCallback((extStr: string): string[] => {
    if (!extStr || !extStr.trim()) return []
    return extStr.split(/[,，]/).map(e => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean)
  }, [])

  const handleAddDir = useCallback(async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        properties: ['openDirectory'],
      })
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
        setExtInput('')
        setModalOpen(true)
      }
    } catch (err: any) {
      console.error('Failed to open directory picker:', err)
      message.error(t('kms.dirPickerFailed') + (err?.message ? `: ${err.message}` : ''))
    }
  }, [message, t])

  const handleEditDir = useCallback((dir: SearchDir) => {
    const exts = parseExts(dir.file_extensions)
    setEditingDir(dir)
    setPendingDirPath(dir.dir_path)
    setDisplayName(dir.display_name)
    setRecursive(dir.recursive === 1)
    setExtInput(exts.join(', '))
    setModalOpen(true)
  }, [parseExts])

  const handleSaveDir = useCallback(async () => {
    const finalExts = parseExts(extInput)
    if (editingDir) {
      onUpdateDir(editingDir.id, {
        displayName: displayName.trim() || undefined,
        recursive,
        fileExtensions: finalExts,
      })
      message.success(t('kms.dirConfigSaved'))
      setModalOpen(false)
      return
    }
    // 新增目录：主进程会立即扫描目录并注册文件（await 完成才关闭弹窗）
    setSaving(true)
    try {
      await onAddDir(pendingDirPath, displayName.trim() || undefined, recursive, finalExts)
      message.success(t('kms.dirConfigAdded'))
      setModalOpen(false)
    } catch (err: any) {
      message.error(t('kms.dirAddFailed') + (err?.message ? `: ${err.message}` : ''))
      throw err // 抛出让 Modal 保持打开，便于用户重试
    } finally {
      setSaving(false)
    }
  }, [editingDir, pendingDirPath, displayName, recursive, extInput, parseExts, onUpdateDir, onAddDir, message, t])

  const modalTitle = editingDir ? t('kms.editSearchDir') : t('kms.addSearchDir')

  const header = (
    <>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Space>
          <FileSearchOutlined style={{ color: token.colorPrimary }} />
          <Title level={5} style={{ margin: 0 }}>{t('kms.searchDirs')}</Title>
        </Space>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleAddDir}
        >
          {t('kms.addSearchDir')}
        </Button>
      </div>
      <Paragraph type="secondary" style={{ margin: '0 0 12px', fontSize: 12 }}>
        {t('kms.settingsPanel.searchDirsDesc')}
      </Paragraph>
    </>
  )

  const dirConfigModal = (
    <Modal
      title={modalTitle}
      open={modalOpen}
      onOk={handleSaveDir}
      onCancel={() => setModalOpen(false)}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      okButtonProps={{ loading: saving }}
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

        {/* 自由文件类型（逗号分隔，留空为全部类型） */}
        <div>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
            {t('kms.searchDirExts')}
          </Text>
          <Input
            value={extInput}
            onChange={e => setExtInput(e.target.value)}
            placeholder={t('kms.searchDirExtsPlaceholder')}
            size="small"
          />
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
            {t('kms.searchDirExtsDesc')}
          </Text>
        </div>
      </div>
    </Modal>
  )

  if (dirs.length === 0) {
    return (
      <>
        {header}
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <Empty
            image={<FileSearchOutlined style={{ fontSize: 48, color: token.colorTextQuaternary }} />}
            description={
              <div>
                <Text style={{ display: 'block', fontSize: 15, fontWeight: 500 }}>
                  {t('kms.noSearchDirs')}
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
            const exts = parseExts(dir.file_extensions)
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
                      <FileSearchOutlined style={{ color: dir.enabled ? token.colorPrimary : token.colorTextQuaternary }} />
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
                      <Tooltip title={exts.length > 0 ? exts.map(e => `.${e}`).join('  ') : t('kms.allFileTypes')}>
                        <Tag
                          color={exts.length === 0 ? 'blue' : undefined}
                          style={{ fontSize: 11, margin: 0, lineHeight: '18px', padding: '0 6px' }}
                        >
                          {t('kms.fileTypes')}: {exts.length === 0
                            ? t('kms.allFileTypes')
                            : `${exts.length} ${t('kms.typesUnit')}`}
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
                      title={t('kms.removeSearchDirConfirm')}
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
      {dirConfigModal}
    </div>
  )
}

export default KMSSearchDirPanel
