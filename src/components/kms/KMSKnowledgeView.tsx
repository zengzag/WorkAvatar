import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Space, Typography, Tag, Spin, Input, Select, Table, Tooltip, Button, theme, Tabs,
  Statistic, Row, App,
} from 'antd'
import {
  FolderOpenOutlined, FileTextOutlined, FireOutlined, InboxOutlined,
  SearchOutlined, ReloadOutlined, EyeOutlined,
  ThunderboltOutlined, RobotOutlined,
  DatabaseOutlined, BarChartOutlined,
} from '@ant-design/icons'
import type { FileSummaryItem, FileSummariesResult } from '../../hooks/useKMS'

const { Text, Title } = Typography

interface IndexDir {
  id: string
  dir_path: string
  display_name: string
  enabled: number
}

interface KMSStats {
  dirs: { total: number; enabled: number }
  files: { total: number; byStatus: Record<string, number>; byTier: Record<string, number>; byExt: Record<string, number> }
  index: { totalEntries: number; byType: Record<string, number>; embeddingCount: number; ftsEntryCount: number }
}

interface KMSKnowledgeViewProps {
  dirs: IndexDir[]
  fileSummaries: FileSummariesResult
  isLoadingSummaries: boolean
  onLoadFileSummaries: (params?: {
    dirId?: string
    dataTier?: 'cold' | 'hot'
    keyword?: string
    page?: number
    pageSize?: number
  }) => void
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
  // 统计信息
  stats: KMSStats | null
  onLoadStats: () => void
}

