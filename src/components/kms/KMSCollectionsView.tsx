import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Button, Empty, Spin, Modal, Input, Space, Tag, Tooltip, Popconfirm,
  Drawer, Table, message, theme, Typography, Tree, Alert, Progress,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, FileOutlined, FolderOutlined,
  ReloadOutlined, ExclamationCircleOutlined, FileAddOutlined,
  FileTextOutlined, SearchOutlined, FolderAddOutlined,
  EyeOutlined, ThunderboltOutlined, LoadingOutlined,
  RobotOutlined, TagOutlined, NodeIndexOutlined,
} from '@ant-design/icons'
import KMSCollectionProcessModal from './KMSCollectionProcessModal'

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

interface TocNode {
  id: string
  title: string
  titlePath: string
  level: number
  paragraphIndex: number
  startOffset: number
  endOffset: number
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
  toc: TocNode[]
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

const parseJsonArray = (json?: string): string[] => {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}

// 将段落列表构建为 Tree 结构（按 title_path 的层级）
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

  const [collections, setCollections] = useState<CollectionItem[]>([])
  const [loading, setLoading] = useState(false)
  // 卡片附加信息：summary + stats
  const [summaryMap, setSummaryMap] = useState<Record<string, CollectionSummary | null>>({})
  const [statsMap, setStatsMap] = useState<Record<string, CollectionStats | null>>({})

