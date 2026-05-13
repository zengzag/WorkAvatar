import { useTranslation } from 'react-i18next'
import {
  Card, Typography, Space, Table, Tag, Button,
  Popconfirm, Empty, Statistic, Row, Col, Spin, Progress,
  Tooltip, Dropdown, theme,
} from 'antd'
import {
  FileTextOutlined, SyncOutlined, ThunderboltOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined,
  ReloadOutlined, RedoOutlined, PauseOutlined, CaretRightOutlined,
  DownOutlined, PauseCircleOutlined, PlayCircleOutlined,
  StopOutlined, InfoCircleOutlined,
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

interface KBDocListProps {
  docs: KBDocument[]
  parsingAll: boolean
  processingAll: boolean
  processProgress: { stage: string; detail: string }
  completedCount: number
  pendingCount: number
  failedCount: number
  pausedCount: number
  processedDocIds: Set<string>
  processingDocId: string | null
  onParseAll: () => void
  onParseDocument: (docId: string) => void
  onProcessDocument: (docId: string) => void
  onDeleteDoc: (docId: string) => void
  onRefresh: () => void
  onPauseParse: (docId: string) => void
  onResumeParse: (docId: string) => void
  onRetryParse: (docId: string) => void
  onPauseAll: () => void
  onResumeAll: () => void
  onCancelAll: () => void
  onViewDetail: (docId: string, docName: string) => void
}

const KBDocList: React.FC<KBDocListProps> = ({
  docs, parsingAll, processingAll, processProgress,
  completedCount, pendingCount, failedCount, pausedCount,
  processedDocIds, processingDocId, onParseAll,
  onParseDocument, onProcessDocument, onDeleteDoc, onRefresh,
  onPauseParse, onResumeParse, onRetryParse,
  onPauseAll, onResumeAll, onCancelAll, onViewDetail,
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

  return (
    <div>
      {(parsingAll || processingAll) && (
        <Card size="small" style={{ marginBottom: 16, border: `1px solid ${token.colorPrimary}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <Space>
              <Spin size="small" />
              <Text strong>{parsingAll ? t('knowledgeBase.batchParsing') : t('knowledgeBase.batchKnowledgeProcessing')}</Text>
              {processProgress.stage && <Text type="secondary">{processProgress.stage}: {processProgress.detail}</Text>}
            </Space>
            {parsingAll && (() => {
              const activeDocs = docs.filter(d => d.parse_status === 'parsing')
              return activeDocs.length > 0 ? (
                <Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('parseProgress.currentDoc')}:</Text>
                  {activeDocs.map(doc => (
                    <Button key={doc.id} size="small" icon={<InfoCircleOutlined />} onClick={() => onViewDetail(doc.id, doc.original_name)}>
                      {doc.original_name.length > 20 ? doc.original_name.substring(0, 20) + '...' : doc.original_name}
                    </Button>
                  ))}
                </Space>
              ) : null
            })()}
            {processingAll && processingDocId && (() => {
              const procDoc = docs.find(d => d.id === processingDocId)
              return procDoc ? (
                <Button size="small" icon={<InfoCircleOutlined />} onClick={() => onViewDetail(procDoc.id, procDoc.original_name)}>
                  {t('parseProgress.detail')}
                </Button>
              ) : null
            })()}
          </div>
        </Card>
      )}
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
                const isUpToDate = status === 'completed' && !!record.is_reused
                return (
                  <Space orientation="vertical" size={2} style={{ width: '100%' }}>
                    <Space size={4}>
                      <Tag color={c.color} icon={c.icon}>{t(c.textKey)}</Tag>
                      {isUpToDate && <Tag color="cyan" style={{ fontSize: 10 }}>{t('parseProgress.upToDate')}</Tag>}
                      {isProcessed && !isUpToDate && <Tag color="purple" icon={<ThunderboltOutlined />} style={{ fontSize: 10 }}>{t('knowledgeBase.processed')}</Tag>}
                    </Space>
                    {(status === 'parsing' || status === 'paused') && (record.parse_progress ?? 0) > 0 && (
                      <Progress
                        percent={Math.round(record.parse_progress || 0)}
                        size="small"
                        status={status === 'paused' ? 'normal' : 'active'}
                        strokeColor={status === 'paused' ? token.colorWarning : undefined}
                        style={{ margin: 0, width: '100%' }}
                      />
                    )}
                    {record.parse_detail && (status === 'parsing' || status === 'paused') && (
                      <Text type="secondary" style={{ fontSize: 11 }}>{record.parse_detail}</Text>
                    )}
                  </Space>
                )
              },
            },
            { title: t('common.action'), key: 'action', width: 320,
              render: (_: any, record: KBDocument) => {
                const isProcessing = processingDocId === record.id
                return (
                  <Space size="small" wrap>
                    {record.parse_status === 'pending' && !isProcessing && (
                      <Button type="link" size="small" onClick={() => onParseDocument(record.id)}>{t('knowledgeBase.parse')}</Button>
                    )}
                    {(record.parse_status === 'parsing' || (record.parse_status === 'completed' && isProcessing)) && (
                      <>
                        {record.parse_status === 'parsing' && (
                          <Button type="link" size="small" icon={<PauseOutlined />} onClick={() => onPauseParse(record.id)}>{t('parseProgress.pause')}</Button>
                        )}
                        <Button type="link" size="small" icon={<InfoCircleOutlined />} onClick={() => onViewDetail(record.id, record.original_name)}>{t('parseProgress.detail')}</Button>
                      </>
                    )}
                    {record.parse_status === 'paused' && !isProcessing && (
                      <>
                        <Button type="link" size="small" icon={<CaretRightOutlined />} onClick={() => onResumeParse(record.id)} style={{ color: token.colorSuccess }}>{t('parseProgress.resume')}</Button>
                        <Button type="link" size="small" icon={<InfoCircleOutlined />} onClick={() => onViewDetail(record.id, record.original_name)}>{t('parseProgress.detail')}</Button>
                      </>
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
