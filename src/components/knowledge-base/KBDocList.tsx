import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Typography, Space, Table, Tag, Button,
  Popconfirm, Empty, Statistic, Row, Col,
  Tooltip, Dropdown, theme, message, Progress,
} from 'antd'
import {
  FileTextOutlined, SyncOutlined, ThunderboltOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined,
  ReloadOutlined, RedoOutlined, PauseOutlined, CaretRightOutlined,
  DownOutlined, PauseCircleOutlined, PlayCircleOutlined,
  StopOutlined, ApartmentOutlined,
  ReadOutlined, DatabaseOutlined,
} from '@ant-design/icons'
import { formatFileSize } from '../../utils/format'

const { Text } = Typography

interface KBDocument {
  id: string
  kb_id: string
  original_name: string
  type: string
  size: number
  hash: string
  parse_status: 'pending' | 'parsing' | 'paused' | 'completed' | 'failed'
  parse_error?: string
  is_reused?: number
  created_at: number
}

interface KBDocListProps {
  docs: KBDocument[]
  parsingAll: boolean
  processingAll: boolean
  buildingGlobal: boolean
  completedCount: number
  pendingCount: number
  failedCount: number
  pausedCount: number
  processedDocIds: Set<string>
  processingDocId: string | null
  docProcessProgress: Record<string, { progress: number; status: string; progressText: string }>
  knowledgeStats: any
  globalSummary: any
  selectedKbId: string
  onParseAll: () => void
  onParseDocument: (docId: string) => void
  onProcessDocument: (docId: string) => void
  onProcessAll: () => void
  onBuildGlobal: () => void
  onDeleteDoc: (docId: string) => void
  onRefresh: () => void
  onPauseParse: (docId: string) => void
  onResumeParse: (docId: string) => void
  onRetryParse: (docId: string) => void
  onPauseAll: () => void
  onResumeAll: () => void
  onCancelAll: () => void
}

