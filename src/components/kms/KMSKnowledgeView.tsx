import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Space, Typography, Tag, Empty, Spin, Input, Select, Table, Tooltip, Button, theme,
} from 'antd'
import {
  FolderOpenOutlined, FileTextOutlined, FireOutlined, InboxOutlined,
  SearchOutlined, ReloadOutlined, EyeOutlined, FolderOutlined,
} from '@ant-design/icons'
import type { DirSummary, FileSummaryItem, FileSummariesResult } from '../../hooks/useKMS'

const { Text, Paragraph } = Typography

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

  // 文件摘要筛选
  const [filterDirId, setFilterDirId] = useState<string | undefined>(undefined)
  const [filterTier, setFilterTier] = useState<'hot' | 'cold' | undefined>(undefined)
  const [filterKeyword, setFilterKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  // 初始加载
  useEffect(() => {
    onLoadDirSummaries()
    onLoadFileSummaries({ page: 1, pageSize: 20 })
  }, [onLoadDirSummaries, onLoadFileSummaries])

  // 重新加载文件摘要
  const reloadFileSummaries = useCallback(() => {
    onLoadFileSummaries({
      dirId: filterDirId,
      dataTier: filterTier,
      keyword: filterKeyword.trim() || undefined,
      page,
      pageSize,
    })
  }, [filterDirId, filterTier, filterKeyword, page, pageSize, onLoadFileSummaries])

  // 筛选条件变化时重新加载
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
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  }

  // 格式化时间
  const formatTime = (ts: number): string => {
    if (!ts) return '-'
    const d = new Date(ts * 1000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  const dirOptions = [
    { label: t('kms.knowledge.allDirs'), value: '' },
    ...dirs.map(d => ({
      label: d.display_name || d.dir_path.split(/[/\\]/).pop() || d.dir_path,
      value: d.id,
    })),
  ]

  const tierOptions = [
    { label: t('kms.knowledge.allTiers'), value: '' },
    { label: t('kms.hotFiles'), value: 'hot' },
    { label: t('kms.coldFiles'), value: 'cold' },
  ]

  // 目录摘要卡片
  const renderDirSummaries = () => {
    if (dirSummaries.length === 0) {
      return (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('kms.knowledge.noDirSummaries')}
          />
        </Card>
      )
    }

    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space size={6}>
            <FolderOpenOutlined style={{ color: token.colorPrimary }} />
            <Text strong style={{ fontSize: 13 }}>{t('kms.knowledge.dirSummaries')}</Text>
            <Tag style={{ fontSize: 11 }}>{dirSummaries.length}</Tag>
          </Space>
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 8,
        }}>
          {dirSummaries.map((dir) => {
            const keywords = parseKeywords(dir.keywords_json)
            return (
              <Card
                key={dir.dir_id}
                size="small"
                style={{
                  borderLeft: `3px solid ${dir.enabled === 0 ? token.colorTextQuaternary : token.colorPrimary}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <FolderOutlined style={{ color: dir.enabled === 0 ? token.colorTextQuaternary : token.colorPrimary }} />
                  <Text strong style={{ fontSize: 12 }} ellipsis>
                    {dir.display_name || dir.dir_path.split(/[/\\]/).pop() || dir.dir_path}
                  </Text>
                  <Tag style={{ fontSize: 10, margin: 0, lineHeight: '16px', padding: '0 4px' }}>
                    {dir.file_count}{t('kms.knowledge.filesUnit')}
                  </Tag>
                </div>
                <Tooltip title={dir.dir_path}>
                  <Text type="secondary" style={{ fontSize: 10, display: 'block', marginBottom: 6 }} ellipsis>
                    {dir.dir_path}
                  </Text>
                </Tooltip>
                <Paragraph
                  type="secondary"
                  style={{
                    fontSize: 11,
                    margin: 0,
                    maxHeight: 60,
                    overflow: 'hidden',
                    lineHeight: 1.5,
                  }}
                >
                  {dir.summary || t('kms.knowledge.noSummary')}
                </Paragraph>
                {keywords.length > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {keywords.slice(0, 5).map((kw, i) => (
                      <Tag key={i} style={{ fontSize: 10, margin: 0, lineHeight: '16px', padding: '0 4px' }}>
                        {kw}
                      </Tag>
                    ))}
                  </div>
                )}
                <Text type="secondary" style={{ fontSize: 10, display: 'block', marginTop: 6 }}>
                  {t('kms.knowledge.updatedAt')}: {formatTime(dir.updated_at)}
                </Text>
              </Card>
            )
          })}
        </div>
      </div>
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
          <Space size={4} style={{ minWidth: 0 }}>
            <FileTextOutlined style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
            <Text
              strong
              style={{ fontSize: 12, cursor: 'pointer' }}
              ellipsis
              onClick={() => onOpenFile(record.file_path)}
            >
              {text}
            </Text>
          </Space>
        </Tooltip>
      ),
    },
    {
      title: t('kms.knowledge.tier'),
      dataIndex: 'data_tier',
      key: 'data_tier',
      width: 80,
      render: (tier: string) => (
        <Tag
          color={tier === 'hot' ? 'red' : 'default'}
          style={{ fontSize: 11, margin: 0 }}
        >
          {tier === 'hot' ? <FireOutlined /> : <InboxOutlined />}
          <span style={{ marginLeft: 4 }}>
            {tier === 'hot' ? t('kms.knowledge.hot') : t('kms.knowledge.cold')}
          </span>
        </Tag>
      ),
    },
    {
      title: t('kms.knowledge.dir'),
      dataIndex: 'dir_name',
      key: 'dir_name',
      width: 120,
      render: (text: string) => (
        <Text type="secondary" style={{ fontSize: 11 }} ellipsis>
          {text || '-'}
        </Text>
      ),
    },
    {
      title: t('kms.knowledge.summary'),
      key: 'summary',
      render: (_: any, record: FileSummaryItem) => {
        const summary = record.summary || record.light_summary || record.preview_text || ''
        const keywords = parseKeywords(record.keywords_json)
        return (
          <div>
            <Paragraph
              type="secondary"
              style={{
                fontSize: 11,
                margin: 0,
                maxHeight: 40,
                overflow: 'hidden',
                lineHeight: 1.5,
              }}
            >
              {summary || t('kms.knowledge.noSummary')}
            </Paragraph>
            {keywords.length > 0 && (
              <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {keywords.slice(0, 4).map((kw, i) => (
                  <Tag key={i} style={{ fontSize: 10, margin: 0, lineHeight: '14px', padding: '0 3px' }}>
                    {kw}
                  </Tag>
                ))}
              </div>
            )}
          </div>
        )
      },
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
      width: 80,
      render: (_: any, record: FileSummaryItem) => (
        <Space size={2}>
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
      ),
    },
  ], [t, token, onOpenFile, onOpenFileDir])

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
        <Space size={6}>
          <Text strong style={{ fontSize: 14 }}>{t('kms.knowledge.title')}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('kms.knowledge.subtitle')}
          </Text>
        </Space>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={handleReload}
          loading={isLoadingSummaries}
        >
          {t('common.refresh')}
        </Button>
      </div>

      {/* 目录摘要 */}
      <div style={{ flexShrink: 0, maxHeight: '40%', overflow: 'auto' }}>
        {renderDirSummaries()}
      </div>

      {/* 文件摘要筛选 */}
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
          style={{ width: 200 }}
        />
        <Select
          size="small"
          style={{ width: 160 }}
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
            scroll={{ x: 'max-content' }}
          />
        </Spin>
      </div>
    </div>
  )
}

export default KMSKnowledgeView
