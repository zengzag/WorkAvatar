import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Tag, Typography, Space, Tooltip, Button, theme, Pagination } from 'antd'
import { FileTextOutlined, FilePdfOutlined, FileExcelOutlined, FileWordOutlined, FileMarkdownOutlined, FileOutlined, CodeOutlined, FolderOpenOutlined, EyeOutlined, ClockCircleOutlined } from '@ant-design/icons'
import HighlightText from './HighlightText'
import { formatTime } from './kms-columns'

const { Text } = Typography

/**
 * 根据容器宽度动态计算文件名最大显示字符数。
 * - 容器越宽，maxLen 越大，中间省略号两侧的字符显示越多
 * - 通过 ResizeObserver 监听容器宽度变化
 */
function useDynamicMaxLen(
  ref: React.RefObject<HTMLElement | null>,
  options?: {
    /** 容器中其他元素占用的预留宽度（图标、tag、按钮等） */
    reservedWidth?: number
    /** 平均字符宽度（px），用于估算可显示字符数 */
    charWidth?: number
    /** 最小字符数 */
    minLen?: number
    /** 最大字符数 */
    maxLen?: number
    /** SSR/初次渲染前的默认值 */
    defaultLen?: number
  }
): number {
  const {
    reservedWidth = 0,
    charWidth = 9,
    minLen = 12,
    maxLen = 80,
    defaultLen = 36,
  } = options || {}
  const [maxLenState, setMaxLenState] = useState(defaultLen)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const width = el.clientWidth
      const available = Math.max(width - reservedWidth, 0)
      const calculated = Math.floor(available / charWidth)
      setMaxLenState(Math.max(minLen, Math.min(maxLen, calculated)))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, reservedWidth, charWidth, minLen, maxLen, defaultLen])

  return maxLenState
}

/** 文件名过长时中间截断，保留扩展名可见 */
function truncateMiddleName(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name
  const dotIdx = name.lastIndexOf('.')
  const ext = dotIdx > 0 ? name.slice(dotIdx) : ''
  const base = dotIdx > 0 ? name.slice(0, dotIdx) : name
  const avail = maxLen - ext.length - 3
  if (avail <= 2) return name.slice(0, maxLen - 3) + '...'
  const half = Math.floor(avail / 2)
  return base.slice(0, half) + '...' + base.slice(-(avail - half)) + ext
}

const MATCH_TYPE_CONFIG: Record<string, { color: string; labelKey: string }> = {
  file_title: { color: 'blue', labelKey: 'kms.matchFileTitle' },
  file_summary: { color: 'green', labelKey: 'kms.matchFileSummary' },
  paragraph: { color: 'orange', labelKey: 'kms.matchParagraph' },
  content: { color: 'purple', labelKey: 'kms.matchContent' },
  hybrid: { color: 'cyan', labelKey: 'kms.matchHybrid' },
  file_name: { color: 'geekblue', labelKey: 'kms.matchFileName' },
}

interface HighlightRange { start: number; end: number }

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
  /** 文件最后修改时间（unix 秒） */
  modified_time?: number
}

const getFileIcon = (fileName: string, token: any) => {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'pdf': return <FilePdfOutlined style={{ color: token.colorError }} />
    case 'doc': case 'docx': return <FileWordOutlined style={{ color: token.colorPrimary }} />
    case 'xls': case 'xlsx': return <FileExcelOutlined style={{ color: token.colorSuccess }} />
    case 'md': case 'markdown': return <FileMarkdownOutlined style={{ color: token.colorInfo }} />
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'py': case 'java': case 'go': case 'rs': case 'c': case 'cpp': case 'h':
      return <CodeOutlined style={{ color: token.colorWarning }} />
    case 'txt': case 'log': return <FileTextOutlined style={{ color: token.colorTextTertiary }} />
    default: return <FileOutlined style={{ color: token.colorTextTertiary }} />
  }
}

interface KMSSearchResultListProps {
  results: SearchResult[]
  searchMode: string
  searchQuery: string
  onPreview: (result: SearchResult) => void
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
}

