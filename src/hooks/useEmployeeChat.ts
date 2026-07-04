import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { Conversation } from '../types'
import type { MessageWithThought, MessageBranch } from '../components/workbench'
import { ensureSegments, patchMissingCompletedAt } from '../components/workbench'
import { getCachedSceneDefaultModel, getSceneDefaultModel } from '../utils/default-model'
import { generateId } from '../utils/format'
import { LRUCache } from '../utils/lru-cache'
import { useChatScroll } from './useChatScroll'

// 对话消息内存缓存最大容量，超过时按 LRU 淘汰，防止长时间使用积累导致内存泄漏
const MESSAGES_CACHE_MAX_SIZE = 20
// 加载状态的最短展示时间（毫秒），避免加载完成太快时 spinner 闪烁
const MIN_LOADING_DISPLAY_MS = 120

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

/**
 * 从消息当前活跃分支获取 content / thought / segments。
 * 当分支存在且活跃分支指向旧分支时，使用旧分支数据而非最新执行数据，
 * 确保切换分支后新消息的上下文与当前展示的分支内容一致。
 */
const getActiveBranchData = (m: MessageWithThought): {
  content: string
  thought?: string
  segments?: MessageWithThought['segments']
} => {
  if (m.role === 'assistant' && m.branches && m.branches.length > 0) {
    const branchIndex = m.activeBranchIndex ?? m.branches.length
    if (branchIndex < m.branches.length) {
      const branch = m.branches[branchIndex]
      return {
        content: branch.content,
        thought: branch.thought,
        segments: branch.segments,
      }
    }
  }
  return {
    content: m.content,
    thought: m.thought,
    segments: m.segments,
  }
}

/**
 * 从 segments 提取 toolCalls 信息，用于跨对话重建同对话内迭代一样的消息格式，
 * 保留 toolCalls 和 reasoning_content 以提升 KV cache 命中率。
 */
const extractToolCallsFromSegments = (m: MessageWithThought): Array<{
  id: string
  name: string
  args: any
  result?: any
  isComplete?: boolean
}> | undefined => {
  if (m.role !== 'assistant' || !m.segments) return undefined
  const toolSegs = m.segments.filter(s => s.type === 'tool_call' && s.toolName)
  if (toolSegs.length === 0) return undefined
  return toolSegs.map(s => ({
    id: s.toolCallId || s.id,
    name: s.toolName!,
    args: s.toolArgs,
    result: s.toolResult,
    isComplete: s.isToolComplete,
  }))
}

const buildEnrichedHistory = (msgs: MessageWithThought[]): Array<{
  role: string
  content: string
  images?: string[]
  reasoning_content?: string
  toolCalls?: Array<{
    id: string
    name: string
    args: any
    result?: any
    isComplete?: boolean
  }>
  toolCallId?: string
}> => {
  return msgs.map(m => {
    const branch = getActiveBranchData(m)
    return {
      role: m.role,
      content: branch.content,
      images: m.images,
      reasoning_content: branch.thought,
      toolCalls: extractToolCallsFromSegments({ ...m, segments: branch.segments }),
    }
  })
}

const _persistentMessages = new LRUCache<string, MessageWithThought[]>(MESSAGES_CACHE_MAX_SIZE)
const _persistentStreamStates = new Map<string, ConversationStreamState>()
let _persistentListenersCleanup: (() => void) | null = null
let _persistentEmployeeId: string | null = null

