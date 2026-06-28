import React, { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Space, Typography, Tag, Empty, Spin, Tooltip, Button, Modal, theme,
} from 'antd'
import {
  HistoryOutlined, DeleteOutlined, EyeOutlined, RobotOutlined, SearchOutlined,
  FileTextOutlined, FilePdfOutlined, FileExcelOutlined, FileWordOutlined,
  FileMarkdownOutlined, FileOutlined, CodeOutlined, FolderOpenOutlined,
  BulbOutlined, CompressOutlined, RiseOutlined, AimOutlined, ReloadOutlined,
} from '@ant-design/icons'
import HighlightText from './HighlightText'
import type { SearchHistoryItem, AgentSearchResult, AgentSearchSource } from '../../hooks/useKMS'

const { Text, Paragraph } = Typography

interface KMSHistoryViewProps {
  history: SearchHistoryItem[]
  onLoadHistory: (params?: { limit?: number; searchMode?: string }) => void
  onGetDetail: (id: string) => Promise<any>
  onDelete: (id: string) => void
  onClear: (searchMode?: string) => void
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
  onPreview: (result: any) => void
}

const QUERY_TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode; labelKey: string }> = {
  locate: { color: 'blue', icon: <AimOutlined />, labelKey: 'kms.queryTypeLocate' },
  concept: { color: 'green', icon: <BulbOutlined />, labelKey: 'kms.queryTypeConcept' },
  trend: { color: 'orange', icon: <RiseOutlined />, labelKey: 'kms.queryTypeTrend' },
  analysis: { color: 'purple', icon: <CompressOutlined />, labelKey: 'kms.queryTypeAnalysis' },
}

const MODE_CONFIG: Record<string, { color: string; labelKey: string }> = {
  keyword: { color: 'blue', labelKey: 'kms.keywordSearch' },
  semantic: { color: 'green', labelKey: 'kms.semanticSearch' },
  hybrid: { color: 'cyan', labelKey: 'kms.hybridSearch' },
  ai: { color: 'purple', labelKey: 'kms.aiSearch' },
}

const getFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'pdf':
      return <FilePdfOutlined style={{ color: '#f5222d' }} />
    case 'doc':
    case 'docx':
      return <FileWordOutlined style={{ color: '#1890ff' }} />
    case 'xls':
    case 'xlsx':
      return <FileExcelOutlined style={{ color: '#52c41a' }} />
    case 'md':
    case 'markdown':
      return <FileMarkdownOutlined style={{ color: '#722ed1' }} />
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'py':
    case 'java':
    case 'go':
    case 'rs':
    case 'c':
    case 'cpp':
    case 'h':
      return <CodeOutlined style={{ color: '#fa8c16' }} />
    case 'txt':
    case 'log':
      return <FileTextOutlined style={{ color: '#8c8c8c' }} />
    default:
      return <FileOutlined style={{ color: '#8c8c8c' }} />
  }
}

const formatTime = (timestamp: number) => {
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  if (days < 7) return `${days}天前`
  return date.toLocaleDateString()
}

