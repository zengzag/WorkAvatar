import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Input, Card, Typography, Space, Tag, Button, Tabs, Tree,
  Empty, Spin, theme, Tooltip, message, Pagination,
} from 'antd'
import {
  FileTextOutlined, SearchOutlined, ReadOutlined,
  UnorderedListOutlined, EditOutlined, SaveOutlined,
  CloseOutlined, FolderOutlined, TagOutlined,
  ProfileOutlined, ApartmentOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'

const { Text, Paragraph } = Typography
const PARAGRAPHS_PER_PAGE = 30

interface DocItem {
  id: string
  original_name: string
  type: string
  size: number
  parse_status: string
}

interface ParagraphItem {
  id: string
  title: string
  title_path: string
  level: number
  paragraph_index: number
  content: string
  summary: string | null
  keywords_json: string
}

interface DocSummaryItem {
  summary: string
  toc_json: string
  keywords_json: string
  main_topics_json: string
}

interface KBContentBrowserProps {
  kbId: string
  docs: DocItem[]
  loading: boolean
}

const KBContentBrowser: React.FC<KBContentBrowserProps> = ({
  kbId, docs, loading,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [searchText, setSearchText] = React.useState('')
  const [selectedDocId, setSelectedDocId] = React.useState<string | null>(null)
  const [selectedDocName, setSelectedDocName] = React.useState('')
  const [docContent, setDocContent] = React.useState<string | null>(null)
  const [docSummary, setDocSummary] = React.useState<DocSummaryItem | null>(null)
  const [docParagraphs, setDocParagraphs] = React.useState<ParagraphItem[]>([])
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [activeDetailTab, setActiveDetailTab] = React.useState('content')
  const [editingSummary, setEditingSummary] = React.useState(false)
  const [editingKeywords, setEditingKeywords] = React.useState(false)
  const [editSummaryText, setEditSummaryText] = React.useState('')
  const [editKeywordsText, setEditKeywordsText] = React.useState('')
  const [editingParagraphId, setEditingParagraphId] = React.useState<string | null>(null)
  const [editParagraphSummary, setEditParagraphSummary] = React.useState('')
  const [editParagraphKeywords, setEditParagraphKeywords] = React.useState('')
  const [paragraphPage, setParagraphPage] = React.useState(1)

  const filteredDocs = React.useMemo(() => {
    if (!searchText.trim()) return docs
    const lower = searchText.toLowerCase()
    return docs.filter(d => d.original_name.toLowerCase().includes(lower))
  }, [docs, searchText])

  const tocData = React.useMemo(() => {
    if (!docSummary?.toc_json) return []
    try {
      const toc = JSON.parse(docSummary.toc_json)
      if (!Array.isArray(toc)) return []
      return toc.map((item: any, index: number) => ({
        key: `toc-${index}`,
        title: (
          <span style={{ paddingLeft: (item.level - 1) * 12 }}>
            <Text strong={item.level === 1} style={{ fontSize: item.level === 1 ? 13 : 12 }}>
              {item.title}
            </Text>
          </span>
        ),
      }))
    } catch {
      return []
    }
  }, [docSummary])

  const mainTopics = React.useMemo(() => {
    if (!docSummary?.main_topics_json) return []
    try { return JSON.parse(docSummary.main_topics_json) } catch { return [] }
  }, [docSummary])

  const docKeywords = React.useMemo(() => {
    if (!docSummary?.keywords_json) return []
    try { return JSON.parse(docSummary.keywords_json) } catch { return [] }
  }, [docSummary])

  const loadDocDetail = React.useCallback(async (docId: string, docName: string) => {
    setSelectedDocId(docId)
    setSelectedDocName(docName)
    setDetailLoading(true)
    setDocContent(null)
    setDocSummary(null)
    setDocParagraphs([])
    setEditingSummary(false)
    setEditingKeywords(false)
    setEditingParagraphId(null)
    setParagraphPage(1)
    try {
      const [content, summary, paragraphs] = await Promise.all([
        window.electronAPI.kb.getDocContent(docId).catch(() => null),
        window.electronAPI.kb.getDocSummary(docId).catch(() => null),
        window.electronAPI.kb.getParagraphs(docId).catch(() => []),
      ])
      setDocContent(content || '')
      setDocSummary(summary || null)
      setDocParagraphs(paragraphs || [])
    } catch {
      message.error(t('knowledgeBase.loadDocDetailFailed'))
    } finally {
      setDetailLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    setSelectedDocId(null)
    setSelectedDocName('')
    setDocContent(null)
    setDocSummary(null)
    setDocParagraphs([])
    setEditingSummary(false)
    setEditingKeywords(false)
    setEditingParagraphId(null)
    setParagraphPage(1)
  }, [kbId])

  const handleSaveSummary = async () => {
    if (!selectedDocId) return
    try {
      await window.electronAPI.kb.updateDocSummary({
        document_id: selectedDocId,
        updates: { summary: editSummaryText },
      })
      setDocSummary(prev => prev ? { ...prev, summary: editSummaryText } : null)
      setEditingSummary(false)
      message.success(t('common.saveSuccess'))
    } catch {
      message.error(t('common.saveFailed'))
    }
  }

  const handleSaveKeywords = async () => {
    if (!selectedDocId) return
    try {
      const keywords = editKeywordsText.split(',').map(k => k.trim()).filter(Boolean)
      await window.electronAPI.kb.updateDocSummary({
        document_id: selectedDocId,
        updates: { keywords_json: JSON.stringify(keywords) },
      })
      setDocSummary(prev => prev ? { ...prev, keywords_json: JSON.stringify(keywords) } : null)
      setEditingKeywords(false)
      message.success(t('common.saveSuccess'))
    } catch {
      message.error(t('common.saveFailed'))
    }
  }

  const handleSaveParagraph = async (paragraphId: string) => {
    try {
      const keywords = editParagraphKeywords.split(',').map(k => k.trim()).filter(Boolean)
      await window.electronAPI.kb.updateParagraph({
        paragraph_id: paragraphId,
        updates: {
          summary: editParagraphSummary,
          keywords_json: JSON.stringify(keywords),
        },
      })
      setDocParagraphs(prev => prev.map(p =>
        p.id === paragraphId
          ? { ...p, summary: editParagraphSummary, keywords_json: JSON.stringify(keywords) }
          : p
      ))
      setEditingParagraphId(null)
      message.success(t('common.saveSuccess'))
    } catch {
      message.error(t('common.saveFailed'))
    }
  }

  const startEditSummary = () => {
    setEditSummaryText(docSummary?.summary || '')
    setEditingSummary(true)
  }

  const startEditKeywords = () => {
    setEditKeywordsText(docKeywords.join(', '))
    setEditingKeywords(true)
  }

  const startEditParagraph = (p: ParagraphItem) => {
    setEditingParagraphId(p.id)
    setEditParagraphSummary(p.summary || '')
    try {
      const kw = JSON.parse(p.keywords_json || '[]')
      setEditParagraphKeywords(kw.join(', '))
    } catch {
      setEditParagraphKeywords('')
    }
  }

  const docTypeIcon = (type: string) => {
    const colorMap: Record<string, string> = {
      pdf: '#f5222d', doc: '#1890ff', docx: '#1890ff',
      xls: '#52c41a', xlsx: '#52c41a', csv: '#52c41a',
      md: '#722ed1', txt: '#8c8c8c', html: '#fa8c16',
      png: '#faad14', jpg: '#faad14', jpeg: '#faad14',
    }
    return colorMap[type] || token.colorPrimary
  }

  const paginatedParagraphs = React.useMemo(() => {
    const start = (paragraphPage - 1) * PARAGRAPHS_PER_PAGE
    return docParagraphs.slice(start, start + PARAGRAPHS_PER_PAGE)
  }, [docParagraphs, paragraphPage])

  const totalParagraphPages = Math.max(1, Math.ceil(docParagraphs.length / PARAGRAPHS_PER_PAGE))

  const mdContent = React.useMemo(() => {
    if (!docContent) return null
    return <ReactMarkdown>{docContent}</ReactMarkdown>
  }, [docContent])

  const detailTabItems = React.useMemo(() => [
    {
      key: 'content',
      label: <Space><ReadOutlined />{t('knowledgeBase.originalDoc')}</Space>,
      children: (
        <div style={{ padding: '0 4px' }}>
          {docContent ? (
            <div style={{
              background: token.colorBgContainer,
              borderRadius: 8,
              padding: 16,
              maxHeight: 'calc(100vh - 320px)',
              overflow: 'auto',
            }}>
              {mdContent}
            </div>
          ) : (
            <Empty description={t('knowledgeBase.docContentEmpty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </div>
      ),
    },
    {
      key: 'toc',
      label: <Space><UnorderedListOutlined />{t('knowledgeBase.toc')}</Space>,
      children: activeDetailTab === 'toc' ? (
        <div style={{ padding: '0 4px' }}>
          {tocData.length > 0 ? (
            <div style={{
              background: token.colorBgContainer,
              borderRadius: 8,
              padding: 12,
            }}>
              <Tree
                defaultExpandAll
                treeData={tocData.slice(0, 500)}
                showLine={{ showLeafIcon: false }}
                style={{ maxHeight: 'calc(100vh - 320px)', overflow: 'auto' }}
              />
            </div>
          ) : (
            <Empty description={t('knowledgeBase.noToc')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </div>
      ) : <div />,
    },
    {
      key: 'summary',
      label: <Space><ProfileOutlined />{t('knowledgeBase.summary')}</Space>,
      children: activeDetailTab === 'summary' ? (
        <div style={{ padding: '0 4px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {docSummary ? (
            <>
              <Card size="small" title={
                <Space>{t('knowledgeBase.docSummary')}
                  {!editingSummary && (
                    <Button type="text" size="small" icon={<EditOutlined />} onClick={startEditSummary} />
                  )}
                </Space>
              }>
                {editingSummary ? (
                  <div>
                    <Input.TextArea
                      value={editSummaryText}
                      onChange={e => setEditSummaryText(e.target.value)}
                      rows={4}
                      style={{ marginBottom: 8 }}
                    />
                    <Space>
                      <Button size="small" type="primary" icon={<SaveOutlined />} onClick={handleSaveSummary}>{t('common.save')}</Button>
                      <Button size="small" icon={<CloseOutlined />} onClick={() => setEditingSummary(false)}>{t('common.cancel')}</Button>
                    </Space>
                  </div>
                ) : (
                  <Paragraph style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, margin: 0 }}>
                    {docSummary.summary || t('knowledgeBase.noSummary')}
                  </Paragraph>
                )}
              </Card>

              {mainTopics.length > 0 && (
                <Card size="small" title={t('knowledgeBase.mainTopics')}>
                  <Space wrap>
                    {mainTopics.map((topic: string, i: number) => (
                      <Tag key={i} color="blue">{topic}</Tag>
                    ))}
                  </Space>
                </Card>
              )}

              <Card size="small" title={
                <Space>{t('knowledgeBase.keywords')}
                  {!editingKeywords && (
                    <Button type="text" size="small" icon={<EditOutlined />} onClick={startEditKeywords} />
                  )}
                </Space>
              }>
                {editingKeywords ? (
                  <div>
                    <Input
                      value={editKeywordsText}
                      onChange={e => setEditKeywordsText(e.target.value)}
                      placeholder={t('knowledgeBase.keywordsEditPlaceholder')}
                      style={{ marginBottom: 8 }}
                    />
                    <Space>
                      <Button size="small" type="primary" icon={<SaveOutlined />} onClick={handleSaveKeywords}>{t('common.save')}</Button>
                      <Button size="small" icon={<CloseOutlined />} onClick={() => setEditingKeywords(false)}>{t('common.cancel')}</Button>
                    </Space>
                  </div>
                ) : (
                  <Space wrap>
                    {docKeywords.length > 0 ? docKeywords.map((kw: string, i: number) => (
                      <Tag key={i}><TagOutlined /> {kw}</Tag>
                    )) : <Text type="secondary">-</Text>}
                  </Space>
                )}
              </Card>
            </>
          ) : (
            <Empty description={t('knowledgeBase.noSummary')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </div>
      ) : <div />,
    },
    {
      key: 'paragraphs',
      label: <Space><ApartmentOutlined />{t('knowledgeBase.paragraphs')} ({docParagraphs.length})</Space>,
      children: activeDetailTab === 'paragraphs' ? (
        <div style={{ padding: '0 4px' }}>
          {docParagraphs.length > 0 ? (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {paginatedParagraphs.map(p => {
                  const level = p.level || 1
                  const keywords: string[] = (() => { try { return JSON.parse(p.keywords_json || '[]') } catch { return [] } })()
                  const isEditing = editingParagraphId === p.id
                  return (
                    <Card
                      key={p.id}
                      size="small"
                      style={{
                        borderLeft: `3px solid ${level === 1 ? token.colorPrimary : level === 2 ? token.colorSuccess : token.colorWarning}`,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <Space>
                          <Text strong>{p.title}</Text>
                          <Tag style={{ fontSize: 10 }} color={level === 1 ? 'blue' : level === 2 ? 'green' : 'default'}>L{level}</Tag>
                        </Space>
                        <Space size={4}>
                          {p.paragraph_index !== undefined && (
                            <Text type="secondary" style={{ fontSize: 11 }}>#{p.paragraph_index}</Text>
                          )}
                          {!isEditing && (
                            <Tooltip title={t('knowledgeBase.editParagraph')}>
                              <Button type="text" size="small" icon={<EditOutlined />} onClick={() => startEditParagraph(p)} />
                            </Tooltip>
                          )}
                        </Space>
                      </div>
                      {p.title_path && (
                        <div style={{ marginBottom: 4 }}>
                          <Text type="secondary" style={{ fontSize: 12 }}>{p.title_path}</Text>
                        </div>
                      )}
                      <div style={{
                        background: token.colorBgLayout,
                        padding: '8px 12px',
                        borderRadius: 6,
                        marginBottom: 8,
                      }}>
                        <Paragraph
                          style={{ fontSize: 13, lineHeight: 1.8, margin: 0, whiteSpace: 'pre-wrap' }}
                          ellipsis={{ rows: 5, expandable: 'collapsible', symbol: t('kbSearch.expand') }}
                        >
                          {p.content}
                        </Paragraph>
                      </div>
                      {isEditing ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <Input.TextArea
                            value={editParagraphSummary}
                            onChange={e => setEditParagraphSummary(e.target.value)}
                            placeholder={t('knowledgeBase.summaryEditPlaceholder')}
                            rows={2}
                          />
                          <Input
                            value={editParagraphKeywords}
                            onChange={e => setEditParagraphKeywords(e.target.value)}
                            placeholder={t('knowledgeBase.keywordsEditPlaceholder')}
                          />
                          <Space>
                            <Button size="small" type="primary" icon={<SaveOutlined />} onClick={() => handleSaveParagraph(p.id)}>{t('common.save')}</Button>
                            <Button size="small" icon={<CloseOutlined />} onClick={() => setEditingParagraphId(null)}>{t('common.cancel')}</Button>
                          </Space>
                        </div>
                      ) : (
                        <>
                          {p.summary && (
                            <div style={{ marginBottom: 4 }}>
                              <Text type="secondary" style={{ fontSize: 12 }}>{t('knowledgeBase.summary')}: </Text>
                              <Text style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{p.summary}</Text>
                            </div>
                          )}
                          {keywords.length > 0 && (
                            <Space size={2} wrap>
                              {keywords.map(k => <Tag key={k} style={{ fontSize: 11 }}>{k}</Tag>)}
                            </Space>
                          )}
                        </>
                      )}
                    </Card>
                  )
                })}
              </div>
              {totalParagraphPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
                  <Pagination
                    current={paragraphPage}
                    total={docParagraphs.length}
                    pageSize={PARAGRAPHS_PER_PAGE}
                    onChange={setParagraphPage}
                    showSizeChanger={false}
                    size="small"
                    showTotal={(total, range) => `${range[0]}-${range[1]} / ${total}`}
                  />
                </div>
              )}
            </>
          ) : (
            <Empty description={t('knowledgeBase.noParagraphs')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </div>
      ) : <div />,
    },
  ], [
    activeDetailTab, docContent, mdContent, docSummary, docParagraphs, paginatedParagraphs,
    totalParagraphPages, tocData, mainTopics, docKeywords, editingSummary, editingKeywords,
    editSummaryText, editKeywordsText, editingParagraphId, editParagraphSummary,
    editParagraphKeywords, paragraphPage, token, t,
  ])

  return (
    <div style={{ display: 'flex', gap: 12, height: 'calc(100vh - 220px)', minHeight: 400 }}>
      <div style={{
        width: 280,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgContainer,
        borderRadius: 8,
        border: `1px solid ${token.colorBorderSecondary}`,
        overflow: 'hidden',
      }}>
        <div style={{ padding: '8px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder={t('knowledgeBase.searchDocs')}
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            allowClear
            size="small"
          />
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 40 }}>
              <Spin />
            </div>
          ) : filteredDocs.length === 0 ? (
            <Empty description={t('knowledgeBase.noDocs')} image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} />
          ) : (
            <div style={{ fontSize: 12 }}>
              {filteredDocs.map((doc) => (
                <div
                  key={doc.id}
                  onClick={() => loadDocDetail(doc.id, doc.original_name)}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    background: selectedDocId === doc.id ? token.colorPrimaryBg : 'transparent',
                    borderLeft: selectedDocId === doc.id ? `3px solid ${token.colorPrimary}` : '3px solid transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', overflow: 'hidden' }}>
                    <FileTextOutlined style={{ color: docTypeIcon(doc.type), flexShrink: 0 }} />
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <Text ellipsis style={{ fontSize: 13, display: 'block' }}>{doc.original_name}</Text>
                      <Space size={4}>
                        <Tag style={{ fontSize: 10 }}>{doc.type}</Tag>
                        {doc.parse_status === 'completed' && (
                          <Tag color="green" style={{ fontSize: 10 }}>{t('knowledgeBase.parsed')}</Tag>
                        )}
                      </Space>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{
        flex: 1,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgContainer,
        borderRadius: 8,
        border: `1px solid ${token.colorBorderSecondary}`,
      }}>
        {!selectedDocId ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty
              image={<FolderOutlined style={{ fontSize: 64, color: token.colorTextQuaternary }} />}
              description={t('knowledgeBase.selectDocToView')}
            />
          </div>
        ) : detailLoading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin description={t('knowledgeBase.loading')} />
          </div>
        ) : (
          <>
            <div style={{
              padding: '12px 16px',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <FileTextOutlined style={{ color: token.colorPrimary, fontSize: 16 }} />
              <Text strong style={{ fontSize: 15 }}>{selectedDocName}</Text>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '0 16px' }}>
              <Tabs
                activeKey={activeDetailTab}
                onChange={setActiveDetailTab}
                items={detailTabItems}
                size="small"
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default KBContentBrowser
