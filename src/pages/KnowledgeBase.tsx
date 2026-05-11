import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Card, Button, Typography, Space, Tag, Modal,
  Input, Empty, Tooltip, Tabs, theme, App,
} from 'antd'
import {
  PlusOutlined, FileTextOutlined, UploadOutlined,
  LinkOutlined, BookOutlined, EditOutlined, FolderOpenOutlined,
  ThunderboltOutlined, NodeIndexOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import { KBListPanel, KBDocList, KBKnowledgeView, KBEntityGraph } from '../components/knowledge-base'

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
                    <KBDocList
                      docs={docs}
                      parsingAll={parsingAll}
                      processingAll={processingAll}
                      processProgress={processProgress}
                      completedCount={completedCount}
                      pendingCount={pendingCount}
                      failedCount={failedCount}
                      processedDocIds={processedDocIds}
                      processingDoc={processingDoc}
                      onParseAll={handleParseAll}
                      onProcessAll={handleProcessAll}
                      onParseDocument={handleParseDocument}
                      onProcessDocument={handleProcessDocument}
                      onDeleteDoc={handleDeleteDoc}
                      onRefresh={() => { loadDocs(selectedKB.id); loadLinkedProjects(selectedKB.id) }}
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
                      timeline={timeline}
                      timelineTopic={timelineTopic}
                      processingDoc={processingDoc}
                      processingAll={processingAll}
                      buildingGlobal={buildingGlobal}
                      processProgress={processProgress}
                      selectedProviderId={selectedProviderId}
                      selectedModelId={selectedModelId}
                      onProviderChange={setSelectedProviderId}
                      onModelChange={setSelectedModelId}
                      onProcessAll={handleProcessAll}
                      onBuildGlobal={handleBuildGlobal}
                      onProcessDocument={handleProcessDocument}
                      onViewChapters={handleViewChapters}
                      onViewDocContent={handleViewDocContent}
                      onGenerateTimeline={handleGenerateTimeline}
                      onTimelineTopicChange={setTimelineTopic}
                      docChapters={docChapters}
                      chapterModalOpen={chapterModalOpen}
                      selectedDocSummary={selectedDocSummary}
                      onCloseChapterModal={() => setChapterModalOpen(false)}
                      docContent={docContent}
                      docContentTitle={docContentTitle}
                      docContentModalOpen={docContentModalOpen}
                      onCloseDocContentModal={() => setDocContentModalOpen(false)}
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
    </div>
  )
}

export default KnowledgeBasePage
