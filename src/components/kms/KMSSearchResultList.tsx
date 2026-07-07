import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Tag, Typography, Space, Tooltip, Button, theme } from 'antd'
import { FileTextOutlined, FilePdfOutlined, FileExcelOutlined, FileWordOutlined, FileMarkdownOutlined, FileOutlined, CodeOutlined, FolderOpenOutlined, EyeOutlined } from '@ant-design/icons'
import HighlightText from './HighlightText'

const { Text } = Typography

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
  fileId: string
  fileResults: SearchResult[]
  searchMode: string
  searchKeywords: string[]
  token: any
  t: (key: string, options?: any) => string
  onPreview: (result: SearchResult) => void
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
}> = ({ fileId, fileResults, searchMode, searchKeywords, token, t, onPreview, onOpenFile, onOpenFileDir }) => {
  const firstItem = fileResults[0]
  const matchConfig = MATCH_TYPE_CONFIG[firstItem.match_type] || { color: 'default', labelKey: 'kms.matchContent' }
  const hasMultiple = fileResults.length > 1
  const [expanded, setExpanded] = useState(!hasMultiple)

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
          {getFileIcon(firstItem.file_name, token)}
          <Text strong style={{ fontSize: 13, cursor: 'pointer' }} ellipsis onClick={() => onPreview(firstItem)} title={t('kms.preview')}>
            {firstItem.file_name}
          </Text>
          <Tag color={matchConfig.color} style={{ fontSize: 11 }}>{t(matchConfig.labelKey)}</Tag>
          {hasMultiple && (
            <Tag color="default" style={{ fontSize: 11 }}>
              {t('kms.matchCount', { count: fileResults.length })}
            </Tag>
          )}
        </Space>
        <Space size={4}>
          <Tooltip title={t('kms.openFile')}>
            <Button size="small" type="text" icon={<FileOutlined />} onClick={() => onOpenFile(firstItem.file_path)} />
          </Tooltip>
          <Tooltip title={t('kms.openDir')}>
            <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => onOpenFileDir(firstItem.file_path)} />
          </Tooltip>
          <Tooltip title={t('kms.preview')}>
            <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => onPreview(firstItem)} />
          </Tooltip>
        </Space>
      </div>

      {searchMode === 'hybrid' && renderScoreBar(firstItem.score)}

      <Tooltip title={firstItem.file_path}>
        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }} ellipsis>{firstItem.file_path}</Text>
      </Tooltip>

      {/* 匹配内容列表 */}
      {hasMultiple && (
        <div style={{ marginBottom: 4 }}>
          <Button
            type="link"
            size="small"
            style={{ padding: 0, fontSize: 12 }}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? t('common.collapse') : t('common.expand')}
          </Button>
        </div>
      )}

      {(!hasMultiple || expanded) && fileResults.map((item, idx) => (
        <div
          key={`${item.file_id}-${item.paragraph_id || idx}`}
          style={{
            padding: '6px 8px',
            marginBottom: idx < fileResults.length - 1 ? 6 : 0,
            borderRadius: 4,
            backgroundColor: idx % 2 === 0 ? token.colorFillTertiary : 'transparent',
            cursor: 'pointer',
          }}
          onClick={() => onPreview(item)}
        >
          {hasMultiple && (
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
              {t('kms.matchItem', { index: idx + 1 })}
            </Text>
          )}
          {item.paragraph_title && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>{item.paragraph_title}</Text>
          )}
          <div style={{ fontSize: 12, color: token.colorTextSecondary, lineHeight: 1.6, maxHeight: 60, overflow: 'hidden' }}>
            <HighlightText text={item.text} highlights={item.highlights} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
            {item.start_line !== undefined && item.end_line !== undefined && (
              <Text type="secondary" style={{ fontSize: 10 }}>L{item.start_line}-{item.end_line}</Text>
            )}
            {item.matched_keywords && item.matched_keywords.length > 0 && (
              <Space size={2} wrap>
                {item.matched_keywords.slice(0, 3).map((kw) => (
                  <Tag key={kw} style={{ fontSize: 9, lineHeight: '14px', padding: '0 3px', margin: 0 }}>{kw}</Tag>
                ))}
              </Space>
            )}
          </div>
        </div>
      ))}
    </Card>
  )
}

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

  // 文件搜索模式：展示简单的文件列表
  if (searchMode === 'file') {
    return (
      <div>
        <div style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('kms.resultCount', { count: results.length })}
          </Text>
        </div>
        {results.map((item) => {
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
                  <Text strong style={{ fontSize: 13, cursor: 'pointer' }} ellipsis onClick={() => onPreview(item)} title={t('kms.preview')}>
                    <HighlightText text={item.file_name} keywords={searchKeywords} />
                  </Text>
                  <Tag color={matchConfig.color} style={{ fontSize: 11 }}>{t(matchConfig.labelKey)}</Tag>
                </Space>
                <Space size={4}>
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
      </div>
    )
  }

  // 非文件搜索模式：按文件合并展示
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('kms.resultCount', { count: groupedResults.length })}
        </Text>
      </div>
      {groupedResults.map(([fileId, fileResults]) => (
        <FileResultCard
          key={fileId}
          fileId={fileId}
          fileResults={fileResults}
          searchMode={searchMode}
          searchKeywords={searchKeywords}
          token={token}
          t={t}
          onPreview={onPreview}
          onOpenFile={onOpenFile}
          onOpenFileDir={onOpenFileDir}
        />
      ))}
    </div>
  )
}

export default KMSSearchResultList
