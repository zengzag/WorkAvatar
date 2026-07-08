import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Button, Empty, Spin, Space, Tag, Tooltip, Popconfirm,
  Drawer, Table, App, theme, Typography, Tree, Alert,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, FileOutlined, FolderOutlined,
  ReloadOutlined, ExclamationCircleOutlined, FileAddOutlined,
  FileTextOutlined, SearchOutlined, FolderAddOutlined,
  EyeOutlined, ThunderboltOutlined, LoadingOutlined,
  RobotOutlined, TagOutlined, NodeIndexOutlined,
} from '@ant-design/icons'
import KMSCollectionProcessModal from './KMSCollectionProcessModal'
import {
  KMSCollectionEditModal,
  KMSCollectionSummaryModal,
  KMSParagraphPreviewDrawer,
  type CollectionItem,
} from './collection'
import { formatFileSize } from '../../utils/format'
import { formatTime } from './kms-columns'

const { Text, Paragraph } = Typography

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
  updated_at?: number
}

interface FileSummary {
  file_id: string
  summary: string
  toc_json: string
  keywords_json: string
  main_topics_json: string
  updated_at?: number
}

interface ParagraphItem {
  id: string
  title: string
  title_path: string
  level: number
  paragraph_index: number
  start_offset: number
  end_offset: number
  summary?: string
  keywords_json?: string
}

interface FileDetailCache {
  summary: FileSummary | null
  paragraphs: ParagraphItem[]
  loading: boolean
  error?: string
}

/** 后台处理中合集的实时状态 */
interface ProcessingCollectionState {
  id: string
  name: string
  phase: string
  message: string
  current: number
  total: number
  percent: number
  lastUpdated: number
}

interface KMSCollectionsViewProps {
  /** 点击"在此合集中搜索"时触发，由父组件切换到搜索视图并设置筛选 */
  onSearchInCollection?: (collectionId: string) => void
  /** 预览文件，由父组件打开 KMSFilePreview */
  onPreviewFile?: (file: { file_id: string; file_name: string; file_path: string; text: string; match_type: string }) => void
}

/** 合集深度处理轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 3000

/** 8 阶段定义（用于计算总体百分比） */
const STAGE_KEYS = ['parsing', 'paragraph_split', 'toc', 'paragraph_summary', 'doc_summary', 'embedding', 'collection_summary', 'collection_embedding'] as const
const STAGE_INDEX: Record<string, number> = {}
STAGE_KEYS.forEach((k, i) => { STAGE_INDEX[k] = i })

const parseJsonArray = (json?: string): string[] => {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}

const buildTocTree = (paragraphs: ParagraphItem[], t: (key: string, options?: any) => string): any[] => {
  const sorted = [...paragraphs].sort((a, b) => a.paragraph_index - b.paragraph_index)
  const roots: any[] = []
  const stack: { node: any; level: number }[] = []

  sorted.forEach((p) => {
    const node = {
      key: p.id,
      title: (
        <span>
          <Text style={{ fontSize: 12 }}>{p.title || t('kms.collectionDetails.unnamedParagraph')}</Text>
          {p.summary ? (
            <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
              {p.summary.length > 50 ? p.summary.slice(0, 50) + '…' : p.summary}
            </Text>
          ) : null}
        </span>
      ),
      raw: p,
    }
    while (stack.length > 0 && stack[stack.length - 1].level >= p.level) {
      stack.pop()
    }
    if (stack.length === 0) {
      roots.push(node)
    } else {
      const parent = stack[stack.length - 1].node
      if (!parent.children) parent.children = []
      parent.children.push(node)
    }
    stack.push({ node, level: p.level })
  })
  return roots
}

