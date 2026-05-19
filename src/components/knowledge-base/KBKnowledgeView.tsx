import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Typography, Space, Tag, Button,
  Statistic, Row, Col, Alert, theme, Tooltip, message,
} from 'antd'
import {
  FileTextOutlined, ThunderboltOutlined, ApartmentOutlined,
  ReadOutlined,
  InfoCircleOutlined, DatabaseOutlined, ReloadOutlined,
} from '@ant-design/icons'


const { Text } = Typography

interface KBKnowledgeViewProps {
  knowledgeStats: any
  globalSummary: any
  processingDocId: string | null
  processingAll: boolean
  buildingGlobal: boolean
  processProgress: { stage: string; detail: string }
  selectedKbId: string

  onProcessAll: () => void
  onBuildGlobal: () => void
  onViewParseDetail?: (docId: string, docName: string) => void
}

const KBKnowledgeView: React.FC<KBKnowledgeViewProps> = ({
  knowledgeStats, globalSummary,
  processingDocId, processingAll, buildingGlobal, processProgress,
  selectedKbId,
  onProcessAll, onBuildGlobal,
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
                  onViewParseDetail(processingDocId, '')
                }}>
                  {t('parseProgress.detail')}
                </Button>
              ) : undefined
            }
          />
        )}

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
          </Card>
        )}

      </Card>
    </div>
  )
}

export default KBKnowledgeView