const FileResultCard: React.FC<{
  fileResults: SearchResult[]
  searchMode: string
  token: any
  t: (key: string, options?: any) => string
  onPreview: (result: SearchResult) => void
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
}> = React.memo(({ fileResults, searchMode, token, t, onPreview, onOpenFile, onOpenFileDir }) => {
  // 只展示最匹配的那一个结果（按 score 排序取最高分）
  const bestItem = fileResults[0]
  const matchConfig = MATCH_TYPE_CONFIG[bestItem.match_type] || { color: 'default', labelKey: 'kms.matchContent' }

  // 容器宽度自适应的文件名最大字符数：左侧 Space 内已包含图标(~14px) + tag(~70px) + gaps(~12px)
  const headerLeftRef = useRef<HTMLDivElement | null>(null)
  const maxLen = useDynamicMaxLen(headerLeftRef, {
    reservedWidth: 160,
    minLen: 12,
    maxLen: 60,
    defaultLen: 30,
  })

  const renderScoreBar = (score?: number) => {
    if (score === undefined || score === null) return null
    const percent = Math.min(Math.round(score * 100), 100)
    return (
      <Tooltip title={`Score: ${score.toFixed(3)}`}>
        <div style={{ width: 60, height: 6, borderRadius: 3, backgroundColor: token.colorFillSecondary, overflow: 'hidden' }}>
          <div style={{ width: `${percent}%`, height: '100%', borderRadius: 3, backgroundColor: token.colorPrimary, transition: 'width 0.3s' }} />
        </div>
      </Tooltip>
    )
  }

  return (
    <Card
      size="small"
      style={{ marginBottom: 8, borderLeft: `3px solid ${token.colorPrimary}` }}
    >
      {/* 文件信息头部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div ref={headerLeftRef} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          {getFileIcon(bestItem.file_name, token)}
          <Text strong style={{ fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => onPreview(bestItem)} title={bestItem.file_name}>
            {truncateMiddleName(bestItem.file_name, maxLen)}
          </Text>
          <Tag color={matchConfig.color} style={{ fontSize: 11, flexShrink: 0 }}>{t(matchConfig.labelKey)}</Tag>
        </div>
        <Space size={4}>
          <Tooltip title={t('kms.openFile')}>
            <Button size="small" type="text" icon={<FileOutlined />} onClick={() => onOpenFile(bestItem.file_path)} />
          </Tooltip>
          <Tooltip title={t('kms.openDir')}>
            <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => onOpenFileDir(bestItem.file_path)} />
          </Tooltip>
          <Tooltip title={t('kms.preview')}>
            <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => onPreview(bestItem)} />
          </Tooltip>
        </Space>
      </div>

      {searchMode === 'hybrid' && renderScoreBar(bestItem.score)}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Tooltip title={bestItem.file_path}>
            <Text type="secondary" style={{ fontSize: 11 }} ellipsis>{bestItem.file_path}</Text>
          </Tooltip>
        </div>
        {bestItem.modified_time !== undefined && bestItem.modified_time > 0 && (
          <Tooltip title={t('kms.lastModified')}>
            <Text type="secondary" style={{ fontSize: 11, flexShrink: 0, whiteSpace: 'nowrap' }}>
              <ClockCircleOutlined style={{ marginRight: 4 }} />
              {formatTime(bestItem.modified_time)}
            </Text>
          </Tooltip>
        )}
      </div>

      {/* 最匹配的内容预览 */}
      <div
        style={{
          padding: '6px 8px',
          borderRadius: 4,
          backgroundColor: token.colorFillTertiary,
          cursor: 'pointer',
        }}
        onClick={() => onPreview(bestItem)}
      >
        {bestItem.paragraph_title && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>{bestItem.paragraph_title}</Text>
        )}
        <div style={{ fontSize: 12, color: token.colorTextSecondary, lineHeight: 1.6, maxHeight: 60, overflow: 'hidden' }}>
          <HighlightText text={bestItem.text} highlights={bestItem.highlights} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
          {bestItem.start_line !== undefined && bestItem.end_line !== undefined && (
            <Text type="secondary" style={{ fontSize: 10 }}>L{bestItem.start_line}-{bestItem.end_line}</Text>
          )}
          {bestItem.matched_keywords && bestItem.matched_keywords.length > 0 && (
            <Space size={2} wrap>
              {bestItem.matched_keywords.slice(0, 3).map((kw) => (
                <Tag key={kw} style={{ fontSize: 9, lineHeight: '14px', padding: '0 3px', margin: 0 }}>{kw}</Tag>
              ))}
            </Space>
          )}
        </div>
      </div>
    </Card>
  )
})

const FileNameResultCard: React.FC<{
  item: SearchResult
  token: any
  t: (key: string, options?: any) => string
  searchKeywords: string[]
  onPreview: (result: SearchResult) => void
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
}> = React.memo(({ item, token, t, searchKeywords, onPreview, onOpenFile, onOpenFileDir }) => {
  const matchConfig = MATCH_TYPE_CONFIG[item.match_type] || { color: 'default', labelKey: 'kms.matchContent' }

  // 容器宽度自适应的文件名最大字符数：左侧 Space 内已包含图标(~14px) + tag(~70px) + gaps(~12px)
  const headerLeftRef = useRef<HTMLDivElement | null>(null)
  const maxLen = useDynamicMaxLen(headerLeftRef, {
    reservedWidth: 120,
    minLen: 12,
    maxLen: 60,
    defaultLen: 30,
  })

  return (
    <Card
      size="small"
      style={{ marginBottom: 6, borderLeft: `3px solid ${token.colorPrimary}` }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div ref={headerLeftRef} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          {getFileIcon(item.file_name, token)}
          <Text strong style={{ fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => onPreview(item)} title={item.file_name}>
            <HighlightText text={truncateMiddleName(item.file_name, maxLen)} keywords={searchKeywords} />
          </Text>
          <Tag color={matchConfig.color} style={{ fontSize: 11, flexShrink: 0 }}>{t(matchConfig.labelKey)}</Tag>
        </div>
        <Space size={4} style={{ flexShrink: 0 }}>
          <Tooltip title={t('kms.openFile')}>
            <Button size="small" type="text" icon={<FileOutlined />} onClick={() => onOpenFile(item.file_path)} />
          </Tooltip>
          <Tooltip title={t('kms.openDir')}>
            <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => onOpenFileDir(item.file_path)} />
          </Tooltip>
          <Tooltip title={t('kms.preview')}>
            <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => onPreview(item)} />
          </Tooltip>
        </Space>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Tooltip title={item.file_path}>
            <Text type="secondary" style={{ fontSize: 11 }} ellipsis>{item.file_path}</Text>
          </Tooltip>
        </div>
        {item.modified_time !== undefined && item.modified_time > 0 && (
          <Tooltip title={t('kms.lastModified')}>
            <Text type="secondary" style={{ fontSize: 11, flexShrink: 0, whiteSpace: 'nowrap' }}>
              <ClockCircleOutlined style={{ marginRight: 4 }} />
              {formatTime(item.modified_time)}
            </Text>
          </Tooltip>
        )}
      </div>
    </Card>
  )
})

