import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Input, Button, Radio, Card, Tag, Empty, Spin, Typography, Space, Tooltip,
  Collapse, Select, DatePicker, theme,
} from 'antd'
import {
  SearchOutlined, FileTextOutlined, FilePdfOutlined, FileExcelOutlined,
  FileWordOutlined, FileMarkdownOutlined, FileOutlined, CodeOutlined,
  FolderOpenOutlined, EyeOutlined, FilterOutlined,
} from '@ant-design/icons'
import HighlightText from './HighlightText'
import type { SearchFilters } from '../../hooks/useKMS'

const { Text } = Typography
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
  searchMode: 'keyword' | 'semantic' | 'hybrid'
  onSearchModeChange: (mode: 'keyword' | 'semantic' | 'hybrid') => void
  searchResults: SearchResult[]
  isSearching: boolean
  onSearch: (query: string, mode?: 'keyword' | 'semantic' | 'hybrid', filters?: SearchFilters) => void
  dirs: IndexDir[]
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
  onPreview: (result: SearchResult) => void
}

const MATCH_TYPE_CONFIG: Record<string, { color: string; labelKey: string }> = {
  file_title: { color: 'blue', labelKey: 'kms.matchFileTitle' },
  file_summary: { color: 'green', labelKey: 'kms.matchFileSummary' },
  paragraph: { color: 'orange', labelKey: 'kms.matchParagraph' },
  content: { color: 'purple', labelKey: 'kms.matchContent' },
  hybrid: { color: 'cyan', labelKey: 'kms.matchHybrid' },
}

const FILE_FORMAT_OPTIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'md', 'txt', 'csv', 'json', 'html', 'xml',
  'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h',
]

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
  isSearching,
  onSearch,
  dirs,
  onOpenFile,
  onOpenFileDir,
  onPreview,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [filterDirIds, setFilterDirIds] = useState<string[]>([])
  const [filterExtensions, setFilterExtensions] = useState<string[]>([])
  const [filterTimeRange, setFilterTimeRange] = useState<[number, number] | null>(null)

  const dirOptions = useMemo(() => {
    return dirs.map((d) => ({
      label: d.display_name || d.dir_path.split(/[/\\]/).pop() || d.dir_path,
      value: d.id,
    }))
  }, [dirs])

  const formatOptions = useMemo(() => {
    return FILE_FORMAT_OPTIONS.map((ext) => ({ label: ext, value: ext }))
  }, [])

  const buildFilters = useCallback((): SearchFilters => {
    const filters: SearchFilters = {}
    if (filterDirIds.length > 0) filters.dirIds = filterDirIds
    if (filterExtensions.length > 0) filters.fileExtensions = filterExtensions
    if (filterTimeRange) {
      filters.timeRangeStart = filterTimeRange[0]
      filters.timeRangeEnd = filterTimeRange[1]
    }
    return filters
  }, [filterDirIds, filterExtensions, filterTimeRange])

  const handleSearch = useCallback(() => {
    if (searchQuery.trim()) {
      onSearch(searchQuery.trim(), searchMode, buildFilters())
    }
  }, [searchQuery, searchMode, onSearch, buildFilters])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isSearching) {
      handleSearch()
    }
  }, [handleSearch, isSearching])

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 搜索输入栏 */}
      <div style={{ marginBottom: 12 }}>
        <Input
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('kms.searchPlaceholder')}
          size="large"
          prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
          suffix={
            <Button
              type="primary"
              size="small"
              icon={<SearchOutlined />}
              onClick={handleSearch}
              loading={isSearching}
            >
              {t('kms.search')}
            </Button>
          }
        />
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
        </Radio.Group>

        <Collapse
          size="small"
          items={[{
            key: 'filters',
            label: (
              <Space size={4}>
                <FilterOutlined />
                <span>{t('kms.advancedFilters')}</span>
                {(filterDirIds.length > 0 || filterExtensions.length > 0 || filterTimeRange) && (
                  <Tag color="blue" style={{ fontSize: 10, margin: 0, lineHeight: '16px' }}>
                    {filterDirIds.length + filterExtensions.length + (filterTimeRange ? 1 : 0)}
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
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin size="large" />
          </div>
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
