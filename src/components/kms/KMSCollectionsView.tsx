import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Button, Empty, Spin, Modal, Input, Space, Tag, Tooltip, Popconfirm,
  Drawer, Table, message, theme, Typography,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, FileOutlined, FolderOutlined,
  ReloadOutlined, ExclamationCircleOutlined, FileAddOutlined,
  FileTextOutlined, SearchOutlined, RobotOutlined, FolderAddOutlined,
  EyeOutlined,
} from '@ant-design/icons'

const { Text, Paragraph } = Typography

interface CollectionItem {
  id: string
  name: string
  description: string
  file_count: number
  created_at: number
  updated_at: number
}

interface CollectionFile {
  id: string
  file_name: string
  file_path: string
  file_ext: string
  file_size: number
  data_tier: string
  index_status: string
  modified_time: number
  added_at: number
  summary: string
  light_summary: string
  keywords_json: string
  main_topics_json: string
}

interface CollectionStats {
  fileCount: number
  indexedCount: number
  hotCount: number
  pendingCount: number
  hasSummary: boolean
}

interface CollectionSummary {
  collection_id: string
  summary: string
  key_topics_json: string
}

interface KMSCollectionsViewProps {
  /** 点击"在此合集中搜索"时触发，由父组件切换到搜索视图并设置筛选 */
  onSearchInCollection?: (collectionId: string) => void
  /** 预览文件，由父组件打开 KMSFilePreview */
  onPreviewFile?: (file: { file_id: string; file_name: string; file_path: string; text: string; match_type: string }) => void
}

const formatFileSize = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const formatTime = (ts: number): string => {
  if (!ts) return '-'
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const SUPPORTED_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'md', 'html', 'htm']

