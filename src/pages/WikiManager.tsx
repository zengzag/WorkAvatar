import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Card,
  Button,
  Space,
  Typography,
  Tag,
  message,
  Modal,
  Spin,
  Tabs,
  Empty,
  Badge,
  List,
  Tooltip,
  Divider,
  Input,
  Alert,
  Progress,
  Switch,
} from 'antd'
import {
  BookOutlined,
  FileTextOutlined,
  ReloadOutlined,
  PlusOutlined,
  EyeOutlined,
  TagsOutlined,
  ArrowLeftOutlined,
  CheckCircleOutlined,
  AuditOutlined,
  SafetyOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import LLMSelector from '../components/llm/LLMSelector'
import dayjs from 'dayjs'

const { Text, Title, Paragraph } = Typography
const { Search } = Input

interface WikiPage {
  id: string
  title: string
  type: 'concept' | 'entity' | 'summary'
  entity_type?: string
  path: string
  tags: string[]
  summary: string
}

interface RawFile {
  path: string
  name: string
  type: string
  parsed: boolean
}

interface WikiStatus {
  initialized: boolean
  raw_count: number
  wiki_page_count: number
  concept_count: number
  entity_count: number
  summary_count: number
  open_audits: number
  last_operation_at: number
}

interface LintResult {
  dead_links: Array<{ source: string; link: string }>
  orphan_pages: string[]
  missing_index: string[]
  total_issues: number
}

interface AuditResult {
  open: Array<{
    id: string
    target: string
    target_lines: [number, number]
    anchor_before: string
    anchor_text: string
    anchor_after: string
    severity: 'info' | 'suggest' | 'error' | 'warn'
    author: string
    created: string
    status: string
    comment: string
  }>
  resolved: Array<any>
}

const WikiManager: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [status, setStatus] = useState<WikiStatus | null>(null)
  const [pages, setPages] = useState<WikiPage[]>([])
  const [rawFiles, setRawFiles] = useState<RawFile[]>([])
  const [loading, setLoading] = useState(false)
  const [compiling, setCompiling] = useState(false)
  const [linting, setLinting] = useState(false)
  const [activeTab, setActiveTab] = useState('overview')
  const [selectedPage, setSelectedPage] = useState<WikiPage | null>(null)
  const [pageContent, setPageContent] = useState<any>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<WikiPage[]>([])
  const [querying, setQuerying] = useState(false)
  const [queryResult, setQueryResult] = useState<string>('')
  const [lintResult, setLintResult] = useState<LintResult | null>(null)
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null)
  const [selectedRawFile, setSelectedRawFile] = useState<RawFile | null>(null)
  const [ingesting, setIngesting] = useState(false)
  const [resolveAuditVisible, setResolveAuditVisible] = useState(false)
  const [selectedAudit, setSelectedAudit] = useState<any>(null)
  const [resolution, setResolution] = useState('')
  const [newPageContent, setNewPageContent] = useState('')
  const [resolvingAudit, setResolvingAudit] = useState(false)

  const [compileProgress, setCompileProgress] = useState<{ stage: string; detail: string } | null>(null)
  const [compileLLMContent, setCompileLLMContent] = useState('')
  const [compileThought, setCompileThought] = useState('')
  const [compileThoughtDone, setCompileThoughtDone] = useState(false)
  const [compileThoughtExpanded, setCompileThoughtExpanded] = useState(true)
  const [compileFileIndex, setCompileFileIndex] = useState(0)
  const [compileTotalFiles, setCompileTotalFiles] = useState(0)
  const [forceCompile, setForceCompile] = useState(false)

  const [ingestProgress, setIngestProgress] = useState<{ stage: string; detail: string } | null>(null)
  const [ingestLLMContent, setIngestLLMContent] = useState('')
  const [ingestThought, setIngestThought] = useState('')
  const [ingestThoughtDone, setIngestThoughtDone] = useState(false)
  const [ingestThoughtExpanded, setIngestThoughtExpanded] = useState(true)
  const [selectedLlmProviderId, setSelectedLlmProviderId] = useState<string>('')
  const [selectedLlmModelId, setSelectedLlmModelId] = useState<string>('')

  useEffect(() => {
    if (projectId) {
      loadStatus()
      loadPages()
      loadRawFiles()
    }
  }, [projectId])

  const loadStatus = async () => {
    window.electronAPI.wiki.getStatus({ project_id: projectId! }).then(result => {
      setStatus(result)
    }).catch(() => {
      console.error('加载 Wiki 状态失败')
    })
  }

  const loadPages = async () => {
    window.electronAPI.wiki.getPages({ project_id: projectId! }).then(result => {
      setPages(result || [])
    }).catch(() => {
      console.error('加载 Wiki 页面失败')
    })
  }

  const loadRawFiles = async () => {
    window.electronAPI.wiki.getRawFiles({ project_id: projectId! }).then(result => {
      setRawFiles(result || [])
    }).catch(() => {
      console.error('加载原始文件失败')
    })
  }

  const showError = (title: string, errors: string[]) => {
    if (errors.length <= 1) {
      message.error(errors[0] || title)
      return
    }
    Modal.error({
      title,
      width: 700,
      content: (
        <div style={{ maxHeight: 400, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>
          {errors.map((e, i) => (
            <div key={i} style={{ marginBottom: i < errors.length - 1 ? 12 : 0, padding: '8px 12px', background: i === 0 ? '#fff2f0' : '#fafafa', borderRadius: 6, border: '1px solid #ffccc7' }}>
              {e}
            </div>
          ))}
        </div>
      ),
    })
  }

  const handleInitialize = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.wiki.initialize({ project_id: projectId! })
      if (result.success) {
        message.success(result.message)
        loadStatus()
        loadRawFiles()
      } else {
        message.error(result.message)
      }
    } catch {
      message.error('初始化失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCompile = async () => {
    setCompiling(true)
    setCompileProgress(null)
    setCompileLLMContent('')
    setCompileThought('')
    setCompileThoughtDone(false)
    setCompileThoughtExpanded(true)
    setCompileFileIndex(0)
    setCompileTotalFiles(0)

    const cleanupProgress = window.electronAPI.wiki.onCompileProgress((progress) => {
      setCompileProgress(progress)
      const match = progress.detail.match(/正在编译第 (\d+)\/(\d+) 个文件/)
      if (match) {
        setCompileFileIndex(parseInt(match[1]))
        setCompileTotalFiles(parseInt(match[2]))
      }
    })

    const cleanupLLMChunk = window.electronAPI.wiki.onCompileLLMChunk((chunk) => {
      setCompileLLMContent((prev) => prev + chunk)
      setCompileThoughtDone(true)
      setCompileThoughtExpanded(false)
    })

    const cleanupThought = window.electronAPI.wiki.onCompileThought((thought) => {
      setCompileThought((prev) => prev + thought)
    })

    try {
      const result = await window.electronAPI.wiki.compile({ project_id: projectId!, force: forceCompile, provider_id: selectedLlmProviderId || undefined, model_id: selectedLlmModelId || undefined })
      if (result.success) {
        const msgParts = [`编译完成！新建 ${result.pages_created} 页`]
        if (result.pages_updated > 0) msgParts.push(`更新 ${result.pages_updated} 页`)
        if (result.skipped > 0) msgParts.push(`跳过 ${result.skipped} 个已解析`)
        message.success(msgParts.join('，'))
        loadStatus()
        loadPages()
      } else {
        showError('编译失败', result.errors || ['未知错误'])
      }
    } catch (err: any) {
      showError('编译失败', [err?.message || '未知错误'])
    } finally {
      cleanupProgress()
      cleanupLLMChunk()
      cleanupThought()
      setCompiling(false)
      setTimeout(() => {
        setCompileProgress(null)
        setCompileLLMContent('')
        setCompileThought('')
        setCompileThoughtDone(false)
        setCompileThoughtExpanded(true)
      }, 3000)
    }
  }

  const handleIngest = async (file: RawFile) => {
    setIngesting(true)
    setSelectedRawFile(file)
    setIngestProgress(null)
    setIngestLLMContent('')
    setIngestThought('')
    setIngestThoughtDone(false)
    setIngestThoughtExpanded(true)

    const cleanupProgress = window.electronAPI.wiki.onIngestProgress((progress) => {
      setIngestProgress(progress)
    })

    const cleanupLLMChunk = window.electronAPI.wiki.onIngestLLMChunk((chunk) => {
      setIngestLLMContent((prev) => prev + chunk)
      setIngestThoughtDone(true)
      setIngestThoughtExpanded(false)
    })

    const cleanupThought = window.electronAPI.wiki.onIngestThought((thought) => {
      setIngestThought((prev) => prev + thought)
    })

    try {
      const result = await window.electronAPI.wiki.ingestSource({
        project_id: projectId!,
        raw_file_path: file.path,
        provider_id: selectedLlmProviderId || undefined,
        model_id: selectedLlmModelId || undefined,
      })
      if (result.success) {
        message.success(`导入完成！新建 ${result.pages_created} 页`)
        loadStatus()
        loadPages()
      } else {
        showError('导入失败', result.errors || ['未知错误'])
      }
    } catch (err: any) {
      showError('导入失败', [err?.message || '未知错误'])
    } finally {
      cleanupProgress()
      cleanupLLMChunk()
      cleanupThought()
      setIngesting(false)
      setSelectedRawFile(null)
      setTimeout(() => {
        setIngestProgress(null)
        setIngestLLMContent('')
        setIngestThought('')
        setIngestThoughtDone(false)
        setIngestThoughtExpanded(true)
      }, 3000)
    }
  }

  const handleSearch = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([])
      return
    }
    try {
      const results = await window.electronAPI.wiki.search({
        project_id: projectId!,
        query,
        top_k: 20,
      })
      setSearchResults(results.map((r: any) => r.page))
    } catch {
      message.error('搜索失败')
    }
  }

  const handleQuery = async (query: string) => {
    if (!query.trim()) return
    setQuerying(true)
    setQueryResult('')
    try {
      const result = await window.electronAPI.wiki.query({
        project_id: projectId!,
        query,
        provider_id: selectedLlmProviderId || undefined,
        model_id: selectedLlmModelId || undefined,
      })
      setQueryResult(result.answer)
    } catch {
      message.error('查询失败')
    } finally {
      setQuerying(false)
    }
  }

  const handleLint = async () => {
    setLinting(true)
    try {
      const result = await window.electronAPI.wiki.lint({ project_id: projectId! })
      setLintResult(result)
      if (result.total_issues > 0) {
        message.warning(`发现 ${result.total_issues} 个问题`)
      } else {
        message.success('Wiki 状态良好，没有发现问题')
      }
      setActiveTab('lint')
    } catch {
      message.error('检查失败')
    } finally {
      setLinting(false)
    }
  }

  const handleAudit = async () => {
    try {
      const result = await window.electronAPI.wiki.audit({ project_id: projectId! })
      setAuditResult(result)
      if (result.open.length > 0) {
        message.warning(`发现 ${result.open.length} 个待处理的审核`)
      } else {
        message.success('审核队列为空')
      }
      setActiveTab('audit')
    } catch {
      message.error('审核检查失败')
    }
  }

  const handleViewPage = async (page: WikiPage) => {
    setSelectedPage(page)
    try {
      const content = await window.electronAPI.wiki.getPage({
        project_id: projectId!,
        page_path: page.path,
      })
      setPageContent(content)
      setActiveTab('page')
    } catch {
      message.error('加载页面内容失败')
    }
  }

  const conceptPages = pages.filter(p => p.type === 'concept')
  const entityPages = pages.filter(p => p.type === 'entity')
  const summaryPages = pages.filter(p => p.type === 'summary')
  const allTags = Array.from(new Set(pages.flatMap((p) => p.tags)))

  const filteredPages = searchQuery.trim()
    ? searchResults.length > 0
      ? searchResults
      : pages.filter(p =>
          p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.summary.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : pages

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'concept': return 'blue'
      case 'entity': return 'green'
      case 'summary': return 'orange'
      default: return 'default'
    }
  }

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'error': return 'red'
      case 'warn': return 'orange'
      case 'suggest': return 'blue'
      case 'info': return 'default'
      default: return 'default'
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <PageHeader
          title="LLM Wiki 知识库"
          subTitle="结构化知识管理"
          onBack={() => navigate(-1)}
          breadcrumb={[{ title: '项目详情' }, { title: '知识库管理' }]}
          extra={
            <Space>
              {!status?.initialized ? (
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={handleInitialize}
                  loading={loading}
                >
                  初始化知识库
                </Button>
              ) : (
                <>
                  <LLMSelector
                    providerId={selectedLlmProviderId}
                    modelId={selectedLlmModelId}
                    onProviderChange={setSelectedLlmProviderId}
                    onModelChange={setSelectedLlmModelId}
                  />
                  <Button
                    icon={<AuditOutlined />}
                    onClick={handleLint}
                    loading={linting}
                  >
                    检查
                  </Button>
                  <Button
                    icon={<SafetyOutlined />}
                    onClick={handleAudit}
                  >
                    审核
                  </Button>
                  <Tooltip title="强制重新编译所有文件（已解析的也会重新处理）">
                    <Space size={4}>
                      <Text type="secondary" style={{ fontSize: 12 }}>强制</Text>
                      <Switch
                        size="small"
                        checked={forceCompile}
                        onChange={setForceCompile}
                        disabled={compiling}
                      />
                    </Space>
                  </Tooltip>
                  <Button
                    icon={<ReloadOutlined spin={compiling} />}
                    onClick={handleCompile}
                    loading={compiling}
                    type="primary"
                  >
                    {forceCompile ? '强制编译全部' : '编译知识库'}
                  </Button>
                </>
              )}
            </Space>
          }
        />
      </div>

      <div style={{ flex: 1, padding: '0 24px 24px', overflow: 'auto' }}>
        {(compiling || compileProgress) && (
          <Card
            style={{ marginBottom: 16, border: '1px solid #1677ff' }}
            title={
              <Space>
                <Spin size="small" />
                <Text strong>知识库编译中</Text>
              </Space>
            }
            extra={
              compileTotalFiles > 0 && (
                <Text type="secondary">
                  {compileFileIndex}/{compileTotalFiles} 文件
                </Text>
              )
            }
          >
            {compileTotalFiles > 0 && (
              <Progress
                percent={Math.round(((compileFileIndex - 1) / compileTotalFiles) * 100)}
                status="active"
                style={{ marginBottom: 12 }}
              />
            )}
            {compileProgress && (
              <Alert
                type="info"
                message={compileProgress.stage}
                description={compileProgress.detail}
                style={{ marginBottom: 12 }}
              />
            )}
            {compileLLMContent && (
              <Card
                size="small"
                title="LLM 实时输出"
                style={{ background: '#1e1e1e', border: '1px solid #333' }}
                headStyle={{ color: '#d4d4d4', borderBottom: '1px solid #333', minHeight: 'auto' }}
                bodyStyle={{ padding: 12, maxHeight: 300, overflow: 'auto' }}
              >
                <pre style={{
                  color: '#d4d4d4',
                  fontSize: 12,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  margin: 0,
                  fontFamily: 'Consolas, "Courier New", monospace',
                }}>
                  {compileLLMContent}
                </pre>
              </Card>
            )}
            {compileThought && (
              <Card
                size="small"
                title={
                  <div
                    style={{ cursor: compileThoughtDone ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                    onClick={() => compileThoughtDone && setCompileThoughtExpanded(!compileThoughtExpanded)}
                  >
                    <span>💭 LLM 思考过程{compileThoughtDone ? ' (已完成)' : ''}</span>
                    {compileThoughtDone && (
                      <span style={{ fontSize: 12, color: '#a0a0d0' }}>
                        {compileThoughtExpanded ? '收起 ▲' : '展开 ▼'}
                      </span>
                    )}
                  </div>
                }
                style={{ background: '#1a1a2e', border: '1px solid #333', marginTop: 12 }}
                headStyle={{ color: '#a0a0d0', borderBottom: compileThoughtExpanded ? '1px solid #333' : 'none', minHeight: 'auto' }}
                bodyStyle={compileThoughtDone && !compileThoughtExpanded ? { display: 'none' } : { padding: 12, maxHeight: 200, overflow: 'auto' }}
              >
                <pre style={{
                  color: '#a0a0d0',
                  fontSize: 11,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  margin: 0,
                  fontFamily: 'Consolas, "Courier New", monospace',
                }}>
                  {compileThought}
                </pre>
              </Card>
            )}
          </Card>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin size="large" />
            <Paragraph type="secondary" style={{ marginTop: 16 }}>
              正在初始化知识库...
            </Paragraph>
          </div>
        ) : !status?.initialized ? (
          <Card style={{ marginTop: 16 }}>
            <Empty
              image={<BookOutlined style={{ fontSize: 64, color: '#d9d9d9' }} />}
              description={
                <div>
                  <Title level={4}>知识库尚未初始化</Title>
                  <Paragraph type="secondary">
                    点击"初始化知识库"按钮，系统将自动同步项目文件并创建 Wiki 结构。
                  </Paragraph>
                  <div style={{ textAlign: 'left', maxWidth: 600, margin: '24px auto', background: '#f6ffed', padding: 16, borderRadius: 8 }}>
                    <Text strong style={{ color: '#52c41a' }}>
                      <CheckCircleOutlined /> LLM Wiki 是什么？
                    </Text>
                    <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                      与传统 RAG 不同，LLM Wiki 会在查询前（编译时）将原始资料转化为结构化、相互链接的 Markdown 文件。知识像复利一样增长，越用越"聪明"。
                    </Paragraph>
                  </div>
                </div>
              }
            >
              <Button type="primary" icon={<PlusOutlined />} onClick={handleInitialize}>
                立即初始化
              </Button>
            </Empty>
          </Card>
        ) : (
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            style={{ marginTop: 8 }}
            items={[
              {
                key: 'overview',
                label: (
                  <Space>
                    <BookOutlined />
                    概览
                  </Space>
                ),
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size="large">
                    <Card>
                      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                        <div style={{ textAlign: 'center', minWidth: 120 }}>
                          <Text type="secondary">原始文件</Text>
                          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#1677ff' }}>
                            {status?.raw_count || 0}
                          </div>
                        </div>
                        <Divider type="vertical" style={{ height: 60 }} />
                        <div style={{ textAlign: 'center', minWidth: 120 }}>
                          <Text type="secondary">概念页面</Text>
                          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#52c41a' }}>
                            {status?.concept_count || 0}
                          </div>
                        </div>
                        <Divider type="vertical" style={{ height: 60 }} />
                        <div style={{ textAlign: 'center', minWidth: 120 }}>
                          <Text type="secondary">实体页面</Text>
                          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#faad14' }}>
                            {status?.entity_count || 0}
                          </div>
                        </div>
                        <Divider type="vertical" style={{ height: 60 }} />
                        <div style={{ textAlign: 'center', minWidth: 120 }}>
                          <Text type="secondary">摘要页面</Text>
                          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#eb2f96' }}>
                            {status?.summary_count || 0}
                          </div>
                        </div>
                        <Divider type="vertical" style={{ height: 60 }} />
                        <div style={{ textAlign: 'center', minWidth: 120 }}>
                          <Text type="secondary">总页面数</Text>
                          <div style={{ fontSize: 32, fontWeight: 'bold' }}>
                            {status?.wiki_page_count || 0}
                          </div>
                        </div>
                        <Divider type="vertical" style={{ height: 60 }} />
                        <div style={{ textAlign: 'center', minWidth: 120 }}>
                          <Text type="secondary">待审核</Text>
                          <div style={{ fontSize: 32, fontWeight: 'bold', color: status?.open_audits ? '#ff4d4f' : '#52c41a' }}>
                            {status?.open_audits || 0}
                          </div>
                        </div>
                      </div>
                    </Card>

                    <Card title="目录结构" size="small">
                      <pre style={{ background: '#f5f5f5', padding: 16, borderRadius: 8, fontSize: 13 }}>
                        {`project-wiki/
├── CLAUDE.md              # Schema 文件（AI 指引）
├── log/                    # 操作日志
│   └── YYYYMMDD.md
├── audit/                  # 人类反馈
│   ├── {timestamp}_{slug}.md
│   └── resolved/
├── raw/                    # 原始资料（只读）
│   ├── articles/
│   ├── papers/
│   ├── notes/
│   └── refs/
├── wiki/                   # 结构化 Wiki
│   ├── index.md            # 知识库总索引
│   ├── concepts/         # 概念页面
│   ├── entities/         # 实体页面
│   └── summaries/        # 摘要页面
└── outputs/                # 问答记录与报告
    └── queries/         # 查询结果`}
                      </pre>
                    </Card>

                    <Card title="快速查询">
                      <Search
                        placeholder="输入问题查询知识库"
                        onSearch={handleQuery}
                        loading={querying}
                        enterButton={<SearchOutlined />}
                        style={{ marginBottom: 16 }}
                      />
                      {queryResult && (
                        <Card size="small" title="回答" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>
                          {queryResult}
                        </Card>
                      )}
                    </Card>
                  </Space>
                ),
              },
              {
                key: 'raw',
                label: (
                  <Space>
                    <FileTextOutlined />
                    原始文件
                    <Badge count={rawFiles.length} style={{ backgroundColor: '#1677ff' }} />
                  </Space>
                ),
                children: (
                  <Card>
                    {(ingesting || ingestProgress) && selectedRawFile && (
                      <Card
                        size="small"
                        style={{ marginBottom: 16, border: '1px solid #1677ff' }}
                        title={
                          <Space>
                            <Spin size="small" />
                            <Text strong>正在导入: {selectedRawFile.name}</Text>
                          </Space>
                        }
                      >
                        {ingestProgress && (
                          <Alert
                            type="info"
                            message={ingestProgress.stage}
                            description={ingestProgress.detail}
                            style={{ marginBottom: 12 }}
                          />
                        )}
                        {ingestLLMContent && (
                          <Card
                            size="small"
                            title="LLM 实时输出"
                            style={{ background: '#1e1e1e', border: '1px solid #333' }}
                            headStyle={{ color: '#d4d4d4', borderBottom: '1px solid #333', minHeight: 'auto' }}
                            bodyStyle={{ padding: 12, maxHeight: 250, overflow: 'auto' }}
                          >
                            <pre style={{
                              color: '#d4d4d4',
                              fontSize: 12,
                              lineHeight: 1.6,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              margin: 0,
                              fontFamily: 'Consolas, "Courier New", monospace',
                            }}>
                              {ingestLLMContent}
                            </pre>
                          </Card>
                        )}
                        {ingestThought && (
                          <Card
                            size="small"
                            title={
                              <div
                                style={{ cursor: ingestThoughtDone ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                                onClick={() => ingestThoughtDone && setIngestThoughtExpanded(!ingestThoughtExpanded)}
                              >
                                <span>💭 LLM 思考过程{ingestThoughtDone ? ' (已完成)' : ''}</span>
                                {ingestThoughtDone && (
                                  <span style={{ fontSize: 12, color: '#a0a0d0' }}>
                                    {ingestThoughtExpanded ? '收起 ▲' : '展开 ▼'}
                                  </span>
                                )}
                              </div>
                            }
                            style={{ background: '#1a1a2e', border: '1px solid #333', marginTop: 12 }}
                            headStyle={{ color: '#a0a0d0', borderBottom: ingestThoughtExpanded ? '1px solid #333' : 'none', minHeight: 'auto' }}
                            bodyStyle={ingestThoughtDone && !ingestThoughtExpanded ? { display: 'none' } : { padding: 12, maxHeight: 200, overflow: 'auto' }}
                          >
                            <pre style={{
                              color: '#a0a0d0',
                              fontSize: 11,
                              lineHeight: 1.5,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              margin: 0,
                              fontFamily: 'Consolas, "Courier New", monospace',
                            }}>
                              {ingestThought}
                            </pre>
                          </Card>
                        )}
                      </Card>
                    )}
                    {rawFiles.length === 0 ? (
                      <Empty description="暂无原始文件" />
                    ) : (
                      <List
                        dataSource={rawFiles}
                        renderItem={(file) => (
                          <List.Item
                            actions={[
                              <Button
                                type={file.parsed ? 'default' : 'primary'}
                                size="small"
                                onClick={() => handleIngest(file)}
                                loading={ingesting && selectedRawFile?.path === file.path}
                              >
                                {file.parsed ? '重新导入' : '导入'}
                              </Button>
                            ]}
                          >
                            <List.Item.Meta
                              avatar={
                                file.parsed
                                  ? <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 20 }} />
                                  : <FileTextOutlined />
                              }
                              title={
                                <Space>
                                  {file.name}
                                  {file.parsed && (
                                    <Tag color="success" style={{ fontSize: 11, lineHeight: '18px' }}>已解析</Tag>
                                  )}
                                </Space>
                              }
                              description={`类型: ${file.type}`}
                            />
                          </List.Item>
                        )}
                      />
                    )}
                  </Card>
                ),
              },
              {
                key: 'concepts',
                label: (
                  <Space>
                    <BookOutlined />
                    概念
                    <Badge count={conceptPages.length} style={{ backgroundColor: '#1677ff' }} />
                  </Space>
                ),
                children: (
                  <Card>
                    <Search
                      placeholder="搜索概念"
                      value={searchQuery}
                      onChange={setSearchQuery}
                      onSearch={handleSearch}
                      style={{ marginBottom: 16 }}
                    />
                    {filteredPages.filter(p => p.type === 'concept').length === 0 ? (
                      <Empty description="暂无概念页面，请先编译或导入文件" />
                    ) : (
                      <List
                        grid={{ gutter: 16, xs: 1, sm: 2, md: 3, lg: 3, xl: 4 }}
                        dataSource={searchQuery.trim() ? filteredPages.filter(p => p.type === 'concept') : conceptPages}
                        renderItem={(page) => (
                          <List.Item>
                            <Card
                              size="small"
                              hoverable
                              onClick={() => handleViewPage(page)}
                              title={
                                <Text strong ellipsis style={{ maxWidth: 200 }}>
                                  {page.title}
                                </Text>
                              }
                              extra={
                                <Tooltip title="查看">
                                  <Button type="text" size="small" icon={<EyeOutlined />} />
                                </Tooltip>
                              }
                            >
                              <Tag color={getTypeColor(page.type)} style={{ marginBottom: 8 }}>
                                {page.type}
                              </Tag>
                              <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ minHeight: 40 }}>
                                {page.summary || '暂无摘要'}
                              </Paragraph>
                              <div style={{ marginTop: 8 }}>
                                {page.tags.slice(0, 3).map((tag) => (
                                  <Tag key={tag} style={{ marginBottom: 4, fontSize: 11, padding: '0 4px' }}>
                                    {tag}
                                  </Tag>
                                ))}
                              </div>
                            </Card>
                          </List.Item>
                        )}
                      />
                    )}
                  </Card>
                ),
              },
              {
                key: 'entities',
                label: (
                  <Space>
                    <TagsOutlined />
                    实体
                    <Badge count={entityPages.length} style={{ backgroundColor: '#52c41a' }} />
                  </Space>
                ),
                children: (
                  <Card>
                    {entityPages.length === 0 ? (
                      <Empty description="暂无实体页面" />
                    ) : (
                      <List
                        grid={{ gutter: 16, xs: 1, sm: 2, md: 3, lg: 3, xl: 4 }}
                        dataSource={entityPages}
                        renderItem={(page) => (
                          <List.Item>
                            <Card
                              size="small"
                              hoverable
                              onClick={() => handleViewPage(page)}
                              title={
                                <Text strong ellipsis style={{ maxWidth: 200 }}>
                                  {page.title}
                                </Text>
                              }
                              extra={
                                <Tooltip title="查看">
                                  <Button type="text" size="small" icon={<EyeOutlined />} />
                                </Tooltip>
                              }
                            >
                              <Tag color={getTypeColor(page.type)} style={{ marginBottom: 8 }}>
                                {page.entity_type || page.type}
                              </Tag>
                              <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ minHeight: 40 }}>
                                {page.summary || '暂无摘要'}
                              </Paragraph>
                              <div style={{ marginTop: 8 }}>
                                {page.tags.slice(0, 3).map((tag) => (
                                  <Tag key={tag} style={{ marginBottom: 4, fontSize: 11, padding: '0 4px' }}>
                                    {tag}
                                  </Tag>
                                ))}
                              </div>
                            </Card>
                          </List.Item>
                        )}
                      />
                    )}
                  </Card>
                ),
              },
              {
                key: 'summaries',
                label: (
                  <Space>
                    <FileTextOutlined />
                    摘要
                    <Badge count={summaryPages.length} style={{ backgroundColor: '#faad14' }} />
                  </Space>
                ),
                children: (
                  <Card>
                    {summaryPages.length === 0 ? (
                      <Empty description="暂无摘要页面" />
                    ) : (
                      <List
                        grid={{ gutter: 16, xs: 1, sm: 2, md: 3, lg: 3, xl: 4 }}
                        dataSource={summaryPages}
                        renderItem={(page) => (
                          <List.Item>
                            <Card
                              size="small"
                              hoverable
                              onClick={() => handleViewPage(page)}
                              title={
                                <Text strong ellipsis style={{ maxWidth: 200 }}>
                                  {page.title}
                                </Text>
                              }
                              extra={
                                <Tooltip title="查看">
                                  <Button type="text" size="small" icon={<EyeOutlined />} />
                                </Tooltip>
                              }
                            >
                              <Tag color={getTypeColor(page.type)} style={{ marginBottom: 8 }}>
                                {page.type}
                              </Tag>
                              <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ minHeight: 40 }}>
                                {page.summary || '暂无摘要'}
                              </Paragraph>
                              <div style={{ marginTop: 8 }}>
                                {page.tags.slice(0, 3).map((tag) => (
                                  <Tag key={tag} style={{ marginBottom: 4, fontSize: 11, padding: '0 4px' }}>
                                    {tag}
                                  </Tag>
                                ))}
                              </div>
                            </Card>
                          </List.Item>
                        )}
                      />
                    )}
                  </Card>
                ),
              },
              {
                key: 'lint',
                label: (
                  <Space>
                    <AuditOutlined />
                    检查
                    {lintResult && lintResult.total_issues > 0 && (
                      <Badge count={lintResult.total_issues} style={{ backgroundColor: '#ff4d4f' }} />
                    )}
                  </Space>
                ),
                children: lintResult ? (
                  <Space direction="vertical" style={{ width: '100%' }} size="large">
                    {lintResult.total_issues === 0 ? (
                      <Card>
                        <Alert
                          message="检查完成"
                          description="没有发现任何问题，Wiki 状态良好"
                          type="success"
                          showIcon
                        />
                      </Card>
                    ) : (
                      <>
                        {lintResult.dead_links.length > 0 && (
                          <Card title={`无效链接 (${lintResult.dead_links.length})`} type="inner">
                            <List
                              dataSource={lintResult.dead_links}
                              renderItem={(item) => (
                                <List.Item>
                                  <Text strong>{item.source}</Text>
                                  <Tag color="red">→ {item.link}</Tag>
                                </List.Item>
                              )}
                            />
                          </Card>
                        )}
                        {lintResult.orphan_pages.length > 0 && (
                          <Card title={`孤立页面 (${lintResult.orphan_pages.length})`} type="inner">
                            <List
                              dataSource={lintResult.orphan_pages}
                              renderItem={(page) => (
                                <List.Item>
                                  <Tag color="orange">{page}</Tag>
                                </List.Item>
                              )}
                            />
                          </Card>
                        )}
                        {lintResult.missing_index.length > 0 && (
                          <Card title={`未索引缺失 (${lintResult.missing_index.length})`} type="inner">
                            <List
                              dataSource={lintResult.missing_index}
                              renderItem={(page) => (
                                <List.Item>
                                  <Tag color="blue">{page}</Tag>
                                </List.Item>
                              )}
                            />
                          </Card>
                        )}
                      </>
                    )}
                  </Space>
                ) : (
                  <Card>
                    <Empty
                      description="点击上方检查结果将显示 Wiki 的健康状况"
                      image={<AuditOutlined style={{ fontSize: 64, color: '#d9d9d9' }} />}
                    />
                  </Card>
                ),
              },
              {
                key: 'audit',
                label: (
                  <Space>
                    <SafetyOutlined />
                    审核
                    {auditResult && auditResult.open.length > 0 && (
                      <Badge count={auditResult.open.length} style={{ backgroundColor: '#ff4d4f' }} />
                    )}
                  </Space>
                ),
                children: auditResult ? (
                  <Space direction="vertical" style={{ width: '100%' }} size="large">
                    {auditResult.open.length > 0 ? (
                      <Card title={`待处理 (${auditResult.open.length})`}>
                        <List
                          dataSource={auditResult.open}
                          renderItem={(item) => (
                            <List.Item
                              extra={
                                <Button
                                  type="primary"
                                  size="small"
                                  onClick={() => {
                                    setSelectedAudit(item)
                                    setNewPageContent('')
                                    setResolution('')
                                    // 自动加载目标页面内容
                                    window.electronAPI.wiki.getPage({
                                      project_id: projectId!,
                                      page_path: item.target
                                    }).then((res: any) => {
                                      if (res) {
                                        setNewPageContent(res.content)
                                      }
                                    })
                                    setResolveAuditVisible(true)
                                  }}
                                >
                                  处理
                                </Button>
                              }
                            >
                              <List.Item.Meta
                                avatar={<Tag color={getSeverityColor(item.severity)}>{item.severity}</Tag>}
                                title={<Text strong>{item.target}</Text>}
                                description={
                                  <div>
                                    <Paragraph type="secondary" style={{ marginBottom: 8 }}>
                                      {item.comment}
                                    </Paragraph>
                                    <Text type="secondary" style={{ fontSize: 12 }}>
                                      作者: {item.author} · 创建于: {item.created}
                                    </Text>
                                  </div>
                                }
                              />
                              <Card size="small" style={{ marginTop: 8, background: '#f5f5f5' }}>
                                <Text code>{item.anchor_text}</Text>
                              </Card>
                            </List.Item>
                          )}
                        />
                      </Card>
                    ) : (
                      <Card>
                        <Alert
                          message="审核队列清空"
                          description="没有待处理的审核"
                          type="success"
                          showIcon
                        />
                      </Card>
                    )}
                    {auditResult.resolved.length > 0 && (
                      <Card title={`已解决 (${auditResult.resolved.length})`}>
                        <List
                          dataSource={auditResult.resolved}
                          renderItem={(item) => (
                            <List.Item>
                              <Tag color="default">已解决</Tag>
                              <Text>{item.comment}</Text>
                            </List.Item>
                          )}
                        />
                      </Card>
                    )}
                  </Space>
                ) : (
                  <Card>
                    <Empty
                      description="点击上方按钮加载审核结果"
                      image={<SafetyOutlined style={{ fontSize: 64, color: '#d9d9d9' }} />}
                    />
                  </Card>
                ),
              },
              {
                key: 'page',
                label: (
                  <Space>
                    <EyeOutlined />
                    {selectedPage?.title || '页面详情'}
                  </Space>
                ),
                children: selectedPage ? (
                  <Card
                    title={selectedPage.title}
                    extra={
                      <Button
                        icon={<ArrowLeftOutlined />}
                        size="small"
                        onClick={() => {
                          setActiveTab('concepts')
                          setSelectedPage(null)
                        }}
                      >
                        返回列表
                      </Button>
                    }
                  >
                    {pageContent ? (
                      <div>
                        <div style={{ marginBottom: 16 }}>
                          <Tag color={getTypeColor(pageContent.type)} style={{ marginRight: 8 }}>
                            {pageContent.type}
                          </Tag>
                          {pageContent.tags?.map((tag: string) => (
                            <Tag key={tag} color="blue" style={{ marginRight: 8 }}>
                              {tag}
                            </Tag>
                          ))}
                        </div>
                        <div
                          style={{
                            background: '#f5f5f5',
                            padding: 16,
                            borderRadius: 8,
                            whiteSpace: 'pre-wrap',
                            fontSize: 14,
                            lineHeight: 1.8,
                          }}
                        >
                          {pageContent.content}
                        </div>
                        {pageContent.links?.length > 0 && (
                          <div style={{ marginTop: 16 }}>
                            <Text strong>相关链接：</Text>
                            <div style={{ marginTop: 8 }}>
                              {pageContent.links.map((link: string) => (
                                <Tag key={link} icon={<BookOutlined />} style={{ marginBottom: 4 }}>
                                  {link}
                                </Tag>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <Spin />
                    )}
                  </Card>
                ) : (
                  <Empty description="请选择页面" />
                ),
              },
            ]}
          />
        )}

        {/* 处理审核模态框 */}
        <Modal
          title={`处理审核: ${selectedAudit?.target}`}
          open={resolveAuditVisible}
          width={800}
          onCancel={() => setResolveAuditVisible(false)}
          onOk={async () => {
            if (!resolution.trim()) {
              message.warning('请输入处理结果')
              return
            }
            setResolvingAudit(true)
            try {
              const result = await window.electronAPI.wiki.resolveAudit({
                project_id: projectId!,
                audit_id: selectedAudit.id,
                resolution,
                new_content: newPageContent
              })
              if (result.success) {
                message.success('审核处理成功')
                setResolveAuditVisible(false)
                // 重新加载审核列表和页面
                handleAudit()
                loadPages()
              } else {
                message.error(result.message || '处理失败')
              }
            } catch (err: any) {
              message.error(`处理失败: ${err.message}`)
            } finally {
              setResolvingAudit(false)
            }
          }}
          confirmLoading={resolvingAudit}
        >
          <div style={{ marginBottom: 16 }}>
            <Text strong>问题描述：</Text>
            <Paragraph style={{ marginTop: 8, background: '#f5f5f5', padding: 12, borderRadius: 6 }}>
              {selectedAudit?.comment}
            </Paragraph>
          </div>
          <div style={{ marginBottom: 16 }}>
            <Text strong>问题位置：</Text>
            <Card size="small" style={{ marginTop: 8, background: '#f5f5f5' }}>
              <Text code>{selectedAudit?.anchor_text}</Text>
            </Card>
          </div>
          <div style={{ marginBottom: 16 }}>
            <Text strong>修改后的页面内容：</Text>
            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>（如果不需要修改页面内容，可以留空）</Text>
            <Input.TextArea
              value={newPageContent}
              onChange={(e) => setNewPageContent(e.target.value)}
              rows={12}
              style={{ marginTop: 8, fontFamily: 'Consolas, monospace' }}
              placeholder="请输入修改后的页面内容..."
            />
          </div>
          <div>
            <Text strong>处理结果说明：</Text>
            <Input.TextArea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={3}
              style={{ marginTop: 8 }}
              placeholder="请输入处理结果说明..."
            />
          </div>
        </Modal>
      </div>
    </div>
  )
}

export default WikiManager
