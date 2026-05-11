import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Card, Button, Typography, Space, Table, Tag, Modal,
  Input, Popconfirm, Empty, Statistic, Row, Col,
  Tooltip, Spin, Tabs, Alert, Select, theme, App,
} from 'antd'
import {
  PlusOutlined, DatabaseOutlined, FileTextOutlined, UploadOutlined,
  DeleteOutlined, ReloadOutlined, LinkOutlined, SyncOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined,
  BookOutlined, FolderOpenOutlined, ReadOutlined,
  ThunderboltOutlined, ApartmentOutlined, NodeIndexOutlined,
  HistoryOutlined, EyeOutlined, SearchOutlined, EditOutlined,
  RedoOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import LLMSelector from '../components/llm/LLMSelector'
import { formatFileSize } from '../utils/format'

const { Title, Text } = Typography

interface KBDocument {
  id: string
  kb_id: string
  original_name: string
  type: string
  size: number
  hash: string
  parse_status: 'pending' | 'parsing' | 'completed' | 'failed'
  parse_error?: string
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
  const [activeTab, setActiveTab] = useState('docs')
  const [selectedProviderId, setSelectedProviderId] = useState<string>('')
  const [selectedModelId, setSelectedModelId] = useState<string>('')

  const [knowledgeStats, setKnowledgeStats] = useState<any>(null)
  const [processingDoc, setProcessingDoc] = useState(false)
  const [processingAll, setProcessingAll] = useState(false)
  const [buildingGlobal, setBuildingGlobal] = useState(false)
  const [processProgress, setProcessProgress] = useState({ stage: '', detail: '' })
  const [entities, setEntities] = useState<any[]>([])
  const [entityFilter, setEntityFilter] = useState<string>('')
  const [selectedEntity, setSelectedEntity] = useState<any>(null)
  const [entityRelations, setEntityRelations] = useState<any[]>([])
  const [entityModalOpen, setEntityModalOpen] = useState(false)
  const [globalSummary, setGlobalSummary] = useState<any>(null)
  const [timeline, setTimeline] = useState<any[]>([])
  const [timelineTopic, setTimelineTopic] = useState('')
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

  const loadKBs = useCallback(async () => {
    try {
      const result = await window.electronAPI.kb.list()
      setKBs(result)
    } catch { message.error(t('knowledgeBase.loadKbFailed')) }
  }, [])

  useEffect(() => { loadKBs() }, [loadKBs])

  const loadDocs = useCallback(async (kbId: string) => {
    try {
      const result = await window.electronAPI.kb.getDocumentList({ kb_id: kbId })
      setDocs(result)
      loadDocProcessingStatus(result)
    } catch { message.error(t('knowledgeBase.loadDocsFailed')) }
  }, [])

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
    setSelectedKB(kb)
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
      setKnowledgeStats(stats)
    } catch {}
  }

  const loadEntities = async (kbId: string, type?: string) => {
    try {
      const result = await window.electronAPI.kb.getEntities({ kb_id: kbId, type })
      setEntities(result)
    } catch {}
  }

  const loadGlobalSummary = async (kbId: string) => {
    try {
      const summary = await window.electronAPI.kb.getGlobalSummary(kbId)
      setGlobalSummary(summary)
    } catch {}
  }

  const handleProcessDocument = async (docId: string) => {
    setProcessingDoc(true)
    setProcessProgress({ stage: '', detail: '' })
    const cleanup = (window as any).electronAPI.kb.onProcessProgress((p: any) => setProcessProgress(p))
    try {
      const result = await window.electronAPI.kb.processDocument({
        doc_id: docId,
        provider_id: selectedProviderId || undefined,
        model_id: selectedModelId || undefined,
      })
      if (result.success) {
        message.success(t('knowledgeBase.knowledgeProcessed'))
        setProcessedDocIds(prev => new Set(prev).add(docId))
        if (selectedKB) { loadDocs(selectedKB.id); loadKnowledgeStats(selectedKB.id); loadEntities(selectedKB.id) }
      } else {
        message.error(result.error || t('knowledgeBase.processFailed'))
      }
    } catch { message.error(t('knowledgeBase.knowledgeProcessFailed')) }
    finally { cleanup(); setProcessingDoc(false); setProcessProgress({ stage: '', detail: '' }) }
  }

  const handleProcessAll = async () => {
    if (!selectedKB) return
    setProcessingAll(true)
    setProcessProgress({ stage: '', detail: '' })
    const cleanup = (window as any).electronAPI.kb.onProcessAllProgress((p: any) => setProcessProgress(p))
    try {
      const result = await window.electronAPI.kb.processAll({
        kb_id: selectedKB.id,
        provider_id: selectedProviderId || undefined,
        model_id: selectedModelId || undefined,
      })
      message.success(t('knowledgeBase.batchProcessResult', { success: result.success, failed: result.failed, skipped: result.skipped }))
      loadDocs(selectedKB.id); loadKnowledgeStats(selectedKB.id); loadEntities(selectedKB.id)
    } catch { message.error(t('knowledgeBase.batchProcessFailed')) }
    finally { cleanup(); setProcessingAll(false); setProcessProgress({ stage: '', detail: '' }) }
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

  const loadDocSummaries = async (_kbId: string) => {
    try {
      const completedDocs = docs.filter(d => d.parse_status === 'completed')
      const summaries: any[] = []
      for (const doc of completedDocs) {
        try {
          const summary = await window.electronAPI.kb.getDocSummary(doc.id)
          if (summary) summaries.push({ ...summary, doc_name: doc.original_name, doc_id: doc.id })
        } catch {}
      }
      setDocSummaries(summaries)
    } catch {}
  }

  const loadAllRelations = async (kbId: string) => {
    try {
      const allEntities = await window.electronAPI.kb.getEntities({ kb_id: kbId })
      const relations: any[] = []
      const seen = new Set<string>()
      for (const entity of allEntities) {
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

  const handleGenerateTimeline = async () => {
    if (!selectedKB) return
    try {
      const result = await window.electronAPI.kb.generateTimeline({ kb_id: selectedKB.id, topic: timelineTopic || undefined })
      setTimeline(result)
    } catch { message.error(t('knowledgeBase.generateTimelineFailed')) }
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
      if (selectedKB?.id === kbId) setSelectedKB(null)
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

  const pendingCount = docs.filter(d => d.parse_status === 'pending').length
  const completedCount = docs.filter(d => d.parse_status === 'completed').length
  const failedCount = docs.filter(d => d.parse_status === 'failed').length

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
        <Card size="small" title={<Space><DatabaseOutlined />{t('knowledgeBase.kbList')}</Space>}
          style={{ width: 280, flexShrink: 0 }}
          styles={{ body: { padding: 0, overflow: 'auto' } }}
        >
          {kbs.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: token.colorTextSecondary }}>
              <Empty description={t('knowledgeBase.noKb')} />
            </div>
          ) : (
            kbs.map(kb => (
              <div key={kb.id} onClick={() => handleSelectKB(kb)}
                style={{
                  padding: '12px 16px', cursor: 'pointer',
                  borderLeft: selectedKB?.id === kb.id ? `3px solid ${token.colorPrimary}` : '3px solid transparent',
                  background: selectedKB?.id === kb.id ? token.colorPrimaryBg : 'transparent',
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <Tooltip title={kb.name} placement="topLeft">
                    <Text strong style={{ fontSize: 14, display: 'block' }} ellipsis>{kb.name}</Text>
                  </Tooltip>
                  <Popconfirm title={t('knowledgeBase.confirmDelete')} onConfirm={(e) => { e?.stopPropagation(); handleDeleteKB(kb.id) }}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }} />
                  </Popconfirm>
                </div>
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}><FileTextOutlined /> {t('common.documents', { count: kb.doc_count || 0 })}</Text>
                </div>
              </div>
            ))
          )}
        </Card>

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
              </Card>

              <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
                {
                  key: 'docs',
                  label: <Space><FileTextOutlined />{t('knowledgeBase.tabDocs')}</Space>,
                  children: (
                    <div>
                      {(parsingAll || processingAll) && (
                        <Card size="small" style={{ marginBottom: 16, border: `1px solid ${token.colorPrimary}` }}>
                          <Space><Spin size="small" /><Text>{parsingAll ? t('knowledgeBase.batchParsing') : t('knowledgeBase.batchKnowledgeProcessing')}</Text></Space>
                          {processProgress.stage && <Text type="secondary" style={{ marginLeft: 8 }}>{processProgress.stage}: {processProgress.detail}</Text>}
                        </Card>
                      )}
                      <Card
                        title={<Space><FileTextOutlined />{t('knowledgeBase.docList')} ({docs.length})</Space>}
                        extra={
                          <Space>
                            <Row gutter={12} style={{ marginBottom: 8 }}>
                              <Col><Statistic title={t('knowledgeBase.parsed')} value={completedCount} styles={{ content: { color: token.colorSuccess, fontSize: 16 } }} /></Col>
                              <Col><Statistic title={t('knowledgeBase.pending')} value={pendingCount} styles={{ content: { color: token.colorWarning, fontSize: 16 } }} /></Col>
                              <Col><Statistic title={t('knowledgeBase.failed')} value={failedCount} styles={{ content: { color: token.colorError, fontSize: 16 } }} /></Col>
                            </Row>
                            {pendingCount > 0 && (
                              <Button icon={<SyncOutlined />} onClick={handleParseAll} type="primary" size="small" loading={parsingAll}>
                                {t('knowledgeBase.parseAll', { count: pendingCount })}
                              </Button>
                            )}
                            {completedCount > 0 && (
                              <Button icon={<ThunderboltOutlined />} onClick={handleProcessAll} size="small" loading={processingAll}>
                                {t('knowledgeBase.knowledgeProcessAll')}
                              </Button>
                            )}
                            <Button icon={<ReloadOutlined />} onClick={() => { loadDocs(selectedKB.id); loadLinkedProjects(selectedKB.id) }} size="small">{t('common.refresh')}</Button>
                          </Space>
                        }
                      >
                        <Table
                          dataSource={docs} rowKey="id" size="small" pagination={{ pageSize: 20 }}
                          scroll={{ x: 'max-content' }}
                          columns={[
                            { title: t('knowledgeBase.fileName'), dataIndex: 'original_name', key: 'name', ellipsis: true,
                              render: (text: string, record: KBDocument) => (
                                <Space><FileTextOutlined style={{ color: token.colorPrimary }} /><span>{text}</span><Tag style={{ fontSize: 10 }}>{record.type}</Tag></Space>
                              ),
                            },
                            { title: t('knowledgeBase.size'), dataIndex: 'size', key: 'size', width: 90,
                              render: (size: number) => <Text type="secondary">{formatFileSize(size)}</Text>,
                            },
                            { title: t('common.status'), dataIndex: 'parse_status', key: 'status', width: 120,
                              render: (status: string, record: KBDocument) => {
                                const config: Record<string, { color: string; text: string; icon: React.ReactNode }> = {
                                  completed: { color: 'green', text: t('knowledgeBase.parsed'), icon: <CheckCircleOutlined /> },
                                  pending: { color: 'orange', text: t('knowledgeBase.pending'), icon: <ClockCircleOutlined /> },
                                  parsing: { color: 'blue', text: t('knowledgeBase.parsing'), icon: <SyncOutlined spin /> },
                                  failed: { color: 'red', text: t('knowledgeBase.failed'), icon: <CloseCircleOutlined /> },
                                }
                                const c = config[status] || { color: 'default', text: status, icon: null }
                                const isProcessed = status === 'completed' && processedDocIds.has(record.id)
                                return <Space size={4}>
                                  <Tag color={c.color} icon={c.icon}>{c.text}</Tag>
                                  {isProcessed && <Tag color="purple" icon={<ThunderboltOutlined />} style={{ fontSize: 10 }}>{t('knowledgeBase.processed')}</Tag>}
                                </Space>
                              },
                            },
                            { title: t('common.action'), key: 'action', width: 200,
                              render: (_: any, record: KBDocument) => (
                                <Space size="small">
                                  {(record.parse_status === 'pending' || record.parse_status === 'failed') && (
                                    <Button type="link" size="small" onClick={() => handleParseDocument(record.id)}>{t('knowledgeBase.parse')}</Button>
                                  )}
                                  {record.parse_status === 'completed' && !processedDocIds.has(record.id) && (
                                    <Button type="link" size="small" icon={<ThunderboltOutlined />}
                                      onClick={() => handleProcessDocument(record.id)} loading={processingDoc}>{t('knowledgeBase.knowledgeProcess')}</Button>
                                  )}
                                  {record.parse_status === 'completed' && processedDocIds.has(record.id) && (
                                    <Button type="link" size="small" icon={<RedoOutlined />}
                                      onClick={() => handleProcessDocument(record.id)} loading={processingDoc}>{t('knowledgeBase.reKnowledgeProcess')}</Button>
                                  )}
                                  <Popconfirm title={t('knowledgeBase.confirmDelete')} onConfirm={() => handleDeleteDoc(record.id)}>
                                    <Button type="link" size="small" danger>{t('common.delete')}</Button>
                                  </Popconfirm>
                                </Space>
                              ),
                            },
                          ]}
                          locale={{ emptyText: <Empty description={t('knowledgeBase.uploadToKb')} /> }}
                        />
                      </Card>
                    </div>
                  ),
                },
                {
                  key: 'knowledge',
                  label: <Space><ThunderboltOutlined />{t('knowledgeBase.tabKnowledge')}</Space>,
                  children: (
                    <div>
                      <Card style={{ marginBottom: 16 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                          <Space>
                            <ThunderboltOutlined style={{ fontSize: 20, color: '#722ed1' }} />
                            <Title level={5} style={{ margin: 0 }}>{t('knowledgeBase.layeredKnowledge')}</Title>
                          </Space>
                          <Space>
                            <LLMSelector
                              providerId={selectedProviderId}
                              modelId={selectedModelId}
                              onProviderChange={setSelectedProviderId}
                              onModelChange={setSelectedModelId}
                            />
                            <Button icon={<ThunderboltOutlined />} onClick={handleProcessAll} loading={processingAll}>{t('knowledgeBase.processAllDocs')}</Button>
                            <Button type="primary" icon={<ApartmentOutlined />} onClick={handleBuildGlobal} loading={buildingGlobal}>{t('knowledgeBase.buildGlobalKnowledge')}</Button>
                          </Space>
                        </div>

                        {(processingDoc || processingAll || buildingGlobal) && processProgress.stage && (
                          <Alert type="info" title={processProgress.stage} description={processProgress.detail} style={{ marginBottom: 16 }} showIcon />
                        )}

                        {knowledgeStats && (
                          <Row gutter={16} style={{ marginBottom: 16 }}>
                            <Col span={4}><Statistic title={t('knowledgeBase.chapters')} value={knowledgeStats.chapterCount} prefix={<ReadOutlined />} /></Col>
                            <Col span={4}><Statistic title={t('knowledgeBase.docSummaries')} value={knowledgeStats.documentSummaryCount} prefix={<FileTextOutlined />} styles={{ content: { color: token.colorSuccess } }} /></Col>
                            <Col span={4}><Statistic title={t('knowledgeBase.globalSummary')} value={knowledgeStats.hasGlobalSummary ? 1 : 0} prefix={<ApartmentOutlined />} styles={{ content: { color: '#722ed1' } }} /></Col>
                            <Col span={4}><Statistic title={t('knowledgeBase.entities')} value={knowledgeStats.entityCount} prefix={<NodeIndexOutlined />} styles={{ content: { color: token.colorPrimary } }} /></Col>
                            <Col span={4}><Statistic title={t('knowledgeBase.relations')} value={knowledgeStats.relationCount} prefix={<ApartmentOutlined />} styles={{ content: { color: token.colorWarning } }} /></Col>
                          </Row>
                        )}

                        {globalSummary && (
                          <Card size="small" title={<Space><ApartmentOutlined />{t('knowledgeBase.globalKnowledgeSummary')}</Space>} style={{ marginBottom: 16 }}>
                            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, maxHeight: 300, overflow: 'auto' }}>
                              {globalSummary.summary}
                            </div>
                            {globalSummary.key_topics_json && (
                              <div style={{ marginTop: 12 }}>
                                <Text type="secondary">{t('knowledgeBase.coreTopics')} </Text>
                                {JSON.parse(globalSummary.key_topics_json || '[]').map((t: string) => (
                                  <Tag key={t} color="purple">{t}</Tag>
                                ))}
                              </div>
                            )}
                            {globalSummary.key_entities_json && (
                              <div style={{ marginTop: 8 }}>
                                <Text type="secondary">{t('knowledgeBase.keyEntities')} </Text>
                                {JSON.parse(globalSummary.key_entities_json || '[]').slice(0, 10).map((e: any, i: number) => (
                                  <Tag key={i} color="blue">{e.name}({e.type})</Tag>
                                ))}
                              </div>
                            )}
                          </Card>
                        )}

                        {docSummaries.length > 0 && (
                          <Card size="small" title={<Space><FileTextOutlined />{t('knowledgeBase.docSummaryList', { count: docSummaries.length })}</Space>} style={{ marginBottom: 16 }}>
                            <Table dataSource={docSummaries} rowKey="doc_id" size="small" pagination={{ pageSize: 5 }}
                              scroll={{ x: 'max-content' }}
                              columns={[
                                { title: t('knowledgeBase.doc'), dataIndex: 'doc_name', key: 'doc_name', width: 200,
                                  render: (name: string, record: any) => (
                                    <Button type="link" size="small" onClick={() => handleViewChapters(record.doc_id, name)}>{name}</Button>
                                  ),
                                },
                                { title: t('knowledgeBase.summary'), dataIndex: 'summary', key: 'summary', ellipsis: true,
                                  render: (summary: string) => <Text type="secondary" ellipsis={{ tooltip: summary }}>{summary}</Text>,
                                },
                                { title: t('knowledgeBase.topics'), dataIndex: 'topics_json', key: 'topics', width: 200,
                                  render: (json: string) => {
                                    const topics: string[] = JSON.parse(json || '[]')
                                    return <Space size={2} wrap>{topics.slice(0, 3).map(t => <Tag key={t} color="green" style={{ fontSize: 11 }}>{t}</Tag>)}</Space>
                                  },
                                },
                                { title: t('common.action'), key: 'action', width: 180,
                                  render: (_: any, record: any) => (
                                    <Space size="small">
                                      <Button type="link" size="small" icon={<ReadOutlined />} onClick={() => handleViewChapters(record.doc_id, record.doc_name)}>{t('knowledgeBase.chaptersBtn')}</Button>
                                      <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewDocContent(record.doc_id, record.doc_name)}>{t('knowledgeBase.original')}</Button>
                                      <Button type="link" size="small" icon={<RedoOutlined />} onClick={() => handleProcessDocument(record.doc_id)} loading={processingDoc}>{t('knowledgeBase.reprocess')}</Button>
                                    </Space>
                                  ),
                                },
                              ]}
                            />
                          </Card>
                        )}

                        {allRelations.length > 0 && (
                          <Card size="small" title={<Space><ApartmentOutlined />{t('knowledgeBase.relationNetwork', { count: allRelations.length })}</Space>}>
                            <Table dataSource={allRelations} rowKey={(r: any) => r.id || `${r.source_entity_id}-${r.target_entity_id}-${r.relation_type}`} size="small" pagination={{ pageSize: 10 }}
                              scroll={{ x: 'max-content' }}
                              columns={[
                                { title: t('knowledgeBase.sourceEntity'), dataIndex: 'source_name', key: 'source', width: 120,
                                  render: (name: string) => <Tag color="blue">{name}</Tag>,
                                },
                                { title: t('knowledgeBase.relation'), dataIndex: 'relation_type', key: 'relation', width: 120,
                                  render: (type: string) => <Text strong style={{ color: '#722ed1' }}>{type}</Text>,
                                },
                                { title: t('knowledgeBase.targetEntity'), dataIndex: 'target_name', key: 'target', width: 120,
                                  render: (name: string) => <Tag color="green">{name}</Tag>,
                                },
                                { title: t('common.description'), dataIndex: 'description', key: 'description', ellipsis: true,
                                  render: (desc: string) => <Text type="secondary" ellipsis>{desc}</Text>,
                                },
                              ]}
                            />
                          </Card>
                        )}
                      </Card>

                      <Card title={<Space><HistoryOutlined />{t('knowledgeBase.timeline')}</Space>}>
                        <Space style={{ marginBottom: 16 }}>
                          <Input placeholder={t('knowledgeBase.timelineFilterPlaceholder')} value={timelineTopic}
                            onChange={e => setTimelineTopic(e.target.value)} style={{ width: 300 }}
                            onPressEnter={handleGenerateTimeline} />
                          <Button icon={<SearchOutlined />} onClick={handleGenerateTimeline} type="primary">{t('knowledgeBase.generateTimeline')}</Button>
                        </Space>
                        {timeline.length > 0 ? (
                          <Table dataSource={timeline} rowKey={(r: any) => `${r.time}-${r.event}`} size="small" pagination={{ pageSize: 20 }}
                            scroll={{ x: 'max-content' }}
                            columns={[
                              { title: t('knowledgeBase.time'), dataIndex: 'time', key: 'time', width: 150 },
                              { title: t('knowledgeBase.event'), dataIndex: 'event', key: 'event', ellipsis: true },
                              { title: t('knowledgeBase.source'), dataIndex: 'source', key: 'source', width: 120, ellipsis: true },
                            ]}
                          />
                        ) : (
                          <Empty description={t('knowledgeBase.timelineEmpty')} />
                        )}
                      </Card>
                    </div>
                  ),
                },
                {
                  key: 'entities',
                  label: <Space><NodeIndexOutlined />{t('knowledgeBase.tabEntity')}</Space>,
                  children: (
                    <div>
                      <Card
                        title={<Space><NodeIndexOutlined />{t('knowledgeBase.entityList', { count: entities.length })}</Space>}
                        extra={
                          <Space>
                            <Select placeholder={t('knowledgeBase.filterByType')} allowClear style={{ width: 140 }} value={entityFilter || undefined}
                              onChange={(v: string) => { setEntityFilter(v || ''); if (selectedKB) loadEntities(selectedKB.id, v || undefined) }}
                              options={[
                                { label: t('knowledgeBase.entityTypePerson'), value: 'person' },
                                { label: t('knowledgeBase.entityTypeOrg'), value: 'organization' },
                                { label: t('knowledgeBase.entityTypeLocation'), value: 'location' },
                                { label: t('knowledgeBase.entityTypeEvent'), value: 'event' },
                                { label: t('knowledgeBase.entityTypeConcept'), value: 'concept' },
                                { label: t('knowledgeBase.entityTypeTool'), value: 'tool' },
                              ]}
                            />
                            <Button icon={<ReloadOutlined />} size="small"
                              onClick={() => { if (selectedKB) loadEntities(selectedKB.id, entityFilter || undefined) }}>{t('common.refresh')}</Button>
                          </Space>
                        }
                      >
                        {entities.length === 0 ? (
                          <Empty description={t('knowledgeBase.noEntities')} />
                        ) : (
                          <Table dataSource={entities} rowKey="id" size="small" pagination={{ pageSize: 20 }}
                            scroll={{ x: 'max-content' }}
                            columns={[
                              { title: t('common.name'), dataIndex: 'name', key: 'name', ellipsis: true, width: 160,
                                render: (name: string, record: any) => (
                                  <Button type="link" size="small" onClick={() => handleViewEntity(record)}>
                                    <NodeIndexOutlined /> {name}
                                  </Button>
                                ),
                              },
                              { title: t('common.type'), dataIndex: 'type', key: 'type', width: 80,
                                render: (type: string) => {
                                  const colors: Record<string, string> = { person: 'blue', organization: 'green', location: 'orange', event: 'red', concept: 'purple', tool: 'cyan' }
                                  return <Tag color={colors[type] || 'default'}>{type}</Tag>
                                },
                              },
                              { title: t('common.description'), dataIndex: 'description', key: 'description', ellipsis: true,
                              },
                              { title: t('knowledgeBase.mentions'), dataIndex: 'mention_count', key: 'mention_count', width: 90,
                                render: (count: number) => <Tag>{count}</Tag>,
                              },
                              { title: t('knowledgeBase.aliases'), dataIndex: 'aliases_json', key: 'aliases', width: 150,
                                render: (json: string) => {
                                  const aliases: string[] = JSON.parse(json || '[]')
                                  return <Space size={2} wrap>{aliases.slice(0, 3).map(a => <Tag key={a} style={{ fontSize: 11 }}>{a}</Tag>)}</Space>
                                },
                              },
                              { title: t('common.action'), key: 'action', width: 60,
                                render: (_: any, record: any) => (
                                  <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewEntity(record)}>{t('knowledgeBase.details')}</Button>
                                ),
                              },
                            ]}
                          />
                        )}
                      </Card>
                    </div>
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
        title={<Space><NodeIndexOutlined />{selectedEntity?.name}</Space>}
        open={entityModalOpen}
        onCancel={() => setEntityModalOpen(false)}
        footer={null}
        width={700}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        {selectedEntity && (
          <div>
            <Space wrap style={{ marginBottom: 16 }}>
              <Tag color={(() => { const c: Record<string, string> = { person: 'blue', organization: 'green', location: 'orange', event: 'red', concept: 'purple' }; return c[selectedEntity.type] || 'default' })()}>
                {selectedEntity.type}
              </Tag>
              <Tag>{t('knowledgeBase.mentionCount', { count: selectedEntity.mention_count })}</Tag>
              {JSON.parse(selectedEntity.aliases_json || '[]').map((a: string) => (
                <Tag key={a} style={{ fontSize: 11 }}>{t('knowledgeBase.aliasLabel')} {a}</Tag>
              ))}
            </Space>
            {selectedEntity.description && (
              <Card size="small" title={t('knowledgeBase.descCard')} style={{ marginBottom: 16 }}>
                <Text>{selectedEntity.description}</Text>
              </Card>
            )}
            {entityRelations.length > 0 && (
              <Card size="small" title={<Space><ApartmentOutlined />{t('knowledgeBase.relationNetworkCard')}</Space>}>
                <Table dataSource={entityRelations} rowKey="id" size="small" pagination={false}
                  columns={[
                    { title: t('knowledgeBase.direction'), key: 'direction', width: 50,
                      render: (_: any, record: any) => record.source_entity_id === selectedEntity.id ? '→' : '←',
                    },
                    { title: t('knowledgeBase.relatedEntity'), key: 'related', width: 150,
                      render: (_: any, record: any) => {
                        const isSource = record.source_entity_id === selectedEntity.id
                        return <Button type="link" size="small" onClick={() => {
                          const relatedId = isSource ? record.target_entity_id : record.source_entity_id
                          const relatedEntity = entities.find((e: any) => e.id === relatedId)
                          if (relatedEntity) {
                            setEntityModalOpen(false)
                            setTimeout(() => handleViewEntity(relatedEntity), 100)
                          }
                        }}>{isSource ? record.target_name : record.source_name}</Button>
                      },
                    },
                    { title: t('common.type'), key: 'related_type', width: 80,
                      render: (_: any, record: any) => {
                        const isSource = record.source_entity_id === selectedEntity.id
                        const type = isSource ? record.target_type : record.source_type
                        return <Tag>{type}</Tag>
                      },
                    },
                    { title: t('knowledgeBase.relation'), dataIndex: 'relation_type', key: 'relation_type', width: 120 },
                    { title: t('common.description'), dataIndex: 'description', key: 'description',
                      render: (desc: string) => <Text type="secondary">{desc}</Text>,
                    },
                  ]}
                />
              </Card>
            )}
          </div>
        )}
      </Modal>

      <Modal
        title={<Space><ReadOutlined />{selectedDocSummary} - {t('knowledgeBase.chapterList')}</Space>}
        open={chapterModalOpen}
        onCancel={() => setChapterModalOpen(false)}
        footer={null}
        width={800}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        {docChapters.length > 0 ? (
          <Table dataSource={docChapters} rowKey="id" size="small" pagination={false}
            columns={[
              { title: t('knowledgeBase.chapters'), dataIndex: 'title', key: 'title', width: 200,
                render: (title: string) => <Text strong>{title}</Text>,
              },
              { title: t('knowledgeBase.summary'), dataIndex: 'summary', key: 'summary',
                render: (summary: string) => <Text type="secondary" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{summary || t('knowledgeBase.noSummary')}</Text>,
              },
              { title: t('knowledgeBase.keywords'), dataIndex: 'keywords_json', key: 'keywords', width: 200,
                render: (json: string) => {
                  const keywords: string[] = JSON.parse(json || '[]')
                  return <Space size={2} wrap>{keywords.map(k => <Tag key={k} style={{ fontSize: 11 }}>{k}</Tag>)}</Space>
                },
              },
              { title: t('knowledgeBase.entities'), dataIndex: 'entities_json', key: 'entities', width: 200,
                render: (json: string) => {
                  const entities: any[] = JSON.parse(json || '[]')
                  return <Space size={2} wrap>{entities.slice(0, 5).map((e, i) => <Tag key={i} color="blue" style={{ fontSize: 11 }}>{e.name}({e.type})</Tag>)}</Space>
                },
              },
            ]}
          />
        ) : (
          <Empty description={t('knowledgeBase.noChapters')} />
        )}
      </Modal>

      <Modal
        title={<Space><FileTextOutlined />{docContentTitle} - {t('knowledgeBase.originalDoc')}</Space>}
        open={docContentModalOpen}
        onCancel={() => setDocContentModalOpen(false)}
        footer={null}
        width={800}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, fontSize: 13 }}>
          {docContent}
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
    </div>
  )
}

export default KnowledgeBasePage