const KMSHistoryView: React.FC<KMSHistoryViewProps> = ({
  history,
  onLoadHistory,
  onGetDetail,
  onDelete,
  onClear,
  onOpenFile,
  onOpenFileDir,
  onPreview,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [filterMode, setFilterMode] = useState<string>('all')
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailData, setDetailData] = useState<any>(null)

  const filteredHistory = useMemo(() => {
    if (filterMode === 'all') return history
    return history.filter(h => h.search_mode === filterMode)
  }, [history, filterMode])

  const handleViewDetail = useCallback(async (id: string) => {
    setDetailModalOpen(true)
    setDetailLoading(true)
    try {
      const detail = await onGetDetail(id)
      setDetailData(detail)
    } catch (err) {
      console.error('Failed to load history detail:', err)
    } finally {
      setDetailLoading(false)
    }
  }, [onGetDetail])

  const handleCloseDetail = useCallback(() => {
    setDetailModalOpen(false)
    setDetailData(null)
  }, [])

  const handleSourcePreview = useCallback((source: AgentSearchSource) => {
    onPreview({
      file_id: source.fileId,
      file_name: source.fileName,
      file_path: source.filePath,
      paragraph_id: source.paragraphId,
      paragraph_title: source.paragraphTitle,
      text: source.snippet,
      match_type: 'content',
      start_offset: source.startOffset,
      end_offset: source.endOffset,
      start_line: source.startLine,
      end_line: source.endLine,
      score: source.score,
    })
  }, [onPreview])

  const renderDetailModal = () => {
    if (!detailData) return null

    const isAI = detailData.search_mode === 'ai'
    const aiResult: AgentSearchResult | null = isAI && detailData.result_data ? detailData.result_data : null
    const keywords = detailData.query ? detailData.query.trim().split(/\s+/).filter(Boolean) : []

    return (
      <Modal
        title={
          <Space>
            <HistoryOutlined />
            <span>{t('kms.historyDetail')}</span>
          </Space>
        }
        open={detailModalOpen}
        onCancel={handleCloseDetail}
        footer={null}
        width={720}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin size="large" />
          </div>
        ) : (
          <div>
            <div style={{ marginBottom: 12 }}>
              <Space size={8} wrap>
                {MODE_CONFIG[detailData.search_mode] && (
                  <Tag color={MODE_CONFIG[detailData.search_mode].color}>
                    {t(MODE_CONFIG[detailData.search_mode].labelKey)}
                  </Tag>
                )}
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {formatTime(detailData.created_at)}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('kms.resultCount', { count: detailData.result_count })}
                </Text>
              </Space>
            </div>

            <Card size="small" style={{ marginBottom: 12 }}>
              <Text strong style={{ fontSize: 13 }}>{t('kms.searchQuery')}:</Text>
              <Paragraph style={{ margin: '4px 0 0', fontSize: 13 }}>
                {detailData.query}
              </Paragraph>
            </Card>

            {aiResult ? (
              <div>
                <Card
                  size="small"
                  style={{
                    marginBottom: 12,
                    borderLeft: `3px solid ${token.colorPrimary}`,
                    backgroundColor: token.colorPrimaryBg,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <Space size={6}>
                      <RobotOutlined style={{ color: token.colorPrimary }} />
                      <Text strong style={{ fontSize: 13 }}>{t('kms.aiConclusion')}</Text>
                      {QUERY_TYPE_CONFIG[aiResult.queryType] && (
                        <Tag color={QUERY_TYPE_CONFIG[aiResult.queryType].color} style={{ fontSize: 11 }}>
                          {QUERY_TYPE_CONFIG[aiResult.queryType].icon}
                          <span style={{ marginLeft: 4 }}>{t(QUERY_TYPE_CONFIG[aiResult.queryType].labelKey)}</span>
                        </Tag>
                      )}
                    </Space>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {t('kms.searchRounds', { count: aiResult.searchRounds })}
                    </Text>
                  </div>
                  <Paragraph style={{ fontSize: 13, lineHeight: 1.7, margin: 0, whiteSpace: 'pre-wrap' }}>
                    <HighlightText text={aiResult.conclusion} keywords={keywords} />
                  </Paragraph>
                </Card>

                {aiResult.sources && aiResult.sources.length > 0 && (
                  <div>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                      {t('kms.sources', { count: aiResult.sources.length })}
                    </Text>
                    {aiResult.sources.map((source, index) => (
                      <Card
                        key={`${source.fileId}-${index}`}
                        size="small"
                        style={{ marginBottom: 6, borderLeft: `2px solid ${token.colorBorder}` }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <Space size={6} style={{ flex: 1, minWidth: 0 }}>
                            <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>[{index + 1}]</Text>
                            {getFileIcon(source.fileName)}
                            <Text
                              strong
                              style={{ fontSize: 12, cursor: 'pointer' }}
                              ellipsis
                              onClick={() => handleSourcePreview(source)}
                            >
                              <HighlightText text={source.fileName} keywords={keywords} />
                            </Text>
                            {source.paragraphTitle && (
                              <Text type="secondary" style={{ fontSize: 11 }}>
                                <HighlightText text={source.paragraphTitle} keywords={keywords} />
                              </Text>
                            )}
                          </Space>
                          <Space size={2}>
                            <Tooltip title={t('kms.preview')}>
                              <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => handleSourcePreview(source)} />
                            </Tooltip>
                            <Tooltip title={t('kms.openFile')}>
                              <Button size="small" type="text" icon={<FileOutlined />} onClick={() => onOpenFile(source.filePath)} />
                            </Tooltip>
                            <Tooltip title={t('kms.openDir')}>
                              <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => onOpenFileDir(source.filePath)} />
                            </Tooltip>
                          </Space>
                        </div>
                        <Tooltip title={source.filePath}>
                          <Text type="secondary" style={{ fontSize: 10, display: 'block', marginTop: 4 }} ellipsis>
                            {source.filePath}
                          </Text>
                        </Tooltip>
                        {source.snippet && (
                          <div style={{ fontSize: 11, color: token.colorTextTertiary, marginTop: 4, lineHeight: 1.5 }}>
                            <HighlightText text={source.snippet} keywords={keywords} />
                          </div>
                        )}
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <Card size="small">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('kms.historyNoDetail')}
                </Text>
              </Card>
            )}
          </div>
        )}
      </Modal>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部操作栏 */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
        flexShrink: 0,
      }}>
        <Space size={4}>
          {['all', 'keyword', 'semantic', 'hybrid', 'ai'].map(mode => (
            <Button
              key={mode}
              size="small"
              type={filterMode === mode ? 'primary' : 'default'}
              onClick={() => setFilterMode(mode)}
            >
              {mode === 'all' ? t('kms.historyAll') : t(MODE_CONFIG[mode]?.labelKey || mode)}
            </Button>
          ))}
        </Space>
        <Space>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => onLoadHistory({ limit: 100 })}
          >
            {t('common.refresh')}
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => {
              Modal.confirm({
                title: t('kms.clearHistoryConfirm'),
                onOk: () => onClear(filterMode === 'all' ? undefined : filterMode),
              })
            }}
          >
            {t('kms.clearHistory')}
          </Button>
        </Space>
      </div>

      {/* 历史列表 */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {filteredHistory.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('kms.noHistory')}
          />
        ) : (
          filteredHistory.map((item) => {
            const modeConfig = MODE_CONFIG[item.search_mode]
            return (
              <Card
                key={item.id}
                size="small"
                style={{
                  marginBottom: 8,
                  borderLeft: `3px solid ${modeConfig ? token.colorPrimary : token.colorBorder}`,
                  cursor: 'pointer',
                }}
                onClick={() => handleViewDetail(item.id)}
                hoverable
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Space size={6} style={{ flex: 1, minWidth: 0 }}>
                    {item.search_mode === 'ai' ? (
                      <RobotOutlined style={{ color: token.colorPrimary }} />
                    ) : (
                      <SearchOutlined style={{ color: token.colorTextSecondary }} />
                    )}
                    <Text
                      strong
                      style={{ fontSize: 13 }}
                      ellipsis
                    >
                      {item.query}
                    </Text>
                    {modeConfig && (
                      <Tag color={modeConfig.color} style={{ fontSize: 10, margin: 0 }}>
                        {t(modeConfig.labelKey)}
                      </Tag>
                    )}
                  </Space>
                  <Space size={4} style={{ flexShrink: 0 }}>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {formatTime(item.created_at)}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {item.result_count}{t('kms.historyResultsUnit')}
                    </Text>
                    <Tooltip title={t('kms.viewDetail')}>
                      <Button
                        size="small"
                        type="text"
                        icon={<EyeOutlined />}
                        onClick={(e) => { e.stopPropagation(); handleViewDetail(item.id) }}
                      />
                    </Tooltip>
                    <Tooltip title={t('common.delete')}>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={(e) => { e.stopPropagation(); onDelete(item.id) }}
                      />
                    </Tooltip>
                  </Space>
                </div>
              </Card>
            )
          })
        )}
      </div>

      {renderDetailModal()}
    </div>
  )
}

export default KMSHistoryView
