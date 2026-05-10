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
  message,
  Spin,
  Empty,
  Descriptions,
  Divider,
  Alert,
  theme,
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

const { Text, Paragraph } = Typography

const DocumentViewer: React.FC = () => {
  const { id, fileId } = useParams<{ id: string; fileId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = theme.useToken()
  const [file, setFile] = useState<File | null>(null)
  const [projectName, setProjectName] = useState('')
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [highlightText, setHighlightText] = useState<string | null>(null)
  const [_chunkIndex, setChunkIndex] = useState<number | null>(null)
  const textContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (fileId) {
      loadFile()
    }
  }, [fileId])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const chunk = params.get('chunk')
    const text = params.get('text')
    
    if (chunk) {
      setChunkIndex(parseInt(chunk, 10))
    }
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
          setProjectName(project?.name || '项目')
        } catch {
          setProjectName('项目')
        }
      }

      if (result?.parsed_json) {
        try {
          const parsed = JSON.parse(result.parsed_json)
          setParseResult(parsed)
        } catch {
          message.error('解析结果格式错误')
        }
      }
    } catch {
      message.error('加载文件失败')
    } finally {
      setLoading(false)
    }
  }

  const handleReparse = async () => {
    try {
      setLoading(true)
      const result = await window.electronAPI.file.parse({ file_id: fileId! })
      if (result.success) {
        message.success('重新解析成功')
        loadFile()
      } else {
        message.error(result.error || '解析失败')
      }
    } catch {
      message.error('重新解析失败')
    } finally {
      setLoading(false)
    }
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'green'
      case 'failed': return 'red'
      case 'parsing': return 'blue'
      default: return 'orange'
    }
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'completed': return '已完成'
      case 'failed': return '失败'
      case 'parsing': return '解析中'
      default: return '待解析'
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin size="large" />
        <Paragraph style={{ marginTop: 16 }}>加载中...</Paragraph>
      </div>
    )
  }

  if (!file) {
    return (
      <div style={{ padding: 24 }}>
        <Empty description="文件不存在" />
        <Button onClick={() => navigate(`/project/${id}`)} style={{ marginTop: 16 }}>
          返回项目
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
          文本内容
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
            <Empty description="暂无文本内容">
              {file.status !== 'completed' && (
                <Button type="primary" onClick={handleReparse} style={{ marginTop: 16 }}>
                  解析文件
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
          章节结构
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
                    {section.content || '<无内容>'}
                  </Paragraph>
                </Card>
              ))}
            </div>
          ) : (
            <Empty description="未检测到章节结构" />
          )}
        </div>
      ),
    },
    {
      key: 'tables',
      label: (
        <Space>
          <TableOutlined />
          表格数据
          {parseResult?.tables?.length ? <Tag>{parseResult.tables.length}</Tag> : null}
        </Space>
      ),
      children: (
        <div>
          {parseResult?.tables && parseResult.tables.length > 0 ? (
            <Space orientation="vertical" style={{ width: '100%' }} size={16}>
              {parseResult.tables.map((table, idx) => (
                <Card key={idx} size="small" title={table.context || `表格 ${idx + 1}`}>
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
            <Empty description="未检测到表格数据" />
          )}
        </div>
      ),
    },
    {
      key: 'metadata',
      label: (
        <Space>
          <InfoCircleOutlined />
          元数据
        </Space>
      ),
      children: (
        <div>
          <Descriptions bordered column={2}>
            <Descriptions.Item label="文件ID">{file.id}</Descriptions.Item>
            <Descriptions.Item label="原始文件名">{file.original_name}</Descriptions.Item>
            <Descriptions.Item label="文件类型">
              <Tag>{file.type}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="文件大小">{formatFileSize(file.size)}</Descriptions.Item>
            <Descriptions.Item label="解析状态">
              <Tag color={getStatusColor(file.status)}>{getStatusText(file.status)}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="规则数量">{file.rule_count || 0}</Descriptions.Item>
            <Descriptions.Item label="问答对数量">{file.qa_count || 0}</Descriptions.Item>
            <Descriptions.Item label="创建时间">
              {new Date(file.created_at * 1000).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label="更新时间">
              {new Date(file.updated_at * 1000).toLocaleString()}
            </Descriptions.Item>
            {file.hash && <Descriptions.Item label="文件哈希">{file.hash}</Descriptions.Item>}
          </Descriptions>

          {parseResult?.metadata && Object.keys(parseResult.metadata).length > 0 && (
            <>
              <Divider />
              <Text strong>解析元数据</Text>
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
              <Alert title="解析错误" description={file.error_message} type="error" showIcon />
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
        subTitle="文档预览"
        onBack={() => navigate(`/project/${id}`)}
        breadcrumb={[
          { title: '仪表盘' },
          { title: projectName },
          { title: '文档预览' },
        ]}
        extra={
          <Space>
            {highlightText && (
              <Tag color="orange" closable onClose={() => setHighlightText(null)}>
                高亮模式
              </Tag>
            )}
            {file.status === 'completed' && (
              <Button onClick={handleReparse}>重新解析</Button>
            )}
            {file.status !== 'completed' && file.status !== 'parsing' && (
              <Button type="primary" onClick={handleReparse}>
                解析文件
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