  // 编辑/创建合集
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingCollection, setEditingCollection] = useState<CollectionItem | null>(null)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [saving, setSaving] = useState(false)

  // 合集详情抽屉（统一：文件管理 + AI 内容查看）
  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false)
  const [drawerCollection, setDrawerCollection] = useState<CollectionItem | null>(null)
  const [drawerSummary, setDrawerSummary] = useState<CollectionSummary | null>(null)
  const [files, setFiles] = useState<CollectionFile[]>([])
  const [filesStats, setFilesStats] = useState<CollectionStats | null>(null)
  const [filesLoading, setFilesLoading] = useState(false)
  const [addingFiles, setAddingFiles] = useState(false)
  // 文件 AI 详情缓存（展开行时懒加载）
  const [detailCache, setDetailCache] = useState<Record<string, FileDetailCache>>({})
  const [expandedFileKeys, setExpandedFileKeys] = useState<string[]>([])
  // 后台索引轮询
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 摘要编辑
  const [summaryModalOpen, setSummaryModalOpen] = useState(false)
  const [summaryCollection, setSummaryCollection] = useState<CollectionItem | null>(null)
  const [summaryText, setSummaryText] = useState('')
  const [summaryTopics, setSummaryTopics] = useState('')
  const [summarySaving, setSummarySaving] = useState(false)
  const [summaryGenerating, setSummaryGenerating] = useState(false)

  // 合集深度处理进度弹窗
  const [processModalOpen, setProcessModalOpen] = useState(false)
  const [processCollection, setProcessCollection] = useState<CollectionItem | null>(null)

  // 后台处理中合集状态跟踪（弹窗关闭后继续在后台跟踪进度）
  const [processingMap, setProcessingMap] = useState<Record<string, ProcessingCollectionState>>({})
  // 已完成的合集处理（用于刷新列表，弹出后短暂保留）
  const processingMapRef = useRef<Record<string, ProcessingCollectionState>>({})
  // 进度事件订阅引用
  const processingUnsubscribeRef = useRef<(() => void) | null>(null)

  // 文件段落增量重新生成进度跟踪（按 fileId 过滤，不含 collectionId）
  const [regenerateState, setRegenerateState] = useState<{
    fileId: string
    fileName: string
    phase: string
    message: string
    percent: number
  } | null>(null)
  const regenerateUnsubscribeRef = useRef<(() => void) | null>(null)
  // loadFileDetail 的 ref，避免 useEffect 因 detailCache 变化而频繁重订阅
  const loadFileDetailRef = useRef<(fileId: string) => void>(() => {})

  // 章节预览抽屉状态
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewParagraph, setPreviewParagraph] = useState<{
    title: string; titlePath: string; content: string; summary: string; keywords: string[]
  } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // 8 阶段定义（用于计算总体百分比）
  const STAGE_KEYS = ['parsing', 'paragraph_split', 'toc', 'paragraph_summary', 'doc_summary', 'embedding', 'collection_summary', 'collection_embedding']
  const STAGE_INDEX: Record<string, number> = {}
  STAGE_KEYS.forEach((k, i) => { STAGE_INDEX[k] = i })

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

  // 全局订阅合集深度处理进度（用于跟踪后台处理状态，即使弹窗关闭也保持订阅）
  useEffect(() => {
    if (processingUnsubscribeRef.current) {
      processingUnsubscribeRef.current()
      processingUnsubscribeRef.current = null
    }
    processingUnsubscribeRef.current = window.electronAPI.kms.onIndexProgress((progress) => {
      // 只关心带 collectionId 的事件（合集深度处理）
      if (!progress.collectionId) return

      // 完成或错误：从处理中列表移除
      if (progress.phase === 'done' || progress.phase === 'error') {
        setProcessingMap((prev) => {
          const next = { ...prev }
          delete next[progress.collectionId!]
          return next
        })
        delete processingMapRef.current[progress.collectionId!]
        // 刷新合集列表与摘要
        loadCollections()
        loadAllSummaryAndStats()
        return
      }

      // 跳过非阶段事件
      if (!(progress.phase in STAGE_INDEX)) return

      // 计算总体百分比（按阶段加权）
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
      processingMapRef.current[progress.collectionId!] = state
    })

    return () => {
      if (processingUnsubscribeRef.current) {
        processingUnsubscribeRef.current()
        processingUnsubscribeRef.current = null
      }
    }
  }, [loadCollections, loadAllSummaryAndStats])

  // 文件段落增量重新生成进度订阅（带 fileId 但不带 collectionId 的事件）
  // 用于在文件详情抽屉中显示"从此重新生成"的实时进度
  useEffect(() => {
    if (regenerateUnsubscribeRef.current) {
      regenerateUnsubscribeRef.current()
      regenerateUnsubscribeRef.current = null
    }
    regenerateUnsubscribeRef.current = window.electronAPI.kms.onIndexProgress((progress) => {
      // 只处理文件级事件（有 fileId 但无 collectionId）
      if (!progress.fileId || progress.collectionId) return

      // 完成/错误：清除状态并刷新文件详情
      if (progress.phase === 'done' || progress.phase === 'error') {
        const finishedFileId = progress.fileId
        setRegenerateState(null)
        // 若抽屉打开的是该文件，刷新其详情
        if (drawerCollection) {
          // 刷新文件段落详情缓存
          setDetailCache(prev => {
            const next = { ...prev }
            delete next[finishedFileId]
            return next
          })
          // 重新加载该文件详情
          loadFileDetailRef.current(finishedFileId)
        }
        message.success(progress.message || t('kms.collectionDetails.regenerateDone'))
        return
      }

      // 跳过非阶段事件
      if (!(progress.phase in STAGE_INDEX)) return

      // 计算总体百分比
      const currentIdx = STAGE_INDEX[progress.phase]
      let fraction = currentIdx / STAGE_KEYS.length
      if (progress.total > 0) {
        fraction += (progress.current / progress.total) / STAGE_KEYS.length
      }
      const percent = Math.min(Math.round(fraction * 100), 99)

      setRegenerateState({
        fileId: progress.fileId,
        fileName: progress.fileName || '',
        phase: progress.phase,
        message: progress.message || '',
        percent,
      })
    })

    return () => {
      if (regenerateUnsubscribeRef.current) {
        regenerateUnsubscribeRef.current()
        regenerateUnsubscribeRef.current = null
      }
    }
  }, [drawerCollection, t])

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

  // ============ 合集深度处理（段落切分/TOC/摘要/智能索引） ============
  const handleProcessDeep = async (collection: CollectionItem) => {
    // 若该合集已在后台处理中，仅重新打开进度弹窗（不触发新处理）
    if (processingMapRef.current[collection.id]) {
      setProcessCollection(collection)
      setProcessModalOpen(true)
      return
    }

    // 先校验是否有文件
    try {
      const stats = await window.electronAPI.kms.getCollectionStats(collection.id)
      if (!stats || stats.fileCount === 0) {
        message.warning(t('kms.collections.aiGenerateNoFiles'))
        return
      }

      // 如果已处理过（有摘要），二次确认
      if (stats.hasSummary || (stats.indexedCount > 0 && stats.indexedCount === stats.fileCount)) {
        Modal.confirm({
          title: t('kms.collectionProcess.reprocessTitle'),
          icon: <ExclamationCircleOutlined style={{ color: token.colorWarning }} />,
          content: t('kms.collectionProcess.reprocessConfirm'),
          okText: t('common.confirm'),
          cancelText: t('common.cancel'),
          onOk: () => {
            setProcessCollection(collection)
            setProcessModalOpen(true)
            window.electronAPI.kms.processCollectionDeep(collection.id)
          },
        })
        return
      }
    } catch {
      // 忽略校验错误，继续触发后端会返回错误
    }
    setProcessCollection(collection)
    setProcessModalOpen(true)
    // fire-and-forget，进度通过 onIndexProgress 推送
    window.electronAPI.kms.processCollectionDeep(collection.id)
  }

  // 关闭弹窗：仅关闭 UI，不取消后台处理（后台处理状态由全局订阅持续跟踪）
  const handleCloseProcessModal = useCallback(() => {
    setProcessModalOpen(false)
    setProcessCollection(null)
  }, [])

  // 取消处理：调用后端取消接口 + 关闭弹窗
  const handleCancelProcessModal = useCallback(() => {
    window.electronAPI.kms.cancelCollectionDeepProcess()
    setProcessModalOpen(false)
    setProcessCollection(null)
  }, [])

  // ============ 文件段落增量重新生成 ==========
  // 取消文件段落增量重新生成
  const handleCancelRegenerate = useCallback(() => {
    window.electronAPI.kms.cancelRegenerateFileParagraph()
    setRegenerateState(null)
  }, [])

  // 预览段落章节内容
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

  // ============ 文件管理 ============
  const openFilesDrawer = async (collection: CollectionItem) => {
    setDrawerCollection(collection)
    setFilesDrawerOpen(true)
    setDetailCache({})
    setExpandedFileKeys([])
    setDrawerSummary(null)
    await loadCollectionFiles(collection.id)
    // 加载合集摘要
    try {
      const summary = await window.electronAPI.kms.getCollectionSummary(collection.id)
      setDrawerSummary(summary || null)
    } catch {}
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
      const freshStats = await window.electronAPI.kms.getCollectionStats(collectionId).catch(() => null)
      if (freshStats && freshStats.pendingCount > 0) {
        startPollingIfNeeded(collectionId, freshStats)
      } else {
        loadAllSummaryAndStats()
      }
    }, 3000)
  }, [loadAllSummaryAndStats])

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

  // 懒加载文件 AI 详情
  const loadFileDetail = useCallback(async (fileId: string) => {
    if (detailCache[fileId]) return
    setDetailCache(prev => ({ ...prev, [fileId]: { summary: null, toc: [], paragraphs: [], loading: true } }))
    try {
      const [fileSummary, toc, paragraphs] = await Promise.all([
        window.electronAPI.kms.getFileSummary(fileId).catch(() => null),
        window.electronAPI.kms.getFileToc(fileId).catch(() => []),
        window.electronAPI.kms.getFileParagraphs(fileId).catch(() => []),
      ])
      setDetailCache(prev => ({
        ...prev,
        [fileId]: {
          summary: fileSummary,
          toc: toc || [],
          paragraphs: paragraphs || [],
          loading: false,
        },
      }))
    } catch (err: any) {
      setDetailCache(prev => ({
        ...prev,
        [fileId]: { summary: null, toc: [], paragraphs: [], loading: false, error: err?.message },
      }))
    }
  }, [detailCache])

  // 同步 loadFileDetail 到 ref，供 useEffect 内回调调用而无需将其加入依赖
  useEffect(() => {
    loadFileDetailRef.current = loadFileDetail
  }, [loadFileDetail])

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
      // 如果抽屉打开的是同一合集，也刷新抽屉摘要
      if (drawerCollection?.id === summaryCollection.id) {
        setDrawerSummary(updated || null)
      }
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

  // ============ 展开行渲染文件 AI 详情 ============
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
    const hasToc = detail.toc.length > 0

    if (!fileSummary?.summary && !hasToc) {
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
                      <Tag key={i} style={{ fontSize: 10, margin: 0 }}>{kw}</Tag>
                    ))}
                  </div>
                )}
                {mainTopics.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    <NodeIndexOutlined style={{ fontSize: 11, color: token.colorTextTertiary }} />
                    {mainTopics.slice(0, 8).map((topic, i) => (
                      <Tag key={i} color="purple" style={{ fontSize: 10, margin: 0 }}>{topic}</Tag>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        )}

        {/* 章节目录 TOC */}
        {hasToc && (
          <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <NodeIndexOutlined style={{ color: token.colorPrimary, fontSize: 14 }} />
              <Text strong style={{ fontSize: 12 }}>{t('kms.collectionDetails.tocTitle')}</Text>
              <Tag style={{ fontSize: 10, margin: 0 }}>{detail.toc.length}</Tag>
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

  // 抽屉中的合集摘要主题
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
                      setProcessCollection({ id: p.id, name: p.name, description: '', file_count: 0, created_at: 0, updated_at: 0 })
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
        width={900}
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
        {/* 文件段落增量重新生成进度提示 */}
        {regenerateState && (
          <Alert
            type="info"
            showIcon
            icon={<LoadingOutlined />}
            style={{ marginBottom: 12 }}
            message={
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Text strong style={{ fontSize: 12 }}>
                    {t('kms.collectionDetails.regeneratingTitle', { name: regenerateState.fileName })}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                    - {regenerateState.message}
                  </Text>
                  <Progress
                    percent={regenerateState.percent}
                    size="small"
                    status="active"
                    style={{ marginTop: 4, marginBottom: 0 }}
                  />
                </div>
                <Button type="link" size="small" danger onClick={handleCancelRegenerate}>
                  {t('common.cancel')}
                </Button>
              </div>
            }
          />
        )}

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
                  {formatTime(drawerSummary.updated_at)}
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
                  <Tag key={i} color="purple" style={{ fontSize: 11, margin: 0 }}>{topic}</Tag>
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

      {/* 合集深度处理进度弹窗 */}
      <KMSCollectionProcessModal
        open={processModalOpen}
        collectionId={processCollection?.id || null}
        collectionName={processCollection?.name || ''}
        onClose={handleCloseProcessModal}
        onCancel={handleCancelProcessModal}
      />

      {/* 章节预览抽屉 */}
      <Drawer
        title={previewParagraph?.title || t('kms.collectionDetails.previewParagraph')}
        open={previewOpen}
        onClose={() => { setPreviewOpen(false); setPreviewParagraph(null) }}
        width={520}
      >
        {previewLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : previewParagraph ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* 标题路径 */}
            {previewParagraph.titlePath && (
              <div>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('kms.collectionDetails.titlePath')}</Text>
                <div style={{ marginTop: 2 }}>
                  <Text style={{ fontSize: 13 }}>{previewParagraph.titlePath}</Text>
                </div>
              </div>
            )}

            {/* 摘要 */}
            {previewParagraph.summary && (
              <Card size="small" style={{ borderColor: token.colorBorderSecondary, background: token.colorFillQuaternary }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <RobotOutlined style={{ color: token.colorPrimary, fontSize: 13 }} />
                  <Text strong style={{ fontSize: 12 }}>{t('kms.collectionDetails.summary')}</Text>
                </div>
                <Paragraph style={{ fontSize: 12, margin: 0, color: token.colorTextSecondary }}>
                  {previewParagraph.summary}
                </Paragraph>
              </Card>
            )}

            {/* 关键词 */}
            {previewParagraph.keywords.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <TagOutlined style={{ color: token.colorPrimary, fontSize: 13 }} />
                  <Text strong style={{ fontSize: 12 }}>{t('kms.collectionDetails.keywords')}</Text>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {previewParagraph.keywords.map((kw, i) => (
                    <Tag key={i} style={{ fontSize: 11, margin: 0 }}>{kw}</Tag>
                  ))}
                </div>
              </div>
            )}

            {/* 原文 */}
            {previewParagraph.content && (
              <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <FileTextOutlined style={{ color: token.colorPrimary, fontSize: 13 }} />
                  <Text strong style={{ fontSize: 12 }}>{t('kms.collectionDetails.originalContent')}</Text>
                </div>
                <Paragraph
                  style={{
                    fontSize: 13,
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 400,
                    overflow: 'auto',
                    backgroundColor: token.colorFillQuaternary,
                    padding: 12,
                    borderRadius: 4,
                  }}
                >
                  {previewParagraph.content}
                </Paragraph>
              </Card>
            )}

            {!previewParagraph.content && !previewParagraph.summary && (
              <Empty description={t('kms.collectionDetails.noContent')} />
            )}
          </div>
        ) : (
          <Empty description={t('kms.collectionDetails.previewLoadFailed')} />
        )}
      </Drawer>
    </div>
  )
}

export default KMSCollectionsView
