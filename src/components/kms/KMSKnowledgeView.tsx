import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Space, Typography, Tag, Empty, Spin, Input, Select, Table, Tooltip, Button, theme, Tabs,
  Statistic, Row, App,
} from 'antd'
import {
  FolderOpenOutlined, FileTextOutlined, FireOutlined, InboxOutlined,
  SearchOutlined, ReloadOutlined, EyeOutlined, FolderOutlined,
  ThunderboltOutlined, CloudUploadOutlined, RobotOutlined,
} from '@ant-design/icons'
import type { DirSummary, FileSummaryItem, FileSummariesResult } from '../../hooks/useKMS'

const { Text, Paragraph, Title } = Typography

interface IndexDir {
  id: string
  dir_path: string
  display_name: string
  enabled: number
}

interface KMSKnowledgeViewProps {
  dirs: IndexDir[]
  dirSummaries: DirSummary[]
  fileSummaries: FileSummariesResult
  isLoadingSummaries: boolean
  onLoadDirSummaries: () => void
  onLoadFileSummaries: (params?: {
    dirId?: string
    dataTier?: 'cold' | 'hot'
    keyword?: string
    page?: number
    pageSize?: number
  }) => void
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
}

const KMSKnowledgeView: React.FC<KMSKnowledgeViewProps> = ({
  dirs,
  dirSummaries,
  fileSummaries,
  isLoadingSummaries,
  onLoadDirSummaries,
  onLoadFileSummaries,
  onOpenFile,
  onOpenFileDir,
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
  const [activeTab, setActiveTab] = useState<'files' | 'dirs'>('files')
  // 手动处理中的目录/文件 ID 集合
  const [processingDirIds, setProcessingDirIds] = useState<Set<string>>(new Set())
  const [processingFileIds, setProcessingFileIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    onLoadDirSummaries()
    onLoadFileSummaries({ page: 1, pageSize: 20 })
  }, [onLoadDirSummaries, onLoadFileSummaries])

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
    onLoadDirSummaries()
    reloadFileSummaries()
  }, [onLoadDirSummaries, reloadFileSummaries])

  // 解析关键词 JSON
  const parseKeywords = (json: string): string[] => {
    if (!json) return []
    try {
      const arr = JSON.parse(json)
      return Array.isArray(arr) ? arr.map(String) : []
    } catch {
      return []
    }
  }

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

  // 手动生成目录摘要
  const handleGenerateDirSummary = async (dirId: string) => {
    if (processingDirIds.has(dirId)) return
    const newSet = new Set(processingDirIds)
    newSet.add(dirId)
    setProcessingDirIds(newSet)
    try {
      const result = await window.electronAPI.kms.generateDirSummary(dirId)
      if (result?.success) {
        message.success(t('kms.knowledge.dirSummaryGenerated'))
        onLoadDirSummaries()
      } else {
        const err = result?.error
        if (err === 'NO_FILES') {
          message.warning(t('kms.knowledge.dirSummaryNoFiles'))
        } else if (err === 'DIR_NOT_FOUND') {
          message.warning(t('kms.knowledge.dirNotFound'))
        } else {
          message.error(t('kms.knowledge.dirSummaryFailed'))
        }
      }
    } catch (err: any) {
      message.error(err?.message || t('kms.knowledge.dirSummaryFailed'))
    } finally {
      const clearSet = new Set(processingDirIds)
      clearSet.delete(dirId)
      setProcessingDirIds(clearSet)
    }
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
        // 摘要生成成功，但向量嵌入可能失败
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

  // 顶部统计：从 dirSummaries 与 fileSummaries 派生
  const stats = useMemo(() => {
    const totalDirs = dirSummaries.length
    const enabledDirs = dirSummaries.filter(d => d.enabled !== 0).length
    const totalFiles = fileSummaries.total
    const hotFiles = fileSummaries.items.filter(f => f.data_tier === 'hot').length
    return { totalDirs, enabledDirs, totalFiles, hotFiles }
  }, [dirSummaries, fileSummaries])

  // 目录摘要卡片
  const renderDirCard = (dir: DirSummary) => {
    const keywords = parseKeywords(dir.keywords_json)
    const isEnabled = dir.enabled !== 0
    const isProcessing = processingDirIds.has(dir.dir_id)
    return (
      <Card
        key={dir.dir_id}
        size="small"
        style={{
          borderColor: isEnabled ? token.colorPrimary : token.colorBorderSecondary,
          borderLeft: `3px solid ${isEnabled ? token.colorPrimary : token.colorTextQuaternary}`,
          height: '100%',
        }}
        styles={{ body: { padding: 12 } }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <FolderOutlined style={{ color: isEnabled ? token.colorPrimary : token.colorTextQuaternary }} />
          <Text strong style={{ fontSize: 13, flex: 1, minWidth: 0 }} ellipsis>
            {dir.display_name || dir.dir_path.split(/[/\\]/).pop() || dir.dir_path}
          </Text>
          <Tag style={{ fontSize: 10, margin: 0, lineHeight: '16px', padding: '0 4px' }}>
            {dir.file_count}{t('kms.knowledge.filesUnit')}
          </Tag>
          <Tooltip title={t('kms.knowledge.generateDirSummary')}>
            <Button
              type="text"
              size="small"
              icon={isProcessing ? <ReloadOutlined spin /> : <ThunderboltOutlined />}
              loading={isProcessing}
              onClick={() => handleGenerateDirSummary(dir.dir_id)}
            />
          </Tooltip>
        </div>
        <Tooltip title={dir.dir_path}>
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }} ellipsis>
            {dir.dir_path}
          </Text>
        </Tooltip>
        <Paragraph
          type="secondary"
          style={{
            fontSize: 12,
            margin: 0,
            maxHeight: 72,
            overflow: 'hidden',
            lineHeight: 1.6,
          }}
        >
          {dir.summary || t('kms.knowledge.noSummary')}
        </Paragraph>
        {keywords.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {keywords.slice(0, 6).map((kw, i) => (
              <Tag key={i} style={{ fontSize: 10, margin: 0, lineHeight: '16px', padding: '0 4px' }}>{kw}</Tag>
            ))}
            {keywords.length > 6 && (
              <Tag style={{ fontSize: 10, margin: 0, lineHeight: '16px', padding: '0 4px' }}>
                +{keywords.length - 6}
              </Tag>
            )}
          </div>
        )}
        <Text type="secondary" style={{ fontSize: 10, display: 'block', marginTop: 8 }}>
          {t('kms.knowledge.updatedAt')}: {formatTime(dir.updated_at)}
        </Text>
      </Card>
    )
  }

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
      width: 60,
      render: (_: any, record: FileSummaryItem) => (
        <Tooltip title={record.has_embedding ? t('kms.knowledge.vectorDone') : t('kms.knowledge.vectorPending')}>
          <Tag
            color={record.has_embedding ? 'success' : 'default'}
            style={{ fontSize: 10, margin: 0, padding: '0 4px' }}
          >
            <CloudUploadOutlined style={{ marginRight: 2 }} />
            {record.has_embedding ? t('kms.knowledge.vectorDone') : t('kms.knowledge.vectorPending')}
          </Tag>
        </Tooltip>
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
        value={stats.totalDirs}
        prefix={<FolderOpenOutlined style={{ color: token.colorPrimary }} />}
        valueStyle={{ fontSize: 16, color: token.colorText }}
      />
      <div style={{ width: 1, background: token.colorBorderSecondary, margin: '0 16px' }} />
      <Statistic
        title={t('kms.knowledge.statsFiles')}
        value={stats.totalFiles}
        prefix={<FileTextOutlined style={{ color: token.colorTextSecondary }} />}
        valueStyle={{ fontSize: 16, color: token.colorText }}
      />
      <div style={{ width: 1, background: token.colorBorderSecondary, margin: '0 16px' }} />
      <Statistic
        title={t('kms.knowledge.statsHot')}
        value={stats.hotFiles}
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

  // 目录摘要 Tab 内容
  const renderDirsTab = () => (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      {dirSummaries.length === 0 ? (
        <Card size="small">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('kms.knowledge.noDirSummaries')}
          />
        </Card>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: 12,
          padding: 4,
        }}>
          {dirSummaries.map(renderDirCard)}
        </div>
      )}
    </div>
  )

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

      {/* 主体：Tabs 切换文件摘要与目录摘要 */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Tabs
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as 'files' | 'dirs')}
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
              key: 'dirs',
              label: (
                <span>
                  <FolderOpenOutlined style={{ marginRight: 4 }} />
                  {t('kms.knowledge.dirsTab')}
                  {dirSummaries.length > 0 && (
                    <Tag color="blue" style={{ fontSize: 10, margin: '0 0 0 4px', lineHeight: '16px', padding: '0 4px' }}>
                      {dirSummaries.length}
                    </Tag>
                  )}
                </span>
              ),
              children: renderDirsTab(),
            },
          ]}
        />
      </div>
    </div>
  )
}

export default KMSKnowledgeView