const KMSSearchResultList: React.FC<KMSSearchResultListProps> = ({
  results,
  searchMode,
  searchQuery,
  onPreview,
  onOpenFile,
  onOpenFileDir,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const topSentinelRef = useRef<HTMLDivElement>(null)

  // 按 file_id 分组合并结果
  const groupedResults = useMemo(() => {
    const groups = new Map<string, SearchResult[]>()
    for (const item of results) {
      if (!groups.has(item.file_id)) {
        groups.set(item.file_id, [])
      }
      groups.get(item.file_id)!.push(item)
    }
    return Array.from(groups.entries())
  }, [results])

  const searchKeywords = useMemo(() => {
    return searchQuery.trim().split(/\s+/).filter(kw => kw.length > 0)
  }, [searchQuery])

  // 搜索结果变化时重置到第一页
  useEffect(() => {
    setCurrentPage(1)
  }, [results])

  // 翻页时滚动到顶部
  const handlePageChange = useCallback((page: number, size: number) => {
    setCurrentPage(page)
    setPageSize(size)
    // 延迟到下次渲染后滚动，确保 DOM 已更新
    setTimeout(() => {
      if (topSentinelRef.current) {
        topSentinelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }, 0)
  }, [])

  const totalItems = searchMode === 'file' ? results.length : groupedResults.length
  // 文件搜索模式需要按 file_id 去重后才能得到正确的 total，避免与分页逻辑不一致
  const totalItemsForFileMode = useMemo(() => {
    if (searchMode !== 'file') return 0
    return new Set(results.map(r => r.file_id)).size
  }, [searchMode, results])

  const renderPagination = () => {
    const total = searchMode === 'file' ? totalItemsForFileMode : totalItems
    if (total <= pageSize) return null
    return (
      <div style={{ textAlign: 'center', marginTop: 12 }}>
        <Pagination
          size="small"
          current={currentPage}
          pageSize={pageSize}
          total={total}
          onChange={handlePageChange}
          showSizeChanger
          pageSizeOptions={[10, 20, 50, 100]}
        />
      </div>
    )
  }

  // 文件搜索模式：展示简单的文件列表
  if (searchMode === 'file') {
    // 按 file_id 去重，避免同文件多条记录（不同 match_type/历史缓存等）造成 React key 重复警告
    const dedupedResults: SearchResult[] = []
    const seenFileIds = new Set<string>()
    for (const item of results) {
      if (seenFileIds.has(item.file_id)) continue
      seenFileIds.add(item.file_id)
      dedupedResults.push(item)
    }
    const startIdx = (currentPage - 1) * pageSize
    const pagedResults = dedupedResults.slice(startIdx, startIdx + pageSize)

    return (
      <div>
        <div ref={topSentinelRef} />
        <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('kms.resultCount', { count: dedupedResults.length })}
          </Text>
        </div>
        {pagedResults.map((item) => (
          <FileNameResultCard
            key={item.file_id}
            item={item}
            token={token}
            t={t}
            searchKeywords={searchKeywords}
            onPreview={onPreview}
            onOpenFile={onOpenFile}
            onOpenFileDir={onOpenFileDir}
          />
        ))}
        {renderPagination()}
      </div>
    )
  }

  // 非文件搜索模式：按文件合并展示
  const startIdx = (currentPage - 1) * pageSize
  const pagedGroupedResults = groupedResults.slice(startIdx, startIdx + pageSize)

  return (
    <div>
      <div ref={topSentinelRef} />
      <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('kms.resultCount', { count: groupedResults.length })}
        </Text>
      </div>
      {pagedGroupedResults.map(([fileId, fileResults]) => (
        <FileResultCard
          key={fileId}
          fileResults={fileResults}
          searchMode={searchMode}
          token={token}
          t={t}
          onPreview={onPreview}
          onOpenFile={onOpenFile}
          onOpenFileDir={onOpenFileDir}
        />
      ))}
      {renderPagination()}
    </div>
  )
}

export default KMSSearchResultList
