import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { App, Button, notification } from 'antd'
import { useTaskDetailStore } from '../stores/task-detail.store'
import { getCachedSceneDefaultModel } from '../utils/default-model'
import type { KBDocument, KnowledgeBase, ScanTreeNode } from '../components/knowledge-base/types'

const KB_SELECTION_KEY = 'workavatar_selected_kb_id'
const KB_TAB_KEY = 'workavatar_selected_kb_tab'

export type { KBDocument, KnowledgeBase, ScanTreeNode }

export const useKnowledgeBase = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const openDetail = useTaskDetailStore((s) => s.openDetail)

  const [kbs, setKBs] = useState<KnowledgeBase[]>([])
  const [selectedKB, setSelectedKB] = useState<KnowledgeBase | null>(null)
  const [docs, setDocs] = useState<KBDocument[]>([])
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newKBName, setNewKBName] = useState('')
  const [newKBDesc, setNewKBDesc] = useState('')
  const [uploadLoading, setUploadLoading] = useState(false)
  const [parsingAll, setParsingAll] = useState(false)
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem(KB_TAB_KEY) || 'docs')
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    return localStorage.getItem('knowledgeBase:selectedProviderId') || getCachedSceneDefaultModel('knowledge')?.provider_id || ''
  })
  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    return localStorage.getItem('knowledgeBase:selectedModelId') || getCachedSceneDefaultModel('knowledge')?.model_id || ''
  })
  const [enableThinking, setEnableThinking] = useState<boolean>(() => {
    return localStorage.getItem('knowledgeBase:enableThinking') === 'true'
  })

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
  const [globalSummary, setGlobalSummary] = useState<any>(null)
  const [searchPanelOpen, setSearchPanelOpen] = useState(false)
  const [editKBModalOpen, setEditKBModalOpen] = useState(false)
  const [editKBName, setEditKBName] = useState('')
  const [editKBDesc, setEditKBDesc] = useState('')
  const [processedDocIds, setProcessedDocIds] = useState<Set<string>>(new Set())
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState({ stage: '', detail: '' })
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [importConflictStrategy, setImportConflictStrategy] = useState<'skip' | 'overwrite' | 'rename'>('skip')
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState({ stage: '', detail: '' })
  const [importKBName, setImportKBName] = useState('')
  const [folderScanModalOpen, setFolderScanModalOpen] = useState(false)
  const [folderScanning, setFolderScanning] = useState(false)
  const [scannedFiles, setScannedFiles] = useState<Array<{ path: string; name: string; ext: string; size: number }>>([])
  const [scannedUnsupported, setScannedUnsupported] = useState<Array<{ path: string; name: string; ext: string }>>([])
  const [selectedScannedKeys, setSelectedScannedKeys] = useState<Set<string>>(new Set())
  const [folderUploading, setFolderUploading] = useState(false)
  const [scannedRootPath, setScannedRootPath] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeKBRef = useRef<string>('')
  const autoRestoredRef = useRef(false)
  const loadDocsRef = useRef<((kbId: string) => Promise<void>) | null>(null)

  const loadKBs = useCallback(async () => {
    try {
      const result = await window.electronAPI.kb.list()
      setKBs(result)
      return result
    } catch { message.error(t('knowledgeBase.loadKbFailed')) }
    return []
  }, [])

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
          if (activeKBRef.current) loadDocsRef.current?.(activeKBRef.current)
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
      } catch (e) { console.error('Failed to load doc processing status:', e) }
    } catch { message.error(t('knowledgeBase.loadDocsFailed')) }
  }, [])
  loadDocsRef.current = loadDocs

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

  const loadKnowledgeStats = async (kbId: string) => {
    try {
      const stats = await window.electronAPI.kb.getStats(kbId)
      if (activeKBRef.current !== kbId) return
      setKnowledgeStats(stats)
    } catch (e) { console.error('Failed to load knowledge stats:', e) }
  }

  const loadGlobalSummary = async (kbId: string) => {
    try {
      const summary = await window.electronAPI.kb.getGlobalSummary(kbId)
      if (activeKBRef.current !== kbId) return
      setGlobalSummary(summary)
    } catch (e) { console.error('Failed to load global summary:', e) }
  }

  const handleSelectKB = useCallback((kb: KnowledgeBase) => {
    activeKBRef.current = kb.id
    setSelectedKB(kb)
    localStorage.setItem(KB_SELECTION_KEY, kb.id)
    setDocs([])
    setKnowledgeStats(null)
    setGlobalSummary(null)
    loadDocs(kb.id)
    loadKnowledgeStats(kb.id)
    loadGlobalSummary(kb.id)
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

  useEffect(() => {
    const hasActiveParsing = docs.some(d => d.parse_status === 'parsing' || d.parse_status === 'paused')
    if (hasActiveParsing && selectedKB) {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => {
          if (activeKBRef.current) {
            window.electronAPI.kb.getDocumentList({ kb_id: activeKBRef.current }).then(result => {
              setDocs(result)
              const stillActive = result.some((d: KBDocument) => d.parse_status === 'parsing' || d.parse_status === 'paused')
              if (!stillActive && pollRef.current) {
                clearInterval(pollRef.current)
                pollRef.current = null
                setParsingAll(false)
                loadDocProcessingStatus(result)
                if (activeKBRef.current) {
                  loadKnowledgeStats(activeKBRef.current)
                  loadGlobalSummary(activeKBRef.current)
                }
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
        if (selectedKB) { loadDocs(selectedKB.id); loadKnowledgeStats(selectedKB.id); loadGlobalSummary(selectedKB.id) }
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
      loadDocs(selectedKB.id); loadKnowledgeStats(selectedKB.id); loadGlobalSummary(selectedKB.id)
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
        loadKnowledgeStats(selectedKB.id); loadGlobalSummary(selectedKB.id)
      } else {
        message.error(result.error || t('knowledgeBase.buildFailed'))
      }
    } catch { message.error(t('knowledgeBase.globalBuildFailed')) }
    finally { cleanup(); setBuildingGlobal(false); setProcessProgress({ stage: '', detail: '' }) }
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

  const handleUploadFolder = async () => {
    if (!selectedKB) return
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: t('knowledgeBase.selectUploadFolder'),
        properties: ['openDirectory'],
      })
      if (result.canceled || !result.filePaths.length) return

      setFolderScanning(true)
      setFolderScanModalOpen(true)
      setScannedFiles([])
      setScannedUnsupported([])
      setSelectedScannedKeys(new Set())
      setScannedRootPath(result.filePaths[0])

      const scanResult = await window.electronAPI.kb.scanFolder({ folder_path: result.filePaths[0] })
      setScannedFiles(scanResult.supported)
      setScannedUnsupported(scanResult.unsupported)
      setSelectedScannedKeys(new Set(scanResult.supported.map((f: any) => f.path)))
      setFolderScanning(false)
    } catch {
      message.error(t('knowledgeBase.scanFolderFailed'))
      setFolderScanning(false)
      setFolderScanModalOpen(false)
    }
  }

  const handleFolderUploadConfirm = async () => {
    if (!selectedKB || selectedScannedKeys.size === 0) return
    const selectedPaths = Array.from(selectedScannedKeys)
    setFolderUploading(true)
    try {
      const uploadResult = await window.electronAPI.kb.uploadDocuments({ kb_id: selectedKB.id, paths: selectedPaths })
      if (uploadResult.imported.length > 0) {
        message.success(t('knowledgeBase.uploadSuccess', { count: uploadResult.imported.length }))
        loadDocs(selectedKB.id)
        loadKBs()
      }
      if (uploadResult.errors.length > 0) {
        message.warning(t('knowledgeBase.uploadPartialFailed', { count: uploadResult.errors.length }))
      }
      setFolderScanModalOpen(false)
    } catch {
      message.error(t('knowledgeBase.uploadFailed'))
    } finally {
      setFolderUploading(false)
    }
  }

  const scannedTreeData = useMemo<ScanTreeNode[]>(() => {
    if (!scannedRootPath || scannedFiles.length === 0) return []
    const rootSep = scannedRootPath.includes('\\') ? '\\' : '/'
    const normalizedRoot = scannedRootPath.replace(/[/\\]+$/, '') + rootSep

    const root: ScanTreeNode = { key: scannedRootPath, name: scannedRootPath.replace(/[/\\]+$/, '').split(/[/\\]+/).pop() || '', isLeaf: false, children: [], fileCount: 0 }
    const dirMap = new Map<string, ScanTreeNode>()
    dirMap.set(scannedRootPath, root)

    for (const file of scannedFiles) {
      const rel = file.path.startsWith(normalizedRoot) ? file.path.slice(normalizedRoot.length) : file.path
      const parts = rel.split(/[/\\]+/)

      let currentPath = scannedRootPath
      let parentNode = root

      for (let i = 0; i < parts.length - 1; i++) {
        const dirName = parts[i]
        currentPath = currentPath + rootSep + dirName
        if (!dirMap.has(currentPath)) {
          const dirNode: ScanTreeNode = { key: currentPath, name: dirName, isLeaf: false, children: [], fileCount: 0 }
          dirMap.set(currentPath, dirNode)
          parentNode.children!.push(dirNode)
        }
        parentNode = dirMap.get(currentPath)!
      }

      parentNode.children!.push({
        key: file.path,
        name: file.name,
        ext: file.ext,
        size: file.size,
        isLeaf: true,
      })
      let p: string | undefined = currentPath
      while (p !== undefined) {
        const node = dirMap.get(p)
        if (node) node.fileCount = (node.fileCount || 0) + 1
        const idx = p.lastIndexOf(rootSep)
        p = idx > 0 ? p.substring(0, idx) : undefined
      }
      root.fileCount = (root.fileCount || 0) + 1
    }

    const sortNodes = (nodes: ScanTreeNode[]) => {
      nodes.sort((a, b) => {
        if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1
        return a.name.localeCompare(b.name)
      })
      for (const node of nodes) {
        if (node.children) sortNodes(node.children)
      }
    }
    sortNodes(root.children || [])

    return root.children || []
  }, [scannedFiles, scannedRootPath])

  const getAllLeafKeys = (nodes: ScanTreeNode[]): string[] => {
    const keys: string[] = []
    const traverse = (list: ScanTreeNode[]) => {
      for (const node of list) {
        if (node.isLeaf) keys.push(node.key)
        else if (node.children) traverse(node.children)
      }
    }
    traverse(nodes)
    return keys
  }

  const handleTreeSelect = (keys: React.Key[]) => {
    const keySet = new Set(keys as string[])
    const leafKeys = getAllLeafKeys(scannedTreeData)
    const onlyFileKeys = leafKeys.filter(k => keySet.has(k))
    setSelectedScannedKeys(new Set(onlyFileKeys))
  }

  const expandedFolderKeys = useMemo(() => {
    const keys: string[] = []
    const traverse = (nodes: ScanTreeNode[], depth: number) => {
      if (depth >= 3) return
      for (const node of nodes) {
        if (!node.isLeaf) {
          keys.push(node.key)
          if (node.children) traverse(node.children, depth + 1)
        }
      }
    }
    traverse(scannedTreeData, 0)
    return keys
  }, [scannedTreeData])

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

      const result = await window.electronAPI.app.showSaveDialog({
        title: t('knowledgeBase.exportSaveAs'),
        defaultPath: `${selectedKB.name}_${dateStr}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) { setExporting(false); cleanup(); return }
      const res = await window.electronAPI.kb.exportFull({ kb_id: selectedKB.id, export_path: result.filePath })
      if (res.success) { message.success(t('knowledgeBase.exportSuccess')); setExportModalOpen(false) }
      else message.error(res.error || t('knowledgeBase.exportFailed'))
    } catch { message.error(t('knowledgeBase.exportFailed')) }
    finally { cleanup(); setExporting(false); setExportProgress({ stage: '', detail: '' }) }
  }

  const handleImport = async () => {
    setImporting(true)
    setImportProgress({ stage: '', detail: '' })
    const cleanup = (window as any).electronAPI.kb.onImportProgress((p: any) => setImportProgress(p))
    try {
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
    } catch { message.error(t('knowledgeBase.importFailed')) }
    finally { cleanup(); setImporting(false); setImportProgress({ stage: '', detail: '' }) }
  }

  const pendingCount = docs.filter(d => d.parse_status === 'pending').length
  const completedCount = docs.filter(d => d.parse_status === 'completed').length
  const failedCount = docs.filter(d => d.parse_status === 'failed').length
  const pausedCount = docs.filter(d => d.parse_status === 'paused').length

  const handleTabChange = (key: string) => {
    setActiveTab(key)
    localStorage.setItem(KB_TAB_KEY, key)
  }

  const handleRefreshDocs = () => {
    if (selectedKB) { loadDocs(selectedKB.id) }
  }

  const handleFolderScanModalClose = () => {
    setFolderScanModalOpen(false)
    setScannedFiles([])
    setScannedUnsupported([])
    setSelectedScannedKeys(new Set())
    setScannedRootPath('')
  }

  const handleOpenImportModal = () => {
    setImportKBName('')
    setImportModalOpen(true)
  }

  return {
    kbs,
    selectedKB,
    onSelectKB: handleSelectKB,
    loadKBs,
    onDeleteKB: handleDeleteKB,

    docs,
    pendingCount,
    completedCount,
    failedCount,
    pausedCount,
    parsingAll,
    uploadLoading,
    processedDocIds,
    onParseDocument: handleParseDocument,
    onParseAll: handleParseAll,
    onDeleteDoc: handleDeleteDoc,
    onPauseParse: handlePauseParse,
    onResumeParse: handleResumeParse,
    onRetryParse: handleRetryParse,
    onPauseAll: handlePauseAll,
    onResumeAll: handleResumeAll,
    onCancelAll: handleCancelAll,
    onUploadFiles: handleUploadFiles,
    onUploadFolder: handleUploadFolder,
    onRefreshDocs: handleRefreshDocs,

    processingDocId,
    processingAll,
    buildingGlobal,
    processProgress,
    knowledgeStats,
    globalSummary,
    onProcessDocument: handleProcessDocument,
    onProcessAll: handleProcessAll,
    onBuildGlobal: handleBuildGlobal,
    onViewParseDetail: handleViewParseDetail,

    createModalOpen,
    setCreateModalOpen,
    newKBName,
    setNewKBName,
    newKBDesc,
    setNewKBDesc,
    onCreateKB: handleCreateKB,

    editKBModalOpen,
    setEditKBModalOpen,
    editKBName,
    setEditKBName,
    editKBDesc,
    setEditKBDesc,
    onConfirmEditKB: confirmEditKB,
    onEditKB: handleEditKB,

    activeTab,
    onTabChange: handleTabChange,

    selectedProviderId,
    selectedModelId,
    enableThinking,
    onLlmChange: (providerId: string, modelId: string) => {
      setSelectedProviderId(providerId)
      setSelectedModelId(modelId)
    },
    onThinkingChange: setEnableThinking,

    exportModalOpen,
    setExportModalOpen,
    exporting,
    exportProgress,
    onExport: handleExport,

    importModalOpen,
    setImportModalOpen,
    importConflictStrategy,
    setImportConflictStrategy,
    importing,
    importProgress,
    importKBName,
    setImportKBName,
    onImport: handleImport,
    onOpenImportModal: handleOpenImportModal,

    folderScanModalOpen,
    folderScanning,
    scannedFiles,
    scannedUnsupported,
    selectedScannedKeys,
    setSelectedScannedKeys,
    scannedRootPath,
    scannedTreeData,
    expandedFolderKeys,
    folderUploading,
    onTreeSelect: handleTreeSelect,
    onFolderUploadConfirm: handleFolderUploadConfirm,
    onFolderScanModalClose: handleFolderScanModalClose,

    searchPanelOpen,
    setSearchPanelOpen,

    navigate,
  }
}