const SUPPORTED_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'md', 'html', 'htm']

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

  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewParagraph, setPreviewParagraph] = useState<{
    title: string; titlePath: string; content: string; summary: string; keywords: string[]
  } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

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
  }, [message])

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
    if (processingUnsubscribeRef.current) {
      processingUnsubscribeRef.current()
      processingUnsubscribeRef.current = null
    }
    processingUnsubscribeRef.current = window.electronAPI.kms.onIndexProgress((progress) => {
      if (!progress.collectionId) return

      if (progress.phase === 'done' || progress.phase === 'error') {
        setProcessingMap((prev) => {
          const next = { ...prev }
          delete next[progress.collectionId!]
          return next
        })
        loadCollections()
        loadAllSummaryAndStats()
        return
      }

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
  }, [loadCollections, loadAllSummaryAndStats])

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
      if (!stats || stats.fileCount === 0) {
        message.warning(t('kms.collections.aiGenerateNoFiles'))
        return
      }

      if (stats.hasSummary || (stats.indexedCount > 0 && stats.indexedCount === stats.fileCount)) {
        modal.confirm({
          title: t('kms.collectionProcess.reprocessTitle'),
          icon: <ExclamationCircleOutlined style={{ color: token.colorWarning }} />,
          content: t('kms.collectionProcess.reprocessConfirm'),
          okText: t('common.confirm'),
          cancelText: t('common.cancel'),
          onOk: () => {
            setProcessCollection({ id: collection.id, name: collection.name })
            setProcessModalOpen(true)
            window.electronAPI.kms.processCollectionDeep(collection.id)
          },
        })
        return
      }
    } catch {
    }
    setProcessCollection({ id: collection.id, name: collection.name })
    setProcessModalOpen(true)
    window.electronAPI.kms.processCollectionDeep(collection.id)
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
      setFiles(fileList || [])
      setFilesStats(stats || null)
    } catch (err: any) {
      message.error(err?.message || 'Failed to load files')
    } finally {
      setFilesLoading(false)
    }
  }, [message])

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
          paragraphs: paragraphs || [],
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

  const renderFileDetail = (file: CollectionFile) => {
    const detail = detailCache[file.id]
    if (!detail || detail.loading) {
      return <div style={{ padding: '12px 24px' }}><Spin size="small" /></div>
    }
    if (detail.error) {
      return <div style={{ padding: '12px 24px' }}><Text type="danger" style={{ fontSize: 12 }}>{detail.error}</Text></div>
    }
    const fileSummary = detail.summary
    const keywords = parseJsonArray(fileSummary?.keywords_json)
    const mainTopics = parseJsonArray(fileSummary?.main_topics_json)
    const hasParagraphs = detail.paragraphs.length > 0

    if (!fileSummary?.summary && !hasParagraphs) {
      return (
        <div style={{ padding: '12px 24px' }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('kms.collectionDetails.noAiContent')}
          />
        </div>
      )
    }

    return (
      <div style={{ padding: '12px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 文件摘要 */}
        {fileSummary?.summary && (
          <Card size="small" style={{ borderColor: token.colorBorderSecondary, background: token.colorFillQuaternary }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <RobotOutlined style={{ color: token.colorPrimary, fontSize: 14 }} />
              <Text strong style={{ fontSize: 12 }}>{t('kms.collectionDetails.fileSummaryTitle')}</Text>
            </div>
            <Paragraph style={{ fontSize: 12, margin: 0, color: token.colorTextSecondary }}>
              {fileSummary.summary}
            </Paragraph>
            {(keywords.length > 0 || mainTopics.length > 0) && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {keywords.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    <TagOutlined style={{ fontSize: 11, color: token.colorTextTertiary }} />
                    {keywords.slice(0, 8).map((kw, i) => (
                      <Tag key={`kw-${i}-${kw}`} style={{ fontSize: 10, margin: 0 }}>{kw}</Tag>
                    ))}
                  </div>
                )}
                {mainTopics.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    <NodeIndexOutlined style={{ fontSize: 11, color: token.colorTextTertiary }} />
                    {mainTopics.slice(0, 8).map((topic, i) => (
                      <Tag key={`topic-${i}-${topic}`} color="purple" style={{ fontSize: 10, margin: 0 }}>{topic}</Tag>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        )}

        {/* 章节目录 TOC */}
        {hasParagraphs && (
          <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <NodeIndexOutlined style={{ color: token.colorPrimary, fontSize: 14 }} />
              <Text strong style={{ fontSize: 12 }}>{t('kms.collectionDetails.tocTitle')}</Text>
              <Tag style={{ fontSize: 10, margin: 0 }}>{detail.paragraphs.length}</Tag>
            </div>
            <Tree
              treeData={buildTocTree(detail.paragraphs, t)}
              defaultExpandAll
              showLine
              selectable={false}
              titleRender={(node: any) => {
                const raw = node?.raw as ParagraphItem
                if (!raw) return node?.title
                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0, flex: 1 }}>
                      <Text style={{ fontSize: 12 }}>{raw.title || t('kms.collectionDetails.unnamed')}</Text>
                      {raw.summary && (
                        <Tooltip title={raw.summary}>
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {raw.summary.length > 60 ? raw.summary.slice(0, 60) + '…' : raw.summary}
                          </Text>
                        </Tooltip>
                      )}
                    </div>
                    <Tooltip title={t('kms.collectionDetails.previewParagraph')}>
                      <Button
                        type="text"
                        size="small"
                        icon={<EyeOutlined />}
                        onClick={(e) => {
                          e.stopPropagation()
                          handlePreviewParagraph(raw.id)
                        }}
                        style={{ flexShrink: 0 }}
                      />
                    </Tooltip>
                  </div>
                )
              }}
            />
          </Card>
        )}
      </div>
    )
  }

  const fileColumns = useMemo(() => [
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
      render: (ts: number) => <Text type="secondary" style={{ fontSize: 11 }}>{formatTime(ts, 'datetime')}</Text>,
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
  ], [t, token, handleOpenFile, handlePreviewFile, handleOpenFileDir, handleRemoveFile])

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
      {Object.values(processingMap).length > 0 && (
        <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
          {Object.values(processingMap).map((p) => (
            <Alert
              key={p.id}
              type="info"
              showIcon
              icon={<LoadingOutlined />}
              message={
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Text strong style={{ fontSize: 13 }}>
                      {t('kms.collectionProcess.backgroundRunningHint', { name: p.name, percent: p.percent })}
                    </Text>
                    {p.message && (
                      <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                        - {p.message}
                      </Text>
                    )}
                  </div>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => {
                      setProcessCollection({ id: p.id, name: p.name })
                      setProcessModalOpen(true)
                    }}
                  >
                    {t('kms.collectionProcess.viewProgress')}
                  </Button>
                </div>
              }
              style={{ padding: '6px 12px' }}
            />
          ))}
        </div>
      )}

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
                      <Tooltip title={processingMap[c.id] ? t('kms.collectionProcess.viewProgress') : t('kms.collectionProcess.title')}>
                        <Button
                          type="text"
                          size="small"
                          icon={processingMap[c.id] ? <LoadingOutlined /> : <ThunderboltOutlined />}
                          onClick={() => handleProcessDeep(c)}
                        />
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
                        <Tag key={`topic-${idx}-${topic}`} color="purple" style={{ fontSize: 10, margin: 0 }}>{topic}</Tag>
                      ))}
                      {keyTopics.length > 4 && (
                        <Tag style={{ fontSize: 10, margin: 0 }}>+{keyTopics.length - 4}</Tag>
                      )}
                    </div>
                  )}

                  {/* 状态行 */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
                    {getStatsTag(c.id)}
                    <Tag style={{ fontSize: 11 }}>{formatTime(c.updated_at, 'datetime')}</Tag>
                  </div>
                </Card>
              )
            })}
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
          pagination={false}
          scroll={{ y: 'calc(100vh - 320px)' }}
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
