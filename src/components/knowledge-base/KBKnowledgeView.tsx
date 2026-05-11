import { useTranslation } from 'react-i18next'
import {
  Card, Typography, Space, Table, Tag, Button, Modal,
  Empty, Statistic, Row, Col, Alert, Input, theme,
} from 'antd'
import {
  FileTextOutlined, ThunderboltOutlined, ApartmentOutlined,
  NodeIndexOutlined, ReadOutlined, HistoryOutlined,
  SearchOutlined, RedoOutlined, EyeOutlined,
} from '@ant-design/icons'
import LLMSelector from '../llm/LLMSelector'

const { Text } = Typography

interface KBKnowledgeViewProps {
  knowledgeStats: any
  globalSummary: any
  docSummaries: any[]
  allRelations: any[]
  timeline: any[]
  timelineTopic: string
  processingDoc: boolean
  processingAll: boolean
  buildingGlobal: boolean
  processProgress: { stage: string; detail: string }
  selectedProviderId: string
  selectedModelId: string
  onProviderChange: (id: string) => void
  onModelChange: (id: string) => void
  onProcessAll: () => void
  onBuildGlobal: () => void
  onProcessDocument: (docId: string) => void
  onViewChapters: (docId: string, docName: string) => void
  onViewDocContent: (docId: string, docName: string) => void
  onGenerateTimeline: () => void
  onTimelineTopicChange: (topic: string) => void
  docChapters: any[]
  chapterModalOpen: boolean
  selectedDocSummary: string | null
  onCloseChapterModal: () => void
  docContent: string
  docContentTitle: string
  docContentModalOpen: boolean
  onCloseDocContentModal: () => void
}

const KBKnowledgeView: React.FC<KBKnowledgeViewProps> = ({
  knowledgeStats, globalSummary, docSummaries, allRelations,
  timeline, timelineTopic, processingDoc, processingAll,
  buildingGlobal, processProgress, selectedProviderId,
  selectedModelId, onProviderChange, onModelChange,
  onProcessAll, onBuildGlobal, onProcessDocument,
  onViewChapters, onViewDocContent, onGenerateTimeline,
  onTimelineTopicChange, docChapters, chapterModalOpen,
  selectedDocSummary, onCloseChapterModal, docContent,
  docContentTitle, docContentModalOpen, onCloseDocContentModal,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Space>
            <ThunderboltOutlined style={{ fontSize: 20, color: '#722ed1' }} />
            <Typography.Title level={5} style={{ margin: 0 }}>{t('knowledgeBase.layeredKnowledge')}</Typography.Title>
          </Space>
          <Space>
            <LLMSelector
              providerId={selectedProviderId}
              modelId={selectedModelId}
              onProviderChange={onProviderChange}
              onModelChange={onModelChange}
            />
            <Button icon={<ThunderboltOutlined />} onClick={onProcessAll} loading={processingAll}>{t('knowledgeBase.processAllDocs')}</Button>
            <Button type="primary" icon={<ApartmentOutlined />} onClick={onBuildGlobal} loading={buildingGlobal}>{t('knowledgeBase.buildGlobalKnowledge')}</Button>
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
                      <Button type="link" size="small" icon={<RedoOutlined />} onClick={() => onProcessDocument(record.doc_id)} loading={processingDoc}>{t('knowledgeBase.reprocess')}</Button>
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
            onChange={e => onTimelineTopicChange(e.target.value)} style={{ width: 300 }}
            onPressEnter={onGenerateTimeline} />
          <Button icon={<SearchOutlined />} onClick={onGenerateTimeline} type="primary">{t('knowledgeBase.generateTimeline')}</Button>
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