const KBDocList: React.FC<KBDocListProps> = ({
  docs, parsingAll, processingAll, buildingGlobal,
  completedCount, pendingCount, failedCount, pausedCount,
  processedDocIds, processingDocId, docProcessProgress, knowledgeStats, globalSummary, selectedKbId,
  onParseAll, onParseDocument, onProcessDocument, onProcessAll, onBuildGlobal,
  onDeleteDoc, onRefresh, onPauseParse, onResumeParse, onRetryParse,
  onPauseAll, onResumeAll, onCancelAll,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const statusConfig: Record<string, { color: string; textKey: string; icon: React.ReactNode }> = {
    completed: { color: 'green', textKey: 'knowledgeBase.parsed', icon: <CheckCircleOutlined /> },
    pending: { color: 'orange', textKey: 'knowledgeBase.pending', icon: <ClockCircleOutlined /> },
    parsing: { color: 'blue', textKey: 'knowledgeBase.parsing', icon: <SyncOutlined spin /> },
    paused: { color: 'gold', textKey: 'parseProgress.paused', icon: <PauseCircleOutlined /> },
    failed: { color: 'red', textKey: 'knowledgeBase.failed', icon: <CloseCircleOutlined /> },
  }

  const hasActiveTasks = docs.some(d => d.parse_status === 'parsing' || d.parse_status === 'paused')

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

        {knowledgeStats && (
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}><Statistic title={t('knowledgeBase.paragraphs')} value={knowledgeStats.paragraphCount} prefix={<ReadOutlined />} /></Col>
            <Col span={8}><Statistic title={t('knowledgeBase.docSummaries')} value={knowledgeStats.documentSummaryCount} prefix={<FileTextOutlined />} styles={{ content: { color: token.colorSuccess } }} /></Col>
            <Col span={8}><Statistic title={t('knowledgeBase.globalSummary')} value={knowledgeStats.hasGlobalSummary ? 1 : 0} prefix={<ApartmentOutlined />} styles={{ content: { color: '#722ed1' } }} /></Col>
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
                      paragraph: t('knowledgeBase.indexTypeParagraph'),
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
          <Card size="small" title={<Space><ApartmentOutlined />{t('knowledgeBase.globalKnowledgeSummary')}</Space>} style={{ marginBottom: 0 }}>
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
          </Card>
        )}
      </Card>

      <Card
        title={<Space><FileTextOutlined />{t('knowledgeBase.docList')} ({docs.length})</Space>}
        extra={
          <Space>
            <Row gutter={12} style={{ marginBottom: 8 }}>
              <Col><Statistic title={t('knowledgeBase.parsed')} value={completedCount} styles={{ content: { color: token.colorSuccess, fontSize: 16 } }} /></Col>
              <Col><Statistic title={t('knowledgeBase.pending')} value={pendingCount} styles={{ content: { color: token.colorWarning, fontSize: 16 } }} /></Col>
              <Col><Statistic title={t('parseProgress.paused')} value={pausedCount} styles={{ content: { color: token.colorWarning, fontSize: 16 } }} /></Col>
              <Col><Statistic title={t('knowledgeBase.failed')} value={failedCount} styles={{ content: { color: token.colorError, fontSize: 16 } }} /></Col>
            </Row>
            {hasActiveTasks && (
              <Dropdown menu={{
                items: [
                  { key: 'pauseAll', icon: <PauseCircleOutlined />, label: t('parseProgress.pauseAll'), onClick: onPauseAll },
                  { key: 'resumeAll', icon: <PlayCircleOutlined />, label: t('parseProgress.resumeAll'), onClick: onResumeAll },
                  { type: 'divider' as const },
                  { key: 'cancelAll', icon: <StopOutlined />, label: t('parseProgress.cancelAll'), danger: true, onClick: onCancelAll },
                ],
              }}>
                <Button size="small">{t('parseProgress.batchOps')} <DownOutlined /></Button>
              </Dropdown>
            )}
            {pendingCount > 0 && (
              <Button icon={<SyncOutlined />} onClick={onParseAll} type="primary" size="small" loading={parsingAll}>
                {t('knowledgeBase.parseAll', { count: pendingCount })}
              </Button>
            )}
            <Button icon={<ReloadOutlined />} onClick={onRefresh} size="small">{t('common.refresh')}</Button>
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
            { title: t('common.status'), dataIndex: 'parse_status', key: 'status', width: 200,
              render: (status: string, record: KBDocument) => {
                const c = statusConfig[status] || { color: 'default', textKey: status, icon: null }
                const isProcessed = status === 'completed' && processedDocIds.has(record.id)
                const processProgress = docProcessProgress[record.id]
                const isPending = processProgress?.status === 'pending'
                const isRunning = processProgress?.status === 'running' || processProgress?.status === 'paused'
                return (
                  <Space size={4} direction="vertical" style={{ width: '100%' }}>
                    <Space size={4}>
                      <Tag color={c.color} icon={c.icon}>{t(c.textKey)}</Tag>
                      {isProcessed && <Tag color="purple" icon={<ThunderboltOutlined />} style={{ fontSize: 10 }}>{t('knowledgeBase.processed')}</Tag>}
                      {isRunning && (
                        <Tag color="processing" icon={<ThunderboltOutlined />} style={{ fontSize: 10 }}>
                          {t('knowledgeBase.processing')}
                        </Tag>
                      )}
                      {isPending && (
                        <Tag color="default" icon={<ClockCircleOutlined />} style={{ fontSize: 10 }}>
                          {t('knowledgeBase.queued')}
                        </Tag>
                      )}
                    </Space>
                    {isRunning && processProgress.progress > 0 && (
                      <Progress
                        percent={processProgress.progress}
                        size="small"
                        status={processProgress.status === 'paused' ? 'normal' : 'active'}
                        style={{ marginBottom: 0, marginTop: 0, width: '100%' }}
                      />
                    )}
                  </Space>
                )
              },
            },
            { title: t('common.action'), key: 'action', width: 280,
              render: (_: any, record: KBDocument) => {
                const isProcessing = processingDocId === record.id
                return (
                  <Space size="small" wrap>
                    {record.parse_status === 'pending' && !isProcessing && (
                      <Button type="link" size="small" onClick={() => onParseDocument(record.id)}>{t('knowledgeBase.parse')}</Button>
                    )}
                    {record.parse_status === 'parsing' && (
                      <Button type="link" size="small" icon={<PauseOutlined />} onClick={() => onPauseParse(record.id)}>{t('parseProgress.pause')}</Button>
                    )}
                    {record.parse_status === 'paused' && !isProcessing && (
                      <Button type="link" size="small" icon={<CaretRightOutlined />} onClick={() => onResumeParse(record.id)} style={{ color: token.colorSuccess }}>{t('parseProgress.resume')}</Button>
                    )}
                    {record.parse_status === 'failed' && !isProcessing && (
                      <>
                        <Tooltip title={record.parse_error}>
                          <Button type="link" size="small" icon={<CloseCircleOutlined />} danger>{t('parseProgress.viewError')}</Button>
                        </Tooltip>
                        <Button type="link" size="small" icon={<RedoOutlined />} onClick={() => onRetryParse(record.id)}>{t('parseProgress.retry')}</Button>
                      </>
                    )}
                    {record.parse_status === 'completed' && !processedDocIds.has(record.id) && !isProcessing && (
                      <Button type="link" size="small" icon={<ThunderboltOutlined />}
                        onClick={() => onProcessDocument(record.id)} loading={isProcessing}>{t('knowledgeBase.knowledgeProcess')}</Button>
                    )}
                    {record.parse_status === 'completed' && processedDocIds.has(record.id) && !isProcessing && (
                      <Button type="link" size="small" icon={<RedoOutlined />}
                        onClick={() => onProcessDocument(record.id)} loading={isProcessing}>{t('knowledgeBase.reKnowledgeProcess')}</Button>
                    )}
                    <Popconfirm title={t('knowledgeBase.confirmDelete')} onConfirm={() => onDeleteDoc(record.id)}>
                      <Button type="link" size="small" danger>{t('common.delete')}</Button>
                    </Popconfirm>
                  </Space>
                )
              },
            },
          ]}
          locale={{ emptyText: <Empty description={t('knowledgeBase.uploadToKb')} /> }}
        />
      </Card>
    </div>
  )
}

export default KBDocList
