import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Input,
  Button,
  Space,
  Typography,
  Tag,
  message,
  Spin,
  Collapse,
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
  LinkOutlined,
  DeleteOutlined,
  EditOutlined,
  BulbOutlined,
  DatabaseOutlined,
  MenuFoldOutlined,
  HistoryOutlined,
  PlusOutlined,
  ArrowLeftOutlined,
  CheckOutlined,
  CloseOutlined,
  ClearOutlined,
  DownOutlined,
  RightOutlined,
  CodeOutlined,
  LoadingOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons'
import LLMSelector from '../components/llm/LLMSelector'
import dayjs from 'dayjs'
import type { Conversation, Message } from '../types'

const { Text, Paragraph } = Typography
const { TextArea } = Input

// 优化对话列表项组件，使用 memo 避免不必要的重渲染
const ConversationItem = memo(({
  conv,
  isActive,
  isEditing,
  editingTitle,
  onSelect,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditTitleChange,
  onEditKeyDown,
  onDelete,
}: {
  conv: Conversation
  isActive: boolean
  isEditing: boolean
  editingTitle: string
  onSelect: (id: string) => void
  onStartEdit: (conv: Conversation, e: React.MouseEvent) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onEditTitleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onEditKeyDown: (e: React.KeyboardEvent) => void
  onDelete: (id: string, e: React.MouseEvent) => void
}) => {
  return (
    <div
      onClick={() => !isEditing && onSelect(conv.id)}
      style={{
        padding: '10px 14px',
        cursor: isEditing ? 'default' : 'pointer',
        borderLeft: isActive ? '3px solid #1677ff' : '3px solid transparent',
        background: isActive ? '#e6f4ff' : 'transparent',
        borderBottom: '1px solid #f0f0f0',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        {isEditing ? (
          <Input
            value={editingTitle}
            onChange={onEditTitleChange}
            onKeyDown={onEditKeyDown}
            autoFocus
            style={{ fontSize: 13, flex: 1, marginRight: 8 }}
            size="small"
          />
        ) : (
          <Text style={{ fontSize: 13, maxWidth: 150 }} ellipsis>
            {conv.title || `对话 ${dayjs(conv.created_at * 1000).format('MM/DD HH:mm')}`}
          </Text>
        )}
        <Space size={2}>
          {isEditing ? (
            <>
              <Button type="text" size="small" icon={<CheckOutlined />}
                onClick={onSaveEdit} style={{ color: '#52c41a' }} />
              <Button type="text" size="small" icon={<CloseOutlined />}
                onClick={onCancelEdit} />
            </>
          ) : (
            <>
              <Button type="text" size="small" icon={<EditOutlined />}
                onClick={(e) => onStartEdit(conv, e)} />
              <Popconfirm title="确认删除" onConfirm={(e) => onDelete(conv.id, e!)}
                okText="确定" cancelText="取消">
                <Button type="text" size="small" danger icon={<DeleteOutlined />}
                  onClick={(ev) => ev.stopPropagation()} />
              </Popconfirm>
            </>
          )}
        </Space>
      </div>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {conv.message_count || 0} 条 · {dayjs(conv.created_at * 1000).format('MM-DD HH:mm')}
      </Text>
    </div>
  )
})

interface SearchResult {
  text: string
  score: number
  source: {
    file_id: string
    file_name: string
    chunk_index: number
  }
}

interface ToolCallInfo {
  id: string
  name: string
  args: any
  result?: any
  isComplete?: boolean
}

interface MessageWithThought extends Message {
  thought?: string
  isStreamingThought?: boolean
  thoughtCollapsed?: boolean
  toolCalls?: ToolCallInfo[]
}

const EmployeeWorkbench: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [employee, setEmployee] = useState<any | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageWithThought[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [providers, setProviders] = useState<any[]>([])
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [showSidePanel, setShowSidePanel] = useState(false)
  const [useRAG, setUseRAG] = useState(true)
  const [selectedLlmProviderId, setSelectedLlmProviderId] = useState<string>('')
  const [selectedLlmModelId, setSelectedLlmModelId] = useState<string>('')
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set())
  const [displayedCount, setDisplayedCount] = useState(10) // 初始显示10条
  const [allConversations, setAllConversations] = useState<Conversation[]>([]) // 保存所有对话
  const conversationListRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const isUserAtBottomRef = useRef(true)
  const finishRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (id) {
      loadEmployee()
      loadConversations()
      loadProviders()
    }
  }, [id])

  useEffect(() => {
    if (isUserAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [messages])

  const handleScroll = useCallback(() => {
    const el = chatContainerRef.current
    if (!el) return
    const threshold = 50
    isUserAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }, [])

  const forceScrollToBottom = () => {
    isUserAtBottomRef.current = true
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const loadEmployee = async () => {
    try {
      const result = await window.electronAPI.employee.get(id!)
      setEmployee(result)
      setProjectId(result.project_id)
      if (result.llm_provider_id) setSelectedLlmProviderId(result.llm_provider_id)
      if (result.llm_model) setSelectedLlmModelId(result.llm_model)
    } catch {
      message.error('加载员工信息失败')
    }
  }

  const loadConversations = async () => {
    try {
      const result = await window.electronAPI.conversation.list({ employee_id: id! })
      setAllConversations(result)
      setConversations(result.slice(0, displayedCount))
    } catch (e) { 
      console.error('[Frontend] 加载对话列表失败', e) 
    }
  }

  // 加载更多对话
  const loadMoreConversations = () => {
    const nextCount = displayedCount + 10
    setDisplayedCount(nextCount)
    setConversations(allConversations.slice(0, nextCount))
  }

  // 检测滚动到底部
  const handleConversationListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    if (target.scrollHeight - target.scrollTop <= target.clientHeight + 10) {
      // 距离底部10px时触发加载更多
      if (conversations.length < allConversations.length) {
        loadMoreConversations()
      }
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
      // 同步更新两个状态，新对话在最前面
      setAllConversations((prev) => [(result as Conversation), ...prev])
      setConversations((prev) => [(result as Conversation), ...prev])
      setActiveConversationId((result as Conversation).id)
      setMessages([])
      setSearchResults([])
      setShowSidePanel(false)
      forceScrollToBottom()
    } catch { message.error('创建对话失败') }
  }

  const selectConversation = (convId: string) => {
    setActiveConversationId(convId)
    setSearchResults([])
    const conv = conversations.find((c) => c.id === convId)
    if (conv) {
      try {
        // 只在选中对话时才完整查询该对话的详细信息（包含消息）
        window.electronAPI.conversation.get(convId).then(fullConv => {
          if (fullConv) {
            const msgs = JSON.parse(fullConv.messages_json || '[]') as MessageWithThought[]
            setMessages(msgs)
          }
        }).catch(() => {
          setMessages([])
        })
      } catch (e) { 
        console.error('[Frontend] JSON parse error:', e)
        setMessages([]) 
      }
    }
  }

  const deleteConversation = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await window.electronAPI.conversation.delete(convId)
      // 同步更新两个状态
      setAllConversations((prev) => prev.filter((c) => c.id !== convId))
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

  const deleteAllConversations = async () => {
    if (!id) return
    try {
      await window.electronAPI.conversation.deleteAll(id)
      setAllConversations([])
      setConversations([])
      setActiveConversationId(null)
      setMessages([])
      message.success('已清空所有对话')
    } catch {
      message.error('清空失败')
    }
  }

  const startEditTitle = (conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingConversationId(conv.id)
    setEditingTitle(conv.title || `对话 ${dayjs(conv.created_at * 1000).format('MM/DD HH:mm')}`)
  }

  const saveEditTitle = async () => {
    if (!editingConversationId || !editingTitle.trim()) {
      setEditingConversationId(null)
      return
    }
    try {
      await window.electronAPI.conversation.update({
        id: editingConversationId,
        title: editingTitle.trim()
      })
      // 同步更新两个状态
      setAllConversations((prev) =>
        prev.map((c) =>
          c.id === editingConversationId
            ? { ...c, title: editingTitle.trim() }
            : c
        )
      )
      setConversations((prev) =>
        prev.map((c) =>
          c.id === editingConversationId
            ? { ...c, title: editingTitle.trim() }
            : c
        )
      )
      message.success('重命名成功')
    } catch {
      message.error('重命名失败')
    } finally {
      setEditingConversationId(null)
    }
  }

  const cancelEditTitle = () => {
    setEditingConversationId(null)
  }

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      saveEditTitle()
    } else if (e.key === 'Escape') {
      cancelEditTitle()
    }
  }

  const handleSourceClick = (result: SearchResult) => {
    if (!projectId) return
    navigate(`/project/${projectId}/file/${result.source.file_id}?chunk=${result.source.chunk_index}&text=${encodeURIComponent(result.text.substring(0, 100))}`)
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
      setInputValue(content)
      setTimeout(() => handleSend(), 100)
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

    let chunkCleanup: () => void
    let doneCleanupFn: () => void
    let errorCleanupFn: () => void
    let ragCleanupFn: () => void
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
            ? {
                ...m,
                toolCalls: [...(m.toolCalls || []), { id: `tc_${Date.now()}`, name: toolCall.name, args: toolCall.args, isComplete: false }],
              }
            : m
        )
      )
    })

    toolResultCleanupFn = window.electronAPI.llm.onToolResult((toolResult: { name: string; result: any }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMessageId) return m
          const toolCalls = m.toolCalls || []
          const lastIncompleteIndex = [...toolCalls].reverse().findIndex(tc => tc.name === toolResult.name && !tc.isComplete)
          if (lastIncompleteIndex === -1) return m
          const actualIndex = toolCalls.length - 1 - lastIncompleteIndex
          const updatedToolCalls = [...toolCalls]
          updatedToolCalls[actualIndex] = { ...updatedToolCalls[actualIndex], result: toolResult.result, isComplete: true }
          return { ...m, toolCalls: updatedToolCalls }
        })
      )
    })

    ragCleanupFn = window.electronAPI.llm.onRAGResults((results: SearchResult[]) => {
      setSearchResults(results)
    })

    const finish = () => {
      chunkCleanup()
      if (thoughtCleanupFn) thoughtCleanupFn()
      if (doneCleanupFn) doneCleanupFn()
      if (errorCleanupFn) errorCleanupFn()
      if (ragCleanupFn) ragCleanupFn()
      if (toolCallCleanupFn) toolCallCleanupFn()
      if (toolResultCleanupFn) toolResultCleanupFn()
      finishRef.current = null
    }

    finishRef.current = finish

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
    } catch { message.error('复制失败') }
  }

  const handleStop = async () => {
    setIsStreaming(false)
    setMessages((prev) =>
      prev.map((m) =>
        m.isStreaming || m.isStreamingThought
          ? { ...m, isStreaming: false, isStreamingThought: false }
          : m
      )
    )
    if (finishRef.current) {
      finishRef.current()
    }
    try {
      await window.electronAPI.llm.abortChat()
    } catch {}
  }

  const toggleToolCallExpand = (id: string) => {
    setExpandedToolCalls(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const TOOL_DISPLAY_NAMES: Record<string, string> = {
    calculator: '计算器',
    date_time: '日期时间',
    string_utils: '字符串处理',
    shell_exec: '执行命令',
    read_file: '读取文件',
    write_file: '写入文件',
    list_dir: '列出目录',
    system_info: '系统信息',
    web_search: '网络搜索',
    web_fetch: '获取网页',
    json_utils: 'JSON处理',
    random_utils: '随机工具',
    env_vars: '环境变量',
    kb_overview: '知识库概览',
    query_global_summary: '全局摘要查询',
    query_knowledge_graph: '知识图谱查询',
    query_chapters: '章节检索',
    query_fulltext: '全文检索',
    get_document_content: '获取文档内容',
    generate_timeline: '生成时间线',
    query_rag: 'RAG检索',
    activate_skill: '激活技能',
    read_reference: '读取参考',
  }

  const getToolDisplayName = (name: string) => TOOL_DISPLAY_NAMES[name] || name

  const hasRagResults = searchResults.length > 0

  if (!employee) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#fff' }}>
      {/* 极简顶栏 */}
      <div style={{
        height: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        borderBottom: '1px solid #f0f0f0',
        background: '#fff',
        flexShrink: 0,
      }}>
        <Space size={12}>
          <Tooltip title="返回仪表盘">
            <Button type="text" icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/dashboard')} style={{ fontSize: 16 }} />
          </Tooltip>
          <Text strong style={{ fontSize: 15 }}>{employee.name}</Text>
          <Tag color={employee.status === 'active' ? 'green' : employee.status === 'draft' ? 'default' : employee.status === 'paused' ? 'orange' : 'red'}
            style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px' }}>
            {employee.status === 'active' ? '运行中' : employee.status === 'draft' ? '草稿' : employee.status === 'paused' ? '已暂停' : '错误'}
          </Tag>
        </Space>
        <Space size={4}>
          <LLMSelector
            providerId={selectedLlmProviderId}
            modelId={selectedLlmModelId}
            onProviderChange={setSelectedLlmProviderId}
            onModelChange={setSelectedLlmModelId}
          />
          <Tooltip title="员工配置">
            <Button type="text" icon={<SettingOutlined />}
              onClick={() => navigate(`/employee/${id}/settings`)} />
          </Tooltip>
          <Tooltip title={showSidePanel ? '关闭面板' : '历史对话'}>
            <Button type="text"
              icon={showSidePanel ? <MenuFoldOutlined /> : <HistoryOutlined />}
              onClick={() => setShowSidePanel(!showSidePanel)}
              style={{ color: conversations.length > 0 ? '#1677ff' : undefined }}
            />
          </Tooltip>
        </Space>
      </div>

      {/* 主内容区域 */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* 侧面板：对话列表 (可折叠) */}
        {showSidePanel && (
          <div style={{
            width: 280,
            flexShrink: 0,
            borderRight: '1px solid #f0f0f0',
            display: 'flex',
            flexDirection: 'column',
            background: '#fafafa',
          }}>
            <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
              <Button type="primary" style={{ flex: 1 }} icon={<PlusOutlined />}
                onClick={startNewConversation}>新对话</Button>
              {conversations.length > 0 && (
                <Popconfirm
                  title="确认清空所有对话记录？"
                  description="此操作不可恢复"
                  onConfirm={deleteAllConversations}
                  okText="确认"
                  cancelText="取消"
                >
                  <Button danger icon={<ClearOutlined />} />
                </Popconfirm>
              )}
            </div>
            <div 
              ref={conversationListRef}
              style={{ flex: 1, overflow: 'auto' }}
              onScroll={handleConversationListScroll}
            >
              {conversations.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conv={conv}
                  isActive={activeConversationId === conv.id}
                  isEditing={editingConversationId === conv.id}
                  editingTitle={editingTitle}
                  onSelect={selectConversation}
                  onStartEdit={startEditTitle}
                  onSaveEdit={saveEditTitle}
                  onCancelEdit={cancelEditTitle}
                  onEditTitleChange={(e) => setEditingTitle(e.target.value)}
                  onEditKeyDown={handleEditKeyDown}
                  onDelete={deleteConversation}
                />
              ))}
              
              {/* 加载更多按钮 */}
              {conversations.length < allConversations.length && (
                <div style={{ padding: '12px', textAlign: 'center' }}>
                  <Button 
                    type="dashed" 
                    block
                    onClick={loadMoreConversations}
                  >
                    加载更多 ({conversations.length}/{allConversations.length})
                  </Button>
                </div>
              )}
              
              {conversations.length === 0 && (
                <div style={{ textAlign: 'center', padding: 24, color: '#999', fontSize: 13 }}>暂无对话</div>
              )}
            </div>
          </div>
        )}

        {/* 对话区域 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

          {/* 消息列表 */}
          <div ref={chatContainerRef} onScroll={handleScroll}
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '24px 20%',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            {/* 知识检索结果迷你提示 */}
            {hasRagResults && (
              <div style={{
                background: '#f0f5ff',
                borderRadius: 8,
                padding: '8px 14px',
                marginBottom: 8,
              }}>
                <Collapse size="small" ghost items={[
                  ...(searchResults.length > 0 ? [{
                    key: 'kb-mini',
                    label: <Space><DatabaseOutlined style={{ color: '#722ed1' }} /><Text strong style={{ fontSize: 13 }}>知识库检索结果 ({searchResults.length})</Text></Space>,
                    children: searchResults.map((r, i) => (
                      <div key={i} style={{ padding: '6px 8px', marginBottom: 6, background: '#f0f5ff', borderRadius: 6 }}>
                        <Text strong style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => handleSourceClick(r)}>
                          <LinkOutlined style={{ marginRight: 4, color: '#1677ff' }} />{r.source.file_name}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>相关度: {(r.score * 100).toFixed(1)}%</Text>
                      </div>
                    )),
                  }] : []),
                ]} />
              </div>
            )}

            {/* 空状态 */}
            {messages.length === 0 && !activeConversationId && (
              <div style={{ textAlign: 'center', paddingTop: '20vh' }}>
                <RobotOutlined style={{ fontSize: 56, color: '#d9d9d9', marginBottom: 20 }} />
                <Paragraph type="secondary" style={{ fontSize: 15, marginBottom: 24 }}>
                  创建新对话，开始与数字员工交流
                </Paragraph>
                <Button type="primary" size="large" icon={<PlusOutlined />} onClick={startNewConversation}>
                  开始新对话
                </Button>
              </div>
            )}

            {messages.length === 0 && activeConversationId && (
              <div style={{ textAlign: 'center', paddingTop: '20vh' }}>
                <RobotOutlined style={{ fontSize: 48, color: '#d9d9d9', marginBottom: 16 }} />
                <Paragraph type="secondary" style={{ fontSize: 14 }}>在下方输入消息开始对话</Paragraph>
              </div>
            )}

            {/* 消息列表 */}
            {messages.map((msg) => (
              <div key={msg.id}
                style={{
                  display: 'flex',
                  gap: 12,
                  flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
                  alignItems: 'flex-start',
                }}
              >
                {/* 头像 */}
                <div style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  background: msg.role === 'assistant' ? '#f0f5ff' : '#e6f4ff',
                }}>
                  {msg.role === 'assistant'
                    ? <RobotOutlined style={{ color: '#1677ff', fontSize: 18 }} />
                    : <UserOutlined style={{ color: '#1677ff', fontSize: 18 }} />}
                </div>

                <div style={{ maxWidth: '80%', minWidth: 0 }}>
                  {/* 思考过程 */}
                  {msg.thought && (
                    <div style={{ marginBottom: 6 }}>
                      <div onClick={() => {
                        if (!msg.isStreamingThought) {
                          setMessages(prev => prev.map(m =>
                            m.id === msg.id ? { ...m, thoughtCollapsed: !m.thoughtCollapsed } : m
                          ))
                        }
                      }}
                        style={{
                          padding: '6px 12px',
                          borderRadius: 8,
                          background: '#faf5ff',
                          border: '1px solid #d3adf7',
                          cursor: msg.isStreamingThought ? 'default' : 'pointer',
                        }}
                      >
                        <Space size={4} style={{ fontSize: 12 }}>
                          <BulbOutlined style={{ color: '#722ed1' }} />
                          <Text type="secondary" style={{ fontSize: 12 }}>思考过程
                            {msg.isStreamingThought && <span className="cursor-blink" style={{ color: '#1677ff' }}>▊</span>}
                          </Text>
                          {!msg.isStreamingThought && (
                            <Text style={{ fontSize: 11, color: '#722ed1' }}>{msg.thoughtCollapsed ? '展开' : '折叠'}</Text>
                          )}
                        </Space>
                        {!msg.thoughtCollapsed && (
                          <Paragraph style={{ fontSize: 12, margin: '6px 0 0', color: '#555', whiteSpace: 'pre-wrap' }}>
                            {msg.thought}
                          </Paragraph>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 工具调用卡片 */}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div style={{ marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {msg.toolCalls.map((tc) => {
                        const isExpanded = expandedToolCalls.has(tc.id)
                        const isRunning = !tc.isComplete
                        const resultStr = tc.result !== undefined
                          ? (typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2))
                          : ''
                        const argsStr = tc.args !== undefined
                          ? (typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args, null, 2))
                          : ''
                        return (
                          <div key={tc.id}
                            style={{
                              borderRadius: 8,
                              border: '1px solid #d9d9d9',
                              borderLeft: `3px solid ${isRunning ? '#1677ff' : '#52c41a'}`,
                              background: '#fafafa',
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              onClick={() => toggleToolCallExpand(tc.id)}
                              style={{
                                padding: '6px 12px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                cursor: 'pointer',
                                userSelect: 'none',
                              }}
                            >
                              {isExpanded ? <DownOutlined style={{ fontSize: 10, color: '#999' }} /> : <RightOutlined style={{ fontSize: 10, color: '#999' }} />}
                              <CodeOutlined style={{ fontSize: 13, color: isRunning ? '#1677ff' : '#52c41a' }} />
                              <Text strong style={{ fontSize: 13, color: '#333' }}>{getToolDisplayName(tc.name)}</Text>
                              <Text type="secondary" style={{ fontSize: 11 }}>({tc.name})</Text>
                              {isRunning ? (
                                <Tag color="processing" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', marginLeft: 'auto' }}>
                                  <LoadingOutlined spin /> 执行中
                                </Tag>
                              ) : (
                                <Tag color="success" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', marginLeft: 'auto' }}>
                                  <CheckCircleOutlined /> 完成
                                </Tag>
                              )}
                            </div>
                            {isExpanded && (
                              <div style={{ borderTop: '1px solid #f0f0f0', padding: '8px 12px' }}>
                                {argsStr && (
                                  <div style={{ marginBottom: tc.result !== undefined ? 8 : 0 }}>
                                    <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>输入参数</Text>
                                    <pre style={{
                                      margin: 0,
                                      padding: '6px 10px',
                                      background: '#fff',
                                      borderRadius: 6,
                                      fontSize: 12,
                                      lineHeight: 1.5,
                                      maxHeight: 200,
                                      overflow: 'auto',
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-all',
                                      border: '1px solid #f0f0f0',
                                    }}>
                                      {argsStr}
                                    </pre>
                                  </div>
                                )}
                                {tc.result !== undefined && (
                                  <div>
                                    <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>返回结果</Text>
                                    <pre style={{
                                      margin: 0,
                                      padding: '6px 10px',
                                      background: '#f6ffed',
                                      borderRadius: 6,
                                      fontSize: 12,
                                      lineHeight: 1.5,
                                      maxHeight: 300,
                                      overflow: 'auto',
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-all',
                                      border: '1px solid #b7eb8f',
                                    }}>
                                      {resultStr.length > 2000 ? resultStr.slice(0, 2000) + '\n...(结果已截断)' : resultStr}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* 消息气泡 */}
                  <div style={{
                    padding: '10px 16px',
                    borderRadius: 12,
                    background: msg.role === 'user' ? '#1677ff' : '#f5f5f5',
                    color: msg.role === 'user' ? '#fff' : 'inherit',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    border: msg.isError ? '1px solid #ff4d4f' : 'none',
                    lineHeight: 1.7,
                  }}>
                    {msg.isStreaming && !msg.content ? (
                      <Text style={{ color: '#999', fontSize: 14 }}>正在思考...</Text>
                    ) : (
                      <Text style={{ color: msg.role === 'user' ? '#fff' : 'inherit', fontSize: 14 }}>
                        {msg.content}
                      </Text>
                    )}
                    {msg.isStreaming && <span className="cursor-blink" style={{ color: msg.role === 'user' ? '#fff' : '#999' }}>▊</span>}
                  </div>

                  {/* 操作按钮 */}
                  {msg.role === 'assistant' && msg.content && !msg.isStreaming && !msg.isError && (
                    <Space size={4} style={{ marginTop: 4, marginLeft: 2 }}>
                      <Button type="text" size="small" icon={<CopyOutlined style={{ fontSize: 12 }} />}
                        onClick={() => handleCopy(msg.content)} />
                      <Button type="text" size="small" icon={<LikeOutlined style={{ fontSize: 12 }} />} />
                      <Button type="text" size="small" icon={<DislikeOutlined style={{ fontSize: 12 }} />} />
                    </Space>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* 底部快捷标签 */}
          <div style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 8,
            padding: '0 0 4px',
          }}>
            <Tag color={useRAG ? 'green' : 'default'} style={{ cursor: 'pointer', fontSize: 12, borderRadius: 12 }}
              onClick={() => setUseRAG(!useRAG)}>
              <DatabaseOutlined /> 知识库 {useRAG ? '开' : '关'}
            </Tag>
          </div>

          {/* 输入区域 */}
          <div
            style={{
              padding: '12px 20% 20px 20%',
              flexShrink: 0,
            }}
          >
            <div style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-end',
              background: '#f7f7f7',
              borderRadius: 16,
              padding: '6px 6px 6px 16px',
              border: '2px solid transparent',
              transition: 'border-color 0.3s',
            }}
              onFocusCapture={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = '#1677ff'
              }}
              onBlurCapture={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = 'transparent'
              }}
            >
              <TextArea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onPressEnter={(e) => {
                  if (!e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                placeholder={activeConversationId ? '输入消息，Enter发送，Shift+Enter换行...' : '创建新对话开始交流...'}
                autoSize={{ minRows: 1, maxRows: 5 }}
                disabled={isStreaming}
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  resize: 'none',
                  fontSize: 14,
                  lineHeight: 1.6,
                  padding: '4px 0',
                  boxShadow: 'none',
                }}
                className="workbench-input"
              />
              {isStreaming ? (
                <Button icon={<StopOutlined />} danger
                  onClick={handleStop}
                  shape="circle" size="middle" />
              ) : (
                <Button icon={<SendOutlined />} type="primary"
                  onClick={handleSend}
                  disabled={!inputValue.trim()}
                  shape="circle" size="middle"
                  style={{ flexShrink: 0 }} />
              )}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .cursor-blink { animation: blink 1s infinite; }
        @keyframes blink { 0%,50%{opacity:1} 51%,100%{opacity:0} }
        .workbench-input::placeholder { color: #bfbfbf; }
        .workbench-input:focus { outline: none; }
        .workbench-input {
          background: transparent !important;
        }
        .workbench-input:hover, .workbench-input:focus {
          background: transparent !important;
        }
        .ant-input-textarea-focused {
          background: transparent !important;
        }
      `}</style>
    </div>
  )
}

export default EmployeeWorkbench