import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { Conversation } from '../types'
import type { MessageWithThought, MessageBranch } from '../components/workbench'
import { ensureSegments, patchMissingCompletedAt } from '../components/workbench'
import { getCachedSceneDefaultModel, getSceneDefaultModel } from '../utils/default-model'
import { generateId } from '../utils/format'

interface UseEmployeeChatParams {
  id: string | undefined
  message: ReturnType<typeof import('antd').App.useApp>['message']
}

interface ConversationStreamState {
  isStreaming: boolean
  conversationId: string
  messages: MessageWithThought[]
  assistantMessageId: string | null
  segCounter: number
  toolCallCounter: number
  cleanupFns: (() => void)[]
}

const getActiveBranchContent = (m: MessageWithThought): string => {
  if (m.role === 'assistant' && m.branches && m.branches.length > 0) {
    const branchIndex = m.activeBranchIndex ?? m.branches.length
    if (branchIndex < m.branches.length) {
      return m.branches[branchIndex].content
    }
  }
  return m.content
}

const _persistentMessages = new Map<string, MessageWithThought[]>()
const _persistentStreamStates = new Map<string, ConversationStreamState>()
let _persistentListenersCleanup: (() => void) | null = null
let _persistentEmployeeId: string | null = null

const useEmployeeChat = ({ id, message }: UseEmployeeChatParams) => {
  const { t } = useTranslation()

  const TOOL_DISPLAY_NAMES: Record<string, string> = useMemo(() => ({
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
    kb_list: t('workbench.toolNames.kb_list'),
    kb_get_toc: t('workbench.toolNames.kb_get_toc'),
    kb_get_paragraphs: t('workbench.toolNames.kb_get_paragraphs'),
    kb_search: t('workbench.toolNames.kb_search'),
    kb_get_content: t('workbench.toolNames.kb_get_content'),
    activate_skill: t('workbench.toolNames.activate_skill'),
    read_reference: t('workbench.toolNames.read_reference'),
  }), [t])

  const [employee, setEmployee] = useState<any | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageWithThought[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [providers, setProviders] = useState<any[]>([])
  const [showSidePanel, setShowSidePanel] = useState(true)
  const [isComparisonMode, setIsComparisonMode] = useState(false)
  const [comparisonMessageIds, setComparisonMessageIds] = useState<string[]>([])
  const [comparisonUserMessageId, setComparisonUserMessageId] = useState<string | null>(null)
  const selectedLlmProviderIdKey = id ? `employeeWorkbench:selectedProviderId:${id}` : 'employeeWorkbench:selectedProviderId'
  const selectedLlmModelIdKey = id ? `employeeWorkbench:selectedModelId:${id}` : 'employeeWorkbench:selectedModelId'
  const enableThinkingKey = id ? `employeeWorkbench:enableThinking:${id}` : 'employeeWorkbench:enableThinking'
  const activeConvIdStorageKey = id ? `employeeWorkbench:activeConvId:${id}` : null

  const [selectedLlmProviderId, setSelectedLlmProviderId] = useState<string>(() => {
    const stored = selectedLlmProviderIdKey ? localStorage.getItem(selectedLlmProviderIdKey) : null
    return stored || getCachedSceneDefaultModel('workbench')?.provider_id || ''
  })
  const [selectedLlmModelId, setSelectedLlmModelId] = useState<string>(() => {
    const stored = selectedLlmModelIdKey ? localStorage.getItem(selectedLlmModelIdKey) : null
    return stored || getCachedSceneDefaultModel('workbench')?.model_id || ''
  })
  const [enableThinking, setEnableThinking] = useState<boolean>(() => {
    const stored = enableThinkingKey ? localStorage.getItem(enableThinkingKey) : null
    return stored === 'true'
  })
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([])

  const handleLlmChange = useCallback((providerId: string, modelId: string) => {
    setSelectedLlmProviderId(providerId)
    setSelectedLlmModelId(modelId)
  }, [])

  useEffect(() => {
    if (selectedLlmProviderIdKey) {
      localStorage.setItem(selectedLlmProviderIdKey, selectedLlmProviderId)
    }
    if (selectedLlmModelIdKey) {
      localStorage.setItem(selectedLlmModelIdKey, selectedLlmModelId)
    }
  }, [selectedLlmProviderId, selectedLlmModelId, selectedLlmProviderIdKey, selectedLlmModelIdKey])
  useEffect(() => {
    if (enableThinkingKey) {
      localStorage.setItem(enableThinkingKey, String(enableThinking))
    }
  }, [enableThinking, enableThinkingKey])

  const [editingConversationId, setEditingConversationId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [displayedCount, setDisplayedCount] = useState(10)
  const [allConversations, setAllConversations] = useState<Conversation[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const isUserAtBottomRef = useRef(true)
  const initializedRef = useRef(false)

  const streamStatesRef = useRef<Map<string, ConversationStreamState>>(_persistentStreamStates)
  const conversationMessagesRef = useRef<Map<string, MessageWithThought[]>>(_persistentMessages)
  const globalListenersCleanupRef = useRef<(() => void) | null>(_persistentListenersCleanup)
  const activeConversationIdRef = useRef<string | null>(null)
  const initVersionRef = useRef(0)
  const selectConvVersionRef = useRef(0)

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
      if (_persistentEmployeeId && _persistentEmployeeId !== id) {
        if (_persistentListenersCleanup) {
          _persistentListenersCleanup()
          _persistentListenersCleanup = null
          globalListenersCleanupRef.current = null
        }
        for (const [, state] of _persistentStreamStates) {
          state.cleanupFns.forEach(fn => fn())
        }
        _persistentStreamStates.clear()
        _persistentMessages.clear()
      }
      _persistentEmployeeId = id
      initVersionRef.current++
      initEmployee()
    }
    return () => {
      initializedRef.current = false
    }
  }, [id])

  const initEmployee = async () => {
    const version = initVersionRef.current
    try {
      const result = await window.electronAPI.employee.get(id!)
      if (version !== initVersionRef.current) return
      setEmployee(result)
      if (result.llm_provider_id && !localStorage.getItem(selectedLlmProviderIdKey)) setSelectedLlmProviderId(result.llm_provider_id)
      if (result.llm_model && !localStorage.getItem(selectedLlmModelIdKey)) setSelectedLlmModelId(result.llm_model)
      loadConversations()
      loadProviders()
    } catch {
      if (version !== initVersionRef.current) return
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
      if (activeConversationIdRef.current && activeConvIdStorageKey) {
        localStorage.setItem(activeConvIdStorageKey, activeConversationIdRef.current)
      }

      for (const [convId, msgs] of conversationMessagesRef.current) {
        if (msgs && msgs.length > 0) {
          const hasStreaming = msgs.some(m => m.isStreaming)
          if (hasStreaming) continue

          window.electronAPI.conversation.update({
            id: convId,
            messages_json: JSON.stringify(msgs),
            message_count: msgs.length,
          }).catch(() => {})
        }
      }
    }
  }, [])

  const calcTotalOutputChars = (segs: any[], content?: string): number => {
    let total = (content || '').length
    for (const s of segs || []) {
      if (s.type === 'answer' && s.content) {
        total += (typeof s.content === 'string' ? s.content.length : 0)
      }
    }
    return total
  }

  const setupGlobalListeners = useCallback(() => {
    if (_persistentListenersCleanup) {
      _persistentListenersCleanup()
      _persistentListenersCleanup = null
      globalListenersCleanupRef.current = null
    }

    const chunkCleanup = window.electronAPI.llm.onChunk((data: { sessionId: string; chunk: string }) => {
      const { sessionId, chunk } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      updateConvMessages(streamState.conversationId, (prev) =>
        prev.map((m) => {
          if (m.id !== streamState.assistantMessageId) return m
          const segs = [...(m.segments || [])]
          const lastSeg = segs[segs.length - 1]

          for (let i = 0; i < segs.length; i++) {
            if (segs[i].type === 'thinking' && segs[i].isStreaming) {
              segs[i] = { ...segs[i], isStreaming: false, collapsed: true, completedAt: Date.now() }
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

      updateConvMessages(streamState.conversationId, (prev) =>
        prev.map((m) => {
          if (m.id !== streamState.assistantMessageId) return m
          const segs = [...(m.segments || [])]
          const lastSeg = segs[segs.length - 1]

          for (let i = 0; i < segs.length; i++) {
            if (segs[i].isStreaming && segs[i].type !== 'thinking') {
              segs[i] = { ...segs[i], isStreaming: false, completedAt: Date.now() }
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

      updateConvMessages(streamState.conversationId, (prev) =>
        prev.map((m) => {
          if (m.id !== streamState.assistantMessageId) return m
          const segs = [...(m.segments || [])]
          const lastSeg = segs[segs.length - 1]
          if (lastSeg && lastSeg.type === 'answer' && lastSeg.isStreaming) {
            segs[segs.length - 1] = { ...lastSeg, isStreaming: false, completedAt: Date.now() }
          }
          if (lastSeg && lastSeg.type === 'thinking' && lastSeg.isStreaming) {
            segs[segs.length - 1] = { ...lastSeg, isStreaming: false, collapsed: true, completedAt: Date.now() }
          }
          segs.push({
            type: 'tool_call',
            id: `${streamState.assistantMessageId}_tool_${streamState.toolCallCounter++}`,
            toolName: name,
            toolArgs: args,
            isToolComplete: false,
            collapsed: true,
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

      updateConvMessages(streamState.conversationId, (prev) =>
        prev.map((m) => {
          if (m.id !== streamState.assistantMessageId) return m
          const segs = [...(m.segments || [])]
          const lastIncompleteIndex = [...segs].reverse().findIndex(
            s => s.type === 'tool_call' && s.toolName === name && !s.isToolComplete
          )
          if (lastIncompleteIndex === -1) return m
          const actualIndex = segs.length - 1 - lastIncompleteIndex
          segs[actualIndex] = { ...segs[actualIndex], toolResult: result, isToolComplete: true, collapsed: true, completedAt: Date.now() }
          return { ...m, segments: segs }
        })
      )
    })

    const doneCleanup = window.electronAPI.llm.onDone((data: { sessionId: string; metadata?: any }) => {
      const { sessionId, metadata } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      updateConvMessages(streamState.conversationId, (prev) => {
        const assistantMsg = prev.find((m) => m.id === streamState.assistantMessageId)
        if (!assistantMsg) return prev
        const segs = (assistantMsg.segments || []).map(s => {
          const completedAt = s.completedAt || Date.now()
          return {
            ...s,
            isStreaming: false,
            completedAt: s.isStreaming ? completedAt : s.completedAt,
            ...(s.type === 'thinking' ? { collapsed: true } : {}),
          }
        })
        const apiTokenUsage = metadata?.tokenUsage || metadata?.usage
        const totalChars = calcTotalOutputChars(segs, assistantMsg.content)
        const tokenUsage = apiTokenUsage
          ? {
              promptTokens: apiTokenUsage.promptTokens ?? apiTokenUsage.prompt_tokens,
              completionTokens: apiTokenUsage.completionTokens ?? apiTokenUsage.completion_tokens,
              totalTokens: apiTokenUsage.totalTokens ?? apiTokenUsage.total_tokens,
              cachedTokens: apiTokenUsage.cachedTokens ?? apiTokenUsage.cached_tokens ?? apiTokenUsage.prompt_tokens_details?.cached_tokens ?? apiTokenUsage.prompt_cache_hit_tokens,
            }
          : (totalChars > 0 ? { totalChars } : undefined)
        const savedAssistantMsg: MessageWithThought = {
          ...assistantMsg,
          isStreaming: false,
          segments: segs,
          tokenUsage,
        }
        window.electronAPI.conversation.update({
          id: streamState.conversationId,
          messages_json: JSON.stringify(prev.map((m) =>
            m.id === streamState.assistantMessageId ? savedAssistantMsg : m
          )),
          message_count: prev.length,
        }).catch(() => {})
        return prev.map((m) =>
          m.id === streamState.assistantMessageId ? savedAssistantMsg : m
        )
      })

      streamState.isStreaming = false
      streamState.cleanupFns.forEach(fn => fn())
      streamStatesRef.current.delete(sessionId)

      const anyStreaming = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === streamState.conversationId && s.isStreaming)
      if (!anyStreaming) {
        setIsStreaming(false)
        if (activeConvIdStorageKey && localStorage.getItem(activeConvIdStorageKey) === streamState.conversationId) {
          localStorage.removeItem(activeConvIdStorageKey)
        }
      }
    })

    const errorCleanup = window.electronAPI.llm.onError((data: { sessionId: string; error: string }) => {
      const { sessionId, error } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      updateConvMessages(streamState.conversationId, (prev) =>
        prev.map((m) =>
          m.id === streamState.assistantMessageId
            ? { ...m, content: t('workbench.errorMsg', { error }), isStreaming: false, isError: true, segments: (m.segments || []).map(s => ({ ...s, isStreaming: false, completedAt: s.completedAt || Date.now() })) }
            : m
        )
      )

      streamState.isStreaming = false
      streamState.cleanupFns.forEach(fn => fn())
      streamStatesRef.current.delete(sessionId)

      const anyStreaming = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === streamState.conversationId && s.isStreaming)
      if (!anyStreaming) {
        setIsStreaming(false)
        if (activeConvIdStorageKey && localStorage.getItem(activeConvIdStorageKey) === streamState.conversationId) {
          localStorage.removeItem(activeConvIdStorageKey)
        }
      }
    })

    const cleanup = () => {
      chunkCleanup()
      thoughtCleanup()
      toolCallCleanup()
      toolResultCleanup()
      doneCleanup()
      errorCleanup()
    }
    _persistentListenersCleanup = cleanup
    globalListenersCleanupRef.current = cleanup
  }, [activeConversationId, t])

  const setupGlobalListenersRef = useRef(setupGlobalListeners)
  setupGlobalListenersRef.current = setupGlobalListeners

  useEffect(() => {
    const savedConvId = activeConvIdStorageKey ? localStorage.getItem(activeConvIdStorageKey) : null
    if (!savedConvId) return

    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === savedConvId && s.isStreaming)

    activeConversationIdRef.current = savedConvId

    if (hasActiveStream || _persistentListenersCleanup) {
      setupGlobalListenersRef.current()
    }

    const msgs = conversationMessagesRef.current.get(savedConvId)
    if (msgs && msgs.length > 0) {
      setActiveConversationId(savedConvId)
      setMessages(msgs)
      setIsStreaming(hasActiveStream)
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

  const loadConversations = async () => {
    try {
      const result = await window.electronAPI.conversation.list({ employee_id: id! })

      const savedConvId = activeConvIdStorageKey ? localStorage.getItem(activeConvIdStorageKey) : null
      let sortedResult = result
      if (savedConvId) {
        const activeIndex = result.findIndex((c: Conversation) => c.id === savedConvId)
        if (activeIndex > 0) {
          sortedResult = [result[activeIndex], ...result.slice(0, activeIndex), ...result.slice(activeIndex + 1)]
        }
      }

      setAllConversations(sortedResult)
      setConversations(sortedResult.slice(0, displayedCount))

      if (!initializedRef.current) {
        initializedRef.current = true
        if (sortedResult.length > 0) {
          const targetConv = savedConvId ? sortedResult.find((c: Conversation) => c.id === savedConvId) : null
          selectConversation(targetConv ? savedConvId! : sortedResult[0].id)
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
        const msgContent = pendingMessage
        setPendingMessage(null)
        setTimeout(() => sendMessage(convId, msgContent), 0)
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
    selectConvVersionRef.current++
    const version = selectConvVersionRef.current
    setActiveConversationId(convId)
    activeConversationIdRef.current = convId

    setIsComparisonMode(false)
    setComparisonMessageIds([])
    setComparisonUserMessageId(null)

    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === convId && s.isStreaming)
    setIsStreaming(hasActiveStream)

    const cachedMsgs = conversationMessagesRef.current.get(convId)
    if (cachedMsgs !== undefined) {
      const patchedCached = cachedMsgs.map(patchMissingCompletedAt)
      const cachePatched = patchedCached.some((m, i) => m !== cachedMsgs[i])
      if (cachePatched) {
        conversationMessagesRef.current.set(convId, patchedCached)
        window.electronAPI.conversation.update({
          id: convId,
          messages_json: JSON.stringify(patchedCached),
          message_count: patchedCached.length,
        }).catch(() => {})
      }
      setMessages(cachePatched ? patchedCached : cachedMsgs)
    } else {
      try {
        const fullConv = await window.electronAPI.conversation.get(convId)
        if (version !== selectConvVersionRef.current) return
        if (fullConv) {
          const parsedMsgs = (JSON.parse(fullConv.messages_json || '[]') as MessageWithThought[])
          const msgs = parsedMsgs
            .map(ensureSegments)
            .map(patchMissingCompletedAt)
          if (msgs.some((m, i) => m !== parsedMsgs[i])) {
            window.electronAPI.conversation.update({
              id: convId,
              messages_json: JSON.stringify(msgs),
              message_count: msgs.length,
            }).catch(() => {})
          }
          setConvMessages(convId, msgs)
        }
      } catch {
        if (version !== selectConvVersionRef.current) return
        setConvMessages(convId, [])
      }
    }
  }

  const deleteConversation = async (convId: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    try {
      const streamEntries = Array.from(streamStatesRef.current.entries()).filter(([, s]) => s.conversationId === convId)
      for (const [sessionId, state] of streamEntries) {
        state.cleanupFns.forEach(fn => fn())
        streamStatesRef.current.delete(sessionId)
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
        const streamEntries = Array.from(streamStatesRef.current.entries()).filter(([, s]) => s.conversationId === convId)
        for (const [sessionId, state] of streamEntries) {
          state.cleanupFns.forEach(fn => fn())
          streamStatesRef.current.delete(sessionId)
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

  const handleSend = async (content: string, images?: string[], models?: Array<{ providerId: string; modelId: string }>) => {
    if (!content.trim() && (!images || images.length === 0)) return

    const currentConvId = activeConversationId
    if (!currentConvId) {
      if (isCreatingConversation) return
      setPendingMessage(content.trim())
      await startNewConversation()
      return
    }

    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === currentConvId && s.isStreaming)
    if (hasActiveStream) return

    sendMessage(currentConvId, content.trim(), images, models)
  }

  const sendMessage = async (convId: string, content: string, images?: string[], models?: Array<{ providerId: string; modelId: string }>) => {
    const targetConvId = convId || activeConversationId
    if (!targetConvId) return

    if (!content.trim() && (!images || images.length === 0)) return

    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === targetConvId && s.isStreaming)
    if (hasActiveStream) return

    setupGlobalListeners()

    const currentMsgs = conversationMessagesRef.current.get(targetConvId) || []

    if (currentMsgs.length === 0) {
      generateConversationTitle(targetConvId, content).catch(() => {})
    }

    const userMessage: MessageWithThought = {
      id: `msg_${generateId()}`,
      role: 'user',
      content,
      images,
      timestamp: Date.now(),
    }

    const updatedMessagesRef = [...currentMsgs, userMessage]
    setConvMessages(targetConvId, [...currentMsgs, userMessage])

    const targetModels = models && models.length > 0 ? models : null

    if (targetModels) {
      const assistantIds: string[] = []
      for (const sel of targetModels) {
        const assistantMessageId = `msg_${generateId()}`
        assistantIds.push(assistantMessageId)
        const assistantMessage: MessageWithThought = {
          id: assistantMessageId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
          segments: [],
          comparisonProviderId: sel.providerId,
          comparisonModelId: sel.modelId,
        }
        updateConvMessages(targetConvId, (prev) => [...prev, assistantMessage])

        const streamState: ConversationStreamState = {
          isStreaming: true,
          conversationId: targetConvId,
          messages: updatedMessagesRef,
          assistantMessageId,
          segCounter: 0,
          toolCallCounter: 0,
          cleanupFns: [],
        }

        if (targetConvId === activeConversationId) {
          setIsStreaming(true)
        }

        try {
          const messageHistory = updatedMessagesRef.map((m) => ({
            role: m.role,
            content: getActiveBranchContent(m),
            images: m.images,
          }))

          const result = await window.electronAPI.llm.employeeChatStream({
            employee_id: id!,
            provider_id: sel.providerId,
            model_id: sel.modelId,
            messages: messageHistory,
            options: { temperature: 0.3 },
            use_skills: true,
            kb_ids: selectedKbIds,
            enable_thinking: enableThinking,
            conversation_id: targetConvId,
          })

          if (result?.sessionId) {
            streamStatesRef.current.set(result.sessionId, streamState)
          }
        } catch {
          streamState.isStreaming = false
          const anyStreaming = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === targetConvId && s.isStreaming)
          if (!anyStreaming) {
            setIsStreaming(false)
          }
        }
      }

      if (targetConvId === activeConversationId && assistantIds.length > 0) {
        setIsComparisonMode(true)
        setComparisonMessageIds(assistantIds)
        setComparisonUserMessageId(userMessage.id)
      }
    } else {
      const providerId = selectedLlmProviderId || employee?.llm_provider_id || providers.find((p: any) => p.is_default)?.id
      if (!providerId) {
        message.warning(t('workbench.noLlmProvider'))
        return
      }

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
        conversationId: targetConvId,
        messages: updatedMessagesRef,
        assistantMessageId,
        segCounter: 0,
        toolCallCounter: 0,
        cleanupFns: [],
      }

      try {
        const messageHistory = updatedMessagesRef.map((m) => ({
          role: m.role,
          content: getActiveBranchContent(m),
          images: m.images,
        }))

        const result = await window.electronAPI.llm.employeeChatStream({
          employee_id: id!,
          provider_id: providerId,
          model_id: selectedLlmModelId || undefined,
          messages: messageHistory,
          options: { temperature: 0.3 },
          use_skills: true,
          kb_ids: selectedKbIds,
          enable_thinking: enableThinking,
          conversation_id: targetConvId,
        })

        if (result?.sessionId) {
          streamStatesRef.current.set(result.sessionId, streamState)
        }
      } catch {
        streamState.isStreaming = false
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
      const currentMsgs = conversationMessagesRef.current.get(activeConversationId) || []
      const msgIndex = currentMsgs.findIndex((m) => m.id === msgId)
      const newMessages = currentMsgs.filter((m) => m.id !== msgId)
      if (msgIndex !== -1 && currentMsgs[msgIndex].role === 'user') {
        const followingAssistant = currentMsgs[msgIndex + 1]
        if (followingAssistant && followingAssistant.role === 'assistant') {
          newMessages.splice(newMessages.indexOf(followingAssistant), 1)
        }
      }
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

  const handleRegenerate = async (msgId: string) => {
    if (!activeConversationId || isStreaming) return
    const currentMsgs = conversationMessagesRef.current.get(activeConversationId) || []
    const msgIndex = currentMsgs.findIndex((m) => m.id === msgId)
    if (msgIndex === -1) return

    const targetMsg = currentMsgs[msgIndex]
    if (targetMsg.role !== 'assistant') return

    const existingBranches = targetMsg.branches || []
    const currentBranch: MessageBranch = {
      content: targetMsg.content,
      segments: targetMsg.segments,
      thought: targetMsg.thought,
      tokenUsage: targetMsg.tokenUsage,
      isError: targetMsg.isError,
      comparisonProviderId: targetMsg.comparisonProviderId,
      comparisonModelId: targetMsg.comparisonModelId,
    }
    const allBranches = [...existingBranches, currentBranch]
    const newBranchIndex = allBranches.length

    const newMessages = [...currentMsgs]
    newMessages[msgIndex] = {
      ...targetMsg,
      branches: allBranches,
      activeBranchIndex: newBranchIndex,
      content: '',
      thought: '',
      segments: [],
      isStreaming: true,
      isError: false,
      tokenUsage: undefined,
      comparisonProviderId: undefined,
      comparisonModelId: undefined,
    }
    setConvMessages(activeConversationId, newMessages)
    await window.electronAPI.conversation.update({
      id: activeConversationId,
      messages_json: JSON.stringify(newMessages),
      message_count: newMessages.length,
    })

    const providerId = selectedLlmProviderId || employee?.llm_provider_id || providers.find((p: any) => p.is_default)?.id
    if (!providerId) {
      message.warning(t('workbench.noLlmProvider'))
      return
    }

    setupGlobalListeners()
    setIsStreaming(true)

    const streamState: ConversationStreamState = {
      isStreaming: true,
      conversationId: activeConversationId,
      messages: newMessages.slice(0, msgIndex),
      assistantMessageId: msgId,
      segCounter: 0,
      toolCallCounter: 0,
      cleanupFns: [],
    }

    try {
      const messageHistory = newMessages.slice(0, msgIndex).map((m) => ({
        role: m.role,
        content: getActiveBranchContent(m),
        images: m.images,
      }))

      const result = await window.electronAPI.llm.employeeChatStream({
        employee_id: id!,
        provider_id: providerId,
        model_id: selectedLlmModelId || undefined,
        messages: messageHistory,
        options: { temperature: 0.3 },
        use_skills: true,
        kb_ids: selectedKbIds,
        enable_thinking: enableThinking,
        conversation_id: activeConversationId,
      })

      if (result?.sessionId) {
        streamStatesRef.current.set(result.sessionId, streamState)
      }
    } catch {
      streamState.isStreaming = false
      for (const [sid, ss] of streamStatesRef.current) {
        if (ss === streamState) {
          streamStatesRef.current.delete(sid)
          break
        }
      }
      setIsStreaming(false)
    }
  }

  const handleSwitchModelRegenerate = async (msgId: string, providerId: string, modelId: string) => {
    if (!activeConversationId || isStreaming) return
    if (!providerId || !modelId) return

    const currentMsgs = conversationMessagesRef.current.get(activeConversationId) || []
    const msgIndex = currentMsgs.findIndex((m) => m.id === msgId)
    if (msgIndex === -1) return

    const targetMsg = currentMsgs[msgIndex]
    if (targetMsg.role !== 'assistant') return

    const existingBranches = targetMsg.branches || []
    const currentBranch: MessageBranch = {
      content: targetMsg.content,
      segments: targetMsg.segments,
      thought: targetMsg.thought,
      tokenUsage: targetMsg.tokenUsage,
      isError: targetMsg.isError,
      comparisonProviderId: targetMsg.comparisonProviderId,
      comparisonModelId: targetMsg.comparisonModelId,
    }
    const allBranches = [...existingBranches, currentBranch]
    const newBranchIndex = allBranches.length

    const newMessages = [...currentMsgs]
    newMessages[msgIndex] = {
      ...targetMsg,
      branches: allBranches,
      activeBranchIndex: newBranchIndex,
      content: '',
      thought: '',
      segments: [],
      isStreaming: true,
      isError: false,
      tokenUsage: undefined,
      comparisonProviderId: providerId,
      comparisonModelId: modelId,
    }
    setConvMessages(activeConversationId, newMessages)
    await window.electronAPI.conversation.update({
      id: activeConversationId,
      messages_json: JSON.stringify(newMessages),
      message_count: newMessages.length,
    })

    setupGlobalListeners()
    setIsStreaming(true)

    const streamState: ConversationStreamState = {
      isStreaming: true,
      conversationId: activeConversationId,
      messages: newMessages.slice(0, msgIndex),
      assistantMessageId: msgId,
      segCounter: 0,
      toolCallCounter: 0,
      cleanupFns: [],
    }

    try {
      const messageHistory = newMessages.slice(0, msgIndex).map((m) => ({
        role: m.role,
        content: getActiveBranchContent(m),
        images: m.images,
      }))

      const result = await window.electronAPI.llm.employeeChatStream({
        employee_id: id!,
        provider_id: providerId,
        model_id: modelId,
        messages: messageHistory,
        options: { temperature: 0.3 },
        use_skills: true,
        kb_ids: selectedKbIds,
        enable_thinking: enableThinking,
        conversation_id: activeConversationId,
      })

      if (result?.sessionId) {
        streamStatesRef.current.set(result.sessionId, streamState)
      }
    } catch {
      streamState.isStreaming = false
      for (const [sid, ss] of streamStatesRef.current) {
        if (ss === streamState) {
          streamStatesRef.current.delete(sid)
          break
        }
      }
      setIsStreaming(false)
    }
  }

  const handleEditAndResubmit = async (msgId: string, newContent: string) => {
    if (!activeConversationId || isStreaming) return
    if (!newContent.trim()) return

    const currentMsgs = conversationMessagesRef.current.get(activeConversationId) || []
    const msgIndex = currentMsgs.findIndex((m) => m.id === msgId)
    if (msgIndex === -1) return

    const targetMsg = currentMsgs[msgIndex]

    const newMessages = currentMsgs.slice(0, msgIndex)
    const editedUserMsg: MessageWithThought = {
      ...targetMsg,
      content: newContent.trim(),
      timestamp: Date.now(),
    }
    newMessages.push(editedUserMsg)

    const assistantMsgIndex = msgIndex + 1
    const existingAssistantMsg = currentMsgs[assistantMsgIndex]
    let assistantMessageId: string

    if (existingAssistantMsg && existingAssistantMsg.role === 'assistant') {
      const existingBranches = existingAssistantMsg.branches || []
      const currentBranch: MessageBranch = {
        content: existingAssistantMsg.content,
        segments: existingAssistantMsg.segments,
        thought: existingAssistantMsg.thought,
        tokenUsage: existingAssistantMsg.tokenUsage,
        isError: existingAssistantMsg.isError,
        comparisonProviderId: existingAssistantMsg.comparisonProviderId,
        comparisonModelId: existingAssistantMsg.comparisonModelId,
      }
      const allBranches = [...existingBranches, currentBranch]
      const newBranchIndex = allBranches.length

      assistantMessageId = existingAssistantMsg.id
      const updatedAssistantMsg: MessageWithThought = {
        ...existingAssistantMsg,
        branches: allBranches,
        activeBranchIndex: newBranchIndex,
        content: '',
        thought: '',
        segments: [],
        isStreaming: true,
        isError: false,
        tokenUsage: undefined,
        comparisonProviderId: undefined,
        comparisonModelId: undefined,
      }
      newMessages.push(updatedAssistantMsg)
    } else {
      assistantMessageId = `msg_${generateId()}`
      const assistantMessage: MessageWithThought = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
        segments: [],
      }
      newMessages.push(assistantMessage)
    }

    setConvMessages(activeConversationId, newMessages)
    await window.electronAPI.conversation.update({
      id: activeConversationId,
      messages_json: JSON.stringify(newMessages),
      message_count: newMessages.length,
    })

    const providerId = selectedLlmProviderId || employee?.llm_provider_id || providers.find((p: any) => p.is_default)?.id
    if (!providerId) {
      message.warning(t('workbench.noLlmProvider'))
      return
    }

    setupGlobalListeners()
    setIsStreaming(true)

    const streamState: ConversationStreamState = {
      isStreaming: true,
      conversationId: activeConversationId,
      messages: newMessages.slice(0, assistantMsgIndex),
      assistantMessageId,
      segCounter: 0,
      toolCallCounter: 0,
      cleanupFns: [],
    }

    try {
      const messageHistory = newMessages.slice(0, assistantMsgIndex).map((m) => ({
        role: m.role,
        content: getActiveBranchContent(m),
        images: m.images,
      }))

      const result = await window.electronAPI.llm.employeeChatStream({
        employee_id: id!,
        provider_id: providerId,
        model_id: selectedLlmModelId || undefined,
        messages: messageHistory,
        options: { temperature: 0.3 },
        use_skills: true,
        kb_ids: selectedKbIds,
        enable_thinking: enableThinking,
        conversation_id: activeConversationId,
      })

      if (result?.sessionId) {
        streamStatesRef.current.set(result.sessionId, streamState)
      }
    } catch {
      streamState.isStreaming = false
      for (const [sid, ss] of streamStatesRef.current) {
        if (ss === streamState) {
          streamStatesRef.current.delete(sid)
          break
        }
      }
      setIsStreaming(false)
    }
  }

  const handleCommand = (command: string) => {
    if (command === '/clear') {
      if (activeConversationId) {
        setConvMessages(activeConversationId, [])
        window.electronAPI.conversation.update({
          id: activeConversationId,
          messages_json: JSON.stringify([]),
          message_count: 0,
        }).catch(() => {})
      }
    } else if (command === '/new') {
      startNewConversation()
    }
  }

  const handleSwitchBranch = (msgId: string, branchIndex: number) => {
    if (!activeConversationId) return
    updateConvMessages(activeConversationId, (prev) => {
      const newMessages = prev.map(m => {
        if (m.id !== msgId) return m
        const branches = m.branches || []
        const maxIndex = branches.length
        if (branchIndex < 0 || branchIndex > maxIndex) return m
        return { ...m, activeBranchIndex: branchIndex }
      })
      window.electronAPI.conversation.update({
        id: activeConversationId,
        messages_json: JSON.stringify(newMessages),
        message_count: newMessages.length,
      }).catch(() => {})
      return newMessages
    })
  }

  const handleCloseComparison = () => {
    if (!activeConversationId) return
    const currentMsgs = conversationMessagesRef.current.get(activeConversationId) || []

    const firstId = comparisonMessageIds[0]
    const firstMsg = currentMsgs.find(m => m.id === firstId)

    if (firstMsg?._comparisonBranchMsgs) {
      updateConvMessages(activeConversationId, (prev) =>
        prev.map(m => {
          if (m.id !== firstId) return m
          const { _comparisonBranchMsgs, ...rest } = m
          return rest as MessageWithThought
        })
      )
      setIsComparisonMode(false)
      setComparisonMessageIds([])
      setComparisonUserMessageId(null)
      return
    }

    const comparisonMsgs = comparisonMessageIds
      .map(id => currentMsgs.find(m => m.id === id))
      .filter((m): m is MessageWithThought => !!m)

    if (comparisonMsgs.length === 0) {
      setIsComparisonMode(false)
      setComparisonMessageIds([])
      setComparisonUserMessageId(null)
      return
    }

    const targetMsg = comparisonMsgs[0]
    const branches: MessageBranch[] = comparisonMsgs.slice(1).map(m => ({
      content: m.content,
      segments: m.segments,
      thought: m.thought,
      tokenUsage: m.tokenUsage,
      isError: m.isError,
      comparisonProviderId: m.comparisonProviderId,
      comparisonModelId: m.comparisonModelId,
    }))

    const aggregatedMsg: MessageWithThought = {
      ...targetMsg,
      branches,
      activeBranchIndex: branches.length,
      comparisonProviderId: targetMsg.comparisonProviderId,
      comparisonModelId: targetMsg.comparisonModelId,
    }

    const otherIds = new Set(comparisonMessageIds.slice(1))
    const newMessages = currentMsgs
      .filter(m => !otherIds.has(m.id))
      .map(m => m.id === targetMsg.id ? aggregatedMsg : m)

    setConvMessages(activeConversationId, newMessages)
    window.electronAPI.conversation.update({
      id: activeConversationId,
      messages_json: JSON.stringify(newMessages),
      message_count: newMessages.length,
    }).catch(() => {})

    setIsComparisonMode(false)
    setComparisonMessageIds([])
    setComparisonUserMessageId(null)
  }

  const handleOpenComparison = (msgId: string) => {
    if (!activeConversationId) return
    const currentMsgs = conversationMessagesRef.current.get(activeConversationId) || []
    const targetMsg = currentMsgs.find(m => m.id === msgId)
    if (!targetMsg || !targetMsg.branches || targetMsg.branches.length === 0) return

    const hasComparisonBranches = targetMsg.branches.some(
      b => b.comparisonProviderId || b.comparisonModelId
    ) || (targetMsg.comparisonProviderId || targetMsg.comparisonModelId)

    if (!hasComparisonBranches) return

    const userMsgIndex = currentMsgs.findIndex(m => m.id === msgId) - 1
    const userMsg = userMsgIndex >= 0 ? currentMsgs[userMsgIndex] : null

    const allBranchMsgs: MessageWithThought[] = []
    for (let i = 0; i < targetMsg.branches.length; i++) {
      const branch = targetMsg.branches[i]
      allBranchMsgs.push({
        ...targetMsg,
        id: `${targetMsg.id}_branch_${i}`,
        content: branch.content,
        segments: branch.segments,
        thought: branch.thought,
        tokenUsage: branch.tokenUsage,
        isError: branch.isError,
        comparisonProviderId: branch.comparisonProviderId,
        comparisonModelId: branch.comparisonModelId,
        branches: undefined,
        activeBranchIndex: undefined,
        isStreaming: false,
      })
    }

    allBranchMsgs.push({
      ...targetMsg,
      id: `${targetMsg.id}_branch_${targetMsg.branches.length}`,
      branches: undefined,
      activeBranchIndex: undefined,
    })

    setIsComparisonMode(true)
    setComparisonMessageIds([msgId])
    setComparisonUserMessageId(userMsg?.id || null)

    updateConvMessages(activeConversationId, () => {
      const msgs = conversationMessagesRef.current.get(activeConversationId) || []
      return msgs.map(m => {
        if (m.id !== msgId) return m
        return { ...m, _comparisonBranchMsgs: allBranchMsgs }
      })
    })
  }

  const getComparisonMessages = (): MessageWithThought[] => {
    if (!activeConversationId || comparisonMessageIds.length === 0) return []
    const currentMsgs = conversationMessagesRef.current.get(activeConversationId) || []

    const firstId = comparisonMessageIds[0]
    const firstMsg = currentMsgs.find(m => m.id === firstId)
    if (firstMsg?._comparisonBranchMsgs) {
      return firstMsg._comparisonBranchMsgs as MessageWithThought[]
    }

    return comparisonMessageIds
      .map(id => currentMsgs.find(m => m.id === id))
      .filter((m): m is MessageWithThought => !!m)
  }

  const getComparisonUserMessage = (): MessageWithThought | null => {
    if (!activeConversationId || !comparisonUserMessageId) return null
    const currentMsgs = conversationMessagesRef.current.get(activeConversationId) || []
    return currentMsgs.find(m => m.id === comparisonUserMessageId) || null
  }

  const handleExportConversation = (convId?: string) => {
    const targetConvId = convId || activeConversationId
    if (!targetConvId) return
    const currentMsgs = conversationMessagesRef.current.get(targetConvId) || []
    if (currentMsgs.length === 0) return

    const lines: string[] = []
    for (const msg of currentMsgs) {
      const role = msg.role === 'user' ? '👤 User' : '🤖 Assistant'
      lines.push(`### ${role}\n`)
      lines.push(msg.content)
      lines.push('')
    }

    const content = lines.join('\n')
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `conversation-${targetConvId}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleStop = async () => {
    if (!activeConversationId) return
    const activeStreamEntries = Array.from(streamStatesRef.current.entries()).filter(
      ([_, s]) => s.conversationId === activeConversationId && s.isStreaming
    )
    for (const [sessionId, streamState] of activeStreamEntries) {
      streamState.isStreaming = false
      streamState.cleanupFns.forEach(fn => fn())
      streamStatesRef.current.delete(sessionId)
      try {
        await window.electronAPI.llm.abortChat(sessionId)
      } catch (e) { console.error('Failed to abort chat:', e) }
    }
    setIsStreaming(false)
    if (activeConvIdStorageKey && localStorage.getItem(activeConvIdStorageKey) === activeConversationId) {
      localStorage.removeItem(activeConvIdStorageKey)
    }
    updateConvMessages(activeConversationId, (prev) =>
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
    const currentMsgs = conversationMessagesRef.current.get(activeConversationId)
    if (currentMsgs) {
      window.electronAPI.conversation.update({
        id: activeConversationId,
        messages_json: JSON.stringify(currentMsgs),
        message_count: currentMsgs.length,
      }).catch(() => {})
    }
  }

  const getToolDisplayName = (name: string) => TOOL_DISPLAY_NAMES[name] || name

  const handleToggleSegment = (msgId: string, segId: string) => {
    if (!activeConversationId) return

    const branchMatch = msgId.match(/^(.+)_branch_(\d+)$/)
    if (branchMatch) {
      const originalMsgId = branchMatch[1]
      const branchIndex = parseInt(branchMatch[2], 10)
      updateConvMessages(activeConversationId, (prev) => prev.map(m => {
        if (m.id !== originalMsgId || !m._comparisonBranchMsgs) return m
        const newBranchMsgs = m._comparisonBranchMsgs.map((bm, idx) => {
          if (idx !== branchIndex || !bm.segments) return bm
          return {
            ...bm,
            segments: bm.segments.map(s =>
              s.id === segId ? { ...s, collapsed: !s.collapsed } : s
            ),
          }
        })
        return { ...m, _comparisonBranchMsgs: newBranchMsgs }
      }))
      return
    }

    updateConvMessages(activeConversationId, (prev) => prev.map(m => {
      if (m.id !== msgId) return m

      const activeIdx = m.activeBranchIndex
      const brs = m.branches
      if (brs && brs.length > 0 && activeIdx !== undefined && activeIdx < brs.length) {
        return {
          ...m,
          branches: brs.map((b, i) => {
            if (i !== activeIdx || !b.segments) return b
            return {
              ...b,
              segments: b.segments.map(s =>
                s.id === segId ? { ...s, collapsed: !s.collapsed } : s
              ),
            }
          }),
        }
      }

      if (!m.segments) return m
      const newSegs = m.segments.map(s =>
        s.id === segId ? { ...s, collapsed: !s.collapsed } : s
      )
      return { ...m, segments: newSegs }
    }))
  }

  const isConversationStreaming = (convId: string) => {
    return Array.from(streamStatesRef.current.values()).some(s => s.conversationId === convId && s.isStreaming)
  }

  return {
    employee,
    conversations,
    allConversations,
    activeConversationId,
    messages,
    isStreaming,
    isCreatingConversation,
    providers,
    selectedLlmProviderId,
    selectedLlmModelId,
    handleLlmChange,
    enableThinking,
    setEnableThinking,
    selectedKbIds,
    setSelectedKbIds,
    showSidePanel,
    setShowSidePanel,
    isComparisonMode,
    comparisonMessageIds,
    handleCloseComparison,
    handleOpenComparison,
    getComparisonMessages,
    getComparisonUserMessage,
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
    handleRegenerate,
    handleSwitchModelRegenerate,
    handleEditAndResubmit,
    handleCommand,
    handleExportConversation,
    handleSwitchBranch,
    handleToggleSegment,
    forceScrollToBottom,
    getToolDisplayName,
    isConversationStreaming,
    generateConversationTitle,
  }
}

export default useEmployeeChat