// 让出主线程一小段时间，让 React 有机会渲染 loading 状态
const yieldToBrowser = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const useEmployeeChat = ({ id, message }: UseEmployeeChatParams) => {
  const { t } = useTranslation()

  const TOOL_DISPLAY_NAMES: Record<string, string> = useMemo(() => ({
    calculator: t('workbench.toolNames.calculator'),
    date_time: t('workbench.toolNames.date_time'),
    shell_exec: t('workbench.toolNames.shell_exec'),
    read_file: t('workbench.toolNames.read_file'),
    write_file: t('workbench.toolNames.write_file'),
    list_dir: t('workbench.toolNames.list_dir'),
    create_folder: t('workbench.toolNames.create_folder'),
    delete_item: t('workbench.toolNames.delete_item'),
    rename_item: t('workbench.toolNames.rename_item'),
    move_item: t('workbench.toolNames.move_item'),
    copy_item: t('workbench.toolNames.copy_item'),
    get_file_info: t('workbench.toolNames.get_file_info'),
    search_files: t('workbench.toolNames.search_files'),
    system_info: t('workbench.toolNames.system_info'),
    web_search: t('workbench.toolNames.web_search'),
    web_fetch: t('workbench.toolNames.web_fetch'),
    json_utils: t('workbench.toolNames.json_utils'),
    random_utils: t('workbench.toolNames.random_utils'),
    env_vars: t('workbench.toolNames.env_vars'),
    activate_skill: t('workbench.toolNames.activate_skill'),
    read_reference: t('workbench.toolNames.read_reference'),
    ask_user: t('workbench.toolNames.ask_user'),
  }), [t])

  const [employee, setEmployee] = useState<any | null>(null)
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageWithThought[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [providers, setProviders] = useState<any[]>([])
  const [showSidePanel, setShowSidePanel] = useState(true)
  const [isComparisonMode, setIsComparisonMode] = useState(false)
  const [comparisonMessageIds, setComparisonMessageIds] = useState<string[]>([])
  const [pendingComparisonAggregation, setPendingComparisonAggregation] = useState<string[] | null>(null)
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
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>([])
  const [minimalMode, setMinimalMode] = useState(false)

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
  const [displayedCount, setDisplayedCount] = useState(20)
  const [allConversations, setAllConversations] = useState<Conversation[]>([])

  // 本地排序：按 COALESCE(last_message_at, created_at) DESC，避免每次重新排序都请求后端
  const conversations = useMemo(() => {
    const sorted = [...allConversations].sort((a, b) => {
      const aTime = a.last_message_at ?? a.created_at
      const bTime = b.last_message_at ?? b.created_at
      return bTime - aTime
    })
    return sorted.slice(0, displayedCount)
  }, [allConversations, displayedCount])

  // 本地更新 last_message_at，避免重新请求后端仅为了列表排序
  const updateConvLastMessageAt = useCallback((convId: string, timestamp: number) => {
    setAllConversations(prev => {
      let found = false
      const updated = prev.map(c => {
        if (c.id === convId) {
          found = true
          return { ...c, last_message_at: timestamp }
        }
        return c
      })
      return found ? updated : prev
    })
  }, [])
  const { messagesEndRef, chatContainerRef, handleScroll, forceScrollToBottom } = useChatScroll(messages)
  const initializedRef = useRef(false)

  const streamStatesRef = useRef<Map<string, ConversationStreamState>>(_persistentStreamStates)
  const conversationMessagesRef = useRef<LRUCache<string, MessageWithThought[]>>(_persistentMessages)
  const globalListenersCleanupRef = useRef<(() => void) | null>(_persistentListenersCleanup)
  const activeConversationIdRef = useRef<string | null>(null)
  const isStreamingRef = useRef<boolean>(false)
  const initVersionRef = useRef(0)
  const selectConvVersionRef = useRef(0)

  // 将 state 同步到 ref，避免闭包陈旧问题
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])
  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  const updateConvMessages = (convId: string, updater: (prev: MessageWithThought[]) => MessageWithThought[]) => {
    const prev = conversationMessagesRef.current.get(convId)
    const base = prev || []
    const next = updater(base)
    if (next !== base) {
      conversationMessagesRef.current.set(convId, next)
    }
    if (convId === activeConversationIdRef.current) {
      setMessages(next)
    }
  }

  const setConvMessages = (convId: string, msgs: MessageWithThought[]) => {
    conversationMessagesRef.current.set(convId, msgs)
    if (convId === activeConversationIdRef.current) {
      setMessages(msgs)
    }
  }

  // 删除对话消息缓存（用于删除/清空对话时）
  const deleteConvMessages = (convId: string) => {
    conversationMessagesRef.current.delete(convId)
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
      // 切换员工或卸载组件前，保存当前对话 ID，便于下次进入时恢复
      // 使用闭包捕获的旧 activeConvIdStorageKey，确保保存到正确的员工名下
      // （闭包中的 key 与本 effect 注册时的 id 一致，正好对应切换前的员工）
      if (activeConversationIdRef.current && activeConvIdStorageKey) {
        localStorage.setItem(activeConvIdStorageKey, activeConversationIdRef.current)
      }
      initializedRef.current = false
    }
  }, [id])

  const initEmployee = async () => {
    const version = initVersionRef.current
    try {
      const result = await window.electronAPI.employee.get(id!)
      if (version !== initVersionRef.current) return
      setEmployee(result)
      loadConversations()
      loadProviders()
    } catch {
      if (version !== initVersionRef.current) return
      setEmployee(null)
    }
  }

  useEffect(() => {
    return () => {
      const entries: [string, MessageWithThought[]][] = []
      for (const entry of conversationMessagesRef.current.entries()) {
        entries.push(entry as [string, MessageWithThought[]])
      }
      for (const [convId, msgs] of entries) {
        if (msgs && msgs.length > 0) {
          const hasStreaming = msgs.some((m: MessageWithThought) => m.isStreaming)
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

    const chunkCleanup = window.electronAPI.llm.onChunk((data: { sessionId: string; chunk?: string; chunks?: string[] }) => {
      const { sessionId } = data
      // 主进程批量发送 chunks 数组（setImmediate 合并），一次性拼接减少渲染次数；
      // 兼容旧 chunk 单字段（理论上不再出现，但保留兜底）
      const chunk = data.chunks && data.chunks.length > 0 ? data.chunks.join('') : (data.chunk || '')
      if (!chunk) return
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

    const toolCallCleanup = window.electronAPI.llm.onToolCall((data: { sessionId: string; id: string; name: string; args: any }) => {
      const { sessionId, id: toolCallId, name, args } = data
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
            toolCallId,
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

    const toolProgressCleanup = window.electronAPI.llm.onToolProgress((data: { sessionId: string; toolCallId: string; name: string; progress: any }) => {
      const { sessionId, toolCallId, name, progress } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      updateConvMessages(streamState.conversationId, (prev) =>
        prev.map((m) => {
          if (m.id !== streamState.assistantMessageId) return m
          const segs = [...(m.segments || [])]
          // 找到对应的 tool_call segment（通过 toolCallId 或 name+incomplete）
          let targetIndex = -1
          if (toolCallId) {
            targetIndex = segs.findIndex(s => s.type === 'tool_call' && s.toolCallId === toolCallId && !s.isToolComplete)
          }
          if (targetIndex === -1) {
            const lastIncompleteIndex = [...segs].reverse().findIndex(
              s => s.type === 'tool_call' && s.toolName === name && !s.isToolComplete
            )
            if (lastIncompleteIndex !== -1) {
              targetIndex = segs.length - 1 - lastIncompleteIndex
            }
          }
          if (targetIndex === -1) return m
          const existingProgress = segs[targetIndex].toolProgress || []
          segs[targetIndex] = {
            ...segs[targetIndex],
            toolProgress: [...existingProgress, progress],
          }
          return { ...m, segments: segs }
        })
      )
    })

    const doneCleanup = window.electronAPI.llm.onDone((data: { sessionId: string; metadata?: any }) => {
      const { sessionId, metadata } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      const doneLastMsgTime = Math.floor(Date.now() / 1000)

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
          last_message_at: doneLastMsgTime,
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
        isStreamingRef.current = false
        if (activeConvIdStorageKey && localStorage.getItem(activeConvIdStorageKey) === streamState.conversationId) {
          localStorage.removeItem(activeConvIdStorageKey)
        }
        // 对话结束后更新 last_message_at 触发本地排序
        updateConvLastMessageAt(streamState.conversationId, doneLastMsgTime)
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
        isStreamingRef.current = false
        if (activeConvIdStorageKey && localStorage.getItem(activeConvIdStorageKey) === streamState.conversationId) {
          localStorage.removeItem(activeConvIdStorageKey)
        }
        // 对话出错后更新 last_message_at 触发本地排序
        updateConvLastMessageAt(streamState.conversationId, Math.floor(Date.now() / 1000))
      }
    })

    const cleanup = () => {
      chunkCleanup()
      thoughtCleanup()
      toolCallCleanup()
      toolResultCleanup()
      toolProgressCleanup()
      doneCleanup()
      errorCleanup()
    }
    _persistentListenersCleanup = cleanup
    globalListenersCleanupRef.current = cleanup
    // 依赖仅 t：listeners 通过 ref（streamStatesRef/activeConversationIdRef）读取运行时状态，
    // 无需在切换对话时重建（原 deps 含 activeConversationId 导致每次切换都 teardown+setup 7 个监听器）
  }, [t])

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

  const loadConversations = async () => {
    try {
      const result = await window.electronAPI.conversation.list({ employee_id: id! })
      setAllConversations(result)

      if (!initializedRef.current) {
        initializedRef.current = true
        const savedConvId = activeConvIdStorageKey ? localStorage.getItem(activeConvIdStorageKey) : null
        if (result.length > 0) {
          const targetConv = savedConvId ? result.find((c: Conversation) => c.id === savedConvId) : null
          selectConversation(targetConv ? savedConvId! : result[0].id)
        } else {
          await startNewConversation()
        }
      }
    } catch (e) {
      console.error('[Frontend] 加载对话列表失败', e)
    }
  }

  const refreshConversationList = async () => {
    try {
      const result = await window.electronAPI.conversation.list({ employee_id: id! })
      setAllConversations(result)
    } catch {
      // 静默失败，不影响用户体验
    }
  }

  const loadMoreConversations = () => {
    setDisplayedCount(prev => prev + 20)
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
        minimal_mode: minimalMode,
      })
      const convId = (result as Conversation).id
      setActiveConversationId(convId)
      activeConversationIdRef.current = convId
      setMessages([])
      setConvMessages(convId, [])
      forceScrollToBottom()

      // 从后端刷新列表以获取正确的排序
      refreshConversationList()

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

  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null)

  const selectConversation = async (convId: string) => {
    selectConvVersionRef.current++
    const version = selectConvVersionRef.current
    setActiveConversationId(convId)
    activeConversationIdRef.current = convId

    setIsComparisonMode(false)
    setComparisonMessageIds([])

    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === convId && s.isStreaming)
    setIsStreaming(hasActiveStream)
    isStreamingRef.current = hasActiveStream

    // 命中 LRU 缓存：同样先展示 loading 过渡，避免 React 一次性 mount 大量 MessageBubble 卡死
    const cachedMsgs = conversationMessagesRef.current.get(convId)
    if (cachedMsgs !== undefined) {
      const cachedLoadingStart = Date.now()
      setLoadingConversationId(convId)
      setMessages([])

      // 让出主线程，让 spinner 先渲染出来再切入实际内容
      await yieldToBrowser()
      if (version !== selectConvVersionRef.current) {
        setLoadingConversationId(prev => prev === convId ? null : prev)
        return
      }

      // 保证 loading 至少展示 MIN_LOADING_DISPLAY_MS，避免一闪而过
      const cachedElapsed = Date.now() - cachedLoadingStart
      if (cachedElapsed < MIN_LOADING_DISPLAY_MS) {
        await new Promise(resolve => setTimeout(resolve, MIN_LOADING_DISPLAY_MS - cachedElapsed))
        if (version !== selectConvVersionRef.current) {
          setLoadingConversationId(prev => prev === convId ? null : prev)
          return
        }
      }

      setMessages(cachedMsgs)
      setLoadingConversationId(null)
      const convData = allConversations.find(c => c.id === convId)
      if (convData) {
        setMinimalMode(!!(convData as any).minimal_mode)
      }
      return
    }

    // 缓存未命中：先切换 UI 状态，再异步加载并显示 loading
    const loadingStart = Date.now()
    setLoadingConversationId(convId)
    setMessages([])

    let fullConv: any = null
    try {
      fullConv = await window.electronAPI.conversation.get(convId)
    } catch {
      if (version !== selectConvVersionRef.current) {
        setLoadingConversationId(prev => prev === convId ? null : prev)
        return
      }
      conversationMessagesRef.current.set(convId, [])
      setLoadingConversationId(null)
      const convData = allConversations.find(c => c.id === convId)
      if (convData) {
        setMinimalMode(!!(convData as any).minimal_mode)
      }
      return
    }

    if (version !== selectConvVersionRef.current) {
      setLoadingConversationId(prev => prev === convId ? null : prev)
      return
    }

    if (fullConv) {
      setMinimalMode(!!fullConv.minimal_mode)
    }

    // 让出主线程，让 loading 状态先渲染出来
    await yieldToBrowser()

    if (version !== selectConvVersionRef.current) {
      setLoadingConversationId(prev => prev === convId ? null : prev)
      return
    }

    // 解析 JSON（这一步对长对话是耗时大头）
    let parsedMsgs: MessageWithThought[] = []
    try {
      parsedMsgs = (JSON.parse(fullConv?.messages_json || '[]') as MessageWithThought[])
    } catch {
      parsedMsgs = []
    }

    // 再次让出主线程，避免后续处理阻塞渲染
    await yieldToBrowser()

    if (version !== selectConvVersionRef.current) {
      setLoadingConversationId(prev => prev === convId ? null : prev)
      return
    }

    // 构造 segments / 补齐 completedAt
    const msgs = parsedMsgs.map(ensureSegments).map(patchMissingCompletedAt)

    if (msgs.some((m, i) => m !== parsedMsgs[i])) {
      window.electronAPI.conversation.update({
        id: convId,
        messages_json: JSON.stringify(msgs),
        message_count: msgs.length,
      }).catch(() => {})
    }

    // 缓存最终处理后的消息，LRU 自动淘汰冷数据
    conversationMessagesRef.current.set(convId, msgs)

    if (version !== selectConvVersionRef.current) {
      setLoadingConversationId(prev => prev === convId ? null : prev)
      return
    }

    // 保证 loading 至少展示 MIN_LOADING_DISPLAY_MS，避免一闪而过
    const elapsed = Date.now() - loadingStart
    if (elapsed < MIN_LOADING_DISPLAY_MS) {
      await new Promise(resolve => setTimeout(resolve, MIN_LOADING_DISPLAY_MS - elapsed))
      if (version !== selectConvVersionRef.current) {
        setLoadingConversationId(prev => prev === convId ? null : prev)
        return
      }
    }

    setMessages(msgs)
    setLoadingConversationId(null)

    const convData = allConversations.find(c => c.id === convId)
    if (convData) {
      setMinimalMode(!!(convData as any).minimal_mode)
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
      deleteConvMessages(convId)

      await window.electronAPI.conversation.delete(convId)
      setAllConversations((prev) => prev.filter((c) => c.id !== convId))
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
        deleteConvMessages(convId)
        await window.electronAPI.conversation.delete(convId)
      }
      setAllConversations((prev) => prev.filter((c) => !convIds.includes(c.id)))
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
    const targetConvId = convId || activeConversationIdRef.current
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

    // 用户发消息时更新 last_message_at，触发列表重新排序
    const lastMsgTime = Math.floor(Date.now() / 1000)
    window.electronAPI.conversation.update({
      id: targetConvId,
      last_message_at: lastMsgTime,
    }).catch(() => {})
    updateConvLastMessageAt(targetConvId, lastMsgTime)

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

        if (targetConvId === activeConversationIdRef.current) {
          setIsStreaming(true)
          isStreamingRef.current = true
        }

        try {
          const messageHistory = buildEnrichedHistory(
            updatedMessagesRef
          )

          const result = await window.electronAPI.llm.employeeChatStream({
            employee_id: id!,
            provider_id: sel.providerId,
            model_id: sel.modelId,
            messages: messageHistory,
            options: { temperature: 0.3 },
            use_skills: true,
            collection_ids: selectedCollectionIds,
            enable_thinking: enableThinking,
            conversation_id: targetConvId,
            minimal_mode: minimalMode,
          })

          if (result?.sessionId) {
            streamStatesRef.current.set(result.sessionId, streamState)
          }
        } catch {
          streamState.isStreaming = false
          const anyStreaming = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === targetConvId && s.isStreaming)
          if (!anyStreaming) {
            setIsStreaming(false)
            isStreamingRef.current = false
          }
        }
      }

      if (targetConvId === activeConversationIdRef.current && assistantIds.length > 0) {
        setIsComparisonMode(true)
        setComparisonMessageIds(assistantIds)
      }
    } else {
      const providerId = selectedLlmProviderId || providers.find((p: any) => p.is_default)?.id
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

      if (targetConvId === activeConversationIdRef.current) {
        setIsStreaming(true)
        isStreamingRef.current = true
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
        const messageHistory = buildEnrichedHistory(updatedMessagesRef)

        const result = await window.electronAPI.llm.employeeChatStream({
          employee_id: id!,
          provider_id: providerId,
          model_id: selectedLlmModelId || undefined,
          messages: messageHistory,
          options: { temperature: 0.3 },
          use_skills: true,
          collection_ids: selectedCollectionIds,
          enable_thinking: enableThinking,
          conversation_id: targetConvId,
          minimal_mode: minimalMode,
        })

        if (result?.sessionId) {
          streamStatesRef.current.set(result.sessionId, streamState)
        }
      } catch {
        streamState.isStreaming = false
        setIsStreaming(false)
        isStreamingRef.current = false
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
    const convId = activeConversationIdRef.current
    if (!convId) return
    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === convId && s.isStreaming)
    if (hasActiveStream) return
    try {
      const currentMsgs = conversationMessagesRef.current.get(convId) || []
      const msgIndex = currentMsgs.findIndex((m) => m.id === msgId)
      const newMessages = currentMsgs.filter((m) => m.id !== msgId)
      if (msgIndex !== -1 && currentMsgs[msgIndex].role === 'user') {
        const followingAssistant = currentMsgs[msgIndex + 1]
        if (followingAssistant && followingAssistant.role === 'assistant') {
          newMessages.splice(newMessages.indexOf(followingAssistant), 1)
        }
      }
      setConvMessages(convId, newMessages)
      await window.electronAPI.conversation.update({
        id: convId,
        messages_json: JSON.stringify(newMessages),
        message_count: newMessages.length,
      })
      message.success(t('common.deleted'))
    } catch {
      message.error(t('common.deleteFailed'))
    }
  }

  const handleRegenerate = async (msgId: string) => {
    const convId = activeConversationIdRef.current
    if (!convId) return
    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === convId && s.isStreaming)
    if (hasActiveStream) return
    const currentMsgs = conversationMessagesRef.current.get(convId) || []
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
    setConvMessages(convId, newMessages)
    await window.electronAPI.conversation.update({
      id: convId,
      messages_json: JSON.stringify(newMessages),
      message_count: newMessages.length,
      last_message_at: Math.floor(Date.now() / 1000),
    })

    const providerId = selectedLlmProviderId || providers.find((p: any) => p.is_default)?.id
    if (!providerId) {
      message.warning(t('workbench.noLlmProvider'))
      return
    }

    setupGlobalListeners()
    setIsStreaming(true)
    isStreamingRef.current = true

    const streamState: ConversationStreamState = {
      isStreaming: true,
      conversationId: convId,
      messages: newMessages.slice(0, msgIndex),
      assistantMessageId: msgId,
      segCounter: 0,
      toolCallCounter: 0,
      cleanupFns: [],
    }

    try {
      const messageHistory = buildEnrichedHistory(newMessages.slice(0, msgIndex))

      const result = await window.electronAPI.llm.employeeChatStream({
        employee_id: id!,
        provider_id: providerId,
        model_id: selectedLlmModelId || undefined,
        messages: messageHistory,
        options: { temperature: 0.3 },
        use_skills: true,
        collection_ids: selectedCollectionIds,
        enable_thinking: enableThinking,
        conversation_id: convId,
        minimal_mode: minimalMode,
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
      isStreamingRef.current = false
    }
  }

  const handleSwitchModelRegenerate = async (msgId: string, providerId: string, modelId: string) => {
    const convId = activeConversationIdRef.current
    if (!convId) return
    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === convId && s.isStreaming)
    if (hasActiveStream) return
    if (!providerId || !modelId) return

    const currentMsgs = conversationMessagesRef.current.get(convId) || []
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
    setConvMessages(convId, newMessages)
    await window.electronAPI.conversation.update({
      id: convId,
      messages_json: JSON.stringify(newMessages),
      message_count: newMessages.length,
      last_message_at: Math.floor(Date.now() / 1000),
    })

    setupGlobalListeners()
    setIsStreaming(true)
    isStreamingRef.current = true

    const streamState: ConversationStreamState = {
      isStreaming: true,
      conversationId: convId,
      messages: newMessages.slice(0, msgIndex),
      assistantMessageId: msgId,
      segCounter: 0,
      toolCallCounter: 0,
      cleanupFns: [],
    }

    try {
      const messageHistory = buildEnrichedHistory(newMessages.slice(0, msgIndex))

      const result = await window.electronAPI.llm.employeeChatStream({
        employee_id: id!,
        provider_id: providerId,
        model_id: modelId,
        messages: messageHistory,
        options: { temperature: 0.3 },
        use_skills: true,
        collection_ids: selectedCollectionIds,
        enable_thinking: enableThinking,
        conversation_id: convId,
        minimal_mode: minimalMode,
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
      isStreamingRef.current = false
    }
  }

  const handleEditAndResubmit = async (msgId: string, newContent: string) => {
    const convId = activeConversationIdRef.current
    if (!convId) return
    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === convId && s.isStreaming)
    if (hasActiveStream) return
    if (!newContent.trim()) return

    const currentMsgs = conversationMessagesRef.current.get(convId) || []
    const msgIndex = currentMsgs.findIndex((m) => m.id === msgId)
    if (msgIndex === -1) return

    const targetMsg = currentMsgs[msgIndex]

    // 编辑用户消息内容
    const editedUserMsg: MessageWithThought = {
      ...targetMsg,
      content: newContent.trim(),
      timestamp: Date.now(),
    }

    // 检查紧随其后的 assistant 消息
    const assistantMsgIndex = msgIndex + 1
    const existingAssistantMsg = currentMsgs[assistantMsgIndex]
    let assistantMessageId: string

    const newMessages = [...currentMsgs]
    newMessages[msgIndex] = editedUserMsg

    if (existingAssistantMsg && existingAssistantMsg.role === 'assistant') {
      // 将当前 assistant 回复保存为分支，重置为空流式状态以重新生成
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
      newMessages[assistantMsgIndex] = {
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
    } else {
      // 没有 assistant 消息，创建新的
      assistantMessageId = `msg_${generateId()}`
      const assistantMessage: MessageWithThought = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
        segments: [],
      }
      // 插入到编辑的用户消息之后
      newMessages.splice(assistantMsgIndex, 0, assistantMessage)
    }

    setConvMessages(convId, newMessages)
    await window.electronAPI.conversation.update({
      id: convId,
      messages_json: JSON.stringify(newMessages),
      message_count: newMessages.length,
      last_message_at: Math.floor(Date.now() / 1000),
    })

    const providerId = selectedLlmProviderId || providers.find((p: any) => p.is_default)?.id
    if (!providerId) {
      message.warning(t('workbench.noLlmProvider'))
      return
    }

    setupGlobalListeners()
    setIsStreaming(true)
    isStreamingRef.current = true

    // 上下文只使用被编辑消息及其上方的消息（不包含 assistant 回复及之后的消息）
    const contextMessages = newMessages.slice(0, assistantMsgIndex)

    const streamState: ConversationStreamState = {
      isStreaming: true,
      conversationId: convId,
      messages: contextMessages,
      assistantMessageId,
      segCounter: 0,
      toolCallCounter: 0,
      cleanupFns: [],
    }

    try {
      const messageHistory = buildEnrichedHistory(contextMessages)

      const result = await window.electronAPI.llm.employeeChatStream({
        employee_id: id!,
        provider_id: providerId,
        model_id: selectedLlmModelId || undefined,
        messages: messageHistory,
        options: { temperature: 0.3 },
        use_skills: true,
        collection_ids: selectedCollectionIds,
        enable_thinking: enableThinking,
        conversation_id: convId,
        minimal_mode: minimalMode,
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
      isStreamingRef.current = false
    }
  }

  const handleCommand = (command: string) => {
    if (command === '/clear') {
      const convId = activeConversationIdRef.current
      if (convId) {
        setConvMessages(convId, [])
        window.electronAPI.conversation.update({
          id: convId,
          messages_json: JSON.stringify([]),
          message_count: 0,
        }).catch(() => {})
      }
    } else if (command === '/new') {
      startNewConversation()
    }
  }

  const handleToggleMinimalMode = useCallback((enabled: boolean) => {
    const convId = activeConversationIdRef.current
    if (!convId) return
    const currentMsgs = conversationMessagesRef.current.get(convId) || []
    if (currentMsgs.length > 0) return
    setMinimalMode(enabled)
    window.electronAPI.conversation.update({
      id: convId,
      minimal_mode: enabled,
    }).catch(() => {})
  }, [])

  const handleSwitchBranch = (msgId: string, branchIndex: number) => {
    const convId = activeConversationIdRef.current
    if (!convId) return
    updateConvMessages(convId, (prev) => {
      const newMessages = prev.map(m => {
        if (m.id !== msgId) return m
        const branches = m.branches || []
        const maxIndex = branches.length
        if (branchIndex < 0 || branchIndex > maxIndex) return m
        return { ...m, activeBranchIndex: branchIndex }
      })
      window.electronAPI.conversation.update({
        id: convId,
        messages_json: JSON.stringify(newMessages),
        message_count: newMessages.length,
      }).catch(() => {})
      return newMessages
    })
  }

  const aggregateComparisonMessages = (convId: string, msgIds: string[]) => {
    const currentMsgs = conversationMessagesRef.current.get(convId) || []
    const comparisonMsgs = msgIds
      .map(id => currentMsgs.find(m => m.id === id))
      .filter((m): m is MessageWithThought => !!m)

    if (comparisonMsgs.length === 0) return

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

    const otherIds = new Set(msgIds.slice(1))
    const newMessages = currentMsgs
      .filter(m => !otherIds.has(m.id))
      .map(m => m.id === targetMsg.id ? aggregatedMsg : m)

    setConvMessages(convId, newMessages)
    window.electronAPI.conversation.update({
      id: convId,
      messages_json: JSON.stringify(newMessages),
      message_count: newMessages.length,
    }).catch(() => {})
  }

  const handleCloseComparison = () => {
    const convId = activeConversationIdRef.current
    if (!convId) return
    const currentMsgs = conversationMessagesRef.current.get(convId) || []

    const firstId = comparisonMessageIds[0]
    const firstMsg = currentMsgs.find(m => m.id === firstId)

    if (firstMsg?._comparisonBranchMsgs) {
      updateConvMessages(convId, (prev) =>
        prev.map(m => {
          if (m.id !== firstId) return m
          const { _comparisonBranchMsgs, ...rest } = m
          return rest as MessageWithThought
        })
      )
      setIsComparisonMode(false)
      setComparisonMessageIds([])
      return
    }

    const hasStreaming = comparisonMessageIds.some(id => {
      const msg = currentMsgs.find(m => m.id === id)
      return msg?.isStreaming
    })

    if (hasStreaming) {
      setIsComparisonMode(false)
      setComparisonMessageIds([])
      setPendingComparisonAggregation(comparisonMessageIds)
      return
    }

    aggregateComparisonMessages(convId, comparisonMessageIds)

    setIsComparisonMode(false)
    setComparisonMessageIds([])
  }

  useEffect(() => {
    if (!pendingComparisonAggregation || isStreaming) return
    const ids = pendingComparisonAggregation
    setPendingComparisonAggregation(null)
    const convId = activeConversationIdRef.current
    if (!convId) return
    aggregateComparisonMessages(convId, ids)
  }, [isStreaming, pendingComparisonAggregation])

  const handleOpenComparison = (msgId: string) => {
    const convId = activeConversationIdRef.current
    if (!convId) return
    const currentMsgs = conversationMessagesRef.current.get(convId) || []
    const targetMsg = currentMsgs.find(m => m.id === msgId)
    if (!targetMsg || !targetMsg.branches || targetMsg.branches.length === 0) return

    const hasComparisonBranches = targetMsg.branches.some(
      b => b.comparisonProviderId || b.comparisonModelId
    ) || (targetMsg.comparisonProviderId || targetMsg.comparisonModelId)

    if (!hasComparisonBranches) return

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

    updateConvMessages(convId, () => {
      const msgs = conversationMessagesRef.current.get(convId) || []
      return msgs.map(m => {
        if (m.id !== msgId) return m
        return { ...m, _comparisonBranchMsgs: allBranchMsgs }
      })
    })
  }

  const getComparisonMessages = (): MessageWithThought[] => {
    const convId = activeConversationIdRef.current
    if (!convId || comparisonMessageIds.length === 0) return []
    const currentMsgs = conversationMessagesRef.current.get(convId) || []

    const firstId = comparisonMessageIds[0]
    const firstMsg = currentMsgs.find(m => m.id === firstId)
    if (firstMsg?._comparisonBranchMsgs) {
      return firstMsg._comparisonBranchMsgs as MessageWithThought[]
    }

    return comparisonMessageIds
      .map(id => currentMsgs.find(m => m.id === id))
      .filter((m): m is MessageWithThought => !!m)
  }

  const handleExportConversation = (convId?: string) => {
    const targetConvId = convId || activeConversationIdRef.current
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
    const convId = activeConversationIdRef.current
    if (!convId) return
    const activeStreamEntries = Array.from(streamStatesRef.current.entries()).filter(
      ([_, s]) => s.conversationId === convId && s.isStreaming
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
    isStreamingRef.current = false
    if (activeConvIdStorageKey && localStorage.getItem(activeConvIdStorageKey) === convId) {
      localStorage.removeItem(activeConvIdStorageKey)
    }
    updateConvMessages(convId, (prev) =>
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
    const currentMsgs = conversationMessagesRef.current.get(convId)
    if (currentMsgs) {
      window.electronAPI.conversation.update({
        id: convId,
        messages_json: JSON.stringify(currentMsgs),
        message_count: currentMsgs.length,
      }).catch(() => {})
    }
  }

  const getToolDisplayName = (name: string) => TOOL_DISPLAY_NAMES[name] || name

  const handleToggleSegment = (msgId: string, segId: string) => {
    const convId = activeConversationIdRef.current
    if (!convId) return

    const branchMatch = msgId.match(/^(.+)_branch_(\d+)$/)
    if (branchMatch) {
      const originalMsgId = branchMatch[1]
      const branchIndex = parseInt(branchMatch[2], 10)
      updateConvMessages(convId, (prev) => prev.map(m => {
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

    updateConvMessages(convId, (prev) => prev.map(m => {
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

  const isConversationStreaming = useCallback((convId: string) => {
    return Array.from(streamStatesRef.current.values()).some(s => s.conversationId === convId && s.isStreaming)
  }, [])

  return {
    employee,
    conversations,
    allConversations,
    activeConversationId,
    messages,
    isStreaming,
    isCreatingConversation,
    loadingConversationId,
    providers,
    selectedLlmProviderId,
    selectedLlmModelId,
    handleLlmChange,
    enableThinking,
    setEnableThinking,
    selectedCollectionIds,
    setSelectedCollectionIds,
    minimalMode,
    handleToggleMinimalMode,
    showSidePanel,
    setShowSidePanel,
    isComparisonMode,
    comparisonMessageIds,
    handleCloseComparison,
    handleOpenComparison,
    getComparisonMessages,
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
