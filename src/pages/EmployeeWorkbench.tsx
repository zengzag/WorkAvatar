import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Button,
  Space,
  Typography,
  Tag,
  Spin,
  Tooltip,
  theme,
  App,
} from 'antd'
import {
  RobotOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  HistoryOutlined,
  ArrowLeftOutlined,
  DatabaseOutlined,
  BulbOutlined,
  BulbFilled,
} from '@ant-design/icons'
import LLMSelector from '../components/llm/LLMSelector'
import dayjs from 'dayjs'
import type { Conversation } from '../types'
import { useTranslation } from 'react-i18next'
import { ConversationSidebar, MessageBubble, ChatInput } from '../components/workbench'
import type { MessageWithThought } from '../components/workbench'
import { ensureSegments } from '../components/workbench'
import { getCachedSceneDefaultModel, getSceneDefaultModel } from '../utils/default-model'

const { Text, Paragraph } = Typography

const EmployeeWorkbench: React.FC = () => {
  const { message } = App.useApp()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const TOOL_DISPLAY_NAMES: Record<string, string> = {
    calculator: t('workbench.toolNames.calculator'),
    date_time: t('workbench.toolNames.date_time'),
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
  const [currentProjectId, setProjectId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageWithThought[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [providers, setProviders] = useState<any[]>([])
  const [showSidePanel, setShowSidePanel] = useState(false)
  const [selectedLlmProviderId, setSelectedLlmProviderId] = useState<string>(() => {
    return localStorage.getItem('employeeWorkbench:selectedProviderId') || getCachedSceneDefaultModel('workbench')?.provider_id || ''
  })
  const [selectedLlmModelId, setSelectedLlmModelId] = useState<string>(() => {
    return localStorage.getItem('employeeWorkbench:selectedModelId') || getCachedSceneDefaultModel('workbench')?.model_id || ''
  })
  const [enableThinking, setEnableThinking] = useState<boolean>(() => {
    return localStorage.getItem('employeeWorkbench:enableThinking') === 'true'
  })

  // Persist selections to localStorage
  useEffect(() => {
    localStorage.setItem('employeeWorkbench:selectedProviderId', selectedLlmProviderId)
  }, [selectedLlmProviderId])
  useEffect(() => {
    localStorage.setItem('employeeWorkbench:selectedModelId', selectedLlmModelId)
  }, [selectedLlmModelId])
  useEffect(() => {
    localStorage.setItem('employeeWorkbench:enableThinking', String(enableThinking))
  }, [enableThinking])
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [displayedCount, setDisplayedCount] = useState(10)
  const [allConversations, setAllConversations] = useState<Conversation[]>([])
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

  const generateConversationTitle = async (conversationId: string, userContent: string) => {
    try {
      const quickModel = await getSceneDefaultModel('quick')
      const providerId = quickModel?.provider_id || providers.find((p: any) => p.is_default)?.id
      if (!providerId) return

      const modelId = quickModel?.model_id || undefined
      const result = await window.electronAPI.llm.chat({
        provider_id: providerId,
        model_id: modelId,
        messages: [
          {
            role: 'system',
            content: t('workbench.titleGenSystemPrompt'),
          },
          {
            role: 'user',
            content: userContent,
          },
        ],
        options: { temperature: 0.3, max_tokens: 50 },
      })

      if (result.success && result.content) {
        const title = result.content.trim().replace(/["""'']/g, '').substring(0, 20)
        if (title) {
          await window.electronAPI.conversation.update({
            id: conversationId,
            title,
          })
          setAllConversations((prev) =>
            prev.map((c) => (c.id === conversationId ? { ...c, title } : c))
          )
          setConversations((prev) =>
            prev.map((c) => (c.id === conversationId ? { ...c, title } : c))
          )
        }
      }
    } catch {}
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

    if (messages.length === 0) {
      generateConversationTitle(activeConversationId, content)
    }

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
        enable_thinking: enableThinking,
        project_id: currentProjectId || undefined,
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

  const handleToggleSegment = (msgId: string, segId: string) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId || !m.segments) return m
      const newSegs = m.segments.map(s =>
        s.id === segId ? { ...s, collapsed: !s.collapsed } : s
      )
      return { ...m, segments: newSegs }
    }))
  }

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
          <Tooltip title={enableThinking ? t('workbench.thinkingEnabled') : t('workbench.thinkingDisabled')}>
            <Button
              type={enableThinking ? 'primary' : 'text'}
              icon={enableThinking ? <BulbFilled /> : <BulbOutlined />}
              size="small"
              onClick={() => setEnableThinking(!enableThinking)}
              style={enableThinking ? {} : { color: token.colorTextSecondary }}
            />
          </Tooltip>
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
          <ConversationSidebar
            conversations={conversations}
            allConversations={allConversations}
            activeConversationId={activeConversationId}
            editingConversationId={editingConversationId}
            editingTitle={editingTitle}
            onSelect={selectConversation}
            onStartEdit={startEditTitle}
            onSaveEdit={saveEditTitle}
            onCancelEdit={cancelEditTitle}
            onEditTitleChange={(e) => setEditingTitle(e.target.value)}
            onEditKeyDown={handleEditKeyDown}
            onDelete={deleteConversation}
            onDeleteAll={deleteAllConversations}
            onNewConversation={startNewConversation}
            onLoadMore={loadMoreConversations}
            onListScroll={handleConversationListScroll}
          />
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

            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                onCopy={handleCopy}
                onDeleteMessage={handleDeleteMessage}
                onToggleSegment={handleToggleSegment}
                getToolDisplayName={getToolDisplayName}
              />
            ))}
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

          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            placeholder={t('workbench.inputPlaceholder')}
          />
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