const KMSCollectionsView: React.FC<KMSCollectionsViewProps> = ({ onSearchInCollection, onPreviewFile }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [collections, setCollections] = useState<CollectionItem[]>([])
  const [loading, setLoading] = useState(false)
  // 卡片附加信息：summary + stats
  const [summaryMap, setSummaryMap] = useState<Record<string, CollectionSummary | null>>({})
  const [statsMap, setStatsMap] = useState<Record<string, CollectionStats | null>>({})
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set())

  // 编辑/创建合集
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingCollection, setEditingCollection] = useState<CollectionItem | null>(null)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [saving, setSaving] = useState(false)

  // 文件抽屉
  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false)
  const [drawerCollection, setDrawerCollection] = useState<CollectionItem | null>(null)
  const [files, setFiles] = useState<CollectionFile[]>([])
  const [filesStats, setFilesStats] = useState<CollectionStats | null>(null)
  const [filesLoading, setFilesLoading] = useState(false)
  const [addingFiles, setAddingFiles] = useState(false)
  // 后台索引轮询
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 摘要编辑
  const [summaryModalOpen, setSummaryModalOpen] = useState(false)
  const [summaryCollection, setSummaryCollection] = useState<CollectionItem | null>(null)
  const [summaryText, setSummaryText] = useState('')
  const [summaryTopics, setSummaryTopics] = useState('')
  const [summarySaving, setSummarySaving] = useState(false)
  const [summaryGenerating, setSummaryGenerating] = useState(false)

  const loadCollections = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.kms.listCollections()
      setCollections(result || [])
    } catch (err: any) {
      message.error(err?.message || 'Failed to load collections')
    } finally {
      setLoading(false)
    }
  }, [])

  // 加载所有合集的摘要与统计
  const loadAllSummaryAndStats = useCallback(async () => {
    try {
      const list = await window.electronAPI.kms.listCollections()
      const ids = (list || []).map((c: any) => c.id)
      const [summaries, statsList] = await Promise.all([
        Promise.all(ids.map((id: string) => window.electronAPI.kms.getCollectionSummary(id).catch(() => null))),
        Promise.all(ids.map((id: string) => window.electronAPI.kms.getCollectionStats(id).catch(() => null))),
      ])
      const sMap: Record<string, CollectionSummary | null> = {}
      const stMap: Record<string, CollectionStats | null> = {}
      ids.forEach((id: string, idx: number) => {
        sMap[id] = summaries[idx]
        stMap[id] = statsList[idx]
      })
      setSummaryMap(sMap)
      setStatsMap(stMap)
    } catch {}
  }, [])

  useEffect(() => {
    loadCollections()
    loadAllSummaryAndStats()
  }, [loadCollections, loadAllSummaryAndStats])

  // ============ 创建/编辑合集 ============
  const openCreateModal = () => {
    setEditingCollection(null)
    setFormName('')
    setFormDesc('')
    setEditModalOpen(true)
  }

  const openEditModal = (collection: CollectionItem) => {
    setEditingCollection(collection)
    setFormName(collection.name)
    setFormDesc(collection.description || '')
    setEditModalOpen(true)
  }

  const handleSaveCollection = async () => {
    const name = formName.trim()
    if (!name) {
      message.warning(t('kms.collections.collectionNamePlaceholder'))
      return
    }
    setSaving(true)
    try {
      if (editingCollection) {
        await window.electronAPI.kms.updateCollection({
          id: editingCollection.id,
          name,
          description: formDesc.trim(),
        })
        message.success(t('kms.collections.updated'))
      } else {
        await window.electronAPI.kms.createCollection({ name, description: formDesc.trim() })
        message.success(t('kms.collections.created'))
      }
      setEditModalOpen(false)
      loadCollections()
      loadAllSummaryAndStats()
    } catch (err: any) {
      message.error(err?.message || 'Failed to save collection')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteCollection = async (collection: CollectionItem) => {
    try {
      await window.electronAPI.kms.deleteCollection(collection.id)
      message.success(t('kms.collections.deleted'))
      loadCollections()
      loadAllSummaryAndStats()
    } catch (err: any) {
      message.error(err?.message || 'Failed to delete collection')
    }
  }

  // ============ AI 生成合集摘要 ============
  const handleAIGenerateSummary = async (collection: CollectionItem) => {
    if (generatingIds.has(collection.id)) return
    const newSet = new Set(generatingIds)
    newSet.add(collection.id)
    setGeneratingIds(newSet)
    try {
      const result = await window.electronAPI.kms.generateCollectionSummary(collection.id)
      if (result && result.error) {
        if (result.error === 'NO_FILES') {
          message.warning(t('kms.collections.aiGenerateNoFiles'))
        } else if (result.error === 'NO_LLM_PROVIDER') {
          message.warning(t('kms.collections.aiGenerateNoLLM'))
        } else {
          message.error(`${t('kms.collections.aiGenerateFailed')}：${result.error}`)
        }
      } else if (result && result.summary) {
        message.success(t('kms.collections.aiGenerateSuccess'))
        // 刷新摘要
        const updated = await window.electronAPI.kms.getCollectionSummary(collection.id)
        setSummaryMap(prev => ({ ...prev, [collection.id]: updated || null }))
      }
    } catch (err: any) {
      message.error(err?.message || t('kms.collections.aiGenerateFailed'))
    } finally {
      const clearSet = new Set(generatingIds)
      clearSet.delete(collection.id)
      setGeneratingIds(clearSet)
    }
  }

  // ============ 文件管理 ============
  const openFilesDrawer = async (collection: CollectionItem) => {
    setDrawerCollection(collection)
    setFilesDrawerOpen(true)
    await loadCollectionFiles(collection.id)
  }

  const loadCollectionFiles = async (collectionId: string) => {
    setFilesLoading(true)
    try {
      const [fileList, stats] = await Promise.all([
        window.electronAPI.kms.listFilesInCollection(collectionId),
        window.electronAPI.kms.getCollectionStats(collectionId),
      ])
      setFiles(fileList || [])
      setFilesStats(stats || null)
    } catch (err: any) {
      message.error(err?.message || 'Failed to load files')
    } finally {
      setFilesLoading(false)
    }
  }

  // 后台轮询：当有 pending 文件时，定时刷新 stats
  const startPollingIfNeeded = useCallback((collectionId: string, stats: CollectionStats | null) => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (!stats || stats.pendingCount === 0) return
    pollTimerRef.current = setTimeout(async () => {
      await loadCollectionFiles(collectionId)
      // 递归继续轮询，直到 pendingCount=0
      const freshStats = await window.electronAPI.kms.getCollectionStats(collectionId).catch(() => null)
      if (freshStats && freshStats.pendingCount > 0) {
        startPollingIfNeeded(collectionId, freshStats)
      } else {
        // 也刷新一下卡片统计
        loadAllSummaryAndStats()
      }
    }, 3000)
  }, [loadAllSummaryAndStats])

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    }
  }, [])

  // 当 filesStats 更新后，若有 pending 文件，启动轮询
  useEffect(() => {
    if (drawerCollection && filesStats && filesStats.pendingCount > 0) {
      startPollingIfNeeded(drawerCollection.id, filesStats)
    }
  }, [drawerCollection, filesStats, startPollingIfNeeded])

  const handleAddFiles = async () => {
    if (!drawerCollection) return
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: t('kms.collections.selectFiles'),
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: t('kms.collections.supportedTypes'),
            extensions: SUPPORTED_EXTS,
          },
        ],
      })
      if (result.canceled || !result.filePaths.length) return

      setAddingFiles(true)
      const addResult = await window.electronAPI.kms.addFilesToCollection({
        collectionId: drawerCollection.id,
        filePaths: result.filePaths,
      })
      setAddingFiles(false)

      if (addResult.failed && addResult.failed.length > 0) {
        message.warning(`${addResult.failed.length} 个文件添加失败`)
      }
      const added = (addResult.added || 0) + (addResult.reused || 0) + (addResult.duplicated || 0)
      if (added > 0) {
        message.success(t('kms.collections.filesAdded', { count: added }))
        loadCollectionFiles(drawerCollection.id)
        loadCollections()
        loadAllSummaryAndStats()
      }
    } catch (err: any) {
      message.error(err?.message || 'Failed to add files')
      setAddingFiles(false)
    }
  }

  // 文件夹批量导入：递归收集支持格式的文件
  const handleAddFolder = async () => {
    if (!drawerCollection) return
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: t('kms.collections.addFolder'),
        properties: ['openDirectory'],
      })
      if (result.canceled || !result.filePaths.length) return

      setAddingFiles(true)
      const dirPath = result.filePaths[0]
      const scanResult = await window.electronAPI.kms.scanDirFiles(dirPath, SUPPORTED_EXTS)
      const filePaths = scanResult?.files || []

      if (filePaths.length === 0) {
        message.warning(t('kms.collections.addFolderHint'))
        setAddingFiles(false)
        return
      }

      const addResult = await window.electronAPI.kms.addFilesToCollection({
        collectionId: drawerCollection.id,
        filePaths,
      })
      setAddingFiles(false)

      if (addResult.failed && addResult.failed.length > 0) {
        message.warning(`${addResult.failed.length} 个文件添加失败`)
      }
      const added = (addResult.added || 0) + (addResult.reused || 0) + (addResult.duplicated || 0)
      if (added > 0) {
        message.success(t('kms.collections.filesAdded', { count: added }))
        loadCollectionFiles(drawerCollection.id)
        loadCollections()
        loadAllSummaryAndStats()
      }
    } catch (err: any) {
      message.error(err?.message || 'Failed to add folder')
      setAddingFiles(false)
    }
  }

  const handleRemoveFile = async (file: CollectionFile) => {
    if (!drawerCollection) return
    try {
      await window.electronAPI.kms.removeFileFromCollection({
        collectionId: drawerCollection.id,
        fileId: file.id,
      })
      message.success(t('kms.collections.fileRemoved'))
      loadCollectionFiles(drawerCollection.id)
      loadCollections()
      loadAllSummaryAndStats()
    } catch (err: any) {
      message.error(err?.message || 'Failed to remove file')
    }
  }

  const handleOpenFile = (filePath: string) => {
    window.electronAPI.kms.openFile(filePath)
  }

  const handleOpenFileDir = (filePath: string) => {
    window.electronAPI.kms.openFileDir(filePath)
  }

  const handlePreviewFile = (file: CollectionFile) => {
    if (onPreviewFile) {
      onPreviewFile({
        file_id: file.id,
        file_name: file.file_name,
        file_path: file.file_path,
        text: '',
        match_type: 'content',
      })
    } else {
      handleOpenFile(file.file_path)
    }
  }

  // ============ 摘要编辑 ============
  const openSummaryModal = async (collection: CollectionItem) => {
    setSummaryCollection(collection)
    setSummaryText('')
    setSummaryTopics('')
    setSummaryModalOpen(true)
    try {
      const summary: CollectionSummary = await window.electronAPI.kms.getCollectionSummary(collection.id)
      if (summary) {
        setSummaryText(summary.summary || '')
        try {
          const topics: string[] = JSON.parse(summary.key_topics_json || '[]')
          setSummaryTopics(topics.join(', '))
        } catch {
          setSummaryTopics('')
        }
      }
    } catch (err: any) {
      // 忽略 - 摘要可能尚未生成
    }
  }

  const handleSaveSummary = async () => {
    if (!summaryCollection) return
    setSummarySaving(true)
    try {
      const topics = summaryTopics
        .split(/[,，]/)
        .map(s => s.trim())
        .filter(Boolean)
      await window.electronAPI.kms.setCollectionSummary({
        collectionId: summaryCollection.id,
        summary: summaryText.trim(),
        keyTopics: topics,
      })
      message.success(t('kms.collections.summarySaved'))
      setSummaryModalOpen(false)
      // 刷新该卡片摘要
      const updated = await window.electronAPI.kms.getCollectionSummary(summaryCollection.id)
      setSummaryMap(prev => ({ ...prev, [summaryCollection.id]: updated || null }))
    } catch (err: any) {
      message.error(t('kms.collections.summarySaveFailed'))
    } finally {
      setSummarySaving(false)
    }
  }

  // 摘要弹窗内 AI 生成
  const handleAIGenerateInModal = async () => {
    if (!summaryCollection) return
    setSummaryGenerating(true)
    try {
      const result = await window.electronAPI.kms.generateCollectionSummary(summaryCollection.id)
      if (result && result.error) {
        if (result.error === 'NO_FILES') {
          message.warning(t('kms.collections.aiGenerateNoFiles'))
        } else if (result.error === 'NO_LLM_PROVIDER') {
          message.warning(t('kms.collections.aiGenerateNoLLM'))
        } else {
          message.error(`${t('kms.collections.aiGenerateFailed')}：${result.error}`)
        }
      } else if (result && result.summary) {
        setSummaryText(result.summary)
        setSummaryTopics((result.keyTopics || []).join(', '))
        message.success(t('kms.collections.aiGenerateSuccess'))
      }
    } catch (err: any) {
      message.error(err?.message || t('kms.collections.aiGenerateFailed'))
    } finally {
      setSummaryGenerating(false)
    }
  }

  // ============ 卡片状态颜色计算 ============
  const getStatsTag = (collectionId: string) => {
    const stats = statsMap[collectionId]
    if (!stats) return null
    const { indexedCount, fileCount, pendingCount } = stats
    if (fileCount === 0) {
      return <Tag style={{ fontSize: 11 }}>{t('kms.collections.fileCount', { count: 0 })}</Tag>
    }
    let color = 'success'
    if (pendingCount > 0 || indexedCount < fileCount) color = 'processing'
    return (
      <Tooltip title={pendingCount > 0 ? t('kms.collections.pendingIndexHint', { count: pendingCount }) : ''}>
        <Tag color={color} style={{ fontSize: 11 }}>
          {t('kms.collections.indexedCount', { count: indexedCount, total: fileCount })}
        </Tag>
      </Tooltip>
    )
  }

  // ============ 文件表格列定义 ============
  const fileColumns = [
    {
      title: t('kms.collections.fileName'),
      dataIndex: 'file_name',
      key: 'file_name',
      render: (name: string, record: CollectionFile) => (
        <Tooltip title={record.file_path}>
          <Space size={4}>
            <FileOutlined style={{ color: token.colorPrimary }} />
            <a onClick={() => handleOpenFile(record.file_path)} style={{ fontSize: 12 }}>{name}</a>
          </Space>
        </Tooltip>
      ),
    },
    {
      title: t('kms.collections.fileSize'),
      dataIndex: 'file_size',
      key: 'file_size',
      width: 90,
      render: (size: number) => <Text type="secondary" style={{ fontSize: 12 }}>{formatFileSize(size)}</Text>,
    },
    {
      title: t('kms.collections.fileStatus'),
      dataIndex: 'index_status',
      key: 'index_status',
      width: 90,
      render: (status: string) => {
        const colorMap: Record<string, string> = {
          completed: 'success',
          pending: 'processing',
          failed: 'error',
        }
        const labelMap: Record<string, string> = {
          completed: t('kms.collections.statusCompleted'),
          pending: t('kms.collections.statusPending'),
          failed: t('kms.collections.statusFailed'),
        }
        return <Tag color={colorMap[status] || 'default'} style={{ fontSize: 11 }}>{labelMap[status] || status}</Tag>
      },
    },
    {
      title: t('kms.collections.fileSummary'),
      dataIndex: 'summary',
      key: 'summary',
      ellipsis: true,
      render: (summary: string, record: CollectionFile) => {
        const text = summary || record.light_summary
        return text ? <Text type="secondary" style={{ fontSize: 12 }}>{text}</Text> : <Text type="secondary" style={{ fontSize: 12, opacity: 0.5 }}>-</Text>
      },
    },
    {
      title: t('kms.collections.addedAt'),
      dataIndex: 'added_at',
      key: 'added_at',
      width: 130,
      render: (ts: number) => <Text type="secondary" style={{ fontSize: 11 }}>{formatTime(ts)}</Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 140,
      render: (_: any, record: CollectionFile) => (
        <Space size={4}>
          <Tooltip title={t('kms.collections.previewFile')}>
            <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => handlePreviewFile(record)} />
          </Tooltip>
          <Tooltip title={t('kms.openDir')}>
            <Button type="text" size="small" icon={<FolderOutlined />} onClick={() => handleOpenFileDir(record.file_path)} />
          </Tooltip>
          <Popconfirm
            title={t('kms.collections.removeFileConfirm')}
            icon={<ExclamationCircleOutlined style={{ color: token.colorError }} />}
            onConfirm={() => handleRemoveFile(record)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* 头部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexShrink: 0 }}>
        <div>
          <Text strong style={{ fontSize: 16 }}>{t('kms.collections.title')}</Text>
          <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>{t('kms.collections.subtitle')}</Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => { loadCollections(); loadAllSummaryAndStats() }} loading={loading}>
            {t('common.refresh')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
            {t('kms.collections.createCollection')}
          </Button>
        </Space>
      </div>

      {/* 合集列表 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin />
          </div>
        ) : collections.length === 0 ? (
          <Empty
            description={t('kms.collections.noCollections')}
            style={{ marginTop: 80 }}
          />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {collections.map(c => {
              const summary = summaryMap[c.id]
              const isGenerating = generatingIds.has(c.id)
              const keyTopics: string[] = (() => {
                try { return JSON.parse(summary?.key_topics_json || '[]') } catch { return [] }
              })()
              return (
                <Card
                  key={c.id}
                  size="small"
                  hoverable
                  styles={{ body: { padding: 12 } }}
                  onClick={() => openFilesDrawer(c)}
                >
                  {/* 标题行 + 操作 */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                    <Space size={6} style={{ minWidth: 0, flex: 1 }}>
                      <FolderOutlined style={{ color: token.colorPrimary, fontSize: 16, flexShrink: 0 }} />
                      <Text strong ellipsis style={{ fontSize: 14 }}>{c.name}</Text>
                    </Space>
                    <Space size={2} onClick={(e) => e.stopPropagation()}>
                      <Tooltip title={t('kms.collections.searchInCollection')}>
                        <Button type="text" size="small" icon={<SearchOutlined />} onClick={() => onSearchInCollection?.(c.id)} />
                      </Tooltip>
                      <Tooltip title={t('kms.collections.aiGenerateSummary')}>
                        <Button type="text" size="small" icon={<RobotOutlined />} loading={isGenerating} onClick={() => handleAIGenerateSummary(c)} />
                      </Tooltip>
                      <Tooltip title={t('kms.collections.editSummary')}>
                        <Button type="text" size="small" icon={<FileTextOutlined />} onClick={() => openSummaryModal(c)} />
                      </Tooltip>
                      <Tooltip title={t('kms.collections.editCollection')}>
                        <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEditModal(c)} />
                      </Tooltip>
                      <Popconfirm
                        title={t('kms.collections.deleteCollectionConfirm')}
                        icon={<ExclamationCircleOutlined style={{ color: token.colorError }} />}
                        onConfirm={() => handleDeleteCollection(c)}
                      >
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  </div>

                  {/* 描述 */}
                  {c.description && (
                    <Paragraph type="secondary" ellipsis={{ rows: 1 }} style={{ fontSize: 12, marginBottom: 6, marginTop: 2 }}>
                      {c.description}
                    </Paragraph>
                  )}

                  {/* 摘要预览 */}
                  {summary?.summary ? (
                    <Tooltip title={summary.summary}>
                      <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ fontSize: 12, marginBottom: 6, color: token.colorTextSecondary }}>
                        {summary.summary}
                      </Paragraph>
                    </Tooltip>
                  ) : (
                    <div style={{ marginBottom: 6 }}>
                      <Text type="secondary" style={{ fontSize: 11, opacity: 0.6, fontStyle: 'italic' }}>
                        {t('kms.collections.noCollectionSummary')}
                      </Text>
                    </div>
                  )}

                  {/* 关键主题 */}
                  {keyTopics.length > 0 && (
                    <div style={{ marginBottom: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {keyTopics.slice(0, 4).map((topic, idx) => (
                        <Tag key={idx} color="purple" style={{ fontSize: 10, margin: 0 }}>{topic}</Tag>
                      ))}
                      {keyTopics.length > 4 && (
                        <Tag style={{ fontSize: 10, margin: 0 }}>+{keyTopics.length - 4}</Tag>
                      )}
                    </div>
                  )}

                  {/* 状态行 */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
                    {getStatsTag(c.id)}
                    <Tag style={{ fontSize: 11 }}>{formatTime(c.updated_at)}</Tag>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* 创建/编辑合集弹窗 */}
      <Modal
        title={editingCollection ? t('kms.collections.editCollection') : t('kms.collections.createCollection')}
        open={editModalOpen}
        onCancel={() => setEditModalOpen(false)}
        onOk={handleSaveCollection}
        confirmLoading={saving}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }}>
          <div>
            <div style={{ marginBottom: 6, fontSize: 12, color: token.colorTextSecondary }}>
              {t('kms.collections.collectionName')} <span style={{ color: token.colorError }}>*</span>
            </div>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t('kms.collections.collectionNamePlaceholder')}
              maxLength={50}
            />
          </div>
          <div>
            <div style={{ marginBottom: 6, fontSize: 12, color: token.colorTextSecondary }}>
              {t('kms.collections.collectionDesc')}
            </div>
            <Input.TextArea
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              placeholder={t('kms.collections.collectionDescPlaceholder')}
              rows={3}
              maxLength={200}
            />
          </div>
        </div>
      </Modal>

      {/* 文件列表抽屉 */}
      <Drawer
        title={
          drawerCollection ? (
            <Space>
              <FolderOutlined style={{ color: token.colorPrimary }} />
              <span>{drawerCollection.name}</span>
              {filesStats && (
                <Tag color={filesStats.pendingCount > 0 ? 'processing' : 'success'} style={{ fontSize: 11 }}>
                  {t('kms.collections.indexedCount', { count: filesStats.indexedCount, total: filesStats.fileCount })}
                </Tag>
              )}
              {filesStats && filesStats.pendingCount > 0 && (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {t('kms.collections.pendingIndexHint', { count: filesStats.pendingCount })}
                </Text>
              )}
            </Space>
          ) : t('kms.collections.viewFiles')
        }
        open={filesDrawerOpen}
        onClose={() => {
          setFilesDrawerOpen(false)
          setDrawerCollection(null)
          setFiles([])
          setFilesStats(null)
          if (pollTimerRef.current) {
            clearTimeout(pollTimerRef.current)
            pollTimerRef.current = null
          }
          loadAllSummaryAndStats()
        }}
        width={820}
        styles={{ body: { padding: 12 } }}
        extra={
          <Space>
            <Tooltip title={t('kms.collections.addFolderHint')}>
              <Button icon={<FolderAddOutlined />} loading={addingFiles} onClick={handleAddFolder}>
                {t('kms.collections.addFolder')}
              </Button>
            </Tooltip>
            <Button type="primary" icon={<FileAddOutlined />} loading={addingFiles} onClick={handleAddFiles}>
              {t('kms.collections.addFiles')}
            </Button>
          </Space>
        }
      >
        <div style={{ marginBottom: 8, padding: '6px 10px', background: token.colorFillAlter, borderRadius: 4, fontSize: 12, color: token.colorTextTertiary }}>
          {t('kms.collections.addFilesHint')}
        </div>
        <Table
          size="small"
          rowKey="id"
          columns={fileColumns}
          dataSource={files}
          loading={filesLoading}
          pagination={false}
          scroll={{ y: 'calc(100vh - 220px)' }}
          locale={{ emptyText: t('kms.collections.noFiles') }}
        />
      </Drawer>

      {/* 合集摘要编辑弹窗 */}
      <Modal
        title={summaryCollection ? `${t('kms.collections.editSummary')} - ${summaryCollection.name}` : t('kms.collections.editSummary')}
        open={summaryModalOpen}
        onCancel={() => setSummaryModalOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setSummaryModalOpen(false)}>{t('common.cancel')}</Button>,
          <Button key="ai" type="default" icon={<RobotOutlined />} loading={summaryGenerating} onClick={handleAIGenerateInModal}>
            {t('kms.collections.aiGenerateSummary')}
          </Button>,
          <Button key="save" type="primary" loading={summarySaving} onClick={handleSaveSummary}>
            {t('common.save')}
          </Button>,
        ]}
        width={600}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }}>
          <div>
            <div style={{ marginBottom: 6, fontSize: 12, color: token.colorTextSecondary }}>
              {t('kms.collections.summary')}
            </div>
            <Input.TextArea
              value={summaryText}
              onChange={(e) => setSummaryText(e.target.value)}
              placeholder={t('kms.collections.summaryPlaceholder')}
              rows={6}
              maxLength={2000}
            />
          </div>
          <div>
            <div style={{ marginBottom: 6, fontSize: 12, color: token.colorTextSecondary }}>
              {t('kms.collections.keyTopics')}
            </div>
            <Input
              value={summaryTopics}
              onChange={(e) => setSummaryTopics(e.target.value)}
              placeholder={t('kms.collections.keyTopicsPlaceholder')}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default KMSCollectionsView
