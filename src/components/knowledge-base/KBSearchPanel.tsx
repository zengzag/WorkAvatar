import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Drawer, Input, Select, Button, Tabs, Card, Tag, Empty, Spin, Space,
  Typography, Tooltip, Modal, theme, Alert,
} from 'antd'
import {
  SearchOutlined, FileTextOutlined,
  GlobalOutlined, BookOutlined,
  FilterOutlined, CopyOutlined, EyeOutlined, DatabaseOutlined,
  RobotOutlined,
} from '@ant-design/icons'

const { Text, Paragraph } = Typography

type SearchMode = 'smart' | 'semantic' | 'advanced' | 'paragraphs' | 'fulltext' | 'globalSummary'

interface KBSearchPanelProps {
  open: boolean
  onClose: () => void
  kbList: any[]
}

const MATCH_TYPE_CONFIG: Record<string, { color: string; labelKey: string }> = {
  title: { color: 'blue', labelKey: 'kbSearch.matchTypeTitle' },
  document_title: { color: 'blue', labelKey: 'kbSearch.matchTypeTitle' },
  summary: { color: 'green', labelKey: 'kbSearch.matchTypeSummary' },
  document_summary: { color: 'green', labelKey: 'kbSearch.matchTypeSummary' },
  keywords: { color: 'orange', labelKey: 'kbSearch.matchTypeKeywords' },
  paragraph: { color: 'orange', labelKey: 'kbSearch.matchTypeKeywords' },
  content: { color: 'purple', labelKey: 'kbSearch.matchTypeContent' },
  content_paragraph: { color: 'purple', labelKey: 'kbSearch.matchTypeContent' },
  hybrid: { color: 'cyan', labelKey: 'kbSearch.matchTypeHybrid' },
}

