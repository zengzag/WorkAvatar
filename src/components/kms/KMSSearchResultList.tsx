import React, { useMemo } from 'react'
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

const getFileIcon = (fileName: string, t: ReturnType<typeof theme.useToken>['token']) => {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'pdf': return <FilePdfOutlined style={{ color: t.colorError }} />
    case 'doc': case 'docx': return <FileWordOutlined style={{ color: t.colorPrimary }} />
    case 'xls': case 'xlsx': return <FileExcelOutlined style={{ color: t.colorSuccess }} />
    case 'md': case 'markdown': return <FileMarkdownOutlined style={{ color: t.colorInfo }} />
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'py': case 'java': case 'go': case 'rs': case 'c': case 'cpp': case 'h':
      return <CodeOutlined style={{ color: t.colorWarning }} />
    case 'txt': case 'log': return <FileTextOutlined style={{ color: t.colorTextTertiary }} />
    default: return <FileOutlined style={{ color: t.colorTextTertiary }} />
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

  const searchKeywords = useMemo(() => {
    if (!searchQuery.trim()) return []
    return searchQuery.trim().split(/\s+/).filter(kw => kw.length > 0)
  }, [searchQuery])

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
    <div>
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('kms.resultCount', { count: results.length })}
        </Text>
      </div>
      {results.map((item, index) => {
        const matchConfig = MATCH_TYPE_CONFIG[item.match_type] || { color: 'default', labelKey: 'kms.matchContent' }
        return (
          <Card
            key={`${item.file_id}-${item.paragraph_id || index}`}
            size="small"
            style={{ marginBottom: 8, borderLeft: `3px solid ${token.colorPrimary}` }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
              <Space size={6} style={{ flex: 1, minWidth: 0 }}>
                {getFileIcon(item.file_name, token)}
                <Text strong style={{ fontSize: 13, cursor: 'pointer' }} ellipsis onClick={() => onPreview(item)} title={t('kms.preview')}>
                  {item.file_name}
                </Text>
                <Tag color={matchConfig.color} style={{ fontSize: 11 }}>{t(matchConfig.labelKey)}</Tag>
              </Space>
              {searchMode === 'hybrid' && renderScoreBar(item.score)}
            </div>

            <Tooltip title={item.file_path}>
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }} ellipsis>{item.file_path}</Text>
            </Tooltip>

            {item.paragraph_title && (
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{item.paragraph_title}</Text>
            )}

            <div style={{ fontSize: 12, color: token.colorTextSecondary, lineHeight: 1.6, marginBottom: 6, maxHeight: 80, overflow: 'hidden' }}>
              <HighlightText text={item.text} highlights={item.highlights} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
              <Space size={4} wrap>
                {item.start_line !== undefined && item.end_line !== undefined && (
                  <Text type="secondary" style={{ fontSize: 11 }}>L{item.start_line}-{item.end_line}</Text>
                )}
                {item.matched_keywords && item.matched_keywords.length > 0 && (
                  <Space size={2} wrap>
                    {item.matched_keywords.slice(0, 5).map((kw) => (
                      <Tag key={kw} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>{kw}</Tag>
                    ))}
                  </Space>
                )}
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
          </Card>
        )
      })}
    </div>
  )
}

export default KMSSearchResultList
