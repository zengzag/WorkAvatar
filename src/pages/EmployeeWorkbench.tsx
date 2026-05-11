import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Input,
  Button,
  Space,
  Typography,
  Tag,
  Spin,
  Popconfirm,
  Tooltip,
  theme,
  App,
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
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
  const { token } = theme.useToken()
  return (
    <div
      onClick={() => !isEditing && onSelect(conv.id)}
      style={{
        padding: '10px 14px',
        cursor: isEditing ? 'default' : 'pointer',
        borderLeft: isActive ? `3px solid ${token.colorPrimary}` : '3px solid transparent',
        background: isActive ? token.colorPrimaryBg : 'transparent',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
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

interface ToolCallInfo {
  id: string
  name: string
  args: any
  result?: any
  isComplete?: boolean
}

interface MessageSegment {
  type: 'thinking' | 'answer' | 'tool_call'
  id: string
  timestamp?: number
  content?: string
  isStreaming?: boolean
  collapsed?: boolean
  toolName?: string
  toolArgs?: any
  toolResult?: any
  isToolComplete?: boolean
}

interface MessageWithThought extends Message {
  thought?: string
  isStreamingThought?: boolean
  thoughtCollapsed?: boolean
  toolCalls?: ToolCallInfo[]
  segments?: MessageSegment[]
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
  activate_skill: '激活技能',
  read_reference: '读取参考',
}

function ensureSegments(msg: MessageWithThought): MessageWithThought {
  if (msg.role !== 'assistant') return msg
  if (msg.segments && msg.segments.length > 0) return msg

  const segments: MessageSegment[] = []
  let segIdx = 0

  if (msg.thought) {
    segments.push({
      type: 'thinking',
      id: `${msg.id}_seg_${segIdx++}`,
      content: msg.thought,
      collapsed: msg.thoughtCollapsed ?? true,
    })
  }

  if (msg.content) {
    segments.push({
      type: 'answer',
      id: `${msg.id}_seg_${segIdx++}`,
      content: msg.content,
    })
  }

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      segments.push({
        type: 'tool_call',
        id: `${msg.id}_tool_${segIdx++}`,
        toolName: tc.name,
        toolArgs: tc.args,
        toolResult: tc.result,
        isToolComplete: tc.isComplete,
        collapsed: true,
      })
    }
  }

  return { ...msg, segments }
}

const EmployeeWorkbench: React.FC = () => {
  const { message } = App.useApp()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const [employee, setEmployee] = useState<any | null>(null)
  const [, setProjectId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageWithThought[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [providers, setProviders] = useState<any[]>([])
  const [showSidePanel, setShowSidePanel] = useState(false)
  const [selectedLlmProviderId, setSelectedLlmProviderId] = useState<string>('')
  const [selectedLlmModelId, setSelectedLlmModelId] = useState<string>('')
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [displayedCount, setDisplayedCount] = useState(10) // 初始显示10条
  const [allConversations, setAllConversations] = useState<Conversation[]>([]) // 保存所有对话
  const conversationListRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const isUserAtBottomRef = useRef(true)
  const finishRef = useRef<(() => void) | null>(null)
  const initializedRef = useRef(false) // 防止重复初始化

  useEffect(() => {
    if (id) {
      loadEmployee()
      loadConversations()
      loadProviders()
    }
    return () => {
      // 组件卸载时重置初始化标志
      initializedRef.current = false
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
      
      if (!initializedRef.current) {
        initializedRef.current = true
        if (result.length > 0) {
          // 有历史对话，自动选择最近的第一个
          selectConversation(result[0].id)
        } else {
          // 没有历史对话，自动创建一个新对话
          await startNewConversation()
        }
      }
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

  const startNewConversation = async (): Promise<string | null> => {
    if (isCreatingConversation) return null
    setIsCreatingConversation(true)
    try {
      const result = await window.electronAPI.conversation.create({
        employee_id: id!,
        title: `对话 ${dayjs().format('MM/DD HH:mm')}`,
      })
      const convId = (result as Conversation).id
      setAllConversations((prev) => [(result as Conversation), ...prev])
      setConversations((prev) => [(result as Conversation), ...prev])
      setActiveConversationId(convId)
      setMessages([])
      setShowSidePanel(false)
      forceScrollToBottom()

      if (pendingMessage) {
        setInputValue(pendingMessage)
        setPendingMessage(null)
        setTimeout(() => sendMessage(), 0)
      }

      return convId
    } catch { 
      message.error('创建对话失败') 
      setPendingMessage(null)
      return null
    } finally {
      setIsCreatingConversation(false)
    }
  }

  const selectConversation = (convId: string) => {
    setActiveConversationId(convId)
    try {
      window.electronAPI.conversation.get(convId).then(fullConv => {
        if (fullConv) {
          const msgs = (JSON.parse(fullConv.messages_json || '[]') as MessageWithThought[])
            .map(ensureSegments)
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

  const handleSend = async () => {
    const content = inputValue.trim()
    if (!content || isStreaming) return

    if (!activeConversationId) {
      if (isCreatingConversation) return
      setPendingMessage(content)
      await startNewConversation()
      return
    }

    setInputValue(content)
    sendMessage()
  }

  const sendMessage = async () => {
    const providerId = selectedLlmProviderId || employee?.llm_provider_id || providers.find((p: any) => p.is_default)?.id
    if (!providerId) {
      message.warning('请先在设置中配置 LLM 提供商')
      return
    }

    const content = inputValue.trim()
    if (!content || isStreaming) return

    if (!activeConversationId) return

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
      segments: [],
    }
    setMessages((prev) => [...prev, assistantMessage])

    setIsStreaming(true)

    let segCounter = 0
    const nextSegId = () => `${assistantMessageId}_seg_${segCounter++}`
    let toolCallCounter = 0
    const nextToolCallId = () => `${assistantMessageId}_tool_${toolCallCounter++}`

    let chunkCleanup: () => void
    let doneCleanupFn: () => void
    let errorCleanupFn: () => void
    let thoughtCleanupFn: () => void
    let toolCallCleanupFn: () => void
    let toolResultCleanupFn: () => void

    chunkCleanup = window.electronAPI.llm.onChunk((chunk: string) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMessageId) return m
          const segs = [...(m.segments || [])]
          const lastSeg = segs[segs.length - 1]
          
          // 在开始输出答案前，先结束并收起之前的思考过程
          for (let i = 0; i < segs.length; i++) {
            if (segs[i].type === 'thinking' && segs[i].isStreaming) {
              segs[i] = { ...segs[i], isStreaming: false, collapsed: true }
            }
          }
          
          if (lastSeg && lastSeg.type === 'answer' && lastSeg.isStreaming) {
            segs[segs.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + chunk }
          } else {
            segs.push({
              type: 'answer',
              id: nextSegId(),
              content: chunk,
              isStreaming: true,
              timestamp: Date.now(),
            })
          }
          return { ...m, segments: segs, content: (m.content || '') + chunk }
        })
      )
    })

    thoughtCleanupFn = window.electronAPI.llm.onThought((thoughtChunk: string) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMessageId) return m
          const segs = [...(m.segments || [])]
          const lastSeg = segs[segs.length - 1]
          
          // 在开始新思考前，先结束之前所有仍在流式的内容
          for (let i = 0; i < segs.length; i++) {
            if (segs[i].isStreaming && segs[i].type !== 'thinking') {
              segs[i] = { ...segs[i], isStreaming: false }
            }
          }
          
          if (lastSeg && lastSeg.type === 'thinking' && lastSeg.isStreaming) {
            segs[segs.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + thoughtChunk }
          } else {
            segs.push({
              type: 'thinking',
              id: nextSegId(),
              content: thoughtChunk,
              isStreaming: true,
              collapsed: false,
              timestamp: Date.now(),
            })
          }
          return { ...m, segments: segs, thought: (m.thought || '') + thoughtChunk }
        })
      )
    })

    toolCallCleanupFn = window.electronAPI.llm.onToolCall((toolCall: { name: string; args: any }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMessageId) return m
          const segs = [...(m.segments || [])]
          const lastSeg = segs[segs.length - 1]
          if (lastSeg && lastSeg.type === 'answer' && lastSeg.isStreaming) {
            segs[segs.length - 1] = { ...lastSeg, isStreaming: false }
          }
          if (lastSeg && lastSeg.type === 'thinking' && lastSeg.isStreaming) {
            segs[segs.length - 1] = { ...lastSeg, isStreaming: false, collapsed: true }
          }
          segs.push({
            type: 'tool_call',
            id: nextToolCallId(),
            toolName: toolCall.name,
            toolArgs: toolCall.args,
            isToolComplete: false,
            collapsed: false,
            timestamp: Date.now(),
          })
          return { ...m, segments: segs }
        })
      )
    })

    toolResultCleanupFn = window.electronAPI.llm.onToolResult((toolResult: { name: string; result: any }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMessageId) return m
          const segs = [...(m.segments || [])]
          const lastIncompleteIndex = [...segs].reverse().findIndex(
            s => s.type === 'tool_call' && s.toolName === toolResult.name && !s.isToolComplete
          )
          if (lastIncompleteIndex === -1) return m
          const actualIndex = segs.length - 1 - lastIncompleteIndex
          segs[actualIndex] = { ...segs[actualIndex], toolResult: toolResult.result, isToolComplete: true, collapsed: true }
          return { ...m, segments: segs }
        })
      )
    })

    const finish = () => {
      chunkCleanup()
      if (thoughtCleanupFn) thoughtCleanupFn()
      if (doneCleanupFn) doneCleanupFn()
      if (errorCleanupFn) errorCleanupFn()
      if (toolCallCleanupFn) toolCallCleanupFn()
      if (toolResultCleanupFn) toolResultCleanupFn()
      finishRef.current = null
    }

    finishRef.current = finish

    doneCleanupFn = window.electronAPI.llm.onDone(() => {
      setMessages((prev) => {
        const assistantMsg = prev.find((m) => m.id === assistantMessageId)
        if (!assistantMsg) return prev
        const segs = (assistantMsg.segments || []).map(s => ({
          ...s,
          isStreaming: false,
          ...(s.type === 'thinking' ? { collapsed: true } : {}),
        }))
        const savedAssistantMsg: MessageWithThought = {
          ...assistantMsg,
          isStreaming: false,
          segments: segs,
        }
        window.electronAPI.conversation.update({
          id: activeConversationId,
          messages_json: JSON.stringify([
            ...updatedMessages,
            savedAssistantMsg,
          ]),
          message_count: updatedMessages.length + 1,
        }).catch(() => {})
        return prev.map((m) =>
          m.id === assistantMessageId ? savedAssistantMsg : m
        )
      })
      setIsStreaming(false)
      finish()
    })

    errorCleanupFn = window.electronAPI.llm.onError((error: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId
            ? { ...m, content: `错误: ${error}`, isStreaming: false, isError: true, segments: (m.segments || []).map(s => ({ ...s, isStreaming: false })) }
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

  const handleDeleteMessage = async (msgId: string) => {
    if (!activeConversationId) return
    try {
      const newMessages = messages.filter((m) => m.id !== msgId)
      setMessages(newMessages)
      await window.electronAPI.conversation.update({
        id: activeConversationId,
        messages_json: JSON.stringify(newMessages),
        message_count: newMessages.length,
      })
      message.success('已删除')
    } catch {
      message.error('删除失败')
    }
  }

  const handleStop = async () => {
    setIsStreaming(false)
    setMessages((prev) =>
      prev.map((m) =>
        m.isStreaming
          ? {
              ...m,
              isStreaming: false,
              segments: (m.segments || []).map(s => ({ ...s, isStreaming: false })),
            }
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

  const getToolDisplayName = (name: string) => TOOL_DISPLAY_NAMES[name] || name

  if (!employee) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: token.colorBgContainer }}>
      {/* 极简顶栏 */}
      <div style={{
        height: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
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
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            flexDirection: 'column',
            background: token.colorBgLayout,
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
                <div style={{ textAlign: 'center', padding: 24, color: token.colorTextSecondary, fontSize: 13 }}>暂无对话</div>
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
              padding: '24px 10%',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            {/* 知识检索结果迷你提示 */}



            {messages.length === 0 && activeConversationId && (
              <div style={{ textAlign: 'center', paddingTop: '20vh' }}>
                <RobotOutlined style={{ fontSize: 48, color: token.colorTextQuaternary, marginBottom: 16 }} />
                <Paragraph type="secondary" style={{ fontSize: 14 }}>在下方输入消息开始对话</Paragraph>
              </div>
            )}

            {/* 消息列表 - 时间线模式 */}
            {messages.map((msg) => {
              const displayMsg = msg.role === 'assistant' ? ensureSegments(msg) : msg
              return (
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
                  background: msg.role === 'assistant' ? token.colorPrimaryBg : token.colorInfoBg,
                }}>
                  {msg.role === 'assistant'
                    ? <RobotOutlined style={{ color: '#1677ff', fontSize: 18 }} />
                    : <UserOutlined style={{ color: '#1677ff', fontSize: 18 }} />}
                </div>

                <div style={{ maxWidth: '80%', minWidth: 0 }}>
                  {/* 用户消息：简单气泡 */}
                  {msg.role === 'user' && (
                    <div>
                      <div style={{
                        padding: '10px 16px',
                        borderRadius: 12,
                        background: token.colorPrimary,
                        color: '#fff',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        lineHeight: 1.7,
                      }}>
                        <Text style={{ color: '#fff', fontSize: 14 }}>{msg.content}</Text>
                      </div>
                      {!msg.isStreaming && (
                        <Space size={4} style={{ marginTop: 2, marginLeft: 2, justifyContent: 'flex-end', display: 'flex' }}>
                          <Popconfirm title="确认删除此消息" onConfirm={() => handleDeleteMessage(msg.id)}
                            okText="确定" cancelText="取消">
                            <Button type="text" size="small" danger icon={<DeleteOutlined style={{ fontSize: 12 }} />} />
                          </Popconfirm>
                        </Space>
                      )}
                    </div>
                  )}

                  {/* 助手消息：时间线分段渲染 */}
                  {msg.role === 'assistant' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {displayMsg.isStreaming && (!displayMsg.segments || displayMsg.segments.length === 0) && (
                        <div style={{
                          padding: '10px 16px',
                          borderRadius: 12,
                          background: token.colorBgLayout,
                          lineHeight: 1.7,
                        }}>
                          <Text style={{ color: token.colorTextQuaternary, fontSize: 14 }}>正在思考...</Text>
                        </div>
                      )}

                      {displayMsg.segments && displayMsg.segments.length > 0 && (
                        <>
                          {/* 时间线连接线 */}
                          <div style={{ position: 'relative', paddingLeft: 0 }}>
                            {/* 先渲染各段 */}
                            {displayMsg.segments.map((seg) => {
                              const isToolPending = seg.type === 'tool_call' && !seg.isToolComplete

                              if (seg.type === 'thinking') {
                                return (
                                  <div key={seg.id} style={{ marginBottom: 0 }}>
                                    <div
                                      onClick={() => {
                                        if (!seg.isStreaming) {
                                          setMessages(prev => prev.map(m => {
                                            if (m.id !== msg.id || !m.segments) return m
                                            const newSegs = m.segments.map(s =>
                                              s.id === seg.id ? { ...s, collapsed: !s.collapsed } : s
                                            )
                                            return { ...m, segments: newSegs }
                                          }))
                                        }
                                      }}
                                      style={{
                                        padding: '8px 14px',
                                        borderRadius: 8,
                                        background: token.colorPrimaryBg,
                                        border: `1px solid ${token.colorPrimaryBorder}`,
                                        borderLeft: `3px solid ${token.colorPrimary}`,
                                        cursor: seg.isStreaming ? 'default' : 'pointer',
                                      }}
                                    >
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <BulbOutlined style={{ color: token.colorPrimary, fontSize: 13 }} />
                                        <Text type="secondary" style={{ fontSize: 12, fontWeight: 500 }}>思考过程</Text>
                                        {seg.isStreaming && <span className="cursor-blink" style={{ color: token.colorPrimary }}>▊</span>}
                                        {!seg.isStreaming && (
                                          <Text style={{ fontSize: 11, color: token.colorPrimary, marginLeft: 'auto' }}>
                                            {seg.collapsed ? '展开 ▸' : '折叠 ▾'}
                                          </Text>
                                        )}
                                      </div>
                                      {!seg.collapsed && seg.content && (
                                        <Paragraph style={{
                                          fontSize: 12,
                                          margin: '8px 0 0',
                                          color: token.colorTextSecondary,
                                          whiteSpace: 'pre-wrap',
                                        }}>
                                          {seg.content}
                                        </Paragraph>
                                      )}
                                    </div>
                                  </div>
                                )
                              }

                              if (seg.type === 'tool_call') {
                                const isExpanded = !seg.collapsed
                                const resultStr = seg.toolResult !== undefined
                                  ? (typeof seg.toolResult === 'string' ? seg.toolResult : JSON.stringify(seg.toolResult, null, 2))
                                  : ''
                                const argsStr = seg.toolArgs !== undefined
                                  ? (typeof seg.toolArgs === 'string' ? seg.toolArgs : JSON.stringify(seg.toolArgs, null, 2))
                                  : ''
                                return (
                                  <div key={seg.id} style={{ marginBottom: 0 }}>
                                    <div
                                      style={{
                                        borderRadius: 8,
                                        border: `1px solid ${token.colorBorderSecondary}`,
                                        borderLeft: `3px solid ${isToolPending ? token.colorPrimary : token.colorSuccess}`,
                                        background: token.colorBgLayout,
                                        overflow: 'hidden',
                                        opacity: 0.9,
                                      }}
                                    >
                                      <div
                                        onClick={() => {
                                          setMessages(prev => prev.map(m => {
                                            if (m.id !== msg.id || !m.segments) return m
                                            const newSegs = m.segments.map(s =>
                                              s.id === seg.id ? { ...s, collapsed: !s.collapsed } : s
                                            )
                                            return { ...m, segments: newSegs }
                                          }))
                                        }}
                                        style={{
                                          padding: '6px 12px',
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 8,
                                          cursor: 'pointer',
                                          userSelect: 'none',
                                        }}
                                      >
                                        {isExpanded ? <DownOutlined style={{ fontSize: 10, color: token.colorTextSecondary }} /> : <RightOutlined style={{ fontSize: 10, color: token.colorTextSecondary }} />}
                                        <CodeOutlined style={{ fontSize: 13, color: isToolPending ? token.colorPrimary : token.colorSuccess }} />
                                        <Text strong style={{ fontSize: 13, color: token.colorText }}>
                                          {seg.toolName ? getToolDisplayName(seg.toolName) : '工具调用'}
                                        </Text>
                                        <Text type="secondary" style={{ fontSize: 11 }}>({seg.toolName})</Text>
                                        {isToolPending ? (
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
                                        <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: '8px 12px' }}>
                                          {argsStr && (
                                            <div style={{ marginBottom: seg.toolResult !== undefined ? 8 : 0 }}>
                                              <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>输入参数</Text>
                                              <pre style={{
                                                margin: 0,
                                                padding: '6px 10px',
                                                background: token.colorBgContainer,
                                                borderRadius: 6,
                                                fontSize: 12,
                                                lineHeight: 1.5,
                                                maxHeight: 200,
                                                overflow: 'auto',
                                                whiteSpace: 'pre-wrap',
                                                wordBreak: 'break-all',
                                                border: `1px solid ${token.colorBorderSecondary}`,
                                              }}>
                                                {argsStr}
                                              </pre>
                                            </div>
                                          )}
                                          {seg.toolResult !== undefined && (
                                            <div>
                                              <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>返回结果</Text>
                                              <pre style={{
                                                margin: 0,
                                                padding: '6px 10px',
                                                background: token.colorSuccessBg,
                                                borderRadius: 6,
                                                fontSize: 12,
                                                lineHeight: 1.5,
                                                maxHeight: 300,
                                                overflow: 'auto',
                                                whiteSpace: 'pre-wrap',
                                                wordBreak: 'break-all',
                                                border: `1px solid ${token.colorSuccessBorder}`,
                                              }}>
                                                {resultStr.length > 2000 ? resultStr.slice(0, 2000) + '\n...(结果已截断)' : resultStr}
                                              </pre>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )
                              }

                              if (seg.type === 'answer') {
                                return (
                                  <div key={seg.id} style={{ marginBottom: 0 }}>
                                    <div style={{
                                      padding: '10px 16px',
                                      borderRadius: 12,
                                      background: token.colorBgLayout,
                                      lineHeight: 1.7,
                                      wordBreak: 'break-word',
                                      border: msg.isError ? '1px solid #ff4d4f' : 'none',
                                    }}>
                                      <div className="markdown-content" style={{ fontSize: 14, color: token.colorText }}>
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                          {seg.content || (seg.isStreaming ? '▊' : '')}
                                        </ReactMarkdown>
                                      </div>
                                      {seg.isStreaming && <span className="cursor-blink" style={{ color: token.colorTextQuaternary }}>▊</span>}
                                    </div>
                                  </div>
                                )
                              }

                              return null
                            })}
                          </div>
                        </>
                      )}

                      {/* 旧格式兜底：没有segments的assistant消息 */}
                      {(!displayMsg.segments || displayMsg.segments.length === 0) && msg.content && !msg.isStreaming && (
                        <div style={{
                          padding: '10px 16px',
                          borderRadius: 12,
                          background: token.colorBgLayout,
                          lineHeight: 1.7,
                          wordBreak: 'break-word',
                          border: msg.isError ? '1px solid #ff4d4f' : 'none',
                        }}>
                          <div className="markdown-content" style={{ fontSize: 14, color: token.colorText }}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {msg.content}
                            </ReactMarkdown>
                          </div>
                        </div>
                      )}

                      {/* 操作按钮 */}
                      {!msg.isStreaming && !msg.isError && msg.content && (
                        <Space size={4} style={{ marginTop: 2, marginLeft: 2 }}>
                          <Button type="text" size="small" icon={<CopyOutlined style={{ fontSize: 12 }} />}
                            onClick={() => handleCopy(msg.content)} />
                          <Button type="text" size="small" icon={<LikeOutlined style={{ fontSize: 12 }} />} />
                          <Button type="text" size="small" icon={<DislikeOutlined style={{ fontSize: 12 }} />} />
                          <Popconfirm title="确认删除此消息" onConfirm={() => handleDeleteMessage(msg.id)}
                            okText="确定" cancelText="取消">
                            <Button type="text" size="small" danger icon={<DeleteOutlined style={{ fontSize: 12 }} />} />
                          </Popconfirm>
                        </Space>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )})}
            <div ref={messagesEndRef} />
          </div>

          {/* 底部快捷标签 */}
          <div style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 8,
            padding: '0 0 4px',
          }}>
            <Tag color="green" style={{ cursor: 'pointer', fontSize: 12, borderRadius: 12 }}>
              <DatabaseOutlined /> 知识库
            </Tag>
          </div>

          {/* 输入区域 */}
          <div
            style={{
              padding: '12px 10% 20px 10%',
              flexShrink: 0,
            }}
          >
            <div style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-end',
              background: token.colorBgLayout,
              borderRadius: 16,
              padding: '6px 6px 6px 16px',
              border: '2px solid transparent',
              transition: 'border-color 0.3s',
            }}
              onFocusCapture={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = token.colorPrimary
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
                placeholder='输入消息，Enter发送，Shift+Enter换行...'
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
        .workbench-input::placeholder { color: ${token.colorTextQuaternary}; }
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
        .markdown-content h1, .markdown-content h2, .markdown-content h3,
        .markdown-content h4, .markdown-content h5, .markdown-content h6 {
          margin-top: 16px;
          margin-bottom: 8px;
          font-weight: 600;
          line-height: 1.4;
        }
        .markdown-content h1 { font-size: 1.4em; border-bottom: 1px solid ${token.colorBorderSecondary}; padding-bottom: 6px; }
        .markdown-content h2 { font-size: 1.25em; border-bottom: 1px solid ${token.colorBorderSecondary}; padding-bottom: 5px; }
        .markdown-content h3 { font-size: 1.1em; }
        .markdown-content p { margin: 0 0 8px; }
        .markdown-content p:last-child { margin-bottom: 0; }
        .markdown-content ul, .markdown-content ol { padding-left: 24px; margin: 0 0 8px; }
        .markdown-content li { margin-bottom: 4px; }
        .markdown-content code {
          background: ${token.colorBgTextHover};
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 0.9em;
          font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
        }
        .markdown-content pre {
          background: ${token.colorBgTextHover};
          padding: 12px 16px;
          border-radius: 8px;
          overflow-x: auto;
          margin: 8px 0;
          border: 1px solid ${token.colorBorderSecondary};
        }
        .markdown-content pre code {
          background: transparent;
          padding: 0;
          border-radius: 0;
          font-size: 0.85em;
          line-height: 1.6;
        }
        .markdown-content blockquote {
          border-left: 3px solid ${token.colorPrimary};
          margin: 8px 0;
          padding: 4px 12px;
          color: ${token.colorTextSecondary};
          background: ${token.colorPrimaryBg};
          border-radius: 0 6px 6px 0;
        }
        .markdown-content table {
          border-collapse: collapse;
          width: 100%;
          margin: 8px 0;
        }
        .markdown-content th, .markdown-content td {
          border: 1px solid ${token.colorBorderSecondary};
          padding: 6px 12px;
          text-align: left;
        }
        .markdown-content th {
          background: ${token.colorBgTextHover};
          font-weight: 600;
        }
        .markdown-content a {
          color: ${token.colorPrimary};
          text-decoration: none;
        }
        .markdown-content a:hover {
          text-decoration: underline;
        }
        .markdown-content hr {
          border: none;
          border-top: 1px solid ${token.colorBorderSecondary};
          margin: 16px 0;
        }
        .markdown-content img {
          max-width: 100%;
          border-radius: 6px;
        }
      `}</style>
    </div>
  )
}

export default EmployeeWorkbench