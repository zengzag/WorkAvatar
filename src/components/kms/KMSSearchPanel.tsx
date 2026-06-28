import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Input, Button, Radio, Card, Tag, Empty, Spin, Typography, Space, Tooltip,
  Collapse, Select, DatePicker, Popover, List, theme,
} from 'antd'
import {
  SearchOutlined, FileTextOutlined, FilePdfOutlined, FileExcelOutlined,
  FileWordOutlined, FileMarkdownOutlined, FileOutlined, CodeOutlined,
  FolderOpenOutlined, EyeOutlined, FilterOutlined, RobotOutlined,
  BulbOutlined, CompressOutlined, RiseOutlined, AimOutlined,
  HistoryOutlined, DeleteOutlined,
} from '@ant-design/icons'
import HighlightText from './HighlightText'
import type { SearchFilters, AgentSearchResult, AgentSearchSource, SearchTraceStep, SearchHistoryItem } from '../../hooks/useKMS'

const { Text, Paragraph } = Typography
const { RangePicker } = DatePicker

interface HighlightRange {
  start: number
  end: number
}

interface SearchResult {
  file_id: string
  file_name: string
  file_path: string
  paragraph_id?: string
  paragraph_title?: string
  text: string
  match_type: string
  start_offset?: number
  end_offset?: number
  start_line?: number
  end_line?: number
  score?: number
  highlights?: HighlightRange[]
  matched_keywords?: string[]
}

interface IndexDir {
  id: string
  dir_path: string
  display_name: string
  enabled: number
  recursive: number
  file_extensions: string
  created_at: number
  updated_at: number
}

interface KMSSearchPanelProps {
  searchQuery: string
  onSearchQueryChange: (query: string) => void
  searchMode: 'keyword' | 'semantic' | 'hybrid' | 'ai'
  onSearchModeChange: (mode: 'keyword' | 'semantic' | 'hybrid' | 'ai') => void
  searchResults: SearchResult[]
  agentResult: AgentSearchResult | null
  liveSteps: SearchTraceStep[]
  isSearching: boolean
  onSearch: (query: string, mode?: 'keyword' | 'semantic' | 'hybrid' | 'ai', filters?: SearchFilters) => void
  dirs: IndexDir[]
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
  onPreview: (result: SearchResult) => void
  /** 受控的合集筛选；用于跨视图联动（如从合集页"在此合集中搜索"） */
  filterCollectionIds?: string[]
  onFilterCollectionIdsChange?: (ids: string[]) => void
  /** 搜索历史列表（用于输入框聚焦时下拉提示） */
  searchHistory?: SearchHistoryItem[]
  /** 加载搜索历史 */
  onLoadSearchHistory?: (params?: { limit?: number }) => void
  /** 删除单条搜索历史 */
  onDeleteSearchHistory?: (id: string) => void
  /** 清空搜索历史 */
  onClearSearchHistory?: () => void
}

const MATCH_TYPE_CONFIG: Record<string, { color: string; labelKey: string }> = {
  file_title: { color: 'blue', labelKey: 'kms.matchFileTitle' },
  file_summary: { color: 'green', labelKey: 'kms.matchFileSummary' },
  paragraph: { color: 'orange', labelKey: 'kms.matchParagraph' },
  content: { color: 'purple', labelKey: 'kms.matchContent' },
  hybrid: { color: 'cyan', labelKey: 'kms.matchHybrid' },
}

const QUERY_TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode; labelKey: string }> = {
  locate: { color: 'blue', icon: <AimOutlined />, labelKey: 'kms.queryTypeLocate' },
  concept: { color: 'green', icon: <BulbOutlined />, labelKey: 'kms.queryTypeConcept' },
  trend: { color: 'orange', icon: <RiseOutlined />, labelKey: 'kms.queryTypeTrend' },
  analysis: { color: 'purple', icon: <CompressOutlined />, labelKey: 'kms.queryTypeAnalysis' },
}

const FILE_FORMAT_OPTIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'md', 'txt', 'csv', 'json', 'html', 'xml',
  'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h',
]