const KMSKnowledgeView: React.FC<KMSKnowledgeViewProps> = ({
  dirs,
  fileSummaries,
  isLoadingSummaries,
  onLoadFileSummaries,
  onOpenFile,
  onOpenFileDir,
  stats,
  onLoadStats,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()

  // 文件摘要筛选
  const [filterDirId, setFilterDirId] = useState<string | undefined>(undefined)
  const [filterTier, setFilterTier] = useState<'hot' | 'cold' | undefined>(undefined)
  const [filterKeyword, setFilterKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [activeTab, setActiveTab] = useState<'files' | 'stats'>('files')
  // 手动处理中的文件 ID 集合
  const [processingFileIds, setProcessingFileIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    onLoadFileSummaries({ page: 1, pageSize: 20 })
    onLoadStats()
  }, [onLoadFileSummaries, onLoadStats])

  // 切换到统计 Tab 时刷新统计
  const handleTabChange = useCallback((key: string) => {
    setActiveTab(key as 'files' | 'stats')
    if (key === 'stats') {
      onLoadStats()
    }
  }, [onLoadStats])

  const reloadFileSummaries = useCallback(() => {
    onLoadFileSummaries({
      dirId: filterDirId,
      dataTier: filterTier,
      keyword: filterKeyword.trim() || undefined,
      page,
      pageSize,
    })
  }, [filterDirId, filterTier, filterKeyword, page, pageSize, onLoadFileSummaries])

  useEffect(() => {
    reloadFileSummaries()
  }, [filterDirId, filterTier, page, pageSize, reloadFileSummaries])

  // 关键词搜索（防抖）
  useEffect(() => {
    const timer = setTimeout(() => {
      if (page !== 1) {
        setPage(1)
      } else {
        reloadFileSummaries()
      }
    }, 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKeyword])

  const handleReload = useCallback(() => {
    reloadFileSummaries()
    onLoadStats()
  }, [reloadFileSummaries, onLoadStats])

  // 格式化文件大小
  const formatSize = (bytes: number): string => {
    if (!bytes) return '-'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  // 格式化时间
  const formatTime = (ts: number): string => {
    if (!ts) return '-'
    const d = new Date(ts * 1000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  // 手动生成文件摘要
  const handleGenerateFileSummary = async (fileId: string) => {
    if (processingFileIds.has(fileId)) return
    const newSet = new Set(processingFileIds)
    newSet.add(fileId)
    setProcessingFileIds(newSet)
    try {
      const result = await window.electronAPI.kms.generateFileSummary(fileId)
      if (result?.success) {
        // 摘要生成成功，但智能索引可能失败
        if (result.embeddingError) {
          message.warning(t('kms.knowledge.fileSummaryGeneratedButEmbeddingFailed', { error: result.embeddingError }))
        } else {
          message.success(t('kms.knowledge.fileSummaryGenerated'))
        }
        reloadFileSummaries()
      } else {
        const err = result?.error
        if (err === 'NO_LLM_PROVIDER') {
          message.warning(t('kms.collections.aiGenerateNoLLM'))
        } else if (err === 'MODEL_NOT_CONFIGURED') {
          message.error(t('kms.knowledge.modelNotConfigured'))
        } else if (err === 'FILE_NOT_FOUND') {
          message.warning(t('kms.knowledge.fileNotFound'))
        } else if (err === 'EMPTY_CONTENT') {
          message.warning(t('kms.knowledge.fileEmptyContent'))
        } else {
          message.error(t('kms.knowledge.fileSummaryFailed'))
        }
      }
    } catch (err: any) {
      message.error(err?.message || t('kms.knowledge.fileSummaryFailed'))
    } finally {
      const clearSet = new Set(processingFileIds)
      clearSet.delete(fileId)
      setProcessingFileIds(clearSet)
    }
  }

  const dirOptions = useMemo(() => [
    { label: t('kms.knowledge.allDirs'), value: '' },
    ...dirs.map(d => ({
      label: d.display_name || d.dir_path.split(/[/\\]/).pop() || d.dir_path,
      value: d.id,
    })),
  ], [dirs, t])

  const tierOptions = useMemo(() => [
    { label: t('kms.knowledge.allTiers'), value: '' },
    { label: t('kms.knowledge.hot'), value: 'hot' },
    { label: t('kms.knowledge.cold'), value: 'cold' },
  ], [t])

  // 顶部统计：使用 KMSStats prop
  const overviewStats = useMemo(() => {
    return {
      totalDirs: stats?.dirs?.total ?? 0,
      totalFiles: stats?.files?.total ?? 0,
      hotFiles: stats?.files?.byTier?.hot ?? 0,
    }
  }, [stats])

  // 文件摘要表格列定义
  const columns = useMemo(() => [
    {
      title: t('kms.knowledge.fileName'),
      dataIndex: 'file_name',
      key: 'file_name',
      width: 200,
      render: (text: string, record: FileSummaryItem) => (
        <Tooltip title={record.file_path}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <FileTextOutlined style={{ color: token.colorTextSecondary, flexShrink: 0, fontSize: 12 }} />
            <span
              style={{ fontSize: 12, fontWeight: 500, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}
              onClick={() => onOpenFile(record.file_path)}
            >
              {text}
            </span>
          </div>
        </Tooltip>
      ),
    },
    {
      title: t('kms.knowledge.tier'),
      dataIndex: 'data_tier',
      key: 'data_tier',
      width: 70,
      render: (tier: string) => (
        <Tag
          color={tier === 'hot' ? 'red' : 'default'}
          style={{ fontSize: 10, margin: 0, padding: '0 4px' }}
        >
          {tier === 'hot' ? <FireOutlined /> : <InboxOutlined />}
        </Tag>
      ),
    },
    {
      title: t('kms.knowledge.dir'),
      dataIndex: 'dir_name',
      key: 'dir_name',
      width: 120,
      render: (text: string) => (
        <Tooltip title={text}>
          <span style={{ fontSize: 12, color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
            {text || '-'}
          </span>
        </Tooltip>
      ),
    },
    {
      title: t('kms.knowledge.summary'),
      key: 'summary',
      width: 250,
      render: (_: any, record: FileSummaryItem) => {
        const summary = record.summary || record.light_summary || record.preview_text || ''
        return (
          <Tooltip title={summary || t('kms.knowledge.noSummary')}>
            <span style={{ fontSize: 12, color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
              {summary || t('kms.knowledge.noSummary')}
            </span>
          </Tooltip>
        )
      },
    },
    {
      title: t('kms.knowledge.vector'),
      key: 'vector',
      width: 65,
      render: (_: any, record: FileSummaryItem) => (
        <span style={{ fontSize: 12, color: record.has_embedding ? token.colorSuccess : token.colorTextQuaternary }}>
          {record.has_embedding ? t('common.yes') : t('common.no')}
        </span>
      ),
    },
    {
      title: t('kms.knowledge.size'),
      dataIndex: 'file_size',
      key: 'file_size',
      width: 80,
      render: (size: number) => (
        <Text type="secondary" style={{ fontSize: 11 }}>{formatSize(size)}</Text>
      ),
    },
    {
      title: t('kms.knowledge.updated'),
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 100,
      render: (ts: number) => (
        <Text type="secondary" style={{ fontSize: 11 }}>{formatTime(ts)}</Text>
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 110,
      render: (_: any, record: FileSummaryItem) => {
        const isProcessing = processingFileIds.has(record.id)
        return (
          <Space size={2}>
            <Tooltip title={t('kms.knowledge.generateFileSummary')}>
              <Button
                size="small"
                type="text"
                icon={isProcessing ? <ReloadOutlined spin /> : <RobotOutlined />}
                loading={isProcessing}
                onClick={() => handleGenerateFileSummary(record.id)}
              />
            </Tooltip>
            <Tooltip title={t('kms.openFile')}>
              <Button
                size="small"
                type="text"
                icon={<EyeOutlined />}
                onClick={() => onOpenFile(record.file_path)}
              />
            </Tooltip>
            <Tooltip title={t('kms.openDir')}>
              <Button
                size="small"
                type="text"
                icon={<FolderOpenOutlined />}
                onClick={() => onOpenFileDir(record.file_path)}
              />
            </Tooltip>
          </Space>
        )
      },
    },
  ], [t, token, onOpenFile, onOpenFileDir, processingFileIds])

  // 顶部统计栏
  const renderStatsBar = () => (
    <Row
      gutter={16}
      style={{
        padding: '8px 12px',
        background: token.colorFillQuaternary,
        borderRadius: 6,
        marginBottom: 12,
        flexShrink: 0,
      }}
    >
      <Statistic
        title={t('kms.knowledge.statsDirs')}
        value={overviewStats.totalDirs}
        prefix={<FolderOpenOutlined style={{ color: token.colorPrimary }} />}
        valueStyle={{ fontSize: 16, color: token.colorText }}
      />
      <div style={{ width: 1, background: token.colorBorderSecondary, margin: '0 16px' }} />
      <Statistic
        title={t('kms.knowledge.statsFiles')}
        value={overviewStats.totalFiles}
        prefix={<FileTextOutlined style={{ color: token.colorTextSecondary }} />}
        valueStyle={{ fontSize: 16, color: token.colorText }}
      />
      <div style={{ width: 1, background: token.colorBorderSecondary, margin: '0 16px' }} />
      <Statistic
        title={t('kms.knowledge.statsHot')}
        value={overviewStats.hotFiles}
        prefix={<FireOutlined style={{ color: token.colorError }} />}
        valueStyle={{ fontSize: 16, color: token.colorText }}
      />
      <div style={{ flex: 1 }} />
      <Button
        size="small"
        icon={<ReloadOutlined />}
        onClick={handleReload}
        loading={isLoadingSummaries}
      >
        {t('common.refresh')}
      </Button>
    </Row>
  )

  // 文件摘要 Tab 内容
  const renderFilesTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 筛选栏 */}
      <div style={{
        display: 'flex',
        gap: 8,
        marginBottom: 12,
        flexWrap: 'wrap',
        flexShrink: 0,
      }}>
        <Input
          allowClear
          size="small"
          prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
          placeholder={t('kms.knowledge.searchPlaceholder')}
          value={filterKeyword}
          onChange={e => setFilterKeyword(e.target.value)}
          style={{ width: 220 }}
        />
        <Select
          size="small"
          style={{ width: 180 }}
          value={filterDirId || ''}
          onChange={v => { setFilterDirId(v || undefined); setPage(1) }}
          options={dirOptions}
        />
        <Select
          size="small"
          style={{ width: 120 }}
          value={filterTier || ''}
          onChange={v => { setFilterTier((v || undefined) as 'hot' | 'cold' | undefined); setPage(1) }}
          options={tierOptions}
        />
      </div>

      {/* 文件摘要表格 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <Spin spinning={isLoadingSummaries} size="small">
          <Table
            size="small"
            rowKey="id"
            columns={columns}
            dataSource={fileSummaries.items}
            tableLayout="fixed"
            pagination={{
              current: page,
              pageSize,
              total: fileSummaries.total,
              showSizeChanger: true,
              showTotal: (total) => t('kms.knowledge.totalFiles', { count: total }),
              pageSizeOptions: [10, 20, 50],
              onChange: (p, ps) => { setPage(p); setPageSize(ps) },
              size: 'small',
            }}
            scroll={{ x: 1000 }}
          />
        </Spin>
      </div>
    </div>
  )

  // 统计信息 Tab 内容
  const renderStatsTab = () => {
    const totalFiles = stats?.files?.total ?? 0
    const indexedFiles = stats?.files?.byStatus?.completed ?? 0
    const pendingFiles = stats?.files?.byStatus?.pending ?? 0
    const failedFiles = stats?.files?.byStatus?.failed ?? 0
    const hotFiles = stats?.files?.byTier?.hot ?? 0
    const coldFiles = stats?.files?.byTier?.cold ?? 0
    const indexEntries = stats?.index?.totalEntries ?? 0
    const embeddingCount = stats?.index?.embeddingCount ?? 0
    const ftsEntryCount = stats?.index?.ftsEntryCount ?? 0
    const enabledDirs = stats?.dirs?.enabled ?? 0
    const totalDirs = stats?.dirs?.total ?? 0

    const statCards = [
      { label: t('kms.totalDirs'), value: totalDirs, sub: `${enabledDirs} ${t('kms.knowledge.enabled')}`, icon: <FolderOpenOutlined style={{ color: token.colorPrimary }} /> },
      { label: t('kms.totalFiles'), value: totalFiles, icon: <FileTextOutlined style={{ color: token.colorPrimary }} /> },
      { label: t('kms.indexedFiles'), value: indexedFiles, icon: <DatabaseOutlined style={{ color: token.colorSuccess }} /> },
      { label: t('kms.pendingFiles'), value: pendingFiles, icon: <ThunderboltOutlined style={{ color: token.colorWarning }} /> },
      { label: t('kms.failedFiles'), value: failedFiles, icon: <FileTextOutlined style={{ color: token.colorError }} /> },
      { label: t('kms.hotFiles'), value: hotFiles, icon: <FireOutlined style={{ color: '#f5222d' }} /> },
      { label: t('kms.coldFiles'), value: coldFiles, icon: <InboxOutlined style={{ color: token.colorTextQuaternary }} /> },
      { label: t('kms.indexEntries'), value: indexEntries, sub: `${ftsEntryCount} FTS`, icon: <DatabaseOutlined style={{ color: token.colorInfo }} /> },
      { label: t('kms.embeddingCount'), value: embeddingCount, icon: <ThunderboltOutlined style={{ color: '#722ed1' }} /> },
    ]

    return (
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 4 }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 12,
        }}>
          {statCards.map((card) => (
            <Card
              key={card.label}
              size="small"
              style={{ textAlign: 'center' }}
            >
              <div style={{ marginBottom: 4, fontSize: 20 }}>{card.icon}</div>
              <Title level={4} style={{ margin: 0, fontSize: 22 }}>{card.value}</Title>
              <Text type="secondary" style={{ fontSize: 12 }}>{card.label}</Text>
              {card.sub && (
                <div style={{ marginTop: 4 }}>
                  <Tag style={{ fontSize: 10, margin: 0, lineHeight: '18px', padding: '0 6px' }}>{card.sub}</Tag>
                </div>
              )}
            </Card>
          ))}
        </div>

        {/* 按扩展名分布 */}
        {stats?.files?.byExt && Object.keys(stats.files.byExt).length > 0 && (
          <Card
            size="small"
            style={{ marginTop: 12 }}
            title={
              <Space size={6}>
                <BarChartOutlined style={{ color: token.colorPrimary }} />
                <Text strong style={{ fontSize: 13 }}>{t('kms.knowledge.byExt')}</Text>
              </Space>
            }
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(stats.files.byExt)
                .sort((a, b) => b[1] - a[1])
                .map(([ext, count]) => (
                  <Tag key={ext} style={{ fontSize: 12, margin: 0, padding: '2px 8px' }}>
                    .{ext}: {count}
                  </Tag>
                ))}
            </div>
          </Card>
        )}

        {/* 按索引类型分布 */}
        {stats?.index?.byType && Object.keys(stats.index.byType).length > 0 && (
          <Card
            size="small"
            style={{ marginTop: 12 }}
            title={
              <Space size={6}>
                <DatabaseOutlined style={{ color: token.colorPrimary }} />
                <Text strong style={{ fontSize: 13 }}>{t('kms.knowledge.byType')}</Text>
              </Space>
            }
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(stats.index.byType)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => (
                  <Tag key={type} style={{ fontSize: 12, margin: 0, padding: '2px 8px' }}>
                    {type}: {count}
                  </Tag>
                ))}
            </div>
          </Card>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部标题 + 统计 */}
      <div style={{ flexShrink: 0, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <Title level={5} style={{ margin: 0 }}>{t('kms.knowledge.title')}</Title>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.knowledge.subtitle')}</Text>
        </div>
      </div>

      {renderStatsBar()}

      {/* 主体：Tabs 切换文件摘要与统计信息 */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Tabs
          activeKey={activeTab}
          onChange={handleTabChange}
          size="small"
          style={{ height: '100%' }}
          tabBarStyle={{ marginBottom: 12 }}
          items={[
            {
              key: 'files',
              label: (
                <span>
                  <FileTextOutlined style={{ marginRight: 4 }} />
                  {t('kms.knowledge.filesTab')}
                  {fileSummaries.total > 0 && (
                    <Tag color="blue" style={{ fontSize: 10, margin: '0 0 0 4px', lineHeight: '16px', padding: '0 4px' }}>
                      {fileSummaries.total}
                    </Tag>
                  )}
                </span>
              ),
              children: renderFilesTab(),
            },
            {
              key: 'stats',
              label: (
                <span>
                  <BarChartOutlined style={{ marginRight: 4 }} />
                  {t('kms.knowledge.statsTab')}
                </span>
              ),
              children: renderStatsTab(),
            },
          ]}
        />
      </div>
    </div>
  )
}

export default KMSKnowledgeView
