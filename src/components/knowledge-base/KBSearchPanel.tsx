import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Drawer, Input, Select, Button, Tabs, Card, Tag, Empty, Spin, Space,
  Typography, Tooltip, Modal, theme, Alert,
} from 'antd'
import {
  SearchOutlined, FileTextOutlined, NodeIndexOutlined,
  ApartmentOutlined, GlobalOutlined, BookOutlined,
  FilterOutlined, CopyOutlined, EyeOutlined, DatabaseOutlined,
} from '@ant-design/icons'

const { Text, Paragraph } = Typography

type SearchMode = 'smart' | 'advanced' | 'chapters' | 'fulltext' | 'entity' | 'graph' | 'globalSummary'

interface KBSearchPanelProps {
  open: boolean
  onClose: () => void
  kbList: any[]
}

const MATCH_TYPE_CONFIG: Record<string, { color: string; labelKey: string }> = {
  title: { color: 'blue', labelKey: 'kbSearch.matchTypeTitle' },
  summary: { color: 'green', labelKey: 'kbSearch.matchTypeSummary' },
  keywords: { color: 'orange', labelKey: 'kbSearch.matchTypeKeywords' },
  content: { color: 'purple', labelKey: 'kbSearch.matchTypeContent' },
  entity: { color: 'red', labelKey: 'kbSearch.matchTypeEntity' },
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
  const [graphResult, setGraphResult] = useState<any>(null)
  const [entityResults, setEntityResults] = useState<any[]>([])
  const [entitySearchType, setEntitySearchType] = useState<string | undefined>(undefined)
  const [advancedDocType, setAdvancedDocType] = useState<string | undefined>(undefined)
  const [docContent, setDocContent] = useState<any>(null)
  const [docContentLoading, setDocContentLoading] = useState(false)
  const [docContentModalOpen, setDocContentModalOpen] = useState(false)
  const [docContentTitle, setDocContentTitle] = useState('')
  const [docContentOffset, setDocContentOffset] = useState<{ start: number; end: number } | null>(null)
  const [searched, setSearched] = useState(false)

  const inputRef = useRef<any>(null)

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

  const resetResults = useCallback(() => {
    setResults([])
    setGlobalSummaryResult(null)
    setGraphResult(null)
    setEntityResults([])
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
        case 'chapters': {
          const data = await window.electronAPI.kb.searchChapters({
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
          setResults((data || []).filter((r: any) => r.match_type === 'content'))
          break
        }
        case 'entity': {
          const data = await window.electronAPI.kb.getEntities({
            kb_id: selectedKbId,
            type: entitySearchType,
          })
          const filtered = (data || []).filter((e: any) =>
            !query.trim() ||
            e.name.toLowerCase().includes(query.toLowerCase()) ||
            (e.description || '').toLowerCase().includes(query.toLowerCase()) ||
            (JSON.parse(e.aliases_json || '[]') as string[]).some((a: string) =>
              a.toLowerCase().includes(query.toLowerCase())
            )
          )
          setEntityResults(filtered.slice(0, topK))
          break
        }
        case 'graph': {
          const entity = await window.electronAPI.kb.getEntity({
            kb_id: selectedKbId,
            name: query.trim(),
          })
          if (entity) {
            const relations = await window.electronAPI.kb.getEntityRelations({
              entity_id: entity.id,
              depth: 2,
            })
            const mentions = await window.electronAPI.kb.getEntityMentions(entity.id)
            setGraphResult({ entity, relations: relations || [], mentions: mentions || [] })
          } else {
            setGraphResult(null)
          }
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
  }, [selectedKbId, query, searchMode, topK, advancedDocType, entitySearchType, resetResults])

  const handleViewDocContent = useCallback(async (docId: string, docName: string, offset?: { start: number; end: number }) => {
    setDocContentLoading(true)
    setDocContent(null)
    setDocContentTitle(docName)
    setDocContentOffset(offset || null)
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
    navigator.clipboard.writeText(text)
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
      key: 'advanced',
      label: (
        <Space>
          <FilterOutlined />
          <span>{t('kbSearch.modeAdvanced')}</span>
        </Space>
      ),
    },
    {
      key: 'chapters',
      label: (
        <Space>
          <BookOutlined />
          <span>{t('kbSearch.modeChapters')}</span>
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
      key: 'entity',
      label: (
        <Space>
          <NodeIndexOutlined />
          <span>{t('kbSearch.modeEntity')}</span>
        </Space>
      ),
    },
    {
      key: 'graph',
      label: (
        <Space>
          <ApartmentOutlined />
          <span>{t('kbSearch.modeGraph')}</span>
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
            <Tag color="default">Score: {item.score}</Tag>
          </Space>
          <Tooltip title={t('kbSearch.copyResult')}>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => handleCopyResult(
                `[${item.document_name}]${item.chapter_title ? ` > ${item.chapter_title}` : ''}\n${item.text}`
              )}
            />
          </Tooltip>
        </div>

        <div style={{ marginBottom: 6 }}>
          <Text strong style={{ fontSize: 13 }}>
            {item.document_name}
          </Text>
          {item.chapter_title && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {' > '}{item.chapter_title}
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
            {item.chapter_id && (
              <Tooltip title={item.chapter_id}>
                <Text type="secondary" style={{ fontSize: 11 }} copyable={{ text: item.chapter_id, tooltips: [t('kbSearch.copyId'), t('kbSearch.copied')] }}>
                  ch: ...{item.chapter_id.slice(-6)}
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
                    : undefined
                )}
                loading={docContentLoading}
              />
            </Tooltip>
          )}
        </div>
      </Card>
    )
  }

  const renderEntityResults = () => {
    if (entityResults.length === 0) {
      return <Empty description={t('kbSearch.noResults')} />
    }

    return (
      <div>
        {entityResults.map((entity: any, index: number) => {
          const aliases: string[] = JSON.parse(entity.aliases_json || '[]')
          return (
            <Card
              key={index}
              size="small"
              style={{ marginBottom: 8, borderLeft: `3px solid ${token.colorError}` }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <Space>
                    <Text strong>{entity.name}</Text>
                    <Tag color="red">{entity.type}</Tag>
                    <Tag>{t('kbSearch.mentionCount', { count: entity.mention_count })}</Tag>
                  </Space>
                  {entity.description && (
                    <Paragraph style={{ fontSize: 12, color: token.colorTextSecondary, marginBottom: 0, marginTop: 4 }}>
                      {entity.description}
                    </Paragraph>
                  )}
                  {aliases.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      <Text type="secondary" style={{ fontSize: 11 }}>{t('knowledgeBase.aliases')}: </Text>
                      {aliases.map((a, i) => (
                        <Tag key={i} style={{ fontSize: 11 }}>{a}</Tag>
                      ))}
                    </div>
                  )}
                </div>
                <Space>
                  <Tooltip title={t('kbSearch.queryGraph')}>
                    <Button
                      type="link"
                      size="small"
                      icon={<ApartmentOutlined />}
                      onClick={() => {
                        setQuery(entity.name)
                        setSearchMode('graph')
                      }}
                    />
                  </Tooltip>
                  <Tooltip title={t('kbSearch.copyResult')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => handleCopyResult(`${entity.name}(${entity.type}): ${entity.description || ''}`)}
                    />
                  </Tooltip>
                </Space>
              </div>
            </Card>
          )
        })}
      </div>
    )
  }

  const renderGraphResult = () => {
    if (!graphResult) {
      return <Empty description={t('kbSearch.entityNotFound')} />
    }

    const { entity, relations, mentions } = graphResult
    const aliases: string[] = JSON.parse(entity.aliases_json || '[]')

    return (
      <div>
        <Card size="small" style={{ marginBottom: 12, borderLeft: `3px solid ${token.colorError}` }}>
          <Space style={{ marginBottom: 8 }}>
            <Text strong style={{ fontSize: 16 }}>{entity.name}</Text>
            <Tag color="red">{entity.type}</Tag>
            <Tag>{t('kbSearch.mentionCount', { count: entity.mention_count })}</Tag>
          </Space>
          {entity.description && (
            <Paragraph style={{ fontSize: 13, marginBottom: 4 }}>{entity.description}</Paragraph>
          )}
          {aliases.length > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('knowledgeBase.aliases')}: </Text>
              {aliases.map((a: string, i: number) => (
                <Tag key={i} style={{ fontSize: 11 }}>{a}</Tag>
              ))}
            </div>
          )}
        </Card>

        {relations.length > 0 && (
          <Card size="small" title={t('kbSearch.relationNetwork', { count: relations.length })} style={{ marginBottom: 12 }}>
            {relations.map((rel: any, i: number) => {
              const isSource = rel.source_entity_id === entity.id
              return (
                <div key={i} style={{ padding: '4px 0', borderBottom: i < relations.length - 1 ? `1px solid ${token.colorBorderSecondary}` : 'none' }}>
                  <Space>
                    <Text type="secondary">{isSource ? '→' : '←'}</Text>
                    <Text strong style={{ fontSize: 13 }}>{isSource ? rel.target_name : rel.source_name}</Text>
                    <Tag style={{ fontSize: 11 }}>{isSource ? rel.target_type : rel.source_type}</Tag>
                    <Tag color="processing" style={{ fontSize: 11 }}>{rel.relation_type}</Tag>
                  </Space>
                  {rel.description && (
                    <div><Text type="secondary" style={{ fontSize: 11 }}>{rel.description}</Text></div>
                  )}
                </div>
              )
            })}
          </Card>
        )}

        {mentions.length > 0 && (
          <Card size="small" title={t('kbSearch.mentionRecords', { count: mentions.length })}>
            {mentions.slice(0, 10).map((m: any, i: number) => (
              <div key={i} style={{ padding: '4px 0', borderBottom: i < Math.min(mentions.length, 10) - 1 ? `1px solid ${token.colorBorderSecondary}` : 'none' }}>
                <Text style={{ fontSize: 12 }}>{m.document_name}{m.chapter_title ? ` > ${m.chapter_title}` : ''}</Text>
                {m.context_text && (
                  <Paragraph style={{ fontSize: 11, color: token.colorTextSecondary, marginBottom: 0, marginTop: 2 }} ellipsis={{ rows: 2 }}>
                    {m.context_text}
                  </Paragraph>
                )}
              </div>
            ))}
          </Card>
        )}
      </div>
    )
  }

  const renderGlobalSummary = () => {
    if (!globalSummaryResult) {
      return <Empty description={t('kbSearch.noGlobalSummary')} />
    }

    const keyTopics: string[] = JSON.parse(globalSummaryResult.key_topics_json || '[]')
    const keyEntities: any[] = JSON.parse(globalSummaryResult.key_entities_json || '[]')

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

        {keyEntities.length > 0 && (
          <Card size="small" title={t('knowledgeBase.keyEntities')}>
            {keyEntities.map((e, i) => (
              <div key={i} style={{ padding: '4px 0', borderBottom: i < keyEntities.length - 1 ? `1px solid ${token.colorBorderSecondary}` : 'none' }}>
                <Space>
                  <Text strong style={{ fontSize: 13 }}>{e.name}</Text>
                  <Tag style={{ fontSize: 11 }}>{e.type}</Tag>
                </Space>
                {e.description && (
                  <div><Text type="secondary" style={{ fontSize: 11 }}>{e.description}</Text></div>
                )}
              </div>
            ))}
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
          </Space>
        }
        open={docContentModalOpen}
        onCancel={() => setDocContentModalOpen(false)}
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
            {docContentOffset
              ? (() => {
                  const content = docContent.content
                  const contextChars = 500
                  const start = Math.max(0, docContentOffset.start - contextChars)
                  const end = Math.min(content.length, docContentOffset.end + contextChars)
                  const displayText = content.substring(start, end)
                  return (
                    <>
                      {start > 0 && <Text type="secondary" style={{ fontSize: 12 }}>... </Text>}
                      {displayText.substring(0, 5000)}
                      {displayText.length > 5000 && (
                        <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                          ...({t('kbSearch.contentTruncated')})
                        </Text>
                      )}
                      {end < content.length && <Text type="secondary" style={{ fontSize: 12 }}> ...</Text>}
                    </>
                  )
                })()
              : docContent.content.substring(0, 5000)
            }
            {!docContentOffset && docContent.content.length > 5000 && (
              <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                ...({t('kbSearch.contentTruncated')})
              </Text>
            )}
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
      case 'entity':
        return renderEntityResults()
      case 'graph':
        return renderGraphResult()
      case 'globalSummary':
        return renderGlobalSummary()
      default:
        if (results.length === 0) {
          return <Empty description={t('kbSearch.noResults')} />
        }
        return (
          <div>
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

  const showAdvancedOptions = searchMode === 'advanced' || searchMode === 'entity'

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
                : searchMode === 'graph'
                  ? t('kbSearch.graphPlaceholder')
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

        {showAdvancedOptions && searchMode === 'entity' && (
          <div style={{ marginTop: 8 }}>
            <Select
              value={entitySearchType}
              onChange={setEntitySearchType}
              allowClear
              style={{ width: 140 }}
              placeholder={t('knowledgeBase.filterByType')}
              options={[
                { value: 'person', label: t('knowledgeBase.entityTypePerson') },
                { value: 'organization', label: t('knowledgeBase.entityTypeOrg') },
                { value: 'location', label: t('knowledgeBase.entityTypeLocation') },
                { value: 'event', label: t('knowledgeBase.entityTypeEvent') },
                { value: 'concept', label: t('knowledgeBase.entityTypeConcept') },
                { value: 'tool', label: t('knowledgeBase.entityTypeTool') },
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
