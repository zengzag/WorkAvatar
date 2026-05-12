import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Card, Button, Typography, Space, Tag, Modal,
  Input, Empty, Tooltip, Tabs, theme, App, notification, Select, Progress, Radio,
} from 'antd'
import {
  PlusOutlined, FileTextOutlined, UploadOutlined,
  LinkOutlined, BookOutlined, EditOutlined, FolderOpenOutlined,
  ThunderboltOutlined, NodeIndexOutlined, ExportOutlined, ImportOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import { KBListPanel, KBDocList, KBKnowledgeView, KBEntityGraph } from '../components/knowledge-base'
import LLMSelector from '../components/llm/LLMSelector'
import { BulbOutlined } from '@ant-design/icons'
import { useTaskDetailStore } from '../stores/task-detail.store'

const { Title, Text } = Typography

const KB_SELECTION_KEY = 'workavatar_selected_kb_id'
const KB_TAB_KEY = 'workavatar_selected_kb_tab'

interface KBDocument {
  id: string
  kb_id: string
  original_name: string
  type: string
  size: number
  hash: string
  parse_status: 'pending' | 'parsing' | 'paused' | 'completed' | 'failed'
  parse_error?: string
  parse_progress?: number
  parse_stage?: string
  parse_detail?: string
  processed_pages?: number
  total_pages?: number
  processed_chunks?: number
  total_chunks?: number
  parse_speed?: number
  parse_eta?: number
  is_reused?: number
  created_at: number
}

interface KnowledgeBase {
  id: string
  name: string
  description: string
  root_path: string
  doc_count: number
  created_at: number
  updated_at: number
}

const KnowledgeBasePage: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const [kbs, setKBs] = useState<KnowledgeBase[]>([])
  const [selectedKB, setSelectedKB] = useState<KnowledgeBase | null>(null)
  const [docs, setDocs] = useState<KBDocument[]>([])
  const [linkedProjects, setLinkedProjects] = useState<any[]>([])
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newKBName, setNewKBName] = useState('')
  const [newKBDesc, setNewKBDesc] = useState('')
  const [uploadLoading, setUploadLoading] = useState(false)
  const [parsingAll, setParsingAll] = useState(false)
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [allProjects, setAllProjects] = useState<any[]>([])
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem(KB_TAB_KEY) || 'docs')
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    return localStorage.getItem('knowledgeBase:selectedProviderId') || ''
  })
  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    return localStorage.getItem('knowledgeBase:selectedModelId') || ''
  })
  const [enableThinking, setEnableThinking] = useState<boolean>(() => {
    return localStorage.getItem('knowledgeBase:enableThinking') === 'true'
  })

  // Persist selections to localStorage
  useEffect(() => {
    localStorage.setItem('knowledgeBase:selectedProviderId', selectedProviderId)
  }, [selectedProviderId])
  useEffect(() => {
    localStorage.setItem('knowledgeBase:selectedModelId', selectedModelId)
  }, [selectedModelId])
  useEffect(() => {
    localStorage.setItem('knowledgeBase:enableThinking', String(enableThinking))
  }, [enableThinking])

  const [knowledgeStats, setKnowledgeStats] = useState<any>(null)
  const [processingDocId, setProcessingDocId] = useState<string | null>(null)
  const [processingAll, setProcessingAll] = useState(false)
  const [buildingGlobal, setBuildingGlobal] = useState(false)
  const [processProgress, setProcessProgress] = useState({ stage: '', detail: '' })
  const [entities, setEntities] = useState<any[]>([])
  const [entityFilter, setEntityFilter] = useState<string>('')
  const [selectedEntity, setSelectedEntity] = useState<any>(null)
  const [entityRelations, setEntityRelations] = useState<any[]>([])
  const [entityModalOpen, setEntityModalOpen] = useState(false)
  const [globalSummary, setGlobalSummary] = useState<any>(null)
  const [docSummaries, setDocSummaries] = useState<any[]>([])
  const [selectedDocSummary, setSelectedDocSummary] = useState<any>(null)
  const [docChapters, setDocChapters] = useState<any[]>([])
  const [chapterModalOpen, setChapterModalOpen] = useState(false)
  const [allRelations, setAllRelations] = useState<any[]>([])
  const [docContentModalOpen, setDocContentModalOpen] = useState(false)
  const [docContent, setDocContent] = useState<string>('')
  const [docContentTitle, setDocContentTitle] = useState<string>('')
  const [editKBModalOpen, setEditKBModalOpen] = useState(false)
  const [editKBName, setEditKBName] = useState('')
  const [editKBDesc, setEditKBDesc] = useState('')
  const [processedDocIds, setProcessedDocIds] = useState<Set<string>>(new Set())
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [exportType, setExportType] = useState<'full' | 'summary' | 'documents'>('full')
  const [exportFormat, setExportFormat] = useState<'json-ld' | 'csv'>('json-ld')
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState({ stage: '', detail: '' })
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [importType, setImportType] = useState<'full' | 'graph'>('full')
  const [importFormat, setImportFormat] = useState<'json-ld' | 'rdf'>('json-ld')
  const [importConflictStrategy, setImportConflictStrategy] = useState<'skip' | 'overwrite' | 'rename' | 'merge'>('skip')
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState({ stage: '', detail: '' })
  const [importKBName, setImportKBName] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeKBRef = useRef<string>('')
  const autoRestoredRef = useRef(false)
  const openDetail = useTaskDetailStore((s) => s.openDetail)

  const loadKBs = useCallback(async () => {
    try {
      const result = await window.electronAPI.kb.list()
      setKBs(result)
      return result
    } catch { message.error(t('knowledgeBase.loadKbFailed')) }
    return []
  }, [])

  useEffect(() => {
    loadKBs().then((kbList) => {
      if (autoRestoredRef.current) return
      autoRestoredRef.current = true
      const savedKbId = localStorage.getItem(KB_SELECTION_KEY)
      if (savedKbId) {
        const savedKb = kbList.find((kb: KnowledgeBase) => kb.id === savedKbId)
        if (savedKb) {
          handleSelectKB(savedKb)
        }
      }
    })
  }, [loadKBs])

  const loadDocs = useCallback(async (kbId: string) => {
    try {
      const result = await window.electronAPI.kb.getDocumentList({ kb_id: kbId })
      if (activeKBRef.current !== kbId) return
      setDocs(result)
      loadDocProcessingStatus(result)
      const hasActiveParsing = result.some((d: KBDocument) => d.parse_status === 'parsing' || d.parse_status === 'paused')
      if (hasActiveParsing) {
        setParsingAll(true)
      }

      const pausedDocs = result.filter((d: KBDocument) => d.parse_status === 'paused')
      if (pausedDocs.length > 0) {
        const resumeAll = () => {
          window.electronAPI.kb.resumeAllParses()
          message.info(t('parseProgress.resumeAllSuccess'))
          if (selectedKB) loadDocs(selectedKB.id)
          notification.destroy(`resumable-${kbId}`)
        }
        notification.open({
          key: `resumable-${kbId}`,
          message: t('parseProgress.hasResumableTasks', { count: pausedDocs.length }),
          duration: 8,
          placement: 'topRight',
          btn: (
            <Button size="small" type="primary" onClick={resumeAll}>
              {t('parseProgress.resumeAllTasks')}
            </Button>
          ),
        })
      }

      try {
        const tasks = await window.electronAPI.tasks.getAll()
        const kbTasks = tasks.filter((t: any) =>
          t.metadata?.kbId === kbId && (t.status === 'running' || t.status === 'paused')
        )
        if (kbTasks.some((t: any) => t.type === 'process')) {
          setProcessingAll(true)
        }
        const singleDocTask = kbTasks.find((t: any) => t.type === 'process' && t.metadata?.docId)
        if (singleDocTask) {
          setProcessingDocId(singleDocTask.metadata.docId)
        }
        if (kbTasks.some((t: any) => t.id?.startsWith('build-global'))) {
          setBuildingGlobal(true)
        }
      } catch {}
    } catch { message.error(t('knowledgeBase.loadDocsFailed')) }
  }, [])

  useEffect(() => {
    const hasActiveParsing = docs.some(d => d.parse_status === 'parsing' || d.parse_status === 'paused')
    if (hasActiveParsing && selectedKB) {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => {
          if (selectedKB) {
            window.electronAPI.kb.getDocumentList({ kb_id: selectedKB.id }).then(result => {
              setDocs(result)
              const stillActive = result.some((d: KBDocument) => d.parse_status === 'parsing' || d.parse_status === 'paused')
              if (!stillActive && pollRef.current) {
                clearInterval(pollRef.current)
                pollRef.current = null
                setParsingAll(false)
                loadDocProcessingStatus(result)
              }
            }).catch(() => {})
          }
        }, 2000)
      }
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [docs, selectedKB])

  const loadDocProcessingStatus = async (docList: KBDocument[]) => {
    const completedDocs = docList.filter(d => d.parse_status === 'completed')
    const results = await Promise.allSettled(
      completedDocs.map(doc => window.electronAPI.kb.getDocSummary(doc.id))
    )
    const processedIds = new Set<string>()
    results.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value) {
        processedIds.add(completedDocs[i].id)
      }
    })
    setProcessedDocIds(processedIds)
  }

  const loadLinkedProjects = useCallback(async (kbId: string) => {
    try { setLinkedProjects(await window.electronAPI.kb.getLinkedProjects(kbId)) } catch {}
  }, [])

  const handleSelectKB = (kb: KnowledgeBase) => {
    activeKBRef.current = kb.id
    setSelectedKB(kb)
    localStorage.setItem(KB_SELECTION_KEY, kb.id)
    setDocs([])
    setKnowledgeStats(null)
    setEntities([])
    setGlobalSummary(null)
    setDocSummaries([])
    setAllRelations([])
    setSelectedEntity(null)
    loadDocs(kb.id)
    loadLinkedProjects(kb.id)
    loadKnowledgeStats(kb.id)
    loadEntities(kb.id)
    loadGlobalSummary(kb.id)
    loadDocSummaries(kb.id)
    loadAllRelations(kb.id)
  }

  const loadKnowledgeStats = async (kbId: string) => {
    try {
      const stats = await window.electronAPI.kb.getStats(kbId)
      if (activeKBRef.current !== kbId) return
      setKnowledgeStats(stats)
    } catch {}
  }

  const loadEntities = async (kbId: string, type?: string) => {
    try {
      const result = await window.electronAPI.kb.getEntities({ kb_id: kbId, type })
      if (activeKBRef.current !== kbId) return
      setEntities(result)
    } catch {}
  }

  const loadGlobalSummary = async (kbId: string) => {
    try {
      const summary = await window.electronAPI.kb.getGlobalSummary(kbId)
      if (activeKBRef.current !== kbId) return
      setGlobalSummary(summary)
    } catch {}
  }

  const handleProcessDocument = async (docId: string) => {
    setProcessingDocId(docId)
    setProcessProgress({ stage: '', detail: '' })
    const cleanup = (window as any).electronAPI.kb.onProcessProgress((p: any) => setProcessProgress(p))
    try {
      const result = await window.electronAPI.kb.processDocument({
        doc_id: docId,
        provider_id: selectedProviderId || undefined,
        model_id: selectedModelId || undefined,
        enable_thinking: enableThinking,
      })
      if (result.success) {
        message.success(t('knowledgeBase.knowledgeProcessed'))
        setProcessedDocIds(prev => new Set(prev).add(docId))
        if (selectedKB) { loadDocs(selectedKB.id); loadKnowledgeStats(selectedKB.id); loadEntities(selectedKB.id) }
      } else {
        message.error(result.error || t('knowledgeBase.processFailed'))
      }
    } catch { message.error(t('knowledgeBase.knowledgeProcessFailed')) }
    finally { cleanup(); setProcessingDocId(null); setProcessProgress({ stage: '', detail: '' }) }
  }

  const handleProcessAll = async () => {
    if (!selectedKB) return
    setProcessingAll(true)
    setProcessProgress({ stage: '', detail: '' })
    const cleanupAll = (window as any).electronAPI.kb.onProcessAllProgress((p: any) => setProcessProgress(p))
    const cleanupProgress = (window as any).electronAPI.kb.onProcessProgress((p: any) => {
      if (p.doc_id) {
        setProcessingDocId(p.doc_id)
        if (p.stage) setProcessProgress({ stage: p.stage, detail: p.detail || '' })
      }
    })
    try {
      const result = await window.electronAPI.kb.processAll({
        kb_id: selectedKB.id,
        provider_id: selectedProviderId || undefined,
        model_id: selectedModelId || undefined,
        enable_thinking: enableThinking,
      })
      message.success(t('knowledgeBase.batchProcessResult', { success: result.success, failed: result.failed, skipped: result.skipped }))
      loadDocs(selectedKB.id); loadKnowledgeStats(selectedKB.id); loadEntities(selectedKB.id)
    } catch { message.error(t('knowledgeBase.batchProcessFailed')) }
    finally { cleanupAll(); cleanupProgress(); setProcessingAll(false); setProcessingDocId(null); setProcessProgress({ stage: '', detail: '' }) }
  }

  const handleBuildGlobal = async () => {
    if (!selectedKB) return
    setBuildingGlobal(true)
    setProcessProgress({ stage: '', detail: '' })
    const cleanup = (window as any).electronAPI.kb.onBuildGlobalProgress((p: any) => setProcessProgress(p))
    try {
      const result = await window.electronAPI.kb.buildGlobal({
        kb_id: selectedKB.id,
        provider_id: selectedProviderId || undefined,
        model_id: selectedModelId || undefined,
        enable_thinking: enableThinking,
      })
      if (result.success) {
        message.success(t('knowledgeBase.globalKnowledgeBuilt'))
        loadKnowledgeStats(selectedKB.id); loadGlobalSummary(selectedKB.id); loadEntities(selectedKB.id)
      } else {
        message.error(result.error || t('knowledgeBase.buildFailed'))
      }
    } catch { message.error(t('knowledgeBase.globalBuildFailed')) }
    finally { cleanup(); setBuildingGlobal(false); setProcessProgress({ stage: '', detail: '' }) }
  }

  const loadDocSummaries = async (kbId: string) => {
    try {
      const summaries = await window.electronAPI.kb.getAllDocSummaries(kbId)
      if (activeKBRef.current !== kbId) return
      setDocSummaries(summaries)
    } catch {}
  }

  const loadAllRelations = async (kbId: string) => {
    try {
      const allEntities = await window.electronAPI.kb.getEntities({ kb_id: kbId })
      if (activeKBRef.current !== kbId) return
      const relations: any[] = []
      const seen = new Set<string>()
      for (const entity of allEntities) {
        if (activeKBRef.current !== kbId) return
        try {
          const entityRels = await window.electronAPI.kb.getEntityRelations({ entity_id: entity.id, depth: 1 })
          for (const rel of entityRels) {
            const key = rel.id || `${rel.source_entity_id}-${rel.target_entity_id}-${rel.relation_type}`
            if (!seen.has(key)) {
              seen.add(key)
              relations.push(rel)
            }
          }
        } catch {}
      }
      if (activeKBRef.current !== kbId) return
      setAllRelations(relations)
    } catch {}
  }

  const handleViewChapters = async (docId: string, docName: string) => {
    try {
      const chapters = await window.electronAPI.kb.getChapters(docId)
      setDocChapters(chapters || [])
      setSelectedDocSummary(docName)
      setChapterModalOpen(true)
    } catch { setDocChapters([]) }
  }

  const handleViewDocContent = async (docId: string, docName: string) => {
    try {
      const content = await window.electronAPI.kb.getDocContent(docId)
      setDocContent(content || t('knowledgeBase.docContentEmpty'))
      setDocContentTitle(docName)
      setDocContentModalOpen(true)
    } catch { setDocContent(t('knowledgeBase.getDocContentFailed')) }
  }

  const handleViewEntity = async (entity: any) => {
    setSelectedEntity(entity)
    try {
      const relations = await window.electronAPI.kb.getEntityRelations({ entity_id: entity.id, depth: 2 })
      setEntityRelations(relations)
    } catch { setEntityRelations([]) }
    setEntityModalOpen(true)
  }

  const handleCreateKB = async () => {
    if (!newKBName.trim()) { message.warning(t('knowledgeBase.enterKbName')); return }
    try {
      const result = await window.electronAPI.kb.create({ name: newKBName.trim(), description: newKBDesc.trim() })
      setKBs(prev => [result, ...prev])
      message.success(t('knowledgeBase.createSuccess'))
      setCreateModalOpen(false)
      setNewKBName('')
      setNewKBDesc('')
      handleSelectKB(result)
    } catch { message.error(t('knowledgeBase.createFailed')) }
  }

  const handleDeleteKB = async (kbId: string) => {
    try {
      await window.electronAPI.kb.delete(kbId)
      setKBs(prev => prev.filter(k => k.id !== kbId))
      if (selectedKB?.id === kbId) {
        setSelectedKB(null)
        localStorage.removeItem(KB_SELECTION_KEY)
      }
      message.success(t('common.deleteSuccess'))
    } catch { message.error(t('common.deleteFailed')) }
  }

  const handleUploadFiles = async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: t('knowledgeBase.selectUploadFiles'),
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: t('knowledgeBase.supportedDocs'), extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'md', 'html', 'htm', 'png', 'jpg', 'jpeg'] }],
      })
      if (result.canceled || !result.filePaths.length || !selectedKB) return

      setUploadLoading(true)
      const uploadResult = await window.electronAPI.kb.uploadDocuments({ kb_id: selectedKB.id, paths: result.filePaths })
      setUploadLoading(false)
      if (uploadResult.imported.length > 0) { message.success(t('knowledgeBase.uploadSuccess', { count: uploadResult.imported.length })); loadDocs(selectedKB.id); loadKBs() }
      if (uploadResult.errors.length > 0) { message.warning(t('knowledgeBase.uploadPartialFailed', { count: uploadResult.errors.length })) }
    } catch { message.error(t('knowledgeBase.uploadFailed')); setUploadLoading(false) }
  }

  const handleParseDocument = async (docId: string) => {
    try {
      const result = await window.electronAPI.kb.parseDocument({ doc_id: docId })
      if (result.success) { message.success(t('knowledgeBase.parseSuccess')); if (selectedKB) loadDocs(selectedKB.id) }
      else message.error(result.error || t('knowledgeBase.parseFailed'))
    } catch { message.error(t('knowledgeBase.parseFailed')) }
  }

  const handleParseAll = async () => {
    if (!selectedKB) return
    setParsingAll(true)
    try {
      const result = await window.electronAPI.kb.parseAll({ kb_id: selectedKB.id })
      message.success(t('knowledgeBase.batchParseResult', { success: result.success, failed: result.failed }))
      loadDocs(selectedKB.id)
    } catch { message.error(t('knowledgeBase.batchParseFailed')) }
    finally { setParsingAll(false) }
  }

  const handleDeleteDoc = async (docId: string) => {
    try { await window.electronAPI.kb.deleteDocument(docId); if (selectedKB) { loadDocs(selectedKB.id); loadKBs() }; message.success(t('common.deleteSuccess')) }
    catch { message.error(t('common.deleteFailed')) }
  }

  const handlePauseParse = async (docId: string) => {
    try {
      const result = await window.electronAPI.kb.pauseParse(docId)
      if (result) { message.info(t('parseProgress.pauseSuccess')); if (selectedKB) loadDocs(selectedKB.id) }
      else message.warning(t('parseProgress.pauseFailed'))
    } catch { message.error(t('parseProgress.pauseFailed')) }
  }

  const handleResumeParse = async (docId: string) => {
    try {
      const result = await window.electronAPI.kb.resumeParse(docId)
      if (result) { message.info(t('parseProgress.resumeSuccess')); if (selectedKB) loadDocs(selectedKB.id) }
      else message.warning(t('parseProgress.resumeFailed'))
    } catch { message.error(t('parseProgress.resumeFailed')) }
  }

  const handleRetryParse = async (docId: string) => {
    try {
      const result = await window.electronAPI.kb.retryParse(docId)
      if (result) { message.info(t('parseProgress.retryStarted')); if (selectedKB) loadDocs(selectedKB.id) }
      else message.warning(t('parseProgress.retryFailed'))
    } catch { message.error(t('parseProgress.retryFailed')) }
  }

  const handlePauseAll = async () => {
    try {
      await window.electronAPI.kb.pauseAllParses()
      message.info(t('parseProgress.pauseAllSuccess'))
      if (selectedKB) loadDocs(selectedKB.id)
    } catch { message.error(t('parseProgress.pauseFailed')) }
  }

  const handleResumeAll = async () => {
    try {
      await window.electronAPI.kb.resumeAllParses()
      message.info(t('parseProgress.resumeAllSuccess'))
      if (selectedKB) loadDocs(selectedKB.id)
    } catch { message.error(t('parseProgress.resumeFailed')) }
  }

  const handleCancelAll = async () => {
    try {
      await window.electronAPI.kb.cancelAllParses()
      message.info(t('parseProgress.cancelAllSuccess'))
      if (selectedKB) loadDocs(selectedKB.id)
    } catch { message.error(t('parseProgress.cancelFailed')) }
  }

  const handleViewParseDetail = (docId: string, docName: string) => {
    openDetail(docId, docName)
  }

  const handleLinkProject = async () => {
    if (!selectedKB) return
    try { const result = await window.electronAPI.project.list(); setAllProjects(result.projects); setLinkModalOpen(true) }
    catch { message.error(t('knowledgeBase.loadProjectsFailed')) }
  }

  const handleProjectLink = async (projectId: string) => {
    if (!selectedKB) return
    try { await window.electronAPI.kb.linkProject({ kb_id: selectedKB.id, project_id: projectId }); message.success(t('knowledgeBase.linkSuccess')); loadLinkedProjects(selectedKB.id); setLinkModalOpen(false) }
    catch { message.error(t('knowledgeBase.linkFailed')) }
  }

  const handleUnlinkProject = async (projectId: string) => {
    if (!selectedKB) return
    try { await window.electronAPI.kb.unlinkProject({ kb_id: selectedKB.id, project_id: projectId }); message.success(t('knowledgeBase.unlinkSuccess')); loadLinkedProjects(selectedKB.id) }
    catch { message.error(t('knowledgeBase.unlinkFailed')) }
  }

  const handleEditKB = () => {
    if (!selectedKB) return
    setEditKBName(selectedKB.name)
    setEditKBDesc(selectedKB.description || '')
    setEditKBModalOpen(true)
  }

  const confirmEditKB = async () => {
    if (!selectedKB || !editKBName.trim()) {
      message.error(t('knowledgeBase.kbNameRequired'))
      return
    }
    try {
      const updatedKB = await window.electronAPI.kb.update({
        id: selectedKB.id,
        name: editKBName.trim(),
        description: editKBDesc.trim(),
      })
      setKBs(prev => prev.map(kb => kb.id === selectedKB.id ? updatedKB : kb))
      setSelectedKB(updatedKB)
      message.success(t('knowledgeBase.updateSuccess'))
      setEditKBModalOpen(false)
    } catch {
      message.error(t('knowledgeBase.updateFailed'))
    }
  }

  const handleExport = async () => {
    if (!selectedKB) return
    setExporting(true)
    setExportProgress({ stage: '', detail: '' })
    const cleanup = (window as any).electronAPI.kb.onExportProgress((p: any) => setExportProgress(p))
    try {
      const now = new Date()
      const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

      if (exportType === 'full') {
        const result = await window.electronAPI.app.showSaveDialog({
          title: t('knowledgeBase.exportSaveAs'),
          defaultPath: `${selectedKB.name}_${dateStr}.zip`,
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
        })
        if (result.canceled || !result.filePath) { setExporting(false); cleanup(); return }
        const res = await window.electronAPI.kb.exportFull({ kb_id: selectedKB.id, export_path: result.filePath })
        if (res.success) { message.success(t('knowledgeBase.exportSuccess')); setExportModalOpen(false) }
        else message.error(res.error || t('knowledgeBase.exportFailed'))
      } else if (exportType === 'summary') {
        const ext = exportFormat === 'json-ld' ? 'jsonld' : 'csv'
        const result = await window.electronAPI.app.showSaveDialog({
          title: t('knowledgeBase.exportSaveAs'),
          defaultPath: `${selectedKB.name}_summary_${dateStr}.${ext}`,
          filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
        })
        if (result.canceled || !result.filePath) { setExporting(false); cleanup(); return }
        const res = await window.electronAPI.kb.exportSummary({ kb_id: selectedKB.id, export_path: result.filePath, format: exportFormat })
        if (res.success) { message.success(t('knowledgeBase.exportSuccess')); setExportModalOpen(false) }
        else message.error(res.error || t('knowledgeBase.exportFailed'))
      } else if (exportType === 'documents') {
        const result = await window.electronAPI.app.showSaveDialog({
          title: t('knowledgeBase.exportSaveAs'),
          defaultPath: `${selectedKB.name}_docs_${dateStr}.zip`,
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
        })
        if (result.canceled || !result.filePath) { setExporting(false); cleanup(); return }
        const res = await window.electronAPI.kb.exportDocuments({ kb_id: selectedKB.id, export_path: result.filePath })
        if (res.success) { message.success(t('knowledgeBase.exportSuccess')); setExportModalOpen(false) }
        else message.error(res.error || t('knowledgeBase.exportFailed'))
      }
    } catch { message.error(t('knowledgeBase.exportFailed')) }
    finally { cleanup(); setExporting(false); setExportProgress({ stage: '', detail: '' }) }
  }

  const handleImport = async () => {
    setImporting(true)
    setImportProgress({ stage: '', detail: '' })
    const cleanup = (window as any).electronAPI.kb.onImportProgress((p: any) => setImportProgress(p))
    try {
      if (importType === 'full') {
        const result = await window.electronAPI.app.showOpenDialog({
          title: t('knowledgeBase.importSelectFile'),
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
          properties: ['openFile'],
        })
        if (result.canceled || !result.filePaths.length) { setImporting(false); cleanup(); return }
        const res = await window.electronAPI.kb.importFull({
          import_path: result.filePaths[0],
          kb_name: importKBName || undefined,
          conflict_strategy: importConflictStrategy as 'skip' | 'overwrite' | 'rename',
        })
        if (res.success) {
          message.success(t('knowledgeBase.importSuccess', { kbId: res.kbId || '' }))
          setImportModalOpen(false)
          const kbList = await loadKBs()
          if (res.kbId) {
            const newKB = kbList.find((kb: KnowledgeBase) => kb.id === res.kbId)
            if (newKB) handleSelectKB(newKB)
          }
        } else {
          message.error(res.error || t('knowledgeBase.importFailed'))
        }
      } else if (importType === 'graph') {
        if (!selectedKB) { message.warning(t('knowledgeBase.selectKbFirst')); setImporting(false); cleanup(); return }
        const result = await window.electronAPI.app.showOpenDialog({
          title: t('knowledgeBase.importSelectFile'),
          filters: [{ name: exportFormat === 'json-ld' ? 'JSON-LD' : 'RDF', extensions: [importFormat === 'json-ld' ? 'jsonld' : 'rdf'] }, { name: 'All Files', extensions: ['*'] }],
          properties: ['openFile'],
        })
        if (result.canceled || !result.filePaths.length) { setImporting(false); cleanup(); return }
        const res = await window.electronAPI.kb.importGraph({
          kb_id: selectedKB.id,
          import_path: result.filePaths[0],
          format: importFormat,
          conflict_strategy: importConflictStrategy as 'skip' | 'overwrite' | 'merge',
        })
        if (res.success) {
          message.success(t('knowledgeBase.importGraphSuccess', { entities: res.imported?.entities || 0, relations: res.imported?.relations || 0 }))
          setImportModalOpen(false)
          if (selectedKB) { loadEntities(selectedKB.id); loadAllRelations(selectedKB.id) }
        } else {
          message.error(res.error || t('knowledgeBase.importFailed'))
        }
      }
    } catch { message.error(t('knowledgeBase.importFailed')) }
    finally { cleanup(); setImporting(false); setImportProgress({ stage: '', detail: '' }) }
  }

  const pendingCount = docs.filter(d => d.parse_status === 'pending').length
  const completedCount = docs.filter(d => d.parse_status === 'completed').length
  const failedCount = docs.filter(d => d.parse_status === 'failed').length
  const pausedCount = docs.filter(d => d.parse_status === 'paused').length

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 24 }}>
      <PageHeader
        title={t('knowledgeBase.title')}
        subTitle={t('knowledgeBase.subtitle')}
        extra={
          <Space>
            <Button icon={<PlusOutlined />} type="primary" onClick={() => setCreateModalOpen(true)}>{t('knowledgeBase.createKb')}</Button>
          </Space>
        }
      />

      <div style={{ flex: 1, display: 'flex', gap: 16, minHeight: 0 }}>
        <KBListPanel
          kbs={kbs}
          selectedKB={selectedKB}
          onSelectKB={handleSelectKB}
          onDeleteKB={handleDeleteKB}
        />

        <div style={{ flex: 1, overflow: 'auto' }}>
          {!selectedKB ? (
            <Card>
              <Empty image={<BookOutlined style={{ fontSize: 64, color: token.colorTextQuaternary }} />}
                description={t('knowledgeBase.selectOrCreate')} />
              <div style={{ textAlign: 'center' }}>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>{t('knowledgeBase.createKb')}</Button>
              </div>
            </Card>
          ) : (
            <div>
              <Card style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <Title level={4} style={{ margin: 0 }} ellipsis>{selectedKB.name}</Title>
                    <Tooltip title={selectedKB.description || t('common.noDescription')}>
                      <Text type="secondary" ellipsis style={{ display: 'block' }}>{selectedKB.description || t('common.noDescription')}</Text>
                    </Tooltip>
                  </div>
                  <Space>
                    <Tooltip title={t('knowledgeBase.editKb')}><Button icon={<EditOutlined />} onClick={handleEditKB}>{t('knowledgeBase.edit')}</Button></Tooltip>
                    <Tooltip title={t('knowledgeBase.linkToProject')}><Button icon={<LinkOutlined />} onClick={handleLinkProject}>{t('knowledgeBase.linkProject')}</Button></Tooltip>
                    <Tooltip title={t('knowledgeBase.exportKb')}><Button icon={<ExportOutlined />} onClick={() => setExportModalOpen(true)}>{t('knowledgeBase.export')}</Button></Tooltip>
                    <Tooltip title={t('knowledgeBase.importKb')}><Button icon={<ImportOutlined />} onClick={() => { setImportKBName(''); setImportModalOpen(true) }}>{t('knowledgeBase.import')}</Button></Tooltip>
                    <Button icon={<UploadOutlined />} onClick={handleUploadFiles} loading={uploadLoading} type="primary">{t('knowledgeBase.uploadFile')}</Button>
                  </Space>
                </div>

                {linkedProjects.length > 0 && (
                  <div style={{ marginTop: 12, padding: '8px 12px', background: token.colorInfoBg, borderRadius: 8 }}>
                    <Text type="secondary">{t('knowledgeBase.linkedProjects')} </Text>
                    {linkedProjects.map((p: any) => (
                      <Tag key={p.id} color="blue" closable onClose={() => handleUnlinkProject(p.id)}
                        style={{ cursor: 'pointer' }} onClick={() => navigate(`/project/${p.id}`)}>{p.name}</Tag>
                    ))}
                  </div>
                )}

                <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 16 }}>
      <LLMSelector
        providerId={selectedProviderId}
        modelId={selectedModelId}
        onProviderChange={setSelectedProviderId}
        onModelChange={setSelectedModelId}
      />
      <Tooltip title={enableThinking ? t('llmSelector.thinkingEnabled') : t('llmSelector.thinkingDisabled')}>
        <BulbOutlined
          style={{
            fontSize: 18,
            color: enableThinking ? token.colorWarning : token.colorTextSecondary,
            cursor: 'pointer',
            transition: 'color 0.3s'
          }}
          onClick={() => setEnableThinking(!enableThinking)}
        />
      </Tooltip>
    </div>
              </Card>

              <Tabs activeKey={activeTab} onChange={(key) => { setActiveTab(key); localStorage.setItem(KB_TAB_KEY, key) }} items={[
                {
                  key: 'docs',
                  label: <Space><FileTextOutlined />{t('knowledgeBase.tabDocs')}</Space>,
                  children: (
                    <KBDocList
                      docs={docs}
                      parsingAll={parsingAll}
                      processingAll={processingAll}
                      processProgress={processProgress}
                      completedCount={completedCount}
                      pendingCount={pendingCount}
                      failedCount={failedCount}
                      pausedCount={pausedCount}
                      processedDocIds={processedDocIds}
                      processingDocId={processingDocId}
                      onParseAll={handleParseAll}
                      onParseDocument={handleParseDocument}
                      onProcessDocument={handleProcessDocument}
                      onDeleteDoc={handleDeleteDoc}
                      onRefresh={() => { loadDocs(selectedKB.id); loadLinkedProjects(selectedKB.id) }}
                      onPauseParse={handlePauseParse}
                      onResumeParse={handleResumeParse}
                      onRetryParse={handleRetryParse}
                      onPauseAll={handlePauseAll}
                      onResumeAll={handleResumeAll}
                      onCancelAll={handleCancelAll}
                      onViewDetail={handleViewParseDetail}
                    />
                  ),
                },
                {
                  key: 'knowledge',
                  label: <Space><ThunderboltOutlined />{t('knowledgeBase.tabKnowledge')}</Space>,
                  children: (
                    <KBKnowledgeView
                      knowledgeStats={knowledgeStats}
                      globalSummary={globalSummary}
                      docSummaries={docSummaries}
                      allRelations={allRelations}
                      processingDocId={processingDocId}
                      processingAll={processingAll}
                      buildingGlobal={buildingGlobal}
                      processProgress={processProgress}
                      onProcessAll={handleProcessAll}
                      onBuildGlobal={handleBuildGlobal}
                      onProcessDocument={handleProcessDocument}
                      onViewChapters={handleViewChapters}
                      onViewDocContent={handleViewDocContent}
                      docChapters={docChapters}
                      chapterModalOpen={chapterModalOpen}
                      selectedDocSummary={selectedDocSummary}
                      onCloseChapterModal={() => setChapterModalOpen(false)}
                      docContent={docContent}
                      docContentTitle={docContentTitle}
                      docContentModalOpen={docContentModalOpen}
                      onCloseDocContentModal={() => setDocContentModalOpen(false)}
                      onViewParseDetail={handleViewParseDetail}
                    />
                  ),
                },
                {
                  key: 'entities',
                  label: <Space><NodeIndexOutlined />{t('knowledgeBase.tabEntity')}</Space>,
                  children: (
                    <KBEntityGraph
                      entities={entities}
                      entityFilter={entityFilter}
                      selectedEntity={selectedEntity}
                      entityRelations={entityRelations}
                      entityModalOpen={entityModalOpen}
                      onEntityFilterChange={setEntityFilter}
                      onLoadEntities={loadEntities}
                      onViewEntity={handleViewEntity}
                      onCloseEntityModal={() => setEntityModalOpen(false)}
                      selectedKBId={selectedKB.id}
                    />
                  ),
                },
              ]} />
            </div>
          )}
        </div>
      </div>

      <Modal title={t('knowledgeBase.newKbModal')} open={createModalOpen} onOk={handleCreateKB} onCancel={() => setCreateModalOpen(false)} okText={t('common.create')} cancelText={t('common.cancel')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0' }}>
          <div><Text strong>{t('knowledgeBase.kbName')}</Text>
            <Input placeholder={t('knowledgeBase.kbNamePlaceholder')} value={newKBName} onChange={e => setNewKBName(e.target.value)} onPressEnter={handleCreateKB} style={{ marginTop: 8 }} />
          </div>
          <div><Text strong>{t('knowledgeBase.kbDescOptional')}</Text>
            <Input.TextArea placeholder={t('knowledgeBase.kbDescPlaceholder')} value={newKBDesc} onChange={e => setNewKBDesc(e.target.value)} rows={3} style={{ marginTop: 8 }} />
          </div>
        </div>
      </Modal>

      <Modal title={t('knowledgeBase.linkToProjectModal')} open={linkModalOpen} onCancel={() => setLinkModalOpen(false)} footer={null}>
        <div>
          {allProjects.map((project: any) => (
            <div
              key={project.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 0',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 8,
                    background: token.colorPrimaryBg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <FolderOpenOutlined style={{ color: token.colorPrimary }} />
                </div>
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  <Tooltip title={project.name}>
                    <Text strong ellipsis style={{ display: 'block' }}>{project.name}</Text>
                  </Tooltip>
                  <Tooltip title={project.description}>
                    <Text type="secondary" ellipsis style={{ display: 'block' }}>{project.description}</Text>
                  </Tooltip>
                </div>
              </div>
              {linkedProjects.some(lp => lp.id === project.id) ? (
                <Tag color="green">{t('knowledgeBase.linked')}</Tag>
              ) : (
                <Button type="link" onClick={() => handleProjectLink(project.id)}>{t('knowledgeBase.link')}</Button>
              )}
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        title={t('knowledgeBase.editKbModal')}
        open={editKBModalOpen}
        onOk={confirmEditKB}
        onCancel={() => setEditKBModalOpen(false)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.kbNameInput')}</Text>
            <Input
              placeholder={t('knowledgeBase.kbNameInputPlaceholder')}
              value={editKBName}
              onChange={(e) => setEditKBName(e.target.value)}
            />
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.kbIntro')}</Text>
            <Input.TextArea
              placeholder={t('knowledgeBase.kbIntroPlaceholder')}
              value={editKBDesc}
              onChange={(e) => setEditKBDesc(e.target.value)}
              rows={4}
            />
          </div>
        </div>
      </Modal>

      <Modal
        title={t('knowledgeBase.exportModalTitle')}
        open={exportModalOpen}
        onOk={handleExport}
        onCancel={() => setExportModalOpen(false)}
        okText={t('knowledgeBase.export')}
        cancelText={t('common.cancel')}
        okButtonProps={{ loading: exporting }}
        width={520}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.exportTypeLabel')}</Text>
            <Radio.Group value={exportType} onChange={e => setExportType(e.target.value)}>
              <Space direction="vertical">
                <Radio value="full">{t('knowledgeBase.exportTypeFull')}</Radio>
                <Radio value="summary">{t('knowledgeBase.exportTypeSummary')}</Radio>
                <Radio value="documents">{t('knowledgeBase.exportTypeDocuments')}</Radio>
              </Space>
            </Radio.Group>
          </div>
          {exportType === 'summary' && (
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.exportFormatLabel')}</Text>
              <Select
                value={exportFormat}
                onChange={setExportFormat}
                style={{ width: '100%' }}
                options={[
                  { value: 'json-ld', label: 'JSON-LD' },
                  { value: 'csv', label: 'CSV' },
                ]}
              />
            </div>
          )}
          {exportType === 'full' && (
            <div style={{ padding: '8px 12px', background: token.colorInfoBg, borderRadius: 8 }}>
              <Text type="secondary">{t('knowledgeBase.exportFullDesc')}</Text>
            </div>
          )}
          {exportType === 'summary' && (
            <div style={{ padding: '8px 12px', background: token.colorInfoBg, borderRadius: 8 }}>
              <Text type="secondary">{t('knowledgeBase.exportSummaryDesc')}</Text>
            </div>
          )}
          {exportType === 'documents' && (
            <div style={{ padding: '8px 12px', background: token.colorInfoBg, borderRadius: 8 }}>
              <Text type="secondary">{t('knowledgeBase.exportDocsDesc')}</Text>
            </div>
          )}
          {exporting && exportProgress.stage && (
            <div>
              <Progress percent={exportProgress.stage === 'complete' ? 100 : undefined} status={exportProgress.stage === 'complete' ? 'success' : 'active'} />
              <Text type="secondary" style={{ fontSize: 12 }}>{exportProgress.detail}</Text>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        title={t('knowledgeBase.importModalTitle')}
        open={importModalOpen}
        onOk={handleImport}
        onCancel={() => setImportModalOpen(false)}
        okText={t('knowledgeBase.import')}
        cancelText={t('common.cancel')}
        okButtonProps={{ loading: importing }}
        width={520}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.importTypeLabel')}</Text>
            <Radio.Group value={importType} onChange={e => setImportType(e.target.value)}>
              <Space direction="vertical">
                <Radio value="full">{t('knowledgeBase.importTypeFull')}</Radio>
                <Radio value="graph">{t('knowledgeBase.importTypeGraph')}</Radio>
              </Space>
            </Radio.Group>
          </div>
          {importType === 'full' && (
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.importKbNameLabel')}</Text>
              <Input
                placeholder={t('knowledgeBase.importKbNamePlaceholder')}
                value={importKBName}
                onChange={e => setImportKBName(e.target.value)}
              />
            </div>
          )}
          {importType === 'graph' && (
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.importFormatLabel')}</Text>
              <Select
                value={importFormat}
                onChange={setImportFormat}
                style={{ width: '100%' }}
                options={[
                  { value: 'json-ld', label: 'JSON-LD' },
                  { value: 'rdf', label: 'RDF' },
                ]}
              />
            </div>
          )}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.conflictStrategyLabel')}</Text>
            <Select
              value={importConflictStrategy}
              onChange={v => setImportConflictStrategy(v)}
              style={{ width: '100%' }}
              options={
                importType === 'graph'
                  ? [
                      { value: 'merge', label: t('knowledgeBase.conflictMerge') },
                      { value: 'overwrite', label: t('knowledgeBase.conflictOverwrite') },
                      { value: 'skip', label: t('knowledgeBase.conflictSkip') },
                    ]
                  : [
                      { value: 'skip', label: t('knowledgeBase.conflictSkip') },
                      { value: 'overwrite', label: t('knowledgeBase.conflictOverwrite') },
                      { value: 'rename', label: t('knowledgeBase.conflictRename') },
                    ]
              }
            />
          </div>
          {importType === 'full' && (
            <div style={{ padding: '8px 12px', background: token.colorInfoBg, borderRadius: 8 }}>
              <Text type="secondary">{t('knowledgeBase.importFullDesc')}</Text>
            </div>
          )}
          {importType === 'graph' && (
            <div style={{ padding: '8px 12px', background: token.colorInfoBg, borderRadius: 8 }}>
              <Text type="secondary">{t('knowledgeBase.importGraphDesc')}</Text>
            </div>
          )}
          {importing && importProgress.stage && (
            <div>
              <Progress percent={importProgress.stage === 'complete' ? 100 : undefined} status={importProgress.stage === 'complete' ? 'success' : 'active'} />
              <Text type="secondary" style={{ fontSize: 12 }}>{importProgress.detail}</Text>
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}

export default KnowledgeBasePage