const KBSearchPanel: React.FC<KBSearchPanelProps> = ({ open, onClose, kbList }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [selectedKbId, setSelectedKbId] = useState<string | undefined>(undefined)
  const [searchMode, setSearchMode] = useState<SearchMode>('smart')
  const [query, setQuery] = useState('')
  const [topK, setTopK] = useState(10)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<any[]>([])
  const [globalSummaryResult, setGlobalSummaryResult] = useState<any>(null)
  const [advancedDocType, setAdvancedDocType] = useState<string | undefined>(undefined)
  const [docContent, setDocContent] = useState<any>(null)
  const [docContentLoading, setDocContentLoading] = useState(false)
  const [docContentModalOpen, setDocContentModalOpen] = useState(false)
  const [docContentTitle, setDocContentTitle] = useState('')
  const [docContentOffset, setDocContentOffset] = useState<{ start: number; end: number } | null>(null)
  const [searched, setSearched] = useState(false)
  const [semanticDegraded, setSemanticDegraded] = useState(false)
  const [highlightParagraphId, setHighlightParagraphId] = useState<string | null>(null)

  const inputRef = useRef<any>(null)
  const highlightRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && kbList.length > 0 && !selectedKbId) {
      setSelectedKbId(kbList[0].id)
    }
  }, [open, kbList])

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 300)
    }
  }, [open, searchMode])

  useEffect(() => {
    if (docContentModalOpen && highlightRef.current) {
      setTimeout(() => {
        highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 200)
    }
  }, [docContentModalOpen, docContent])

  const resetResults = useCallback(() => {
    setResults([])
    setGlobalSummaryResult(null)
    setDocContent(null)
    setDocContentModalOpen(false)
    setSearched(false)
  }, [])

  const handleSearch = useCallback(async () => {
    if (!selectedKbId || !query.trim()) return

    setLoading(true)
    resetResults()
    setSearched(true)

    try {
      switch (searchMode) {
        case 'smart': {
          const data = await window.electronAPI.kb.search({
            kb_id: selectedKbId,
            query: query.trim(),
            top_k: topK,
          })
          setResults(data || [])
          break
        }
        case 'semantic': {
          const stats = await window.electronAPI.kb.searchIndexStats(selectedKbId)
          const hasEmbeddings = (stats as any)?.embeddingCount > 0
          setSemanticDegraded(!hasEmbeddings)
          const data = await window.electronAPI.kb.searchWithEmbedding({
            kb_id: selectedKbId,
            query: query.trim(),
            top_k: topK,
          })
          setResults(data || [])
          break
        }
        case 'advanced': {
          const data = await window.electronAPI.kb.advancedSearch({
            kb_id: selectedKbId,
            query: query.trim(),
            top_k: topK,
            document_type: advancedDocType,
          })
          setResults(data || [])
          break
        }
        case 'paragraphs': {
          const data = await window.electronAPI.kb.searchParagraphs({
            kb_id: selectedKbId,
            query: query.trim(),
            top_k: topK,
          })
          setResults(data || [])
          break
        }
        case 'fulltext': {
          const data = await window.electronAPI.kb.search({
            kb_id: selectedKbId,
            query: query.trim(),
            top_k: topK,
          })
          setResults((data || []).filter((r: any) => r.match_type === 'content' || r.match_type === 'content_paragraph'))
          break
        }
        case 'globalSummary': {
          const data = await window.electronAPI.kb.getGlobalSummary(selectedKbId)
          setGlobalSummaryResult(data)
          break
        }
      }
    } catch (error) {
      console.error('Search failed:', error)
    } finally {
      setLoading(false)
    }
  }, [selectedKbId, query, searchMode, topK, advancedDocType, resetResults])

  const handleViewDocContent = useCallback(async (docId: string, docName: string, offset?: { start: number; end: number }, paragraphId?: string) => {
    setDocContentLoading(true)
    setDocContent(null)
    setDocContentTitle(docName)
    setDocContentOffset(offset || null)
    setHighlightParagraphId(paragraphId || null)
    setDocContentModalOpen(true)
    try {
      const content = await window.electronAPI.kb.getDocContent(docId)
      setDocContent({ id: docId, content: content || '' })
    } catch (error) {
      console.error('Failed to get doc content:', error)
    } finally {
      setDocContentLoading(false)
    }
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      handleSearch()
    }
  }, [handleSearch, loading])

  const handleCopyResult = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
  }, [])

  const selectedKb = kbList.find(kb => kb.id === selectedKbId)

  const searchModeItems = [
    {
      key: 'smart',
      label: (
        <Space>
          <SearchOutlined />
          <span>{t('kbSearch.modeSmart')}</span>
        </Space>
      ),
    },
    {
      key: 'semantic',
      label: (
        <Space>
          <RobotOutlined />
          <span>{t('kbSearch.modeSemantic')}</span>
        </Space>
      ),
    },
    {
      key: 'advanced',
      label: (
        <Space>
          <FilterOutlined />
          <span>{t('kbSearch.modeAdvanced')}</span>
        </Space>
      ),
    },
    {
      key: 'paragraphs',
      label: (
        <Space>
          <BookOutlined />
          <span>{t('kbSearch.modeParagraphs')}</span>
        </Space>
      ),
    },
    {
      key: 'fulltext',
      label: (
        <Space>
          <FileTextOutlined />
          <span>{t('kbSearch.modeFulltext')}</span>
        </Space>
      ),
    },
    {
      key: 'globalSummary',
      label: (
        <Space>
          <GlobalOutlined />
          <span>{t('kbSearch.modeGlobalSummary')}</span>
        </Space>
      ),
    },
  ]

  const renderHighlightedContent = (content: string, offset: { start: number; end: number } | null, paragraphId: string | null) => {
    if (!offset && !paragraphId) {
      return (
        <>
          {content.substring(0, 10000)}
          {content.length > 10000 && (
            <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
              ...({t('kbSearch.contentTruncated')})
            </Text>
          )}
        </>
      )
    }

    if (offset) {
      const contextChars = 500
      const start = Math.max(0, offset.start - contextChars)
      const end = Math.min(content.length, offset.end + contextChars)
      const beforeText = content.substring(start, offset.start)
      const highlightText = content.substring(offset.start, offset.end)
      const afterText = content.substring(offset.end, end)

      return (
        <>
          {start > 0 && <Text type="secondary" style={{ fontSize: 12 }}>... </Text>}
          <span ref={highlightRef}>{beforeText}</span>
          <mark style={{
            background: token.colorWarningBg,
            padding: '1px 2px',
            borderRadius: 2,
            fontWeight: 500,
          }}>
            {highlightText.substring(0, 5000)}
          </mark>
          {afterText.substring(0, 5000)}
          {(highlightText.length > 5000 || afterText.length > 5000) && (
            <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
              ...({t('kbSearch.contentTruncated')})
            </Text>
          )}
          {end < content.length && <Text type="secondary" style={{ fontSize: 12 }}> ...</Text>}
        </>
      )
    }

    return (
      <>
        {content.substring(0, 10000)}
        {content.length > 10000 && (
          <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
            ...({t('kbSearch.contentTruncated')})
          </Text>
        )}
      </>
    )
  }

  const renderResultItem = (item: any, index: number) => {
    const matchConfig = MATCH_TYPE_CONFIG[item.match_type] || { color: 'default', labelKey: 'kbSearch.matchTypeOther' }

    return (
      <Card
        key={index}
        size="small"
        style={{
          marginBottom: 8,
          borderLeft: `3px solid ${token.colorPrimary}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
          <Space wrap>
            <Tag color={matchConfig.color}>{t(matchConfig.labelKey)}</Tag>
          </Space>
          <Tooltip title={t('kbSearch.copyResult')}>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => handleCopyResult(
                `[${item.document_name}]${item.paragraph_title ? ` > ${item.paragraph_title}` : ''}\n${item.text}`
              )}
            />
          </Tooltip>
        </div>

        <div style={{ marginBottom: 6 }}>
          <Text strong style={{ fontSize: 13 }}>
            {item.document_name}
          </Text>
          {item.paragraph_title && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {' > '}{item.paragraph_title}
            </Text>
          )}
          {item.document_type && (
            <Tag style={{ marginLeft: 8, fontSize: 11 }}>{item.document_type}</Tag>
          )}
        </div>

        {item.match_details && (
          <div style={{ marginBottom: 6 }}>
            {item.match_details.map((detail: string, i: number) => (
              <Tag key={i} color="processing" style={{ fontSize: 11, marginBottom: 2 }}>{detail}</Tag>
            ))}
          </div>
        )}

        <Paragraph
          style={{ fontSize: 12, color: token.colorTextSecondary, marginBottom: 4 }}
          ellipsis={{ rows: 3, expandable: 'collapsible', symbol: t('kbSearch.expand') }}
        >
          {item.text}
        </Paragraph>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space size={4} split={<Text type="secondary" style={{ fontSize: 11 }}>|</Text>}>
            {item.document_id && (
              <Tooltip title={item.document_id}>
                <Text type="secondary" style={{ fontSize: 11, cursor: 'pointer' }} copyable={{ text: item.document_id, tooltips: [t('kbSearch.copyId'), t('kbSearch.copied')] }}>
                  doc: ...{item.document_id.slice(-6)}
                </Text>
              </Tooltip>
            )}
            {item.paragraph_id && (
              <Tooltip title={item.paragraph_id}>
                <Text type="secondary" style={{ fontSize: 11 }} copyable={{ text: item.paragraph_id, tooltips: [t('kbSearch.copyId'), t('kbSearch.copied')] }}>
                  p: ...{item.paragraph_id.slice(-6)}
                </Text>
              </Tooltip>
            )}
            {item.start_line !== undefined && item.end_line !== undefined && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                L{item.start_line}-{item.end_line}
              </Text>
            )}
            {item.start_offset !== undefined && item.end_offset !== undefined && item.match_type === 'content' && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                @{item.start_offset}-{item.end_offset}
              </Text>
            )}
          </Space>
          {item.document_id && (
            <Tooltip title={t('kbSearch.viewContent')}>
              <Button
                type="link"
                size="small"
                icon={<EyeOutlined />}
                onClick={() => handleViewDocContent(item.document_id, item.document_name,
                  item.start_offset !== undefined && item.end_offset !== undefined
                    ? { start: item.start_offset, end: item.end_offset }
                    : undefined,
                  item.paragraph_id
                )}
                loading={docContentLoading}
              />
            </Tooltip>
          )}
        </div>
      </Card>
    )
  }

  const renderGlobalSummary = () => {
    if (!globalSummaryResult) {
      return <Empty description={t('kbSearch.noGlobalSummary')} />
    }

    const keyTopics: string[] = (() => { try { return JSON.parse(globalSummaryResult.key_topics_json || '[]') } catch { return [] } })()

    return (
      <div>
        <Card size="small" style={{ marginBottom: 12, borderLeft: `3px solid ${token.colorPrimary}` }}>
          <Paragraph style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
            {globalSummaryResult.summary}
          </Paragraph>
        </Card>

        {keyTopics.length > 0 && (
          <Card size="small" title={t('knowledgeBase.coreTopics')} style={{ marginBottom: 12 }}>
            <Space wrap>
              {keyTopics.map((topic, i) => (
                <Tag key={i} color="blue">{topic}</Tag>
              ))}
            </Space>
          </Card>
        )}
      </div>
    )
  }

  const renderDocContentModal = () => {
    return (
      <Modal
        title={
          <Space>
            <FileTextOutlined />
            <span>{docContentTitle}</span>
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
              - {t('kbSearch.docContent')}
            </Text>
            {docContentOffset && (
              <Tag color="orange" style={{ fontSize: 11 }}>
                {t('kbSearch.locatedAt', { start: docContentOffset.start, end: docContentOffset.end })}
              </Tag>
            )}
          </Space>
        }
        open={docContentModalOpen}
        onCancel={() => { setDocContentModalOpen(false); setHighlightParagraphId(null) }}
        footer={null}
        width={720}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        {docContentLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        ) : docContent ? (
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, fontSize: 13, backgroundColor: token.colorBgLayout, padding: 16, borderRadius: 8 }}>
            {renderHighlightedContent(docContent.content, docContentOffset, highlightParagraphId)}
          </div>
        ) : (
          <Empty description={t('kbSearch.noResults')} />
        )}
      </Modal>
    )
  }

  const renderSearchResults = () => {
    if (loading) {
      return (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin tip={t('kbSearch.searching')} />
        </div>
      )
    }

    if (!searched) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t('kbSearch.searchHint')}
        />
      )
    }

    switch (searchMode) {
      case 'globalSummary':
        return renderGlobalSummary()
      default:
        if (results.length === 0) {
          return <Empty description={t('kbSearch.noResults')} />
        }
        return (
          <div>
            {semanticDegraded && searchMode === 'semantic' && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                title={t('kbSearch.semanticDegraded')}
              />
            )}
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('kbSearch.resultCount', { count: results.length })}
              </Text>
            </div>
            {results.map((item, index) => renderResultItem(item, index))}
          </div>
        )
    }
  }

  const showQueryInput = searchMode !== 'globalSummary'

  const showAdvancedOptions = searchMode === 'advanced'

  return (
    <Drawer
      title={null}
      open={open}
      onClose={onClose}
      width={680}
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column' },
      }}
    >
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Space>
            <SearchOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
            <Typography.Title level={5} style={{ margin: 0 }}>
              {t('kbSearch.title')}
            </Typography.Title>
          </Space>
          {selectedKb && (
            <Tag color="blue" icon={<DatabaseOutlined />}>
              {selectedKb.name}
            </Tag>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <Select
            value={selectedKbId}
            onChange={(val) => { setSelectedKbId(val); resetResults() }}
            style={{ width: 200 }}
            placeholder={t('kbSearch.selectKb')}
            options={kbList.map((kb: any) => ({
              value: kb.id,
              label: kb.name,
            }))}
          />
          <Select
            value={topK}
            onChange={setTopK}
            style={{ width: 90 }}
            options={[
              { value: 5, label: 'Top 5' },
              { value: 10, label: 'Top 10' },
              { value: 20, label: 'Top 20' },
            ]}
          />
        </div>

        {showQueryInput && (
          <Input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              searchMode === 'advanced'
                ? t('kbSearch.advancedPlaceholder')
                : t('kbSearch.searchPlaceholder')
            }
            size="large"
            prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
            suffix={
              <Button
                type="primary"
                size="small"
                icon={<SearchOutlined />}
                onClick={handleSearch}
                loading={loading}
              >
                {t('kbSearch.search')}
              </Button>
            }
          />
        )}

        {showAdvancedOptions && searchMode === 'advanced' && (
          <div style={{ marginTop: 8 }}>
            <Select
              value={advancedDocType}
              onChange={setAdvancedDocType}
              allowClear
              style={{ width: 140 }}
              placeholder={t('kbSearch.docTypeFilter')}
              options={[
                { value: 'pdf', label: 'PDF' },
                { value: 'docx', label: 'Word' },
                { value: 'xlsx', label: 'Excel' },
                { value: 'txt', label: 'TXT' },
                { value: 'md', label: 'Markdown' },
              ]}
            />
          </div>
        )}

        {searchMode === 'globalSummary' && (
          <Button
            type="primary"
            icon={<GlobalOutlined />}
            onClick={handleSearch}
            loading={loading}
            block
          >
            {t('kbSearch.queryGlobalSummary')}
          </Button>
        )}

        {searchMode === 'advanced' && (
          <Alert
            type="info"
            title={t('kbSearch.advancedSyntaxTitle')}
            description={t('kbSearch.advancedSyntaxDesc')}
            style={{ marginTop: 8, fontSize: 12 }}
            showIcon
          />
        )}
      </div>

      <div style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <Tabs
          activeKey={searchMode}
          onChange={(key) => { setSearchMode(key as SearchMode); resetResults() }}
          items={searchModeItems}
          style={{ padding: '0 20px' }}
          size="small"
        />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
        {renderSearchResults()}
      </div>
      {renderDocContentModal()}
    </Drawer>
  )
}

export default KBSearchPanel
