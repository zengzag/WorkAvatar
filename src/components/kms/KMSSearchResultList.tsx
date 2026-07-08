import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Tag, Typography, Space, Tooltip, Button, theme, Pagination } from 'antd'
import { FileTextOutlined, FilePdfOutlined, FileExcelOutlined, FileWordOutlined, FileMarkdownOutlined, FileOutlined, CodeOutlined, FolderOpenOutlined, EyeOutlined } from '@ant-design/icons'
import HighlightText from './HighlightText'

const { Text } = Typography

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
        <Space size={6} style={{ flex: 1, minWidth: 0 }}>
          {getFileIcon(bestItem.file_name, token)}
          <Text strong style={{ fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => onPreview(bestItem)} title={bestItem.file_name}>
            {truncateMiddleName(bestItem.file_name, 36)}
          </Text>
          <Tag color={matchConfig.color} style={{ fontSize: 11 }}>{t(matchConfig.labelKey)}</Tag>
        </Space>
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

      <Tooltip title={bestItem.file_path}>
        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }} ellipsis>{bestItem.file_path}</Text>
      </Tooltip>

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

  const renderPagination = () => {
    if (totalItems <= pageSize) return null
    return (
      <div style={{ textAlign: 'center', marginTop: 12 }}>
        <Pagination
          size="small"
          current={currentPage}
          pageSize={pageSize}
          total={totalItems}
          onChange={handlePageChange}
          showSizeChanger
          pageSizeOptions={[10, 20, 50, 100]}
        />
      </div>
    )
  }

  // 文件搜索模式：展示简单的文件列表
  if (searchMode === 'file') {
    const startIdx = (currentPage - 1) * pageSize
    const pagedResults = results.slice(startIdx, startIdx + pageSize)

    return (
      <div>
        <div ref={topSentinelRef} />
        <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('kms.resultCount', { count: results.length })}
          </Text>
        </div>
        {pagedResults.map((item) => {
          const matchConfig = MATCH_TYPE_CONFIG[item.match_type] || { color: 'default', labelKey: 'kms.matchContent' }
          return (
            <Card
              key={item.file_id}
              size="small"
              style={{ marginBottom: 6, borderLeft: `3px solid ${token.colorPrimary}` }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Space size={6} style={{ flex: 1, minWidth: 0 }}>
                  {getFileIcon(item.file_name, token)}
                  <Text strong style={{ fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => onPreview(item)} title={item.file_name}>
                    <HighlightText text={truncateMiddleName(item.file_name, 36)} keywords={searchKeywords} />
                  </Text>
                  <Tag color={matchConfig.color} style={{ fontSize: 11, flexShrink: 0 }}>{t(matchConfig.labelKey)}</Tag>
                </Space>
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
              <Tooltip title={item.file_path}>
                <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }} ellipsis>{item.file_path}</Text>
              </Tooltip>
            </Card>
          )
        })}
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
