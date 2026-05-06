import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Card,
  Input,
  Button,
  Space,
  Typography,
  Tag,
  message,
  Spin,
  Collapse,
  Badge,
  Popconfirm,
  Tooltip,
} from 'antd'
import {
  SendOutlined,
  RobotOutlined,
  UserOutlined,
  StopOutlined,
  CopyOutlined,
  DislikeOutlined,
  LikeOutlined,
  SettingOutlined,
  BookOutlined,
  LinkOutlined,
  DeleteOutlined,
  BulbOutlined,
  ReloadOutlined,
  DatabaseOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import LLMSelector from '../components/llm/LLMSelector'
import dayjs from 'dayjs'
import type { Employee, Conversation, Message } from '../types'

const { Text, Paragraph } = Typography
const { TextArea } = Input

interface SearchResult {
  text: string
  score: number
  source: {
    file_id: string
    file_name: string
    chunk_index: number
  }
}

interface WikiSearchResult {
  page: {
    id: string
    title: string
    type: 'concept' | 'entity' | 'summary'
    entity_type?: string
    content: string
    tags: string[]
    sources: string[]
    created_at: number
    updated_at: number
    path: string
  }
  relevance: number
  matched_sections: string[]
}

interface MessageWithThought extends Message {
  thought?: string
  isStreamingThought?: boolean
  thoughtCollapsed?: boolean
}

const EmployeeWorkbench: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageWithThought[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [providers, setProviders] = useState<any[]>([])
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [wikiResults, setWikiResults] = useState<WikiSearchResult[]>([])
  const [showRAGPanel, setShowRAGPanel] = useState(true)
  const [showHistoryPanel, setShowHistoryPanel] = useState(true)
  const [useRAG, setUseRAG] = useState(true)
  const [useWiki, setUseWiki] = useState(true)
  const [selectedLlmProviderId, setSelectedLlmProviderId] = useState<string>('')
  const [selectedLlmModelId, setSelectedLlmModelId] = useState<string>('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (id) {
      loadEmployee()
      loadConversations()
      loadProviders()
    }
  }, [id])

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const loadEmployee = async () => {
    try {
      const result = await window.electronAPI.employee.get(id!)
      setEmployee(result)
      setProjectId(result.project_id)
      if (result.llm_provider_id) {
        setSelectedLlmProviderId(result.llm_provider_id)
      }
      if (result.llm_model) {
        setSelectedLlmModelId(result.llm_model)
      }
    } catch {
      message.error('加载员工信息失败')
    }
  }

  const loadConversations = async () => {
    try {
      const result = await window.electronAPI.conversation.list({ employee_id: id! })
      setConversations(result)
    } catch {
      console.error('加载对话列表失败')
    }
  }

  const loadProviders = async () => {
    try {
      const result = await window.electronAPI.llm.getProviders()
      setProviders(result as any[])
    } catch {}
  }

  const startNewConversation = async () => {
    try {
      const result = await window.electronAPI.conversation.create({
        employee_id: id!,
        title: `对话 ${dayjs().format('MM/DD HH:mm')}`,
      })
      setConversations((prev) => [result as Conversation, ...prev])
      setActiveConversationId((result as Conversation).id)
      setMessages([])
      setSearchResults([])
    } catch {
      message.error('创建对话失败')
    }
  }

  const selectConversation = (convId: string) => {
    setActiveConversationId(convId)
    setSearchResults([])
    setWikiResults([])
    const conv = conversations.find((c) => c.id === convId)
    if (conv) {
      try {
        const msgs = JSON.parse(conv.messages_json || '[]') as MessageWithThought[]
        setMessages(msgs)
      } catch {
        setMessages([])
      }
    }
  }

  const deleteConversation = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await window.electronAPI.conversation.delete(convId)
      setConversations((prev) => prev.filter((c) => c.id !== convId))
      if (activeConversationId === convId) {
        setActiveConversationId(null)
        setMessages([])
      }
      message.success('删除成功')
    } catch {
      message.error('删除失败')
    }
  }

  const handleSourceClick = (result: SearchResult) => {
    if (!projectId) return
    const fileId = result.source.file_id
    const chunkIndex = result.source.chunk_index
    navigate(`/project/${projectId}/file/${fileId}?chunk=${chunkIndex}&text=${encodeURIComponent(result.text.substring(0, 100))}`)
  }

  const handleSend = async () => {
    const providerId = selectedLlmProviderId || employee?.llm_provider_id || providers.find((p: any) => p.is_default)?.id
    if (!providerId) {
      message.warning('请先在设置中配置 LLM 提供商')
      return
    }

    const content = inputValue.trim()
    if (!content || isStreaming) return

    if (!activeConversationId) {
      await startNewConversation()
      return
    }

    setInputValue('')

    const userMessage: MessageWithThought = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    }

    const updatedMessages = [...messages, userMessage]
    setMessages(updatedMessages)

    const assistantMessageId = `msg_${Date.now() + 1}`
    const assistantMessage: MessageWithThought = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      thought: '',
      isStreamingThought: false,
    }
    setMessages((prev) => [...prev, assistantMessage])

    setIsStreaming(true)
    setSearchResults([])
    setWikiResults([])

    let chunkCleanup: () => void
    let doneCleanupFn: () => void
    let errorCleanupFn: () => void
    let ragCleanupFn: () => void
    let wikiCleanupFn: () => void
    let thoughtCleanupFn: () => void
    let toolCallCleanupFn: () => void
    let toolResultCleanupFn: () => void

    chunkCleanup = window.electronAPI.llm.onChunk((chunk: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId
            ? { ...m, content: m.content + chunk }
            : m
        )
      )
    })

    thoughtCleanupFn = window.electronAPI.llm.onThought((thoughtChunk: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId
            ? { ...m, thought: (m.thought || '') + thoughtChunk, isStreamingThought: true }
            : m
        )
      )
    })

    toolCallCleanupFn = window.electronAPI.llm.onToolCall((toolCall: { name: string; args: any }) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId
            ? { ...m, thought: (m.thought || '') + `\n[调用工具: ${toolCall.name}]`, isStreamingThought: true }
            : m
        )
      )
    })

    toolResultCleanupFn = window.electronAPI.llm.onToolResult((toolResult: { name: string; result: any }) => {
      const resultPreview = typeof toolResult.result === 'string'
        ? toolResult.result.slice(0, 200)
        : JSON.stringify(toolResult.result).slice(0, 200)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId
            ? { ...m, thought: (m.thought || '') + `\n[工具结果: ${resultPreview}]`, isStreamingThought: true }
            : m
        )
      )
    })

    ragCleanupFn = window.electronAPI.llm.onRAGResults((results: SearchResult[]) => {
      setSearchResults(results)
    })

    wikiCleanupFn = window.electronAPI.wiki.onWikiResults((results: WikiSearchResult[]) => {
      setWikiResults(results)
    })

    const finish = () => {
      chunkCleanup()
      if (thoughtCleanupFn) thoughtCleanupFn()
      if (doneCleanupFn) doneCleanupFn()
      if (errorCleanupFn) errorCleanupFn()
      if (ragCleanupFn) ragCleanupFn()
      if (wikiCleanupFn) wikiCleanupFn()
      if (toolCallCleanupFn) toolCallCleanupFn()
      if (toolResultCleanupFn) toolResultCleanupFn()
    }

    doneCleanupFn = window.electronAPI.llm.onDone(() => {
      setMessages((prev) => {
        const assistantMsg = prev.find((m) => m.id === assistantMessageId)
        const finalContent = assistantMsg?.content || ''
        window.electronAPI.conversation.update({
          id: activeConversationId,
          messages_json: JSON.stringify([
            ...updatedMessages,
            { ...assistantMessage, content: finalContent, isStreaming: false, isStreamingThought: false, thoughtCollapsed: true },
          ]),
          message_count: updatedMessages.length + 1,
        }).catch(() => {})
        return prev.map((m) =>
          m.id === assistantMessageId ? { ...m, isStreaming: false, isStreamingThought: false, thoughtCollapsed: true } : m
        )
      })
      setIsStreaming(false)
      finish()
    })

    errorCleanupFn = window.electronAPI.llm.onError((error: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId
            ? { ...m, content: `错误: ${error}`, isStreaming: false, isError: true, isStreamingThought: false }
            : m
        )
      )
      setIsStreaming(false)
      finish()
    })

    try {
      const messageHistory: Array<{ role: string; content: string }> = []
      updatedMessages.forEach((m) => messageHistory.push({ role: m.role, content: m.content }))

      await window.electronAPI.llm.employeeChatStream({
        employee_id: id!,
        provider_id: providerId,
        model_id: selectedLlmModelId || undefined,
        messages: messageHistory,
        options: { temperature: 0.3 },
        use_skills: true,
        use_wiki: useWiki,
        use_rag: useRAG,
      })
    } catch {
      finish()
      setIsStreaming(false)
    }
  }

  const handleCopy = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      message.success('已复制')
    } catch {
      message.error('复制失败')
    }
  }

  const handleStop = () => {
    setIsStreaming(false)
    setMessages((prev) =>
      prev.map((m) =>
        m.isStreaming || m.isStreamingThought
          ? { ...m, isStreaming: false, isStreamingThought: false }
          : m
      )
    )
  }

  const handleRefreshConversation = (convId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const conv = conversations.find((c) => c.id === convId)
    if (conv && activeConversationId === convId) {
      try {
        const msgs = JSON.parse(conv.messages_json || '[]') as MessageWithThought[]
        setMessages(msgs)
        message.success('已刷新')
      } catch {
        setMessages([])
      }
    }
  }

  const statusColorMap: Record<string, string> = {
    draft: 'default',
    active: 'green',
    paused: 'orange',
    error: 'red',
  }

  if (!employee) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <PageHeader
          title={employee.name}
          subTitle={employee.description || '数字员工工作台'}
          onBack={() => navigate('/dashboard')}
          breadcrumb={[{ title: '仪表盘' }, { title: employee.name }]}
          extra={
            <Space>
              <LLMSelector
                providerId={selectedLlmProviderId}
                modelId={selectedLlmModelId}
                onProviderChange={setSelectedLlmProviderId}
                onModelChange={setSelectedLlmModelId}
              />
              <Tag color={statusColorMap[employee.status]}>
                {employee.status === 'active'
                  ? '运行中'
                  : employee.status === 'draft'
                  ? '草稿'
                  : employee.status === 'paused'
                  ? '已暂停'
                  : '错误'}
              </Tag>
              <Button
                icon={<SettingOutlined />}
                onClick={() => navigate(`/employee/${id}/settings`)}
              >
                配置
              </Button>
            </Space>
          }
        />
      </div>

      <div style={{ flex: 1, display: 'flex', padding: '0 24px 24px', gap: 16, minHeight: 0 }}>
        {showHistoryPanel && (
        <Card
          size="small"
          title="对话列表"
          style={{ width: 260, flexShrink: 0 }}
          styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', height: '100%' } }}
          extra={
            <Button
              type="text"
              size="small"
              icon={<MenuFoldOutlined />}
              onClick={() => setShowHistoryPanel(false)}
              title="隐藏对话列表"
            />
          }
        >
          <div style={{ padding: '0 12px 8px' }}>
            <Button block type="primary" onClick={startNewConversation} style={{ marginBottom: 8 }}>
              新对话
            </Button>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {conversations.map((conv) => (
              <div
                key={conv.id}
                onClick={() => selectConversation(conv.id)}
                style={{
                  padding: '10px 12px',
                  cursor: 'pointer',
                  borderLeft: activeConversationId === conv.id ? '3px solid #1677ff' : '3px solid transparent',
                  background: activeConversationId === conv.id ? '#e6f4ff' : 'transparent',
                  borderBottom: '1px solid #f0f0f0',
                  transition: 'all 0.2s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                  <Text style={{ fontSize: 13, maxWidth: 160 }} ellipsis>
                    {conv.title || `对话 ${dayjs(conv.created_at * 1000).format('MM/DD HH:mm')}`}
                  </Text>
                  <Space size={4} style={{ flexShrink: 0 }}>
                    <Tooltip title="刷新">
                      <Button
                        type="text"
                        size="small"
                        icon={<ReloadOutlined />}
                        onClick={(e) => handleRefreshConversation(conv.id, e)}
                      />
                    </Tooltip>
                    <Popconfirm
                      title="确认删除"
                      description="删除后无法恢复，确定要删除吗？"
                      onConfirm={(e) => deleteConversation(conv.id, e!)}
                      okText="确定"
                      cancelText="取消"
                    >
                      <Tooltip title="删除">
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                      </Tooltip>
                    </Popconfirm>
                  </Space>
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {conv.message_count || 0} 条消息 · {dayjs(conv.created_at * 1000).format('MM-DD HH:mm')}
                </Text>
              </div>
            ))}
            {conversations.length === 0 && (
              <div style={{ textAlign: 'center', padding: 24, color: '#999' }}>
                暂无对话
              </div>
            )}
          </div>
        </Card>
        )}

        {!showHistoryPanel && (
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', marginRight: -8 }}>
            <Tooltip title="展开对话列表">
              <Button
                type="text"
                icon={<MenuUnfoldOutlined />}
                onClick={() => setShowHistoryPanel(true)}
                style={{ height: 64 }}
              />
            </Tooltip>
          </div>
        )}

        <Card
          style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
          styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' } }}
        >
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            {messages.length === 0 && !activeConversationId && (
              <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
                <RobotOutlined style={{ fontSize: 64, marginBottom: 16 }} />
                <Paragraph type="secondary">
                  选择一个对话或创建新对话开始与数字员工交流
                </Paragraph>
                <Button type="primary" onClick={startNewConversation}>
                  开始新对话
                </Button>
              </div>
            )}

            {messages.length === 0 && activeConversationId && (
              <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
                <RobotOutlined style={{ fontSize: 48, marginBottom: 16 }} />
                <Paragraph type="secondary">
                  在下方输入消息，开始与数字员工对话
                </Paragraph>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  gap: 8,
                }}
              >
                {msg.role === 'assistant' && (
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 6,
                      background: '#e6f4ff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <RobotOutlined style={{ color: '#1677ff' }} />
                  </div>
                )}

                <div style={{ maxWidth: '70%', minWidth: 0 }}>
                  {msg.thought && (
                    <div style={{ marginBottom: 8 }}>
                      <div
                        style={{
                          padding: '8px 12px',
                          borderRadius: 8,
                          background: '#f0f5ff',
                          border: '1px solid #adc6ff',
                          fontSize: 13,
                          color: '#1677ff',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            cursor: 'pointer',
                            marginBottom: msg.thoughtCollapsed ? 0 : 4,
                          }}
                          onClick={() => {
                            if (!msg.isStreamingThought) {
                              setMessages((prev) =>
                                prev.map((m) =>
                                  m.id === msg.id ? { ...m, thoughtCollapsed: !m.thoughtCollapsed } : m
                                )
                              )
                            }
                          }}
                        >
                          <Space>
                            <BulbOutlined />
                            <Text strong>思考过程</Text>
                            {msg.isStreamingThought && <span className="cursor-blink">▊</span>}
                          </Space>
                          {!msg.isStreamingThought && (
                            <span style={{ fontSize: 12, color: '#1677ff' }}>
                              {msg.thoughtCollapsed ? '展开' : '折叠'}
                            </span>
                          )}
                        </div>
                        {!msg.thoughtCollapsed && (
                          <Paragraph style={{ fontSize: 12, margin: 0, color: '#333' }}>
                            {msg.thought}
                          </Paragraph>
                        )}
                      </div>
                    </div>
                  )}

                  <div
                    style={{
                      padding: '10px 14px',
                      borderRadius: 12,
                      background: msg.role === 'user' ? '#1677ff' : '#f5f5f5',
                      color: msg.role === 'user' ? '#fff' : 'inherit',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      border: msg.isError ? '1px solid #ff4d4f' : 'none',
                    }}
                  >
                    {msg.isStreaming && !msg.content ? (
                      <Text type="secondary" style={{ color: msg.role === 'user' ? '#fff' : 'inherit' }}>
                        正在思考...
                      </Text>
                    ) : (
                      <Text style={{ color: msg.role === 'user' ? '#fff' : 'inherit', fontSize: 14 }}>
                        {msg.content}
                      </Text>
                    )}
                    {msg.isStreaming && <span className="cursor-blink">▊</span>}
                  </div>

                  {msg.role === 'assistant' && msg.content && !msg.isStreaming && !msg.isError && (
                    <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
                      <Button
                        type="text"
                        size="small"
                        icon={<CopyOutlined />}
                        onClick={() => handleCopy(msg.content)}
                      />
                      <Button type="text" size="small" icon={<LikeOutlined />} />
                      <Button type="text" size="small" icon={<DislikeOutlined />} />
                    </div>
                  )}
                </div>

                {msg.role === 'user' && (
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 6,
                      background: '#1677ff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <UserOutlined style={{ color: '#fff' }} />
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div style={{ borderTop: '1px solid #f0f0f0', padding: 16 }}>
            <Space.Compact style={{ width: '100%' }}>
              <TextArea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onPressEnter={(e) => {
                  if (!e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                placeholder={
                  activeConversationId
                    ? '输入消息，Enter发送，Shift+Enter换行...'
                    : '先创建新对话...'
                }
                autoSize={{ minRows: 1, maxRows: 4 }}
                style={{ flex: 1 }}
                disabled={!activeConversationId}
              />
              {isStreaming ? (
                <Button icon={<StopOutlined />} danger onClick={handleStop}>
                  停止
                </Button>
              ) : (
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  onClick={handleSend}
                  disabled={!inputValue.trim() || !activeConversationId}
                >
                  发送
                </Button>
              )}
            </Space.Compact>
          </div>
        </Card>

        {showRAGPanel && (
          <Card
            size="small"
            title={
              <Space>
                <DatabaseOutlined />
                <span>知识检索</span>
                {(wikiResults.length > 0 || searchResults.length > 0) && (
                  <Badge count={wikiResults.length || searchResults.length} style={{ backgroundColor: '#1677ff' }} />
                )}
              </Space>
            }
            extra={
              <Space size={4}>
                <Tag
                  color={useWiki ? 'blue' : 'default'}
                  style={{ cursor: 'pointer', fontSize: 11 }}
                  onClick={() => setUseWiki(!useWiki)}
                >
                  Wiki
                </Tag>
                <Tag
                  color={useRAG ? 'green' : 'default'}
                  style={{ cursor: 'pointer', fontSize: 11 }}
                  onClick={() => setUseRAG(!useRAG)}
                >
                  RAG
                </Tag>
                <Button
                  type="text"
                  size="small"
                  icon={<MenuFoldOutlined />}
                  onClick={() => setShowRAGPanel(false)}
                  title="隐藏知识检索"
                />
              </Space>
            }
            style={{ width: 320, flexShrink: 0 }}
            styles={{ body: { padding: 12, overflow: 'auto', maxHeight: 'calc(100vh - 200px)' } }}
          >
            {wikiResults.length === 0 && searchResults.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 24, color: '#999' }}>
                <BookOutlined style={{ fontSize: 32, marginBottom: 8 }} />
                <Paragraph type="secondary" style={{ fontSize: 12 }}>
                  发送消息后，将在此显示检索到的相关知识
                </Paragraph>
                <div style={{ marginTop: 8 }}>
                  {useWiki && <Tag style={{ fontSize: 12 }} color="blue">Wiki 知识库</Tag>}
                  {useRAG && <Tag style={{ fontSize: 12 }} color="green">RAG 模式</Tag>}
                  {!useWiki && !useRAG && <Tag style={{ fontSize: 12 }}>知识检索已关闭</Tag>}
                </div>
              </div>
            ) : (
              <Collapse
                size="small"
                defaultActiveKey={['0']}
              >
                {wikiResults.length > 0 && (
                  <Collapse.Panel
                    header={
                      <Space>
                        <BookOutlined style={{ color: '#1677ff' }} />
                        <span>Wiki 知识 ({wikiResults.length})</span>
                      </Space>
                    }
                    key="wiki"
                  >
                    {wikiResults.map((result, idx) => (
                      <div key={idx} style={{ marginBottom: 12, padding: 8, background: '#f6ffed', borderRadius: 6 }}>
                        <Text strong style={{ fontSize: 13, color: '#52c41a' }}>
                          {result.page.title}
                        </Text>
                        <div style={{ marginTop: 4 }}>
                          <Tag color={result.page.type === 'concept' ? 'blue' : result.page.type === 'entity' ? 'green' : 'orange'} style={{ marginBottom: 4, fontSize: 10, padding: '0 4px' }}>
                            {result.page.type}
                          </Tag>
                          {result.page.tags.map((tag) => (
                            <Tag key={tag} style={{ marginBottom: 4, fontSize: 10, padding: '0 4px' }}>{tag}</Tag>
                          ))}
                        </div>
                        <Paragraph style={{ fontSize: 12, margin: '4px 0 0' }} ellipsis={{ rows: 3 }}>
                          {result.page.content.substring(0, 300)}
                        </Paragraph>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          相关度: {(result.relevance * 100).toFixed(0)}%
                        </Text>
                      </div>
                    ))}
                  </Collapse.Panel>
                )}
                {searchResults.length > 0 && (
                  <Collapse.Panel
                    header={
                      <Space>
                        <DatabaseOutlined style={{ color: '#722ed1' }} />
                        <span>RAG 检索 ({searchResults.length})</span>
                      </Space>
                    }
                    key="rag"
                  >
                    {searchResults.map((result, idx) => (
                      <div key={idx} style={{ marginBottom: 8, padding: 8, background: '#f0f5ff', borderRadius: 6 }}>
                        <Text strong style={{ fontSize: 12, cursor: 'pointer' }} ellipsis onClick={() => handleSourceClick(result)}>
                          <LinkOutlined style={{ marginRight: 4, color: '#1677ff' }} />
                          {result.source.file_name}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
                          相关度: {(result.score * 100).toFixed(1)}%
                        </Text>
                        <Paragraph style={{ fontSize: 11, margin: '4px 0 0' }}>
                          {result.text.substring(0, 200)}...
                        </Paragraph>
                      </div>
                    ))}
                  </Collapse.Panel>
                )}
              </Collapse>
            )}
          </Card>
        )}

        {!showRAGPanel && (
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', marginLeft: -8 }}>
            <Tooltip title="展开知识检索">
              <Button
                type="text"
                icon={<MenuUnfoldOutlined />}
                onClick={() => setShowRAGPanel(true)}
                style={{ height: 64 }}
              />
            </Tooltip>
          </div>
        )}
      </div>

      <style>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
        .cursor-blink {
          animation: blink 1s infinite;
        }
      `}</style>
    </div>
  )
}

export default EmployeeWorkbench
