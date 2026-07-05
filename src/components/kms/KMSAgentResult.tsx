import React, { useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Tag, Typography, Space, Tooltip, Button, Collapse, theme } from 'antd'
import { FileTextOutlined, FilePdfOutlined, FileExcelOutlined, FileWordOutlined, FileMarkdownOutlined, FileOutlined, CodeOutlined, FolderOpenOutlined, EyeOutlined, RobotOutlined, BulbOutlined, CompressOutlined, RiseOutlined, AimOutlined } from '@ant-design/icons'
import HighlightText from './HighlightText'
import type { AgentSearchResult, AgentSearchSource } from '../../hooks/useKMS'

const { Text, Paragraph } = Typography

const QUERY_TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode; labelKey: string }> = {
  locate: { color: 'blue', icon: <AimOutlined />, labelKey: 'kms.queryTypeLocate' },
  concept: { color: 'green', icon: <BulbOutlined />, labelKey: 'kms.queryTypeConcept' },
  trend: { color: 'orange', icon: <RiseOutlined />, labelKey: 'kms.queryTypeTrend' },
  analysis: { color: 'purple', icon: <CompressOutlined />, labelKey: 'kms.queryTypeAnalysis' },
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

interface KMSAgentResultProps {
  agentResult: AgentSearchResult
  searchKeywords: string[]
  stepTypeColors: Record<string, string>
  onPreview: (result: SearchResult) => void
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
}

const KMSAgentResult: React.FC<KMSAgentResultProps> = ({
  agentResult,
  searchKeywords,
  stepTypeColors,
  onPreview,
  onOpenFile,
  onOpenFileDir,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const typeIcons = useMemo<Record<string, string>>(() => ({
    info: '•', llm: '🤖', search: '🔍', read: '📄', plan: '📋', result: '✓',
  }), [])

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

  const typeConfig = QUERY_TYPE_CONFIG[agentResult.queryType] || QUERY_TYPE_CONFIG.locate

  return (
    <div>
      <Card size="small" style={{ marginBottom: 12, borderLeft: `3px solid ${token.colorPrimary}`, backgroundColor: token.colorPrimaryBg }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Space size={6}>
            <RobotOutlined style={{ color: token.colorPrimary }} />
            <Text strong style={{ fontSize: 13 }}>{t('kms.aiConclusion')}</Text>
            <Tag color={typeConfig.color} style={{ fontSize: 11 }}>
              {typeConfig.icon}
              <span style={{ marginLeft: 4 }}>{t(typeConfig.labelKey)}</span>
            </Tag>
          </Space>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('kms.searchRounds', { count: agentResult.searchRounds })}
          </Text>
        </div>
        <Paragraph style={{ fontSize: 13, lineHeight: 1.7, margin: 0, whiteSpace: 'pre-wrap' }}>
          <HighlightText text={agentResult.conclusion} keywords={searchKeywords} />
        </Paragraph>
      </Card>

      {agentResult.sources.length > 0 && (
        <div>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            {t('kms.sources', { count: agentResult.sources.length })}
          </Text>
          {agentResult.sources.map((source, index) => (
            <Card key={`${source.fileId}-${index}`} size="small" style={{ marginBottom: 6, borderLeft: `2px solid ${token.colorBorder}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <Space size={6} style={{ flex: 1, minWidth: 0 }}>
                  <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>[{index + 1}]</Text>
                  {getFileIcon(source.fileName, token)}
                  <Text strong style={{ fontSize: 12, cursor: 'pointer' }} ellipsis onClick={() => handleSourcePreview(source)} title={t('kms.preview')}>
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
                <Text type="secondary" style={{ fontSize: 10, display: 'block', marginTop: 4 }} ellipsis>{source.filePath}</Text>
              </Tooltip>
              <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                {source.startLine !== undefined && source.endLine !== undefined && (
                  <Text type="secondary" style={{ fontSize: 10 }}>L{source.startLine}-{source.endLine}</Text>
                )}
                {source.startOffset !== undefined && source.endOffset !== undefined && (
                  <Text type="secondary" style={{ fontSize: 10 }}>off:{source.startOffset}-{source.endOffset}</Text>
                )}
              </div>
              {source.snippet && (
                <div style={{ fontSize: 11, color: token.colorTextTertiary, marginTop: 4, lineHeight: 1.5, maxHeight: 40, overflow: 'hidden' }}>
                  <HighlightText text={source.snippet} keywords={searchKeywords} />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {((agentResult.searchSteps && agentResult.searchSteps.length > 0) || agentResult.searchTrace.length > 0) && (
        <Collapse size="small" style={{ marginTop: 12 }} items={[{
          key: 'trace',
          label: <Text type="secondary" style={{ fontSize: 11 }}>{t('kms.searchTrace')}</Text>,
          children: (
            <div style={{ fontSize: 11, lineHeight: 1.6 }}>
              {(agentResult.searchSteps || []).map((step, i) => (
                <div key={`step-${step.phase}-${i}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '3px 0', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
                  <span style={{ color: stepTypeColors[step.type] || token.colorTextTertiary, flexShrink: 0 }}>[{step.phase}]</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ color: token.colorTextSecondary }}>{step.action}</span>
                    {step.detail && <span style={{ color: token.colorTextTertiary, marginLeft: 4 }}>— {step.detail}</span>}
                    {step.durationMs !== undefined && <span style={{ color: token.colorTextQuaternary, marginLeft: 6 }}>{step.durationMs}ms</span>}
                  </div>
                </div>
              ))}
              {(!agentResult.searchSteps || agentResult.searchSteps.length === 0) &&
                agentResult.searchTrace.map((trace, i) => (
                  <div key={`trace-${i}`} style={{ color: token.colorTextTertiary }}>• {trace}</div>
                ))
              }
            </div>
          ),
        }]} />
      )}
    </div>
  )
}

export default KMSAgentResult