// 格式化搜索历史时间戳为相对时间
const formatHistoryTime = (timestamp: number) => {
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

const KMSSearchPanel: React.FC<KMSSearchPanelProps> = ({
  searchQuery,
  onSearchQueryChange,
  searchMode,
  onSearchModeChange,
  searchResults,
  agentResult,
  liveSteps,
  isSearching,
  onSearch,
  dirs,
  onOpenFile,
  onOpenFileDir,
  onPreview,
  filterCollectionIds: controlledCollectionIds,
  onFilterCollectionIdsChange,
  searchHistory,
  onLoadSearchHistory,
  onDeleteSearchHistory,
  onClearSearchHistory,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [filterDirIds, setFilterDirIds] = useState<string[]>([])
  const [internalCollectionIds, setInternalCollectionIds] = useState<string[]>([])
  const filterCollectionIds = controlledCollectionIds ?? internalCollectionIds
  const setFilterCollectionIds = (ids: string[]) => {
    if (onFilterCollectionIdsChange) {
      onFilterCollectionIdsChange(ids)
    } else {
      setInternalCollectionIds(ids)
    }
  }
  const [filterExtensions, setFilterExtensions] = useState<string[]>([])
  const [filterTimeRange, setFilterTimeRange] = useState<[number, number] | null>(null)
  const [collectionOptions, setCollectionOptions] = useState<{ label: string; value: string }[]>([])

  // 搜索历史下拉控制
  const [historyOpen, setHistoryOpen] = useState(false)
  const inputRef = useRef<any>(null)

  const dirOptions = useMemo(() => {
    return dirs.map((d) => ({
      label: d.display_name || d.dir_path.split(/[/\\]/).pop() || d.dir_path,
      value: d.id,
    }))
  }, [dirs])

  const formatOptions = useMemo(() => {
    return FILE_FORMAT_OPTIONS.map((ext) => ({ label: ext, value: ext }))
  }, [])

  // 加载合集列表用于筛选
  useEffect(() => {
    let cancelled = false
    window.electronAPI.kms.listCollections().then((result: any[]) => {
      if (cancelled) return
      const opts = (result || []).map((c: any) => ({ label: c.name, value: c.id }))
      setCollectionOptions(opts)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const buildFilters = useCallback((): SearchFilters => {
    const filters: SearchFilters = {}
    if (filterDirIds.length > 0) filters.dirIds = filterDirIds
    if (filterCollectionIds.length > 0) filters.collectionIds = filterCollectionIds
    if (filterExtensions.length > 0) filters.fileExtensions = filterExtensions
    if (filterTimeRange) {
      filters.timeRangeStart = filterTimeRange[0]
      filters.timeRangeEnd = filterTimeRange[1]
    }
    return filters
  }, [filterDirIds, filterCollectionIds, filterExtensions, filterTimeRange])

  const handleSearch = useCallback(() => {
    if (searchQuery.trim()) {
      onSearch(searchQuery.trim(), searchMode, buildFilters())
      setHistoryOpen(false)
    }
  }, [searchQuery, searchMode, onSearch, buildFilters])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isSearching) {
      handleSearch()
    }
  }, [handleSearch, isSearching])

  // 搜索历史相关处理
  // 输入框聚焦时加载历史并展开下拉
  const handleInputFocus = useCallback(() => {
    if (onLoadSearchHistory) {
      onLoadSearchHistory({ limit: 20 })
    }
    // 总是展开下拉：有历史则显示列表，无历史则显示空提示
    setHistoryOpen(true)
  }, [onLoadSearchHistory])

  // 输入框失焦时收起（延迟以便点击下拉项）
  const handleInputBlur = useCallback(() => {
    setTimeout(() => setHistoryOpen(false), 200)
  }, [])

  // 点击历史项：回填到输入框并触发搜索
  const handlePickHistory = useCallback((item: SearchHistoryItem) => {
    onSearchQueryChange(item.query)
    setHistoryOpen(false)
    // 自动用历史项的搜索模式与查询触发一次搜索
    onSearch(item.query, item.search_mode as any, buildFilters())
  }, [onSearchQueryChange, onSearch, buildFilters])

  // 删除单条历史
  const handleDeleteHistory = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (onDeleteSearchHistory) {
      onDeleteSearchHistory(id)
    }
  }, [onDeleteSearchHistory])

  // 清空全部历史
  const handleClearHistory = useCallback(() => {
    if (onClearSearchHistory) {
      onClearSearchHistory()
    }
  }, [onClearSearchHistory])

  // 历史下拉内容
  const renderHistoryContent = () => {
    if (!searchHistory || searchHistory.length === 0) {
      return (
        <div style={{ width: 380, padding: '12px 16px', textAlign: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.noHistory')}</Text>
        </div>
      )
    }
    return (
      <div style={{ width: 380, maxHeight: 360, overflow: 'auto', padding: '4px 0' }}>
        <List
          size="small"
          split={false}
          dataSource={searchHistory}
          renderItem={(item) => (
            <List.Item
              style={{ padding: '6px 12px', cursor: 'pointer', border: 'none' }}
              onClick={() => handlePickHistory(item)}
            >
              <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8 }}>
                <HistoryOutlined style={{ color: token.colorTextQuaternary, flexShrink: 0 }} />
                <Text ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12 }}>{item.query}</Text>
                <Tag style={{ fontSize: 10, margin: 0, flexShrink: 0 }}>{item.result_count}{t('kms.historyResultsUnit')}</Tag>
                <Text type="secondary" style={{ fontSize: 10, flexShrink: 0 }}>{formatHistoryTime(item.created_at)}</Text>
                {onDeleteSearchHistory && (
                  <Tooltip title={t('common.delete')}>
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={(e) => handleDeleteHistory(e, item.id)}
                      style={{ flexShrink: 0 }}
                    />
                  </Tooltip>
                )}
              </div>
            </List.Item>
          )}
        />
        {onClearSearchHistory && (
          <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: '6px 12px', textAlign: 'right' }}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={handleClearHistory}>
              {t('kms.clearHistory')}
            </Button>
          </div>
        )}
      </div>
    )
  }

  const handleTimeRangeChange = useCallback((dates: any) => {
    if (dates && dates[0] && dates[1]) {
      setFilterTimeRange([
        dates[0].startOf('day').valueOf(),
        dates[1].endOf('day').valueOf(),
      ])
    } else {
      setFilterTimeRange(null)
    }
  }, [])

  const handleSourcePreview = useCallback((source: AgentSearchSource) => {
    // 将 AgentSearchSource 转换为 SearchResult 格式以便预览
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

  // 从搜索查询中提取关键词用于高亮
  const searchKeywords = useMemo(() => {
    if (!searchQuery.trim()) return []
    return searchQuery.trim().split(/\s+/).filter(kw => kw.length > 0)
  }, [searchQuery])

  const renderScoreBar = (score?: number) => {
    if (score === undefined || score === null) return null
    const percent = Math.min(Math.round(score * 100), 100)
    return (
      <Tooltip title={`Score: ${score.toFixed(3)}`}>
        <div style={{
          width: 60,
          height: 6,
          borderRadius: 3,
          backgroundColor: token.colorFillSecondary,
          overflow: 'hidden',
        }}>
          <div style={{
            width: `${percent}%`,
            height: '100%',
            borderRadius: 3,
            backgroundColor: token.colorPrimary,
            transition: 'width 0.3s',
          }} />
        </div>
      </Tooltip>
    )
  }

  const renderResultItem = (item: SearchResult, index: number) => {
    const matchConfig = MATCH_TYPE_CONFIG[item.match_type] || { color: 'default', labelKey: 'kms.matchContent' }

    return (
      <Card
        key={`${item.file_id}-${item.paragraph_id || index}`}
        size="small"
        style={{
          marginBottom: 8,
          borderLeft: `3px solid ${token.colorPrimary}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <Space size={6} style={{ flex: 1, minWidth: 0 }}>
            {getFileIcon(item.file_name)}
            <Text
              strong
              style={{ fontSize: 13, cursor: 'pointer' }}
              ellipsis
              onClick={() => onPreview(item)}
              title={t('kms.preview')}
            >
              {item.file_name}
            </Text>
            <Tag color={matchConfig.color} style={{ fontSize: 11 }}>
              {t(matchConfig.labelKey)}
            </Tag>
          </Space>
          {searchMode === 'hybrid' && renderScoreBar(item.score)}
        </div>

        <Tooltip title={item.file_path}>
          <Text
            type="secondary"
            style={{ fontSize: 11, display: 'block', marginBottom: 6 }}
            ellipsis
          >
            {item.file_path}
          </Text>
        </Tooltip>

        {item.paragraph_title && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
            {item.paragraph_title}
          </Text>
        )}

        <div style={{
          fontSize: 12,
          color: token.colorTextSecondary,
          lineHeight: 1.6,
          marginBottom: 6,
          maxHeight: 80,
          overflow: 'hidden',
        }}>
          <HighlightText
            text={item.text}
            highlights={item.highlights}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
          <Space size={4} wrap>
            {item.start_line !== undefined && item.end_line !== undefined && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                L{item.start_line}-{item.end_line}
              </Text>
            )}
            {item.matched_keywords && item.matched_keywords.length > 0 && (
              <Space size={2} wrap>
                {item.matched_keywords.slice(0, 5).map((kw, i) => (
                  <Tag key={i} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>
                    {kw}
                  </Tag>
                ))}
              </Space>
            )}
          </Space>
          <Space size={4}>
            <Tooltip title={t('kms.openFile')}>
              <Button
                size="small"
                type="text"
                icon={<FileOutlined />}
                onClick={() => onOpenFile(item.file_path)}
              />
            </Tooltip>
            <Tooltip title={t('kms.openDir')}>
              <Button
                size="small"
                type="text"
                icon={<FolderOpenOutlined />}
                onClick={() => onOpenFileDir(item.file_path)}
              />
            </Tooltip>
            <Tooltip title={t('kms.preview')}>
              <Button
                size="small"
                type="text"
                icon={<EyeOutlined />}
                onClick={() => onPreview(item)}
              />
            </Tooltip>
          </Space>
        </div>
      </Card>
    )
  }

  const renderAgentResult = () => {
    if (!agentResult) return null

    const typeConfig = QUERY_TYPE_CONFIG[agentResult.queryType] || QUERY_TYPE_CONFIG.locate

    return (
      <div>
        {/* AI 结论卡片 */}
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
              <Text strong style={{ fontSize: 13 }}>
                {t('kms.aiConclusion')}
              </Text>
              <Tag color={typeConfig.color} style={{ fontSize: 11 }}>
                {typeConfig.icon}
                <span style={{ marginLeft: 4 }}>{t(typeConfig.labelKey)}</span>
              </Tag>
            </Space>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('kms.searchRounds', { count: agentResult.searchRounds })}
            </Text>
          </div>

          <Paragraph
            style={{
              fontSize: 13,
              lineHeight: 1.7,
              margin: 0,
              whiteSpace: 'pre-wrap',
            }}
          >
            <HighlightText
              text={agentResult.conclusion}
              keywords={searchKeywords}
            />
          </Paragraph>
        </Card>

        {/* 溯源信息 */}
        {agentResult.sources.length > 0 && (
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
              {t('kms.sources', { count: agentResult.sources.length })}
            </Text>
            {agentResult.sources.map((source, index) => (
              <Card
                key={`${source.fileId}-${index}`}
                size="small"
                style={{
                  marginBottom: 6,
                  borderLeft: `2px solid ${token.colorBorder}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <Space size={6} style={{ flex: 1, minWidth: 0 }}>
                    <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                      [{index + 1}]
                    </Text>
                    {getFileIcon(source.fileName)}
                    <Text
                      strong
                      style={{ fontSize: 12, cursor: 'pointer' }}
                      ellipsis
                      onClick={() => handleSourcePreview(source)}
                      title={t('kms.preview')}
                    >
                      <HighlightText text={source.fileName} keywords={searchKeywords} />
                    </Text>
                    {source.paragraphTitle && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        <HighlightText text={source.paragraphTitle} keywords={searchKeywords} />
                      </Text>
                    )}
                  </Space>
                  <Space size={2}>
                    <Tooltip title={t('kms.preview')}>
                      <Button
                        size="small"
                        type="text"
                        icon={<EyeOutlined />}
                        onClick={() => handleSourcePreview(source)}
                      />
                    </Tooltip>
                    <Tooltip title={t('kms.openFile')}>
                      <Button
                        size="small"
                        type="text"
                        icon={<FileOutlined />}
                        onClick={() => onOpenFile(source.filePath)}
                      />
                    </Tooltip>
                    <Tooltip title={t('kms.openDir')}>
                      <Button
                        size="small"
                        type="text"
                        icon={<FolderOpenOutlined />}
                        onClick={() => onOpenFileDir(source.filePath)}
                      />
                    </Tooltip>
                  </Space>
                </div>

                <Tooltip title={source.filePath}>
                  <Text
                    type="secondary"
                    style={{ fontSize: 10, display: 'block', marginTop: 4 }}
                    ellipsis
                  >
                    {source.filePath}
                  </Text>
                </Tooltip>

                <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  {source.startLine !== undefined && source.endLine !== undefined && (
                    <Text type="secondary" style={{ fontSize: 10 }}>
                      L{source.startLine}-{source.endLine}
                    </Text>
                  )}
                  {source.startOffset !== undefined && source.endOffset !== undefined && (
                    <Text type="secondary" style={{ fontSize: 10 }}>
                      off:{source.startOffset}-{source.endOffset}
                    </Text>
                  )}
                </div>

                {source.snippet && (
                  <div style={{
                    fontSize: 11,
                    color: token.colorTextTertiary,
                    marginTop: 4,
                    lineHeight: 1.5,
                    maxHeight: 40,
                    overflow: 'hidden',
                  }}>
                    <HighlightText text={source.snippet} keywords={searchKeywords} />
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}

        {/* 检索过程（可折叠，展示结构化中间步骤） */}
        {((agentResult.searchSteps && agentResult.searchSteps.length > 0) || agentResult.searchTrace.length > 0) && (
          <Collapse
            size="small"
            style={{ marginTop: 12 }}
            items={[{
              key: 'trace',
              label: (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {t('kms.searchTrace')}
                </Text>
              ),
              children: (
                <div style={{ fontSize: 11, lineHeight: 1.6 }}>
                  {(agentResult.searchSteps || []).map((step, i) => {
                    const typeColors: Record<string, string> = {
                      info: token.colorTextTertiary,
                      llm: '#722ed1',
                      search: '#1677ff',
                      read: '#fa8c16',
                      plan: '#13c2c2',
                      result: '#52c41a',
                    }
                    return (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 6,
                          padding: '3px 0',
                          borderBottom: `1px solid ${token.colorBorderSecondary}`,
                        }}
                      >
                        <span style={{ color: typeColors[step.type] || token.colorTextTertiary, flexShrink: 0 }}>
                          [{step.phase}]
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ color: token.colorTextSecondary }}>{step.action}</span>
                          {step.detail && (
                            <span style={{ color: token.colorTextTertiary, marginLeft: 4 }}>— {step.detail}</span>
                          )}
                          {step.durationMs !== undefined && (
                            <span style={{ color: token.colorTextQuaternary, marginLeft: 6 }}>{step.durationMs}ms</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {/* 兼容旧格式 */}
                  {(!agentResult.searchSteps || agentResult.searchSteps.length === 0) &&
                    agentResult.searchTrace.map((trace, i) => (
                      <div key={`old-${i}`} style={{ color: token.colorTextTertiary }}>• {trace}</div>
                    ))
                  }
                </div>
              ),
            }]}
          />
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 搜索输入栏（聚焦时弹出搜索历史下拉） */}
      <div style={{ marginBottom: 12 }}>
        <Popover
          content={renderHistoryContent()}
          trigger="click"
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          placement="bottomLeft"
          overlayInnerStyle={{ padding: 0 }}
          overlayStyle={{ paddingTop: 4 }}
        >
          <Input
            ref={inputRef}
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            placeholder={t('kms.searchPlaceholder')}
            size="large"
            prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
            suffix={
              <Space size={4}>
                {searchHistory && searchHistory.length > 0 && (
                  <Tooltip title={t('kms.searchHistory')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<HistoryOutlined />}
                      onClick={() => setHistoryOpen((v) => !v)}
                    />
                  </Tooltip>
                )}
                <Button
                  type="primary"
                  size="small"
                  icon={searchMode === 'ai' ? <RobotOutlined /> : <SearchOutlined />}
                  onClick={handleSearch}
                  loading={isSearching}
                >
                  {t('kms.search')}
                </Button>
              </Space>
            }
          />
        </Popover>
      </div>

      {/* 搜索模式 + 高级筛选 */}
      <div style={{ marginBottom: 12 }}>
        <Radio.Group
          value={searchMode}
          onChange={(e) => onSearchModeChange(e.target.value)}
          optionType="button"
          buttonStyle="solid"
          size="small"
          style={{ marginBottom: 8 }}
        >
          <Radio.Button value="keyword">{t('kms.keywordSearch')}</Radio.Button>
          <Radio.Button value="semantic">{t('kms.semanticSearch')}</Radio.Button>
          <Radio.Button value="hybrid">{t('kms.hybridSearch')}</Radio.Button>
          <Radio.Button value="ai">
            <RobotOutlined style={{ marginRight: 4 }} />
            {t('kms.aiSearch')}
          </Radio.Button>
        </Radio.Group>

        <Collapse
          size="small"
          items={[{
            key: 'filters',
            label: (
              <Space size={4}>
                <FilterOutlined />
                <span>{t('kms.advancedFilters')}</span>
                {(filterDirIds.length > 0 || filterCollectionIds.length > 0 || filterExtensions.length > 0 || filterTimeRange) && (
                  <Tag color="blue" style={{ fontSize: 10, margin: 0, lineHeight: '16px' }}>
                    {filterDirIds.length + filterCollectionIds.length + filterExtensions.length + (filterTimeRange ? 1 : 0)}
                  </Tag>
                )}
              </Space>
            ),
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                    {t('kms.filterDirectory')}
                  </Text>
                  <Select
                    mode="multiple"
                    allowClear
                    style={{ width: '100%' }}
                    placeholder={t('kms.allDirs')}
                    value={filterDirIds}
                    onChange={setFilterDirIds}
                    options={dirOptions}
                    maxTagCount="responsive"
                  />
                </div>
                <div>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                    {t('kms.filterCollection')}
                  </Text>
                  <Select
                    mode="multiple"
                    allowClear
                    style={{ width: '100%' }}
                    placeholder={t('kms.collections.noCollections')}
                    value={filterCollectionIds}
                    onChange={setFilterCollectionIds}
                    options={collectionOptions}
                    maxTagCount="responsive"
                    notFoundContent={t('kms.collections.noCollections')}
                  />
                </div>
                <div>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                    {t('kms.filterFileFormat')}
                  </Text>
                  <Select
                    mode="multiple"
                    allowClear
                    style={{ width: '100%' }}
                    placeholder={t('kms.allFormats')}
                    value={filterExtensions}
                    onChange={setFilterExtensions}
                    options={formatOptions}
                    maxTagCount="responsive"
                  />
                </div>
                <div>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                    {t('kms.filterTimeRange')}
                  </Text>
                  <RangePicker
                    style={{ width: '100%' }}
                    onChange={handleTimeRangeChange}
                  />
                </div>
              </div>
            ),
          }]}
        />
      </div>

      {/* 搜索结果列表 */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {isSearching ? (
          searchMode === 'ai' && liveSteps.length > 0 ? (
            <div style={{ padding: '12px 4px' }}>
              <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Spin size="small" />
                <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.aiSearching')}</Text>
              </div>
              {liveSteps.map((step, i) => {
                const typeColors: Record<string, string> = {
                  info: token.colorTextTertiary,
                  llm: '#722ed1',
                  search: '#1677ff',
                  read: '#fa8c16',
                  plan: '#13c2c2',
                  result: '#52c41a',
                }
                const typeIcons: Record<string, string> = {
                  info: '•',
                  llm: '🤖',
                  search: '🔍',
                  read: '📄',
                  plan: '📋',
                  result: '✓',
                }
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '4px 0',
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: token.colorTextSecondary,
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                    }}
                  >
                    <span style={{ color: typeColors[step.type] || token.colorTextTertiary, flexShrink: 0 }}>
                      {typeIcons[step.type] || '•'}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>
                        <Text style={{ fontSize: 12, fontWeight: 500 }}>{step.action}</Text>
                        {step.durationMs !== undefined && (
                          <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>{step.durationMs}ms</Text>
                        )}
                      </div>
                      {step.detail && (
                        <Text type="secondary" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                          {step.detail}
                        </Text>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: 60 }}>
              <Spin size="large" tip={searchMode === 'ai' ? t('kms.aiSearching') : t('kms.searching')} />
            </div>
          )
        ) : searchMode === 'ai' ? (
          agentResult ? (
            <div>
              {renderAgentResult()}
            </div>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('kms.noAiResult')}
            />
          )
        ) : searchResults.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('kms.noResults')}
          />
        ) : (
          <div>
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('kms.resultCount', { count: searchResults.length })}
              </Text>
            </div>
            {searchResults.map((item, index) => renderResultItem(item, index))}
          </div>
        )}
      </div>
    </div>
  )
}

export default KMSSearchPanel
