import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Typography, Space, Table, Tag, Button, Modal,
  Empty, Statistic, Row, Col, Alert, theme, Tooltip, message,
} from 'antd'
import {
  FileTextOutlined, ThunderboltOutlined, ApartmentOutlined,
  NodeIndexOutlined, ReadOutlined, RedoOutlined, EyeOutlined,
  InfoCircleOutlined, DatabaseOutlined, ReloadOutlined,
} from '@ant-design/icons'


const { Text } = Typography

interface KBKnowledgeViewProps {
  knowledgeStats: any
  globalSummary: any
  docSummaries: any[]
  allRelations: any[]
  processingDocId: string | null
  processingAll: boolean
  buildingGlobal: boolean
  processProgress: { stage: string; detail: string }
  selectedKbId: string

  onProcessAll: () => void
  onBuildGlobal: () => void
  onProcessDocument: (docId: string) => void
  onViewChapters: (docId: string, docName: string) => void
  onViewDocContent: (docId: string, docName: string) => void
  docChapters: any[]
  chapterModalOpen: boolean
  selectedDocSummary: string | null
  onCloseChapterModal: () => void
  docContent: string
  docContentTitle: string
  docContentModalOpen: boolean
  onCloseDocContentModal: () => void
  onViewParseDetail?: (docId: string, docName: string) => void
}

const KBKnowledgeView: React.FC<KBKnowledgeViewProps> = ({
  knowledgeStats, globalSummary, docSummaries, allRelations,
  processingDocId, processingAll, buildingGlobal, processProgress,
  selectedKbId,
  onProcessAll, onBuildGlobal, onProcessDocument,
  onViewChapters, onViewDocContent,
  docChapters, chapterModalOpen, selectedDocSummary, onCloseChapterModal,
  docContent, docContentTitle, docContentModalOpen, onCloseDocContentModal,
  onViewParseDetail,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [searchIndexStats, setSearchIndexStats] = React.useState<any>(null)
  const [rebuildingIndex, setRebuildingIndex] = React.useState(false)

  React.useEffect(() => {
    if (selectedKbId) {
      window.electronAPI.kb.searchIndexStats(selectedKbId).then((stats: any) => {
        setSearchIndexStats(stats)
      }).catch(() => {})
    }
  }, [selectedKbId, knowledgeStats])

  const handleRebuildIndex = async () => {
    if (!selectedKbId) return
    setRebuildingIndex(true)
    try {
      await window.electronAPI.kb.rebuildSearchIndex(selectedKbId)
      const stats = await window.electronAPI.kb.searchIndexStats(selectedKbId)
      setSearchIndexStats(stats)
      message.success(t('knowledgeBase.rebuildIndexSuccess'))
    } catch {
      message.error(t('knowledgeBase.rebuildIndexFailed'))
    } finally {
      setRebuildingIndex(false)
    }
  }

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Space>
            <ThunderboltOutlined style={{ fontSize: 20, color: '#722ed1' }} />
            <Typography.Title level={5} style={{ margin: 0 }}>{t('knowledgeBase.layeredKnowledge')}</Typography.Title>
          </Space>
          <Space>
            <Button icon={<ThunderboltOutlined />} onClick={onProcessAll} loading={processingAll}>{t('knowledgeBase.processAllDocs')}</Button>
            <Button type="primary" icon={<ApartmentOutlined />} onClick={onBuildGlobal} loading={buildingGlobal}>{t('knowledgeBase.buildGlobalKnowledge')}</Button>
          </Space>
        </div>

        {(processingAll || buildingGlobal) && processProgress.stage && (
          <Alert
            type="info"
            title={processProgress.stage}
            description={processProgress.detail}
            style={{ marginBottom: 16 }}
            showIcon
            action={
              onViewParseDetail && processingDocId ? (
                <Button size="small" icon={<InfoCircleOutlined />} onClick={() => {
                  const doc = docSummaries.find((d: any) => d.doc_id === processingDocId)
                  onViewParseDetail(processingDocId, doc?.doc_name || '')
                }}>
                  {t('parseProgress.detail')}
                </Button>
              ) : undefined
            }
          />
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

        {searchIndexStats && (
          <Card size="small" style={{ marginBottom: 16 }} title={
            <Space>
              <DatabaseOutlined style={{ color: token.colorPrimary }} />
              <span>{t('knowledgeBase.searchIndexTitle')}</span>
            </Space>
          } extra={
            <Tooltip title={t('knowledgeBase.rebuildIndexTip')}>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={handleRebuildIndex}
                loading={rebuildingIndex}
              >
                {t('knowledgeBase.rebuildIndex')}
              </Button>
            </Tooltip>
          }>
            <Row gutter={16}>
              <Col span={6}>
                <Statistic
                  title={t('knowledgeBase.indexEntries')}
                  value={searchIndexStats.totalEntries}
                  prefix={<DatabaseOutlined />}
                  styles={{ content: { color: token.colorPrimary, fontSize: 20 } }}
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title={t('knowledgeBase.embeddingCount')}
                  value={searchIndexStats.embeddingCount}
                  prefix={<ApartmentOutlined />}
                  styles={{ content: { color: '#722ed1', fontSize: 20 } }}
                />
              </Col>
              <Col span={12}>
                <Space size={4} wrap>
                  {Object.entries(searchIndexStats.byType || {}).map(([type, count]: [string, any]) => {
                    const labelMap: Record<string, string> = {
                      document_title: t('knowledgeBase.indexTypeDocTitle'),
                      document_summary: t('knowledgeBase.indexTypeDocSummary'),
                      chapter: t('knowledgeBase.indexTypeChapter'),
                      entity: t('knowledgeBase.indexTypeEntity'),
                      content_paragraph: t('knowledgeBase.indexTypeContent'),
                    }
                    return <Tag key={type} color="blue">{labelMap[type] || type}: {count}</Tag>
                  })}
                </Space>
              </Col>
            </Row>
          </Card>
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
                    <Button type="link" size="small" onClick={() => onViewChapters(record.doc_id, name)}>{name}</Button>
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
                      <Button type="link" size="small" icon={<ReadOutlined />} onClick={() => onViewChapters(record.doc_id, record.doc_name)}>{t('knowledgeBase.chaptersBtn')}</Button>
                      <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => onViewDocContent(record.doc_id, record.doc_name)}>{t('knowledgeBase.original')}</Button>
                      <Button type="link" size="small" icon={<RedoOutlined />} onClick={() => onProcessDocument(record.doc_id)} loading={processingDocId === record.doc_id}>{t('knowledgeBase.reprocess')}</Button>
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

      <Modal
        title={<Space><ReadOutlined />{selectedDocSummary} - {t('knowledgeBase.chapterList')}</Space>}
        open={chapterModalOpen}
        onCancel={onCloseChapterModal}
        footer={null}
        width={800}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        {docChapters.length > 0 ? (
          <Table dataSource={docChapters} rowKey="id" size="small" pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: t('knowledgeBase.chapters'), dataIndex: 'title', key: 'title', width: 200,
                render: (title: string) => <Text strong>{title}</Text>,
              },
              { title: t('knowledgeBase.summary'), dataIndex: 'summary', key: 'summary', width: 350,
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
        onCancel={onCloseDocContentModal}
        footer={null}
        width={800}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, fontSize: 13 }}>
          {docContent}
        </div>
      </Modal>
    </div>
  )
}

export default KBKnowledgeView
