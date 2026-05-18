import { useState, useEffect, useRef, useCallback } from 'react'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { Conversation } from '../types'
import type { MessageWithThought } from '../components/workbench'
import { ensureSegments } from '../components/workbench'
import { getCachedSceneDefaultModel, getSceneDefaultModel } from '../utils/default-model'
import { generateId } from '../utils/format'

interface UseEmployeeChatParams {
  id: string | undefined
  message: ReturnType<typeof import('antd').App.useApp>['message']
}

interface ConversationStreamState {
  isStreaming: boolean
  messages: MessageWithThought[]
  assistantMessageId: string | null
  segCounter: number
  toolCallCounter: number
  cleanupFns: (() => void)[]
}

const useEmployeeChat = ({ id, message }: UseEmployeeChatParams) => {
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
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageWithThought[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [providers, setProviders] = useState<any[]>([])
  const [showSidePanel, setShowSidePanel] = useState(true)
  const [selectedLlmProviderId, setSelectedLlmProviderId] = useState<string>(() => {
    return localStorage.getItem('employeeWorkbench:selectedProviderId') || getCachedSceneDefaultModel('workbench')?.provider_id || ''
  })
  const [selectedLlmModelId, setSelectedLlmModelId] = useState<string>(() => {
    return localStorage.getItem('employeeWorkbench:selectedModelId') || getCachedSceneDefaultModel('workbench')?.model_id || ''
  })
  const [enableThinking, setEnableThinking] = useState<boolean>(() => {
    return localStorage.getItem('employeeWorkbench:enableThinking') === 'true'
  })

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
  const initializedRef = useRef(false)

  const streamStatesRef = useRef<Map<string, ConversationStreamState>>(new Map())
  const conversationMessagesRef = useRef<Map<string, MessageWithThought[]>>(new Map())
  const globalListenersCleanupRef = useRef<(() => void) | null>(null)
  const activeConversationIdRef = useRef<string | null>(null)

  const updateConvMessages = (convId: string, updater: (prev: MessageWithThought[]) => MessageWithThought[]) => {
    conversationMessagesRef.current.set(convId, updater(conversationMessagesRef.current.get(convId) || []))
    if (convId === activeConversationIdRef.current) {
      setMessages(conversationMessagesRef.current.get(convId) || [])
    }
  }

  const setConvMessages = (convId: string, msgs: MessageWithThought[]) => {
    conversationMessagesRef.current.set(convId, msgs)
    if (convId === activeConversationIdRef.current) {
      setMessages(msgs)
    }
  }

  useEffect(() => {
    if (id) {
      initEmployee()
    }
    return () => {
      initializedRef.current = false
    }
  }, [id])

  const initEmployee = async () => {
    try {
      const result = await window.electronAPI.employee.get(id!)
      setEmployee(result)
      if (result.llm_provider_id) setSelectedLlmProviderId(result.llm_provider_id)
      if (result.llm_model) setSelectedLlmModelId(result.llm_model)
      loadConversations()
      loadProviders()
    } catch {
      setEmployee(null)
    }
  }

  useEffect(() => {
    if (isUserAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [messages])

  useEffect(() => {
    return () => {
      if (globalListenersCleanupRef.current) {
        globalListenersCleanupRef.current()
        globalListenersCleanupRef.current = null
      }
      for (const [, state] of streamStatesRef.current) {
        state.cleanupFns.forEach(fn => fn())
      }
      streamStatesRef.current.clear()
    }
  }, [])

  const setupGlobalListeners = useCallback(() => {
    if (globalListenersCleanupRef.current) return

    const chunkCleanup = window.electronAPI.llm.onChunk((data: { sessionId: string; chunk: string }) => {
      const { sessionId, chunk } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      updateConvMessages(sessionId, (prev) =>
        prev.map((m) => {
          if (m.id !== streamState.assistantMessageId) return m
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
              id: `${streamState.assistantMessageId}_seg_${streamState.segCounter++}`,
              content: chunk,
              isStreaming: true,
              timestamp: Date.now(),
            })
          }
          return { ...m, segments: segs, content: (m.content || '') + chunk }
        })
      )
    })

    const thoughtCleanup = window.electronAPI.llm.onThought((data: { sessionId: string; thought: string }) => {
      const { sessionId, thought } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      updateConvMessages(sessionId, (prev) =>
        prev.map((m) => {
          if (m.id !== streamState.assistantMessageId) return m
          const segs = [...(m.segments || [])]
          const lastSeg = segs[segs.length - 1]

          for (let i = 0; i < segs.length; i++) {
            if (segs[i].isStreaming && segs[i].type !== 'thinking') {
              segs[i] = { ...segs[i], isStreaming: false }
            }
          }

          if (lastSeg && lastSeg.type === 'thinking' && lastSeg.isStreaming) {
            segs[segs.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + thought }
          } else {
            segs.push({
              type: 'thinking',
              id: `${streamState.assistantMessageId}_seg_${streamState.segCounter++}`,
              content: thought,
              isStreaming: true,
              collapsed: false,
              timestamp: Date.now(),
            })
          }
          return { ...m, segments: segs, thought: (m.thought || '') + thought }
        })
      )
    })

    const toolCallCleanup = window.electronAPI.llm.onToolCall((data: { sessionId: string; name: string; args: any }) => {
      const { sessionId, name, args } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      updateConvMessages(sessionId, (prev) =>
        prev.map((m) => {
          if (m.id !== streamState.assistantMessageId) return m
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
            id: `${streamState.assistantMessageId}_tool_${streamState.toolCallCounter++}`,
            toolName: name,
            toolArgs: args,
            isToolComplete: false,
            collapsed: false,
            timestamp: Date.now(),
          })
          return { ...m, segments: segs }
        })
      )
    })

    const toolResultCleanup = window.electronAPI.llm.onToolResult((data: { sessionId: string; name: string; result: any }) => {
      const { sessionId, name, result } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      updateConvMessages(sessionId, (prev) =>
        prev.map((m) => {
          if (m.id !== streamState.assistantMessageId) return m
          const segs = [...(m.segments || [])]
          const lastIncompleteIndex = [...segs].reverse().findIndex(
            s => s.type === 'tool_call' && s.toolName === name && !s.isToolComplete
          )
          if (lastIncompleteIndex === -1) return m
          const actualIndex = segs.length - 1 - lastIncompleteIndex
          segs[actualIndex] = { ...segs[actualIndex], toolResult: result, isToolComplete: true, collapsed: true }
          return { ...m, segments: segs }
        })
      )
    })

    const doneCleanup = window.electronAPI.llm.onDone((data: { sessionId: string }) => {
      const { sessionId } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      updateConvMessages(sessionId, (prev) => {
        const assistantMsg = prev.find((m) => m.id === streamState.assistantMessageId)
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
        const prevMsgs = prev.filter(m => m.role === 'user')
        window.electronAPI.conversation.update({
          id: sessionId,
          messages_json: JSON.stringify([...prevMsgs, savedAssistantMsg]),
          message_count: prevMsgs.length + 1,
        }).catch(() => {})
        return prev.map((m) =>
          m.id === streamState.assistantMessageId ? savedAssistantMsg : m
        )
      })

      streamState.isStreaming = false
      streamState.cleanupFns.forEach(fn => fn())
      streamStatesRef.current.delete(sessionId)

      if (sessionId === activeConversationId) {
        setIsStreaming(false)
      }
    })

    const errorCleanup = window.electronAPI.llm.onError((data: { sessionId: string; error: string }) => {
      const { sessionId, error } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      updateConvMessages(sessionId, (prev) =>
        prev.map((m) =>
          m.id === streamState.assistantMessageId
            ? { ...m, content: t('workbench.errorMsg', { error }), isStreaming: false, isError: true, segments: (m.segments || []).map(s => ({ ...s, isStreaming: false })) }
            : m
        )
      )

      streamState.isStreaming = false
      streamState.cleanupFns.forEach(fn => fn())
      streamStatesRef.current.delete(sessionId)

      if (sessionId === activeConversationId) {
        setIsStreaming(false)
      }
    })

    globalListenersCleanupRef.current = () => {
      chunkCleanup()
      thoughtCleanup()
      toolCallCleanup()
      toolResultCleanup()
      doneCleanup()
      errorCleanup()
    }
  }, [activeConversationId, t])

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
    } catch (e) { console.error('Failed to load providers:', e) }
  }

  const startNewConversation = async (): Promise<string | null> => {
    if (isCreatingConversation || !id) return null
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
      activeConversationIdRef.current = convId
      setMessages([])
      setConvMessages(convId, [])
      forceScrollToBottom()

      if (pendingMessage) {
        setInputValue(pendingMessage)
        setPendingMessage(null)
        setTimeout(() => sendMessage(convId), 0)
      }

      return convId
    } catch {
      setPendingMessage(null)
      return null
    } finally {
      setIsCreatingConversation(false)
    }
  }

  const selectConversation = async (convId: string) => {
    setActiveConversationId(convId)
    activeConversationIdRef.current = convId

    const streamState = streamStatesRef.current.get(convId)
    setIsStreaming(!!streamState?.isStreaming)

    const cachedMsgs = conversationMessagesRef.current.get(convId)
    if (cachedMsgs !== undefined) {
      setMessages(cachedMsgs)
    } else {
      try {
        const fullConv = await window.electronAPI.conversation.get(convId)
        if (fullConv) {
          const msgs = (JSON.parse(fullConv.messages_json || '[]') as MessageWithThought[])
            .map(ensureSegments)
          setConvMessages(convId, msgs)
        }
      } catch {
        setConvMessages(convId, [])
      }
    }
  }

  const deleteConversation = async (convId: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    try {
      const streamState = streamStatesRef.current.get(convId)
      if (streamState) {
        streamState.cleanupFns.forEach(fn => fn())
        streamStatesRef.current.delete(convId)
      }
      conversationMessagesRef.current.delete(convId)

      await window.electronAPI.conversation.delete(convId)
      setAllConversations((prev) => prev.filter((c) => c.id !== convId))
      setConversations((prev) => prev.filter((c) => c.id !== convId))
      if (activeConversationId === convId) {
        setActiveConversationId(null)
        activeConversationIdRef.current = null
        setMessages([])
        setIsStreaming(false)
      }
      message.success(t('workbench.deleteSuccess'))
    } catch {
      message.error(t('workbench.deleteFailed'))
    }
  }

  const deleteSelectedConversations = async (convIds: string[]) => {
    try {
      for (const convId of convIds) {
        const streamState = streamStatesRef.current.get(convId)
        if (streamState) {
          streamState.cleanupFns.forEach(fn => fn())
          streamStatesRef.current.delete(convId)
        }
        conversationMessagesRef.current.delete(convId)
        await window.electronAPI.conversation.delete(convId)
      }
      setAllConversations((prev) => prev.filter((c) => !convIds.includes(c.id)))
      setConversations((prev) => prev.filter((c) => !convIds.includes(c.id)))
      if (convIds.includes(activeConversationId || '')) {
        setActiveConversationId(null)
        setMessages([])
        setIsStreaming(false)
      }
      message.success(t('workbench.deleteSuccess'))
    } catch {
      message.error(t('workbench.deleteFailed'))
    }
  }

  const deleteAllConversations = async () => {
    if (!id) return
    try {
      for (const [, state] of streamStatesRef.current) {
        state.cleanupFns.forEach(fn => fn())
      }
      streamStatesRef.current.clear()
      conversationMessagesRef.current.clear()

      await window.electronAPI.conversation.deleteAll(id)
      setAllConversations([])
      setConversations([])
      setActiveConversationId(null)
      activeConversationIdRef.current = null
      setMessages([])
      setIsStreaming(false)
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
    } catch (e) { console.error('Failed to generate conversation title:', e) }
  }

  const handleSend = async () => {
    const content = inputValue.trim()
    if (!content) return

    const currentConvId = activeConversationId
    if (!currentConvId) {
      if (isCreatingConversation) return
      setPendingMessage(content)
      await startNewConversation()
      return
    }

    const streamState = streamStatesRef.current.get(currentConvId)
    if (streamState?.isStreaming) return

    sendMessage(currentConvId)
  }

  const sendMessage = async (convId?: string) => {
    const targetConvId = convId || activeConversationId
    if (!targetConvId) return

    const providerId = selectedLlmProviderId || employee?.llm_provider_id || providers.find((p: any) => p.is_default)?.id
    if (!providerId) {
      message.warning(t('workbench.noLlmProvider'))
      return
    }

    const content = inputValue.trim()
    if (!content) return

    const existingStream = streamStatesRef.current.get(targetConvId)
    if (existingStream?.isStreaming) return

    setInputValue('')

    setupGlobalListeners()

    const currentMsgs = conversationMessagesRef.current.get(targetConvId) || []

    if (currentMsgs.length === 0) {
      generateConversationTitle(targetConvId, content).catch(() => {})
    }

    const userMessage: MessageWithThought = {
      id: `msg_${generateId()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    }

    const updatedMessagesRef = [...currentMsgs, userMessage]
    setConvMessages(targetConvId, [...currentMsgs, userMessage])

    const assistantMessageId = `msg_${generateId()}`
    const assistantMessage: MessageWithThought = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      segments: [],
    }
    updateConvMessages(targetConvId, (prev) => [...prev, assistantMessage])

    if (targetConvId === activeConversationId) {
      setIsStreaming(true)
    }

    const streamState: ConversationStreamState = {
      isStreaming: true,
      messages: updatedMessagesRef,
      assistantMessageId,
      segCounter: 0,
      toolCallCounter: 0,
      cleanupFns: [],
    }
    streamStatesRef.current.set(targetConvId, streamState)

    try {
      const messageHistory: Array<{ role: string; content: string }> = []
      updatedMessagesRef.forEach((m) => messageHistory.push({ role: m.role, content: m.content }))

      await window.electronAPI.llm.employeeChatStream({
        employee_id: id!,
        provider_id: providerId,
        model_id: selectedLlmModelId || undefined,
        messages: messageHistory,
        options: { temperature: 0.3 },
        use_skills: true,
        enable_thinking: enableThinking,
        conversation_id: targetConvId,
      })
    } catch {
      streamState.isStreaming = false
      streamStatesRef.current.delete(targetConvId)
      if (targetConvId === activeConversationId) {
        setIsStreaming(false)
      }
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
      setConvMessages(activeConversationId, newMessages)
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
    if (!activeConversationId) return
    const streamState = streamStatesRef.current.get(activeConversationId)
    if (streamState) {
      streamState.isStreaming = false
      streamState.cleanupFns.forEach(fn => fn())
      streamStatesRef.current.delete(activeConversationId)
    }
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
    try {
      await window.electronAPI.llm.abortChat(activeConversationId)
    } catch (e) { console.error('Failed to abort chat:', e) }
  }

  const getToolDisplayName = (name: string) => TOOL_DISPLAY_NAMES[name] || name

  const handleToggleSegment = (msgId: string, segId: string) => {
    if (!activeConversationId) return
    updateConvMessages(activeConversationId, (prev) => prev.map(m => {
      if (m.id !== msgId || !m.segments) return m
      const newSegs = m.segments.map(s =>
        s.id === segId ? { ...s, collapsed: !s.collapsed } : s
      )
      return { ...m, segments: newSegs }
    }))
  }

  const isConversationStreaming = (convId: string) => {
    return !!streamStatesRef.current.get(convId)?.isStreaming
  }

  return {
    employee,
    conversations,
    allConversations,
    activeConversationId,
    messages,
    inputValue,
    setInputValue,
    isStreaming,
    isCreatingConversation,
    providers,
    selectedLlmProviderId,
    setSelectedLlmProviderId,
    selectedLlmModelId,
    setSelectedLlmModelId,
    enableThinking,
    setEnableThinking,
    showSidePanel,
    setShowSidePanel,
    editingConversationId,
    editingTitle,
    setEditingTitle,
    displayedCount,
    messagesEndRef,
    chatContainerRef,
    handleScroll,
    handleSend,
    handleStop,
    selectConversation,
    deleteConversation,
    deleteSelectedConversations,
    deleteAllConversations,
    startEditTitle,
    saveEditTitle,
    cancelEditTitle,
    handleEditKeyDown,
    startNewConversation,
    loadMoreConversations,
    handleConversationListScroll,
    handleCopy,
    handleDeleteMessage,
    handleToggleSegment,
    forceScrollToBottom,
    getToolDisplayName,
    isConversationStreaming,
  }
}

export default useEmployeeChat
