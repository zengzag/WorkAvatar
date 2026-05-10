import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Card, Button, Typography, Space, message, Table, Tag, Modal,
  Input, Popconfirm, Empty, Statistic, Row, Col,
  Tooltip, Spin, Tabs, Alert, Select,
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
  const navigate = useNavigate()
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
    } catch { message.error('加载知识库列表失败') }
  }, [])

  useEffect(() => { loadKBs() }, [loadKBs])

  const loadDocs = useCallback(async (kbId: string) => {
    try {
      const result = await window.electronAPI.kb.getDocumentList({ kb_id: kbId })
      setDocs(result)
      loadDocProcessingStatus(result)
    } catch { message.error('加载文档列表失败') }
  }, [])

  const loadDocProcessingStatus = async (docList: KBDocument[]) => {
    const processedIds = new Set<string>()
    const completedDocs = docList.filter(d => d.parse_status === 'completed')
    for (const doc of completedDocs) {
      try {
        const summary = await window.electronAPI.kb.getDocSummary(doc.id)
        if (summary) processedIds.add(doc.id)
      } catch {}
    }
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
        message.success('文档知识处理完成')
        setProcessedDocIds(prev => new Set(prev).add(docId))
        if (selectedKB) { loadDocs(selectedKB.id); loadKnowledgeStats(selectedKB.id); loadEntities(selectedKB.id) }
      } else {
        message.error(result.error || '处理失败')
      }
    } catch { message.error('知识处理失败') }
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
      message.success(`处理完成: 成功 ${result.success}, 失败 ${result.failed}, 跳过 ${result.skipped}`)
      loadDocs(selectedKB.id); loadKnowledgeStats(selectedKB.id); loadEntities(selectedKB.id)
    } catch { message.error('批量处理失败') }
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
        message.success('全局知识构建完成')
        loadKnowledgeStats(selectedKB.id); loadGlobalSummary(selectedKB.id); loadEntities(selectedKB.id)
      } else {
        message.error(result.error || '构建失败')
      }
    } catch { message.error('全局知识构建失败') }
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
      setDocContent(content || '文档内容为空')
      setDocContentTitle(docName)
      setDocContentModalOpen(true)
    } catch { setDocContent('获取文档内容失败') }
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
    } catch { message.error('生成时间线失败') }
  }

  const handleCreateKB = async () => {
    if (!newKBName.trim()) { message.warning('请输入知识库名称'); return }
    try {
      const result = await window.electronAPI.kb.create({ name: newKBName.trim(), description: newKBDesc.trim() })
      setKBs(prev => [result, ...prev])
      message.success('知识库创建成功')
      setCreateModalOpen(false)
      setNewKBName('')
      setNewKBDesc('')
      handleSelectKB(result)
    } catch { message.error('创建知识库失败') }
  }

  const handleDeleteKB = async (kbId: string) => {
    try {
      await window.electronAPI.kb.delete(kbId)
      setKBs(prev => prev.filter(k => k.id !== kbId))
      if (selectedKB?.id === kbId) setSelectedKB(null)
      message.success('删除成功')
    } catch { message.error('删除失败') }
  }

  const handleUploadFiles = async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: '选择文件上传到知识库',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '支持的文档', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'md', 'html', 'htm', 'png', 'jpg', 'jpeg'] }],
      })
      if (result.canceled || !result.filePaths.length || !selectedKB) return

      setUploadLoading(true)
      const uploadResult = await window.electronAPI.kb.uploadDocuments({ kb_id: selectedKB.id, paths: result.filePaths })
      setUploadLoading(false)
      if (uploadResult.imported.length > 0) { message.success(`成功上传 ${uploadResult.imported.length} 个文件`); loadDocs(selectedKB.id); loadKBs() }
      if (uploadResult.errors.length > 0) { message.warning(`${uploadResult.errors.length} 个文件上传失败`) }
    } catch { message.error('上传失败'); setUploadLoading(false) }
  }

  const handleParseDocument = async (docId: string) => {
    try {
      const result = await window.electronAPI.kb.parseDocument({ doc_id: docId })
      if (result.success) { message.success('解析成功'); if (selectedKB) loadDocs(selectedKB.id) }
      else message.error(result.error || '解析失败')
    } catch { message.error('解析失败') }
  }

  const handleParseAll = async () => {
    if (!selectedKB) return
    setParsingAll(true)
    try {
      const result = await window.electronAPI.kb.parseAll({ kb_id: selectedKB.id })
      message.success(`解析完成: 成功 ${result.success} 个, 失败 ${result.failed} 个`)
      loadDocs(selectedKB.id)
    } catch { message.error('批量解析失败') }
    finally { setParsingAll(false) }
  }

  const handleDeleteDoc = async (docId: string) => {
    try { await window.electronAPI.kb.deleteDocument(docId); if (selectedKB) { loadDocs(selectedKB.id); loadKBs() }; message.success('删除成功') }
    catch { message.error('删除失败') }
  }

  const handleLinkProject = async () => {
    if (!selectedKB) return
    try { const result = await window.electronAPI.project.list(); setAllProjects(result.projects); setLinkModalOpen(true) }
    catch { message.error('加载项目列表失败') }
  }

  const handleProjectLink = async (projectId: string) => {
    if (!selectedKB) return
    try { await window.electronAPI.kb.linkProject({ kb_id: selectedKB.id, project_id: projectId }); message.success('关联成功'); loadLinkedProjects(selectedKB.id); setLinkModalOpen(false) }
    catch { message.error('关联失败') }
  }

  const handleUnlinkProject = async (projectId: string) => {
    if (!selectedKB) return
    try { await window.electronAPI.kb.unlinkProject({ kb_id: selectedKB.id, project_id: projectId }); message.success('取消关联成功'); loadLinkedProjects(selectedKB.id) }
    catch { message.error('取消关联失败') }
  }

  const handleEditKB = () => {
    if (!selectedKB) return
    setEditKBName(selectedKB.name)
    setEditKBDesc(selectedKB.description || '')
    setEditKBModalOpen(true)
  }

  const confirmEditKB = async () => {
    if (!selectedKB || !editKBName.trim()) {
      message.error('知识库名称不能为空')
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
      message.success('知识库更新成功')
      setEditKBModalOpen(false)
    } catch {
      message.error('知识库更新失败')
    }
  }

  const pendingCount = docs.filter(d => d.parse_status === 'pending').length
  const completedCount = docs.filter(d => d.parse_status === 'completed').length
  const failedCount = docs.filter(d => d.parse_status === 'failed').length

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 24 }}>
      <PageHeader
        title="知识库管理"
        subTitle="独立于项目的知识库，可关联到多个项目共享使用"
        extra={
          <Space>
            <Button icon={<PlusOutlined />} type="primary" onClick={() => setCreateModalOpen(true)}>新建知识库</Button>
          </Space>
        }
      />

      <div style={{ flex: 1, display: 'flex', gap: 16, minHeight: 0 }}>
        <Card size="small" title={<Space><DatabaseOutlined />知识库列表</Space>}
          style={{ width: 280, flexShrink: 0 }}
          styles={{ body: { padding: 0, overflow: 'auto' } }}
        >
          {kbs.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#999' }}>
              <Empty description="暂无知识库" />
            </div>
          ) : (
            kbs.map(kb => (
              <div key={kb.id} onClick={() => handleSelectKB(kb)}
                style={{
                  padding: '12px 16px', cursor: 'pointer',
                  borderLeft: selectedKB?.id === kb.id ? '3px solid #1677ff' : '3px solid transparent',
                  background: selectedKB?.id === kb.id ? '#e6f4ff' : 'transparent',
                  borderBottom: '1px solid #f0f0f0',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <Tooltip title={kb.name} placement="topLeft">
                    <Text strong style={{ fontSize: 14, display: 'block' }} ellipsis>{kb.name}</Text>
                  </Tooltip>
                  <Popconfirm title="确认删除?" onConfirm={(e) => { e?.stopPropagation(); handleDeleteKB(kb.id) }}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }} />
                  </Popconfirm>
                </div>
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}><FileTextOutlined /> {kb.doc_count || 0} 文档</Text>
                </div>
              </div>
            ))
          )}
        </Card>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {!selectedKB ? (
            <Card>
              <Empty image={<BookOutlined style={{ fontSize: 64, color: '#d9d9d9' }} />}
                description="选择一个知识库或新建一个开始管理文档" />
              <div style={{ textAlign: 'center' }}>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>新建知识库</Button>
              </div>
            </Card>
          ) : (
            <div>
              <Card style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <Title level={4} style={{ margin: 0 }} ellipsis>{selectedKB.name}</Title>
                    <Tooltip title={selectedKB.description || '暂无描述'}>
                      <Text type="secondary" ellipsis style={{ display: 'block' }}>{selectedKB.description || '暂无描述'}</Text>
                    </Tooltip>
                  </div>
                  <Space>
                    <Tooltip title="编辑知识库信息"><Button icon={<EditOutlined />} onClick={handleEditKB}>编辑</Button></Tooltip>
                    <Tooltip title="关联到项目"><Button icon={<LinkOutlined />} onClick={handleLinkProject}>关联项目</Button></Tooltip>
                    <Button icon={<UploadOutlined />} onClick={handleUploadFiles} loading={uploadLoading} type="primary">上传文件</Button>
                  </Space>
                </div>

                {linkedProjects.length > 0 && (
                  <div style={{ marginTop: 12, padding: '8px 12px', background: '#f0f5ff', borderRadius: 8 }}>
                    <Text type="secondary">已关联项目: </Text>
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
                  label: <Space><FileTextOutlined />文档管理</Space>,
                  children: (
                    <div>
                      {(parsingAll || processingAll) && (
                        <Card size="small" style={{ marginBottom: 16, border: '1px solid #1677ff' }}>
                          <Space><Spin size="small" /><Text>{parsingAll ? '批量解析中...' : '批量知识处理中...'}</Text></Space>
                          {processProgress.stage && <Text type="secondary" style={{ marginLeft: 8 }}>{processProgress.stage}: {processProgress.detail}</Text>}
                        </Card>
                      )}
                      <Card
                        title={<Space><FileTextOutlined />文档列表 ({docs.length})</Space>}
                        extra={
                          <Space>
                            <Row gutter={12} style={{ marginBottom: 8 }}>
                              <Col><Statistic title="已解析" value={completedCount} styles={{ content: { color: '#52c41a', fontSize: 16 } }} /></Col>
                              <Col><Statistic title="待解析" value={pendingCount} styles={{ content: { color: '#faad14', fontSize: 16 } }} /></Col>
                              <Col><Statistic title="失败" value={failedCount} styles={{ content: { color: '#ff4d4f', fontSize: 16 } }} /></Col>
                            </Row>
                            {pendingCount > 0 && (
                              <Button icon={<SyncOutlined />} onClick={handleParseAll} type="primary" size="small" loading={parsingAll}>
                                全部解析 ({pendingCount})
                              </Button>
                            )}
                            {completedCount > 0 && (
                              <Button icon={<ThunderboltOutlined />} onClick={handleProcessAll} size="small" loading={processingAll}>
                                全部知识处理
                              </Button>
                            )}
                            <Button icon={<ReloadOutlined />} onClick={() => { loadDocs(selectedKB.id); loadLinkedProjects(selectedKB.id) }} size="small">刷新</Button>
                          </Space>
                        }
                      >
                        <Table
                          dataSource={docs} rowKey="id" size="small" pagination={{ pageSize: 20 }}
                          scroll={{ x: 'max-content' }}
                          columns={[
                            { title: '文件名', dataIndex: 'original_name', key: 'name', ellipsis: true,
                              render: (text: string, record: KBDocument) => (
                                <Space><FileTextOutlined style={{ color: '#1677ff' }} /><span>{text}</span><Tag style={{ fontSize: 10 }}>{record.type}</Tag></Space>
                              ),
                            },
                            { title: '大小', dataIndex: 'size', key: 'size', width: 90,
                              render: (size: number) => <Text type="secondary">{formatSize(size)}</Text>,
                            },
                            { title: '状态', dataIndex: 'parse_status', key: 'status', width: 120,
                              render: (status: string, record: KBDocument) => {
                                const config: Record<string, { color: string; text: string; icon: React.ReactNode }> = {
                                  completed: { color: 'green', text: '已解析', icon: <CheckCircleOutlined /> },
                                  pending: { color: 'orange', text: '待解析', icon: <ClockCircleOutlined /> },
                                  parsing: { color: 'blue', text: '解析中', icon: <SyncOutlined spin /> },
                                  failed: { color: 'red', text: '失败', icon: <CloseCircleOutlined /> },
                                }
                                const c = config[status] || { color: 'default', text: status, icon: null }
                                const isProcessed = status === 'completed' && processedDocIds.has(record.id)
                                return <Space size={4}>
                                  <Tag color={c.color} icon={c.icon}>{c.text}</Tag>
                                  {isProcessed && <Tag color="purple" icon={<ThunderboltOutlined />} style={{ fontSize: 10 }}>已处理</Tag>}
                                </Space>
                              },
                            },
                            { title: '操作', key: 'action', width: 200,
                              render: (_: any, record: KBDocument) => (
                                <Space size="small">
                                  {(record.parse_status === 'pending' || record.parse_status === 'failed') && (
                                    <Button type="link" size="small" onClick={() => handleParseDocument(record.id)}>解析</Button>
                                  )}
                                  {record.parse_status === 'completed' && !processedDocIds.has(record.id) && (
                                    <Button type="link" size="small" icon={<ThunderboltOutlined />}
                                      onClick={() => handleProcessDocument(record.id)} loading={processingDoc}>知识处理</Button>
                                  )}
                                  {record.parse_status === 'completed' && processedDocIds.has(record.id) && (
                                    <Button type="link" size="small" icon={<RedoOutlined />}
                                      onClick={() => handleProcessDocument(record.id)} loading={processingDoc}>重新知识处理</Button>
                                  )}
                                  <Popconfirm title="确认删除?" onConfirm={() => handleDeleteDoc(record.id)}>
                                    <Button type="link" size="small" danger>删除</Button>
                                  </Popconfirm>
                                </Space>
                              ),
                            },
                          ]}
                          locale={{ emptyText: <Empty description="上传文件到知识库" /> }}
                        />
                      </Card>
                    </div>
                  ),
                },
                {
                  key: 'knowledge',
                  label: <Space><ThunderboltOutlined />知识处理</Space>,
                  children: (
                    <div>
                      <Card style={{ marginBottom: 16 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                          <Space>
                            <ThunderboltOutlined style={{ fontSize: 20, color: '#722ed1' }} />
                            <Title level={5} style={{ margin: 0 }}>分层知识处理</Title>
                          </Space>
                          <Space>
                            <LLMSelector
                              providerId={selectedProviderId}
                              modelId={selectedModelId}
                              onProviderChange={setSelectedProviderId}
                              onModelChange={setSelectedModelId}
                            />
                            <Button icon={<ThunderboltOutlined />} onClick={handleProcessAll} loading={processingAll}>处理全部文档</Button>
                            <Button type="primary" icon={<ApartmentOutlined />} onClick={handleBuildGlobal} loading={buildingGlobal}>构建全局知识</Button>
                          </Space>
                        </div>

                        {(processingDoc || processingAll || buildingGlobal) && processProgress.stage && (
                          <Alert type="info" title={processProgress.stage} description={processProgress.detail} style={{ marginBottom: 16 }} showIcon />
                        )}

                        {knowledgeStats && (
                          <Row gutter={16} style={{ marginBottom: 16 }}>
                            <Col span={4}><Statistic title="章节" value={knowledgeStats.chapterCount} prefix={<ReadOutlined />} /></Col>
                            <Col span={4}><Statistic title="文档摘要" value={knowledgeStats.documentSummaryCount} prefix={<FileTextOutlined />} styles={{ content: { color: '#52c41a' } }} /></Col>
                            <Col span={4}><Statistic title="全局摘要" value={knowledgeStats.hasGlobalSummary ? 1 : 0} prefix={<ApartmentOutlined />} styles={{ content: { color: '#722ed1' } }} /></Col>
                            <Col span={4}><Statistic title="实体" value={knowledgeStats.entityCount} prefix={<NodeIndexOutlined />} styles={{ content: { color: '#1677ff' } }} /></Col>
                            <Col span={4}><Statistic title="关系" value={knowledgeStats.relationCount} prefix={<ApartmentOutlined />} styles={{ content: { color: '#faad14' } }} /></Col>
                          </Row>
                        )}

                        {globalSummary && (
                          <Card size="small" title={<Space><ApartmentOutlined />全局知识摘要</Space>} style={{ marginBottom: 16 }}>
                            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, maxHeight: 300, overflow: 'auto' }}>
                              {globalSummary.summary}
                            </div>
                            {globalSummary.key_topics_json && (
                              <div style={{ marginTop: 12 }}>
                                <Text type="secondary">核心主题: </Text>
                                {JSON.parse(globalSummary.key_topics_json || '[]').map((t: string) => (
                                  <Tag key={t} color="purple">{t}</Tag>
                                ))}
                              </div>
                            )}
                            {globalSummary.key_entities_json && (
                              <div style={{ marginTop: 8 }}>
                                <Text type="secondary">关键实体: </Text>
                                {JSON.parse(globalSummary.key_entities_json || '[]').slice(0, 10).map((e: any, i: number) => (
                                  <Tag key={i} color="blue">{e.name}({e.type})</Tag>
                                ))}
                              </div>
                            )}
                          </Card>
                        )}

                        {docSummaries.length > 0 && (
                          <Card size="small" title={<Space><FileTextOutlined />文档摘要 ({docSummaries.length})</Space>} style={{ marginBottom: 16 }}>
                            <Table dataSource={docSummaries} rowKey="doc_id" size="small" pagination={{ pageSize: 5 }}
                              scroll={{ x: 'max-content' }}
                              columns={[
                                { title: '文档', dataIndex: 'doc_name', key: 'doc_name', width: 200,
                                  render: (name: string, record: any) => (
                                    <Button type="link" size="small" onClick={() => handleViewChapters(record.doc_id, name)}>{name}</Button>
                                  ),
                                },
                                { title: '摘要', dataIndex: 'summary', key: 'summary', ellipsis: true,
                                  render: (summary: string) => <Text type="secondary" ellipsis={{ tooltip: summary }}>{summary}</Text>,
                                },
                                { title: '主题', dataIndex: 'topics_json', key: 'topics', width: 200,
                                  render: (json: string) => {
                                    const topics: string[] = JSON.parse(json || '[]')
                                    return <Space size={2} wrap>{topics.slice(0, 3).map(t => <Tag key={t} color="green" style={{ fontSize: 11 }}>{t}</Tag>)}</Space>
                                  },
                                },
                                { title: '操作', key: 'action', width: 180,
                                  render: (_: any, record: any) => (
                                    <Space size="small">
                                      <Button type="link" size="small" icon={<ReadOutlined />} onClick={() => handleViewChapters(record.doc_id, record.doc_name)}>章节</Button>
                                      <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewDocContent(record.doc_id, record.doc_name)}>原文</Button>
                                      <Button type="link" size="small" icon={<RedoOutlined />} onClick={() => handleProcessDocument(record.doc_id)} loading={processingDoc}>重新处理</Button>
                                    </Space>
                                  ),
                                },
                              ]}
                            />
                          </Card>
                        )}

                        {allRelations.length > 0 && (
                          <Card size="small" title={<Space><ApartmentOutlined />关系网络 ({allRelations.length})</Space>}>
                            <Table dataSource={allRelations} rowKey={(r: any) => r.id || `${r.source_entity_id}-${r.target_entity_id}-${r.relation_type}`} size="small" pagination={{ pageSize: 10 }}
                              scroll={{ x: 'max-content' }}
                              columns={[
                                { title: '源实体', dataIndex: 'source_name', key: 'source', width: 120,
                                  render: (name: string) => <Tag color="blue">{name}</Tag>,
                                },
                                { title: '关系', dataIndex: 'relation_type', key: 'relation', width: 120,
                                  render: (type: string) => <Text strong style={{ color: '#722ed1' }}>{type}</Text>,
                                },
                                { title: '目标实体', dataIndex: 'target_name', key: 'target', width: 120,
                                  render: (name: string) => <Tag color="green">{name}</Tag>,
                                },
                                { title: '描述', dataIndex: 'description', key: 'description', ellipsis: true,
                                  render: (desc: string) => <Text type="secondary" ellipsis>{desc}</Text>,
                                },
                              ]}
                            />
                          </Card>
                        )}
                      </Card>

                      <Card title={<Space><HistoryOutlined />时间线</Space>}>
                        <Space style={{ marginBottom: 16 }}>
                          <Input placeholder="输入主题筛选时间线..." value={timelineTopic}
                            onChange={e => setTimelineTopic(e.target.value)} style={{ width: 300 }}
                            onPressEnter={handleGenerateTimeline} />
                          <Button icon={<SearchOutlined />} onClick={handleGenerateTimeline} type="primary">生成时间线</Button>
                        </Space>
                        {timeline.length > 0 ? (
                          <Table dataSource={timeline} rowKey={(r: any) => `${r.time}-${r.event}`} size="small" pagination={{ pageSize: 20 }}
                            scroll={{ x: 'max-content' }}
                            columns={[
                              { title: '时间', dataIndex: 'time', key: 'time', width: 150 },
                              { title: '事件', dataIndex: 'event', key: 'event', ellipsis: true },
                              { title: '来源', dataIndex: 'source', key: 'source', width: 120, ellipsis: true },
                            ]}
                          />
                        ) : (
                          <Empty description='点击"生成时间线"查看知识库中的时间线事件' />
                        )}
                      </Card>
                    </div>
                  ),
                },
                {
                  key: 'entities',
                  label: <Space><NodeIndexOutlined />实体图谱</Space>,
                  children: (
                    <div>
                      <Card
                        title={<Space><NodeIndexOutlined />实体列表 ({entities.length})</Space>}
                        extra={
                          <Space>
                            <Select placeholder="按类型筛选" allowClear style={{ width: 140 }} value={entityFilter || undefined}
                              onChange={(v: string) => { setEntityFilter(v || ''); if (selectedKB) loadEntities(selectedKB.id, v || undefined) }}
                              options={[
                                { label: '人物', value: 'person' },
                                { label: '组织', value: 'organization' },
                                { label: '地点', value: 'location' },
                                { label: '事件', value: 'event' },
                                { label: '概念', value: 'concept' },
                                { label: '工具', value: 'tool' },
                              ]}
                            />
                            <Button icon={<ReloadOutlined />} size="small"
                              onClick={() => { if (selectedKB) loadEntities(selectedKB.id, entityFilter || undefined) }}>刷新</Button>
                          </Space>
                        }
                      >
                        {entities.length === 0 ? (
                          <Empty description="暂无实体，请先进行知识处理" />
                        ) : (
                          <Table dataSource={entities} rowKey="id" size="small" pagination={{ pageSize: 20 }}
                            scroll={{ x: 'max-content' }}
                            columns={[
                              { title: '名称', dataIndex: 'name', key: 'name', ellipsis: true, width: 160,
                                render: (name: string, record: any) => (
                                  <Button type="link" size="small" onClick={() => handleViewEntity(record)}>
                                    <NodeIndexOutlined /> {name}
                                  </Button>
                                ),
                              },
                              { title: '类型', dataIndex: 'type', key: 'type', width: 80,
                                render: (type: string) => {
                                  const colors: Record<string, string> = { person: 'blue', organization: 'green', location: 'orange', event: 'red', concept: 'purple', tool: 'cyan' }
                                  return <Tag color={colors[type] || 'default'}>{type}</Tag>
                                },
                              },
                              { title: '描述', dataIndex: 'description', key: 'description', ellipsis: true,
                              },
                              { title: '提及次数', dataIndex: 'mention_count', key: 'mention_count', width: 90,
                                render: (count: number) => <Tag>{count}</Tag>,
                              },
                              { title: '别名', dataIndex: 'aliases_json', key: 'aliases', width: 150,
                                render: (json: string) => {
                                  const aliases: string[] = JSON.parse(json || '[]')
                                  return <Space size={2} wrap>{aliases.slice(0, 3).map(a => <Tag key={a} style={{ fontSize: 11 }}>{a}</Tag>)}</Space>
                                },
                              },
                              { title: '操作', key: 'action', width: 60,
                                render: (_: any, record: any) => (
                                  <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewEntity(record)}>详情</Button>
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

      <Modal title="新建知识库" open={createModalOpen} onOk={handleCreateKB} onCancel={() => setCreateModalOpen(false)} okText="创建" cancelText="取消">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0' }}>
          <div><Text strong>知识库名称</Text>
            <Input placeholder="例如：合同知识库" value={newKBName} onChange={e => setNewKBName(e.target.value)} onPressEnter={handleCreateKB} style={{ marginTop: 8 }} />
          </div>
          <div><Text strong>描述（选填）</Text>
            <Input.TextArea placeholder="描述该知识库包含的内容..." value={newKBDesc} onChange={e => setNewKBDesc(e.target.value)} rows={3} style={{ marginTop: 8 }} />
          </div>
        </div>
      </Modal>

      <Modal title="关联到项目" open={linkModalOpen} onCancel={() => setLinkModalOpen(false)} footer={null}>
        <div>
          {allProjects.map((project: any) => (
            <div
              key={project.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 0',
                borderBottom: '1px solid #f0f0f0',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 8,
                    background: '#e6f4ff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <FolderOpenOutlined style={{ color: '#1677ff' }} />
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
                <Tag color="green">已关联</Tag>
              ) : (
                <Button type="link" onClick={() => handleProjectLink(project.id)}>关联</Button>
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
              <Tag>提及 {selectedEntity.mention_count} 次</Tag>
              {JSON.parse(selectedEntity.aliases_json || '[]').map((a: string) => (
                <Tag key={a} style={{ fontSize: 11 }}>别名: {a}</Tag>
              ))}
            </Space>
            {selectedEntity.description && (
              <Card size="small" title="描述" style={{ marginBottom: 16 }}>
                <Text>{selectedEntity.description}</Text>
              </Card>
            )}
            {entityRelations.length > 0 && (
              <Card size="small" title={<Space><ApartmentOutlined />关系网络</Space>}>
                <Table dataSource={entityRelations} rowKey="id" size="small" pagination={false}
                  columns={[
                    { title: '方向', key: 'direction', width: 50,
                      render: (_: any, record: any) => record.source_entity_id === selectedEntity.id ? '→' : '←',
                    },
                    { title: '关联实体', key: 'related', width: 150,
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
                    { title: '类型', key: 'related_type', width: 80,
                      render: (_: any, record: any) => {
                        const isSource = record.source_entity_id === selectedEntity.id
                        const type = isSource ? record.target_type : record.source_type
                        return <Tag>{type}</Tag>
                      },
                    },
                    { title: '关系', dataIndex: 'relation_type', key: 'relation_type', width: 120 },
                    { title: '描述', dataIndex: 'description', key: 'description',
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
        title={<Space><ReadOutlined />{selectedDocSummary} - 章节列表</Space>}
        open={chapterModalOpen}
        onCancel={() => setChapterModalOpen(false)}
        footer={null}
        width={800}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        {docChapters.length > 0 ? (
          <Table dataSource={docChapters} rowKey="id" size="small" pagination={false}
            columns={[
              { title: '章节', dataIndex: 'title', key: 'title', width: 200,
                render: (title: string) => <Text strong>{title}</Text>,
              },
              { title: '摘要', dataIndex: 'summary', key: 'summary',
                render: (summary: string) => <Text type="secondary" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{summary || '无摘要'}</Text>,
              },
              { title: '关键词', dataIndex: 'keywords_json', key: 'keywords', width: 200,
                render: (json: string) => {
                  const keywords: string[] = JSON.parse(json || '[]')
                  return <Space size={2} wrap>{keywords.map(k => <Tag key={k} style={{ fontSize: 11 }}>{k}</Tag>)}</Space>
                },
              },
              { title: '实体', dataIndex: 'entities_json', key: 'entities', width: 200,
                render: (json: string) => {
                  const entities: any[] = JSON.parse(json || '[]')
                  return <Space size={2} wrap>{entities.slice(0, 5).map((e, i) => <Tag key={i} color="blue" style={{ fontSize: 11 }}>{e.name}({e.type})</Tag>)}</Space>
                },
              },
            ]}
          />
        ) : (
          <Empty description="暂无章节数据" />
        )}
      </Modal>

      <Modal
        title={<Space><FileTextOutlined />{docContentTitle} - 原始文档</Space>}
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
        title="编辑知识库信息"
        open={editKBModalOpen}
        onOk={confirmEditKB}
        onCancel={() => setEditKBModalOpen(false)}
        okText="保存"
        cancelText="取消"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>知识库名称</Text>
            <Input
              placeholder="请输入知识库名称"
              value={editKBName}
              onChange={(e) => setEditKBName(e.target.value)}
            />
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>知识库简介</Text>
            <Input.TextArea
              placeholder="请输入知识库简介"
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
