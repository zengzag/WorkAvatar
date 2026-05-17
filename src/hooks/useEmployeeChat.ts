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
  const activeListenersRef = useRef<(() => void)[]>([])

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

  useEffect(() => {
    return () => {
      activeListenersRef.current.forEach(cleanup => cleanup())
      activeListenersRef.current = []
      if (finishRef.current) {
        finishRef.current()
      }
    }
  }, [])

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

  const selectConversation = async (convId: string) => {
    setActiveConversationId(convId)
    try {
      const fullConv = await window.electronAPI.conversation.get(convId)
      if (fullConv) {
        const msgs = (JSON.parse(fullConv.messages_json || '[]') as MessageWithThought[])
          .map(ensureSegments)
        setMessages(msgs)
      }
    } catch {
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
      generateConversationTitle(activeConversationId, content).catch(() => {})
    }

    const userMessage: MessageWithThought = {
      id: `msg_${generateId()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    }

    const updatedMessagesRef = [...messages, userMessage]
    setMessages(prev => [...prev, userMessage])

    const assistantMessageId = `msg_${generateId()}`
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
      activeListenersRef.current = []
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
            ...updatedMessagesRef,
            savedAssistantMsg,
          ]),
          message_count: updatedMessagesRef.length + 1,
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

    activeListenersRef.current = [chunkCleanup, thoughtCleanupFn, doneCleanupFn, errorCleanupFn, toolCallCleanupFn, toolResultCleanupFn]

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
  }
}

export default useEmployeeChat
