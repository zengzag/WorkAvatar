import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Button, Empty, Spin, Space, Tag, Tooltip,
  Drawer, Table, App, theme, Typography,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, FileAddOutlined, FolderAddOutlined,
  FolderOutlined, RobotOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons'
import KMSCollectionProcessModal from './KMSCollectionProcessModal'
import {
  KMSCollectionEditModal,
  KMSCollectionSummaryModal,
  KMSParagraphPreviewDrawer,
  CollectionFileDetail,
  CollectionCard,
  ProcessingAlerts,
  buildFileColumns,
  type CollectionItem,
} from './collection'
import {
  type CollectionFile,
  type CollectionStats,
  type CollectionSummary,
  type FileDetailCache,
  type ProcessingCollectionState,
  type KMSCollectionsViewProps,
  POLL_INTERVAL_MS,
  STAGE_KEYS,
  STAGE_INDEX,
  SUPPORTED_EXTS,
  parseJsonArray,
} from './collection/collection-types'
import { formatTime } from './kms-columns'

const { Text, Paragraph } = Typography

const KMSCollectionsView: React.FC<KMSCollectionsViewProps> = ({ onSearchInCollection, onPreviewFile }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message, modal } = App.useApp()

  const [collections, setCollections] = useState<CollectionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [summaryMap, setSummaryMap] = useState<Record<string, CollectionSummary | null>>({})
  const [statsMap, setStatsMap] = useState<Record<string, CollectionStats | null>>({})

  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingCollection, setEditingCollection] = useState<CollectionItem | null>(null)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [saving, setSaving] = useState(false)

  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false)
  const [drawerCollection, setDrawerCollection] = useState<CollectionItem | null>(null)
  const [drawerSummary, setDrawerSummary] = useState<CollectionSummary | null>(null)
  const [files, setFiles] = useState<CollectionFile[]>([])
  const [filesStats, setFilesStats] = useState<CollectionStats | null>(null)
  const [filesLoading, setFilesLoading] = useState(false)
  const [addingFiles, setAddingFiles] = useState(false)
  const [detailCache, setDetailCache] = useState<Record<string, FileDetailCache>>({})
  const [expandedFileKeys, setExpandedFileKeys] = useState<string[]>([])
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [summaryModalOpen, setSummaryModalOpen] = useState(false)
  const [summaryCollection, setSummaryCollection] = useState<CollectionItem | null>(null)
  const [summaryText, setSummaryText] = useState('')
  const [summaryTopics, setSummaryTopics] = useState('')
  const [summarySaving, setSummarySaving] = useState(false)
  const [summaryGenerating, setSummaryGenerating] = useState(false)

  const [processModalOpen, setProcessModalOpen] = useState(false)
  const [processCollection, setProcessCollection] = useState<{ id: string; name: string } | null>(null)

  const [processingMap, setProcessingMap] = useState<Record<string, ProcessingCollectionState>>({})
  const processingUnsubscribeRef = useRef<(() => void) | null>(null)

  // processingFileIds state 仅用于触发重渲染（列定义通过 ref 读取最新值，避免 useMemo 依赖重建）
  const [, setProcessingFileIds] = useState<Set<string>>(new Set())
  const processingFileIdsRef = useRef<Set<string>>(new Set())
  const loadCollectionFilesRef = useRef<(collectionId: string) => Promise<void>>(async () => {})

  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewParagraph, setPreviewParagraph] = useState<{
    title: string; titlePath: string; content: string; summary: string; keywords: string[]
  } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const loadCollections = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.kms.listCollections()
      // safeHandle 错误时返回 { error }（truthy），需 Array.isArray 兜底
      setCollections(Array.isArray(result) ? result : [])
    } catch (err: any) {
      message.error(err?.message || 'Failed to load collections')
    } finally {
      setLoading(false)
    }
  }, [message])

  const loadAllSummaryAndStats = useCallback(async () => {
    try {
      const list = await window.electronAPI.kms.listCollections()
      // safeHandle 错误时返回 { error }（truthy），需 Array.isArray 兜底
      const ids = (Array.isArray(list) ? list : []).map((c: any) => c.id)
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
    if (processingUnsubscribeRef.current) {
      processingUnsubscribeRef.current()
      processingUnsubscribeRef.current = null
    }
    processingUnsubscribeRef.current = window.electronAPI.kms.onIndexProgress((progress) => {
      if (!progress.collectionId) return

      // 单文件深度处理：fileId 在 processingFileIdsRef 中时为单文件操作
      const isSingleFileOp = progress.fileId && processingFileIdsRef.current.has(progress.fileId)

      if (progress.phase === 'done' || progress.phase === 'error') {
        if (isSingleFileOp) {
          // 单文件深度处理完成：移除 fileId 并刷新文件列表
          setProcessingFileIds((prev) => {
            const next = new Set(prev)
            next.delete(progress.fileId!)
            return next
          })
          processingFileIdsRef.current.delete(progress.fileId!)
          if (drawerCollection) {
            loadCollectionFilesRef.current(drawerCollection.id)
          }
          loadAllSummaryAndStats()
          return
        }
        // 合集级深度处理完成
        setProcessingMap((prev) => {
          const next = { ...prev }
          delete next[progress.collectionId!]
          return next
        })
        loadCollections()
        loadAllSummaryAndStats()
        return
      }

      // 单文件操作的中间进度不更新 processingMap（避免显示合集级处理指示器）
      if (isSingleFileOp) return

      if (!(progress.phase in STAGE_INDEX)) return

      const currentIdx = STAGE_INDEX[progress.phase]
      let fraction = currentIdx / STAGE_KEYS.length
      if (progress.total > 0) {
        fraction += (progress.current / progress.total) / STAGE_KEYS.length
      }
      const percent = Math.min(Math.round(fraction * 100), 99)

      const state: ProcessingCollectionState = {
        id: progress.collectionId!,
        name: progress.collectionName || '',
        phase: progress.phase,
        message: progress.message || '',
        current: progress.current,
        total: progress.total,
        percent,
        lastUpdated: Math.floor(Date.now() / 1000),
      }
      setProcessingMap((prev) => ({ ...prev, [progress.collectionId!]: state }))
    })

    return () => {
      if (processingUnsubscribeRef.current) {
        processingUnsubscribeRef.current()
        processingUnsubscribeRef.current = null
      }
    }
  }, [loadCollections, loadAllSummaryAndStats, drawerCollection])

  useEffect(() => {
    loadCollections()
    loadAllSummaryAndStats()
  }, [loadCollections, loadAllSummaryAndStats])

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

  const handleProcessDeep = async (collection: CollectionItem) => {
    if (processingMap[collection.id]) {
      setProcessCollection({ id: collection.id, name: collection.name })
      setProcessModalOpen(true)
      return
    }

    try {
      const stats = await window.electronAPI.kms.getCollectionStats(collection.id)
      // safeHandle 异常时返回 { error }（truthy），需显式判定避免误判为有效 stats
      if (!stats || stats.error || stats.fileCount === 0) {
        if (stats?.error) {
          message.error(stats.error)
          return
        }
        message.warning(t('kms.collections.aiGenerateNoFiles'))
        return
      }

      // 所有文件均已深度处理 → 询问是否强制全量重处理
      const deepProcessedCount = stats.deepProcessedCount ?? 0
      if (deepProcessedCount === stats.fileCount) {
        modal.confirm({
          title: t('kms.collectionProcess.reprocessTitle'),
          icon: <ExclamationCircleOutlined style={{ color: token.colorWarning }} />,
          content: t('kms.collectionProcess.reprocessConfirm'),
          okText: t('common.confirm'),
          cancelText: t('common.cancel'),
          onOk: () => {
            setProcessCollection({ id: collection.id, name: collection.name })
            setProcessModalOpen(true)
            window.electronAPI.kms.processCollectionDeep(collection.id, false)
          },
        })
        return
      }
    } catch {
    }
    // 有未处理的文件 → 增量处理（无需确认）
    setProcessCollection({ id: collection.id, name: collection.name })
    setProcessModalOpen(true)
    window.electronAPI.kms.processCollectionDeep(collection.id, true)
  }

  const handleCloseProcessModal = useCallback(() => {
    setProcessModalOpen(false)
    setProcessCollection(null)
  }, [])

  const handleCancelProcessModal = useCallback(() => {
    window.electronAPI.kms.cancelCollectionDeepProcess()
    setProcessModalOpen(false)
    setProcessCollection(null)
  }, [])

  const handlePreviewParagraph = useCallback(async (paragraphId: string) => {
    setPreviewOpen(true)
    setPreviewLoading(true)
    setPreviewParagraph(null)
    try {
      const data = await window.electronAPI.kms.getParagraphContent(paragraphId)
      if (data) {
        setPreviewParagraph({
          title: data.title || '',
          titlePath: data.title_path || '',
          content: data.content || '',
          summary: data.summary || '',
          keywords: (() => { try { return JSON.parse(data.keywords_json || '[]') } catch { return [] } })(),
        })
      }
    } catch {
      setPreviewParagraph(null)
    } finally {
      setPreviewLoading(false)
    }
  }, [])

  const openFilesDrawer = async (collection: CollectionItem) => {
    setDrawerCollection(collection)
    setFilesDrawerOpen(true)
    setDetailCache({})
    setExpandedFileKeys([])
    setDrawerSummary(null)
    await loadCollectionFiles(collection.id)
    try {
      const summary = await window.electronAPI.kms.getCollectionSummary(collection.id)
      setDrawerSummary(summary || null)
    } catch {}
  }

  const loadCollectionFiles = useCallback(async (collectionId: string) => {
    setFilesLoading(true)
    try {
      const [fileList, stats] = await Promise.all([
        window.electronAPI.kms.listFilesInCollection(collectionId),
        window.electronAPI.kms.getCollectionStats(collectionId),
      ])
      // safeHandle 异常时返回 { error }（truthy），需类型兜底避免下游迭代/字段访问出错
      setFiles(Array.isArray(fileList) ? fileList : [])
      setFilesStats(stats && !stats.error ? stats : null)
    } catch (err: any) {
      message.error(err?.message || 'Failed to load files')
    } finally {
      setFilesLoading(false)
    }
  }, [message])
  loadCollectionFilesRef.current = loadCollectionFiles

  const startPollingIfNeeded = useCallback((collectionId: string, stats: CollectionStats | null) => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (!stats || stats.pendingCount === 0) return
    pollTimerRef.current = setTimeout(async () => {
      await loadCollectionFiles(collectionId)
      const freshStats = await window.electronAPI.kms.getCollectionStats(collectionId).catch(() => null)
      if (freshStats && freshStats.pendingCount > 0) {
        startPollingIfNeeded(collectionId, freshStats)
      } else {
        loadAllSummaryAndStats()
      }
    }, POLL_INTERVAL_MS)
  }, [loadAllSummaryAndStats, loadCollectionFiles])

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (drawerCollection && filesStats && filesStats.pendingCount > 0) {
      startPollingIfNeeded(drawerCollection.id, filesStats)
    }
  }, [drawerCollection, filesStats, startPollingIfNeeded])

  const loadFileDetail = useCallback(async (fileId: string) => {
    if (detailCache[fileId]) return
    setDetailCache(prev => ({ ...prev, [fileId]: { summary: null, paragraphs: [], loading: true } }))
    try {
      const [fileSummary, paragraphs] = await Promise.all([
        window.electronAPI.kms.getFileSummary(fileId).catch(() => null),
        window.electronAPI.kms.getFileParagraphs(fileId).catch(() => []),
      ])
      setDetailCache(prev => ({
        ...prev,
        [fileId]: {
          summary: fileSummary,
          // safeHandle 错误时返回 { error }（truthy），需 Array.isArray 兜底
          paragraphs: Array.isArray(paragraphs) ? paragraphs : [],
          loading: false,
        },
      }))
    } catch (err: any) {
      setDetailCache(prev => ({
        ...prev,
        [fileId]: { summary: null, paragraphs: [], loading: false, error: err?.message },
      }))
    }
  }, [detailCache])

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
        message.warning(t('kms.collections.filesAddFailed', { count: addResult.failed.length }))
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
        message.warning(t('kms.collections.filesAddFailed', { count: addResult.failed.length }))
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

  const handleRemoveFile = useCallback(async (file: CollectionFile) => {
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
  }, [drawerCollection, t, loadCollectionFiles, loadCollections, loadAllSummaryAndStats])

  const handleOpenFile = useCallback((filePath: string) => {
    window.electronAPI.kms.openFile(filePath)
  }, [])

  const handleOpenFileDir = useCallback((filePath: string) => {
    window.electronAPI.kms.openFileDir(filePath)
  }, [])

  const handlePreviewFile = useCallback((file: CollectionFile) => {
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
  }, [onPreviewFile, handleOpenFile])

  const handleProcessFileDeep = useCallback(async (file: CollectionFile) => {
    if (!drawerCollection) return
    if (processingFileIdsRef.current.has(file.id)) return

    // 添加到处理中集合（同时更新 state 和 ref）
    setProcessingFileIds((prev) => {
      const next = new Set(prev)
      next.add(file.id)
      return next
    })
    processingFileIdsRef.current.add(file.id)

    window.electronAPI.kms.processFileDeep(file.id, drawerCollection.id)
  }, [drawerCollection])

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
      const updated = await window.electronAPI.kms.getCollectionSummary(summaryCollection.id)
      setSummaryMap(prev => ({ ...prev, [summaryCollection.id]: updated || null }))
      if (drawerCollection?.id === summaryCollection.id) {
        setDrawerSummary(updated || null)
      }
    } catch (err: any) {
      message.error(t('kms.collections.summarySaveFailed'))
    } finally {
      setSummarySaving(false)
    }
  }

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

  const renderFileDetail = useCallback((file: CollectionFile) => {
    const detail = detailCache[file.id]
    return (
      <CollectionFileDetail
        file={file}
        detail={detail}
        onPreviewParagraph={handlePreviewParagraph}
      />
    )
  }, [detailCache, handlePreviewParagraph])

  const fileColumns = useMemo(() => buildFileColumns(t, token, {
    onOpenFile: handleOpenFile,
    onPreviewFile: handlePreviewFile,
    onOpenFileDir: handleOpenFileDir,
    onRemoveFile: handleRemoveFile,
    onProcessFileDeep: handleProcessFileDeep,
    processingFileIdsRef,
  }), [t, token, handleOpenFile, handlePreviewFile, handleOpenFileDir, handleRemoveFile, handleProcessFileDeep])

  const drawerKeyTopics = parseJsonArray(drawerSummary?.key_topics_json)

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

      {/* 后台处理指示器：弹窗关闭后仍持续跟踪后台处理进度，可点击重新打开弹窗 */}
      <ProcessingAlerts
        processingMap={processingMap}
        onViewProgress={(id, name) => {
          setProcessCollection({ id, name })
          setProcessModalOpen(true)
        }}
      />

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
            {collections.map(c => (
              <CollectionCard
                key={c.id}
                collection={c}
                summary={summaryMap[c.id]}
                stats={statsMap[c.id]}
                processing={processingMap[c.id]}
                handlers={{
                  onSearchInCollection,
                  onProcessDeep: handleProcessDeep,
                  onOpenSummaryModal: openSummaryModal,
                  onOpenEditModal: openEditModal,
                  onDeleteCollection: handleDeleteCollection,
                  onOpenFilesDrawer: openFilesDrawer,
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 创建/编辑合集弹窗 */}
      <KMSCollectionEditModal
        open={editModalOpen}
        editingCollection={editingCollection}
        formName={formName}
        formDesc={formDesc}
        saving={saving}
        onNameChange={setFormName}
        onDescChange={setFormDesc}
        onCancel={() => setEditModalOpen(false)}
        onSave={handleSaveCollection}
      />

      {/* 合集详情抽屉（统一：文件管理 + AI 内容查看） */}
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
          setDetailCache({})
          setExpandedFileKeys([])
          setDrawerSummary(null)
          if (pollTimerRef.current) {
            clearTimeout(pollTimerRef.current)
            pollTimerRef.current = null
          }
          loadAllSummaryAndStats()
        }}
        size={900}
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
        {/* 合集全局摘要卡片 */}
        {drawerSummary && (
          <Card
            size="small"
            style={{ borderColor: token.colorPrimary, background: token.colorFillQuaternary, marginBottom: 12 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <RobotOutlined style={{ color: token.colorPrimary, fontSize: 16 }} />
              <Text strong style={{ fontSize: 13 }}>{t('kms.collectionDetails.collectionSummaryTitle')}</Text>
              {drawerSummary.updated_at ? (
                <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
                  {formatTime(drawerSummary.updated_at, 'datetime')}
                </Text>
              ) : null}
            </div>
            {drawerSummary.summary ? (
              <Paragraph style={{ fontSize: 12, margin: 0, color: token.colorTextSecondary, lineHeight: 1.7 }}>
                {drawerSummary.summary}
              </Paragraph>
            ) : (
              <Text type="secondary" style={{ fontSize: 12, fontStyle: 'italic' }}>
                {t('kms.collectionDetails.noCollectionSummary')}
              </Text>
            )}
            {drawerKeyTopics.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {drawerKeyTopics.map((topic, i) => (
                  <Tag key={`drawer-topic-${i}-${topic}`} color="purple" style={{ fontSize: 11, margin: 0 }}>{topic}</Tag>
                ))}
              </div>
            )}
          </Card>
        )}

        <div style={{ marginBottom: 8, padding: '6px 10px', background: token.colorFillAlter, borderRadius: 4, fontSize: 12, color: token.colorTextTertiary }}>
          {t('kms.collectionDetails.fileListHint')}
        </div>
        <Table
          size="small"
          rowKey="id"
          columns={fileColumns}
          dataSource={files}
          loading={filesLoading}
          pagination={{ pageSize: 50, showSizeChanger: false, simple: true }}
          scroll={{ y: 'calc(100vh - 360px)' }}
          locale={{ emptyText: t('kms.collections.noFiles') }}
          expandable={{
            expandedRowKeys: expandedFileKeys,
            onExpand: (expanded, record: CollectionFile) => {
              if (expanded) {
                setExpandedFileKeys([...expandedFileKeys, record.id])
                if (!detailCache[record.id]) {
                  loadFileDetail(record.id)
                }
              } else {
                setExpandedFileKeys(expandedFileKeys.filter(k => k !== record.id))
              }
            },
            expandedRowRender: renderFileDetail,
            rowExpandable: (record: CollectionFile) => record.index_status === 'completed',
          }}
        />
      </Drawer>

      {/* 合集摘要编辑弹窗 */}
      <KMSCollectionSummaryModal
        open={summaryModalOpen}
        summaryCollection={summaryCollection}
        summaryText={summaryText}
        summaryTopics={summaryTopics}
        summarySaving={summarySaving}
        summaryGenerating={summaryGenerating}
        onSummaryChange={setSummaryText}
        onTopicsChange={setSummaryTopics}
        onCancel={() => setSummaryModalOpen(false)}
        onSave={handleSaveSummary}
        onAIGenerate={handleAIGenerateInModal}
      />

      {/* 合集深度处理进度弹窗 */}
      <KMSCollectionProcessModal
        open={processModalOpen}
        collectionId={processCollection?.id || null}
        collectionName={processCollection?.name || ''}
        onClose={handleCloseProcessModal}
        onCancel={handleCancelProcessModal}
      />

      {/* 章节预览抽屉 */}
      <KMSParagraphPreviewDrawer
        open={previewOpen}
        previewParagraph={previewParagraph}
        previewLoading={previewLoading}
        onClose={() => { setPreviewOpen(false); setPreviewParagraph(null) }}
      />
    </div>
  )
}

export default KMSCollectionsView
