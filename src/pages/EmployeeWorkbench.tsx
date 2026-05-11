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
import { useTranslation } from 'react-i18next'

const { Text, Paragraph } = Typography
const { TextArea } = Input

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
  const { t } = useTranslation()
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
            {conv.title || t('workbench.defaultConvTitle', { date: dayjs(conv.created_at * 1000).format('MM/DD HH:mm') })}
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
              <Popconfirm title={t('workbench.confirmDelete')} onConfirm={(e) => onDelete(conv.id, e!)}
                okText={t('common.confirm')} cancelText={t('common.cancel')}>
                <Button type="text" size="small" danger icon={<DeleteOutlined />}
                  onClick={(ev) => ev.stopPropagation()} />
              </Popconfirm>
            </>
          )}
        </Space>
      </div>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {t('common.messages', { count: conv.message_count || 0 })} · {dayjs(conv.created_at * 1000).format('MM-DD HH:mm')}
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
  const { t } = useTranslation()

  const TOOL_DISPLAY_NAMES: Record<string, string> = {
    calculator: t('workbench.toolNames.calculator'),
    date_time: t('workbench.toolNames.date_time'),
    string_utils: t('workbench.toolNames.string_utils'),
    shell_exec: t('workbench.toolNames.shell_exec'),
    read_file: t('workbench.toolNames.read_file'),
    write_file: t('workbench.toolNames.write_file'),
    list_dir: t('workbench.toolNames.list_dir'),
    system_info: t('workbench.toolNames.system_info'),
    web_search: t('workbench.toolNames.web_search'),
    web_fetch: t('workbench.toolNames.web_fetch'),
    json_utils: t('workbench.toolNames.json_utils'),
    random_utils: t('workbench.toolNames.random_utils'),
    env_vars: t('workbench.toolNames.env_vars'),
    kb_overview: t('workbench.toolNames.kb_overview'),
    query_global_summary: t('workbench.toolNames.query_global_summary'),
    query_knowledge_graph: t('workbench.toolNames.query_knowledge_graph'),
    query_chapters: t('workbench.toolNames.query_chapters'),
    query_fulltext: t('workbench.toolNames.query_fulltext'),
    get_document_content: t('workbench.toolNames.get_document_content'),
    activate_skill: t('workbench.toolNames.activate_skill'),
    read_reference: t('workbench.toolNames.read_reference'),
  }

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
  const [displayedCount, setDisplayedCount] = useState(10)
  const [allConversations, setAllConversations] = useState<Conversation[]>([])
  const conversationListRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const isUserAtBottomRef = useRef(true)
  const finishRef = useRef<(() => void) | null>(null)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (id) {
      loadEmployee()
      loadConversations()
      loadProviders()
    }
    return () => {
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
      message.error(t('workbench.loadEmployeeFailed'))
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
          selectConversation(result[0].id)
        } else {
          await startNewConversation()
        }
      }
    } catch (e) { 
      console.error('[Frontend] 加载对话列表失败', e) 
    }
  }

  const loadMoreConversations = () => {
    const nextCount = displayedCount + 10
    setDisplayedCount(nextCount)
    setConversations(allConversations.slice(0, nextCount))
  }

  const handleConversationListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    if (target.scrollHeight - target.scrollTop <= target.clientHeight + 10) {
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
        title: t('workbench.defaultConvTitle', { date: dayjs().format('MM/DD HH:mm') }),
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
      message.error(t('workbench.createConvFailed')) 
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
      setAllConversations((prev) => prev.filter((c) => c.id !== convId))
      setConversations((prev) => prev.filter((c) => c.id !== convId))
      if (activeConversationId === convId) {
        setActiveConversationId(null)
        setMessages([])
      }
      message.success(t('workbench.deleteSuccess'))
    } catch {
      message.error(t('workbench.deleteFailed'))
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
      message.success(t('workbench.clearAllSuccess'))
    } catch {
      message.error(t('workbench.clearAllFailed'))
    }
  }

  const startEditTitle = (conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingConversationId(conv.id)
    setEditingTitle(conv.title || t('workbench.defaultConvTitle', { date: dayjs(conv.created_at * 1000).format('MM/DD HH:mm') }))
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
      message.success(t('workbench.renameSuccess'))
    } catch {
      message.error(t('workbench.renameFailed'))
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
      message.warning(t('workbench.noLlmProvider'))
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
            ? { ...m, content: t('workbench.errorMsg', { error }), isStreaming: false, isError: true, segments: (m.segments || []).map(s => ({ ...s, isStreaming: false })) }
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
      message.success(t('common.copied'))
    } catch { message.error(t('common.copyFailed')) }
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
      message.success(t('common.deleted'))
    } catch {
      message.error(t('common.deleteFailed'))
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
          <Tooltip title={t('workbench.backToDashboard')}>
            <Button type="text" icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/dashboard')} style={{ fontSize: 16 }} />
          </Tooltip>
          <Text strong style={{ fontSize: 15 }}>{employee.name}</Text>
          <Tag color={employee.status === 'active' ? 'green' : employee.status === 'draft' ? 'default' : employee.status === 'paused' ? 'orange' : 'red'}
            style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px' }}>
            {employee.status === 'active' ? t('workbench.statusRunning') : employee.status === 'draft' ? t('workbench.statusDraft') : employee.status === 'paused' ? t('workbench.statusPaused') : t('workbench.statusError')}
          </Tag>
        </Space>
        <Space size={4}>
          <LLMSelector
            providerId={selectedLlmProviderId}
            modelId={selectedLlmModelId}
            onProviderChange={setSelectedLlmProviderId}
            onModelChange={setSelectedLlmModelId}
          />
          <Tooltip title={t('workbench.employeeConfig')}>
            <Button type="text" icon={<SettingOutlined />}
              onClick={() => navigate(`/employee/${id}/settings`)} />
          </Tooltip>
          <Tooltip title={showSidePanel ? t('workbench.closePanel') : t('workbench.historyConv')}>
            <Button type="text"
              icon={showSidePanel ? <MenuFoldOutlined /> : <HistoryOutlined />}
              onClick={() => setShowSidePanel(!showSidePanel)}
              style={{ color: conversations.length > 0 ? '#1677ff' : undefined }}
            />
          </Tooltip>
        </Space>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
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
                onClick={startNewConversation}>{t('workbench.newConv')}</Button>
              {conversations.length > 0 && (
                <Popconfirm
                  title={t('workbench.confirmClearAll')}
                  description={t('workbench.clearAllDesc')}
                  onConfirm={deleteAllConversations}
                  okText={t('common.confirm')}
                  cancelText={t('common.cancel')}
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
              
              {conversations.length < allConversations.length && (
                <div style={{ padding: '12px', textAlign: 'center' }}>
                  <Button 
                    type="dashed" 
                    block
                    onClick={loadMoreConversations}
                  >
                    {t('workbench.loadMore', { current: conversations.length, total: allConversations.length })}
                  </Button>
                </div>
              )}
              
              {conversations.length === 0 && (
                <div style={{ textAlign: 'center', padding: 24, color: token.colorTextSecondary, fontSize: 13 }}>{t('workbench.noConv')}</div>
              )}
            </div>
          </div>
        )}

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

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
            {messages.length === 0 && activeConversationId && (
              <div style={{ textAlign: 'center', paddingTop: '20vh' }}>
                <RobotOutlined style={{ fontSize: 48, color: token.colorTextQuaternary, marginBottom: 16 }} />
                <Paragraph type="secondary" style={{ fontSize: 14 }}>{t('workbench.startConvHint')}</Paragraph>
              </div>
            )}

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
                          <Popconfirm title={t('workbench.confirmDeleteMsg')} onConfirm={() => handleDeleteMessage(msg.id)}
                            okText={t('common.confirm')} cancelText={t('common.cancel')}>
                            <Button type="text" size="small" danger icon={<DeleteOutlined style={{ fontSize: 12 }} />} />
                          </Popconfirm>
                        </Space>
                      )}
                    </div>
                  )}

                  {msg.role === 'assistant' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {displayMsg.isStreaming && (!displayMsg.segments || displayMsg.segments.length === 0) && (
                        <div style={{
                          padding: '10px 16px',
                          borderRadius: 12,
                          background: token.colorBgLayout,
                          lineHeight: 1.7,
                        }}>
                          <Text style={{ color: token.colorTextQuaternary, fontSize: 14 }}>{t('workbench.thinking')}</Text>
                        </div>
                      )}

                      {displayMsg.segments && displayMsg.segments.length > 0 && (
                        <>
                          <div style={{ position: 'relative', paddingLeft: 0 }}>
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
                                        <Text type="secondary" style={{ fontSize: 12, fontWeight: 500 }}>{t('workbench.thinkingProcess')}</Text>
                                        {seg.isStreaming && <span className="cursor-blink" style={{ color: token.colorPrimary }}>▊</span>}
                                        {!seg.isStreaming && (
                                          <Text style={{ fontSize: 11, color: token.colorPrimary, marginLeft: 'auto' }}>
                                            {seg.collapsed ? t('workbench.expand') : t('workbench.collapse')}
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
                                          {seg.toolName ? getToolDisplayName(seg.toolName) : t('workbench.toolCall')}
                                        </Text>
                                        <Text type="secondary" style={{ fontSize: 11 }}>({seg.toolName})</Text>
                                        {isToolPending ? (
                                          <Tag color="processing" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', marginLeft: 'auto' }}>
                                            <LoadingOutlined spin /> {t('workbench.executing')}
                                          </Tag>
                                        ) : (
                                          <Tag color="success" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', marginLeft: 'auto' }}>
                                            <CheckCircleOutlined /> {t('workbench.completed')}
                                          </Tag>
                                        )}
                                      </div>
                                      {isExpanded && (
                                        <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: '8px 12px' }}>
                                          {argsStr && (
                                            <div style={{ marginBottom: seg.toolResult !== undefined ? 8 : 0 }}>
                                              <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>{t('workbench.inputParams')}</Text>
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
                                              <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>{t('workbench.outputResult')}</Text>
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
                                                {resultStr.length > 2000 ? resultStr.slice(0, 2000) + '\n' + t('workbench.resultTruncated') : resultStr}
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

                      {!msg.isStreaming && !msg.isError && msg.content && (
                        <Space size={4} style={{ marginTop: 2, marginLeft: 2 }}>
                          <Button type="text" size="small" icon={<CopyOutlined style={{ fontSize: 12 }} />}
                            onClick={() => handleCopy(msg.content)} />
                          <Button type="text" size="small" icon={<LikeOutlined style={{ fontSize: 12 }} />} />
                          <Button type="text" size="small" icon={<DislikeOutlined style={{ fontSize: 12 }} />} />
                          <Popconfirm title={t('workbench.confirmDeleteMsg')} onConfirm={() => handleDeleteMessage(msg.id)}
                            okText={t('common.confirm')} cancelText={t('common.cancel')}>
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

          <div style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 8,
            padding: '0 0 4px',
          }}>
            <Tag color="green" style={{ cursor: 'pointer', fontSize: 12, borderRadius: 12 }}>
              <DatabaseOutlined /> {t('workbench.knowledgeBase')}
            </Tag>
          </div>

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
                placeholder={t('workbench.inputPlaceholder')}
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
