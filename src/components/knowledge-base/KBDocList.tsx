import { useTranslation } from 'react-i18next'
import {
  Card, Typography, Space, Table, Tag, Button,
  Popconfirm, Empty, Statistic, Row, Col, Spin, theme,
} from 'antd'
import {
  FileTextOutlined, SyncOutlined, ThunderboltOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined,
  ReloadOutlined, RedoOutlined,
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
  parse_status: 'pending' | 'parsing' | 'completed' | 'failed'
  parse_error?: string
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
  processedDocIds: Set<string>
  processingDoc: boolean
  onParseAll: () => void
  onProcessAll: () => void
  onParseDocument: (docId: string) => void
  onProcessDocument: (docId: string) => void
  onDeleteDoc: (docId: string) => void
  onRefresh: () => void
}

const KBDocList: React.FC<KBDocListProps> = ({
  docs, parsingAll, processingAll, processProgress,
  completedCount, pendingCount, failedCount, processedDocIds,
  processingDoc, onParseAll, onProcessAll, onParseDocument,
  onProcessDocument, onDeleteDoc, onRefresh,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
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
              <Button icon={<SyncOutlined />} onClick={onParseAll} type="primary" size="small" loading={parsingAll}>
                {t('knowledgeBase.parseAll', { count: pendingCount })}
              </Button>
            )}
            {completedCount > 0 && (
              <Button icon={<ThunderboltOutlined />} onClick={onProcessAll} size="small" loading={processingAll}>
                {t('knowledgeBase.knowledgeProcessAll')}
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
                    <Button type="link" size="small" onClick={() => onParseDocument(record.id)}>{t('knowledgeBase.parse')}</Button>
                  )}
                  {record.parse_status === 'completed' && !processedDocIds.has(record.id) && (
                    <Button type="link" size="small" icon={<ThunderboltOutlined />}
                      onClick={() => onProcessDocument(record.id)} loading={processingDoc}>{t('knowledgeBase.knowledgeProcess')}</Button>
                  )}
                  {record.parse_status === 'completed' && processedDocIds.has(record.id) && (
                    <Button type="link" size="small" icon={<RedoOutlined />}
                      onClick={() => onProcessDocument(record.id)} loading={processingDoc}>{t('knowledgeBase.reKnowledgeProcess')}</Button>
                  )}
                  <Popconfirm title={t('knowledgeBase.confirmDelete')} onConfirm={() => onDeleteDoc(record.id)}>
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
  )
}

export default KBDocList
