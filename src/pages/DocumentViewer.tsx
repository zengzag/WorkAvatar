import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import {
  Card,
  Button,
  Tag,
  Typography,
  Space,
  Tabs,
  Table,
  Spin,
  Empty,
  Descriptions,
  Divider,
  Alert,
  theme,
  App,
} from 'antd'
import {
  FileTextOutlined,
  TableOutlined,
  InfoCircleOutlined,
  BookOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import type { File, ParseResult } from '../types'
import type { TabsProps } from 'antd'
import { formatFileSize } from '../utils/format'
import { useTranslation } from 'react-i18next'

const { Text, Paragraph } = Typography

const getStatusColor = (status: string) => {
  switch (status) {
    case 'completed': return 'green'
    case 'failed': return 'red'
    case 'parsing': return 'blue'
    default: return 'orange'
  }
}

const DocumentViewer: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { id, fileId } = useParams<{ id: string; fileId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = theme.useToken()
  const [file, setFile] = useState<File | null>(null)
  const [projectName, setProjectName] = useState('')
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [highlightText, setHighlightText] = useState<string | null>(null)
  const textContainerRef = useRef<HTMLDivElement>(null)

  const getStatusText = (status: string) => {
    switch (status) {
      case 'completed': return t('documentViewer.completed')
      case 'failed': return t('documentViewer.failed')
      case 'parsing': return t('documentViewer.parsing')
      default: return t('documentViewer.pending')
    }
  }

  useEffect(() => {
    if (fileId) {
      loadFile()
    }
  }, [fileId])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const text = params.get('text')
    
    if (text) {
      setHighlightText(decodeURIComponent(text))
    }
  }, [location.search])

  useEffect(() => {
    if (highlightText && textContainerRef.current && parseResult?.fullText) {
      setTimeout(() => {
        const container = textContainerRef.current
        if (container) {
          const text = container.innerHTML
          const regex = new RegExp(highlightText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
          const match = text.match(regex)
          if (match) {
            const highlighted = text.replace(
              match[0],
              `<mark style="background-color: #fff2e8; color: #e67700; padding: 2px 4px; border-radius: 4px; font-weight: 500;">${match[0]}</mark>`
            )
            container.innerHTML = highlighted
            
            const markElement = container.querySelector('mark')
            if (markElement) {
              markElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
          }
        }
      }, 100)
    }
  }, [highlightText, parseResult])

  const loadFile = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.file.get(fileId!)
      setFile(result)

      if (result?.project_id) {
        try {
          const project = await window.electronAPI.project.get(result.project_id)
          setProjectName(project?.name || t('documentViewer.defaultProject'))
        } catch {
          setProjectName(t('documentViewer.defaultProject'))
        }
      }

      if (result?.parsed_json) {
        try {
          const parsed = JSON.parse(result.parsed_json)
          setParseResult(parsed)
        } catch {
          message.error(t('documentViewer.parseResultError'))
        }
      }
    } catch {
      message.error(t('documentViewer.loadFileFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleReparse = async () => {
    try {
      setLoading(true)
      const result = await window.electronAPI.file.parse({ file_id: fileId! })
      if (result.success) {
        message.success(t('documentViewer.reparseSuccess'))
        loadFile()
      } else {
        message.error(result.error || t('documentViewer.parseFailed'))
      }
    } catch {
      message.error(t('documentViewer.reparseFailed'))
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin size="large" />
        <Paragraph style={{ marginTop: 16 }}>{t('documentViewer.loading')}</Paragraph>
      </div>
    )
  }

  if (!file) {
    return (
      <div style={{ padding: 24 }}>
        <Empty description={t('documentViewer.fileNotFound')} />
        <Button onClick={() => navigate(`/project/${id}`)} style={{ marginTop: 16 }}>
          {t('documentViewer.backToProject')}
        </Button>
      </div>
    )
  }

  const tabItems: TabsProps['items'] = [
    {
      key: 'text',
      label: (
        <Space>
          <FileTextOutlined />
          {t('documentViewer.tabText')}
        </Space>
      ),
      children: (
        <div>
          {parseResult?.fullText ? (
            <div
              ref={textContainerRef}
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                lineHeight: 1.8,
                fontSize: 14,
                padding: 16,
                background: token.colorBgLayout,
                borderRadius: 8,
                maxHeight: '60vh',
                overflow: 'auto',
              }}
            >
              {parseResult.fullText}
            </div>
          ) : (
            <Empty description={t('documentViewer.noTextContent')}>
              {file.status !== 'completed' && (
                <Button type="primary" onClick={handleReparse} style={{ marginTop: 16 }}>
                  {t('documentViewer.parseFile')}
                </Button>
              )}
            </Empty>
          )}
        </div>
      ),
    },
    {
      key: 'sections',
      label: (
        <Space>
          <BookOutlined />
          {t('documentViewer.tabChapters')}
          {parseResult?.sections?.length ? <Tag>{parseResult.sections.length}</Tag> : null}
        </Space>
      ),
      children: (
        <div>
          {parseResult?.sections && parseResult.sections.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {parseResult.sections.map((section, idx) => (
                <Card
                  key={idx}
                  size="small"
                  title={
                    <Space>
                      <Tag color="blue">Level {section.level}</Tag>
                      <Text strong>{section.title}</Text>
                    </Space>
                  }
                >
                  <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                    {section.content || t('documentViewer.noContent')}
                  </Paragraph>
                </Card>
              ))}
            </div>
          ) : (
            <Empty description={t('documentViewer.noChapters')} />
          )}
        </div>
      ),
    },
    {
      key: 'tables',
      label: (
        <Space>
          <TableOutlined />
          {t('documentViewer.tabTables')}
          {parseResult?.tables?.length ? <Tag>{parseResult.tables.length}</Tag> : null}
        </Space>
      ),
      children: (
        <div>
          {parseResult?.tables && parseResult.tables.length > 0 ? (
            <Space orientation="vertical" style={{ width: '100%' }} size={16}>
              {parseResult.tables.map((table, idx) => (
                <Card key={idx} size="small" title={table.context || t('documentViewer.table', { index: idx + 1 })}>
                  <Table
                    size="small"
                    bordered
                    pagination={false}
                    dataSource={table.rows.map((row, rIdx) => {
                      const record: Record<string, any> = { key: rIdx }
                      table.headers.forEach((h, hIdx) => {
                        record[h] = row[hIdx] || ''
                      })
                      return record
                    })}
                    columns={table.headers.map((h) => ({
                      title: h,
                      dataIndex: h,
                      key: h,
                    }))}
                    scroll={{ x: 'max-content' }}
                  />
                </Card>
              ))}
            </Space>
          ) : (
            <Empty description={t('documentViewer.noTables')} />
          )}
        </div>
      ),
    },
    {
      key: 'metadata',
      label: (
        <Space>
          <InfoCircleOutlined />
          {t('documentViewer.tabMetadata')}
        </Space>
      ),
      children: (
        <div>
          <Descriptions bordered column={2}>
            <Descriptions.Item label={t('documentViewer.fileId')}>{file.id}</Descriptions.Item>
            <Descriptions.Item label={t('documentViewer.originalName')}>{file.original_name}</Descriptions.Item>
            <Descriptions.Item label={t('documentViewer.fileType')}>
              <Tag>{file.type}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('documentViewer.fileSize')}>{formatFileSize(file.size)}</Descriptions.Item>
            <Descriptions.Item label={t('documentViewer.parseStatus')}>
              <Tag color={getStatusColor(file.status)}>{getStatusText(file.status)}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('documentViewer.ruleCount')}>{file.rule_count || 0}</Descriptions.Item>
            <Descriptions.Item label={t('documentViewer.qaCount')}>{file.qa_count || 0}</Descriptions.Item>
            <Descriptions.Item label={t('documentViewer.createTime')}>
              {new Date(file.created_at * 1000).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label={t('documentViewer.updateTime')}>
              {new Date(file.updated_at * 1000).toLocaleString()}
            </Descriptions.Item>
            {file.hash && <Descriptions.Item label={t('documentViewer.fileHash')}>{file.hash}</Descriptions.Item>}
          </Descriptions>

          {parseResult?.metadata && Object.keys(parseResult.metadata).length > 0 && (
            <>
              <Divider />
              <Text strong>{t('documentViewer.parseMetadata')}</Text>
              <Descriptions bordered column={2} style={{ marginTop: 16 }}>
                {Object.entries(parseResult.metadata).map(([key, value]) => (
                  <Descriptions.Item key={key} label={key}>
                    {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            </>
          )}

          {file.error_message && (
            <>
              <Divider />
              <Alert title={t('documentViewer.parseError')} description={file.error_message} type="error" showIcon />
            </>
          )}
        </div>
      ),
    },
  ]

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <PageHeader
        title={file.original_name}
        subTitle={t('documentViewer.breadcrumbDocPreview')}
        onBack={() => navigate(`/project/${id}`)}
        breadcrumb={[
          { title: t('documentViewer.breadcrumbChatCenter'), onClick: () => navigate('/') },
          { title: projectName },
          { title: t('documentViewer.breadcrumbDocPreview') },
        ]}
        extra={
          <Space>
            {highlightText && (
              <Tag color="orange" closable onClose={() => setHighlightText(null)}>
                {t('documentViewer.highlightMode')}
              </Tag>
            )}
            {file.status === 'completed' && (
              <Button onClick={handleReparse}>{t('documentViewer.reparse')}</Button>
            )}
            {file.status !== 'completed' && file.status !== 'parsing' && (
              <Button type="primary" onClick={handleReparse}>
                {t('documentViewer.parseFile')}
              </Button>
            )}
          </Space>
        }
      />

      <Card>
        <Tabs items={tabItems} defaultActiveKey="text" />
      </Card>
    </div>
  )
}

export default DocumentViewer
