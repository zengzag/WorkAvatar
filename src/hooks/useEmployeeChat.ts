import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { Conversation } from '../types'
import type { MessageWithThought, MessageBranch } from '../components/workbench'
import { ensureSegments, patchMissingCompletedAt } from '../components/workbench'
import { generateId } from '../utils/format'
import { LRUCache } from '../utils/lru-cache'
import { useChatScroll } from './useChatScroll'
import { useLlmSettings } from './useLlmSettings'
import { getSceneDefaultModel } from '../utils/default-model'
import {
  type ConversationStreamState,
  MIN_LOADING_DISPLAY_MS,
  CONVERSATION_PAGE_SIZE,
  SCROLL_BOTTOM_THRESHOLD_PX,
  DEFAULT_TEMPERATURE,
  buildEnrichedHistory,
  createPersistentMessagesCache,
} from './chat-helpers'
import { useStreamListeners, getPersistentListenersCleanup, setPersistentListenersCleanup, getPersistentEmployeeId, setPersistentEmployeeId } from './useStreamListeners'

interface UseEmployeeChatParams {
  id: string | undefined
  message: ReturnType<typeof import('antd').App.useApp>['message']
}

// 按 employeeId 分组的消息缓存：切换员工时不再清空旧员工缓存，
// 切回时可直接命中内存缓存，避免重新 IPC + JSON.parse。
// Map<employeeId, LRUCache<convId, messages>>
const _persistentMessagesByEmployee = new Map<string, LRUCache<string, MessageWithThought[]>>()
const _persistentStreamStates = new Map<string, ConversationStreamState>()

// 按 employeeId 缓存员工元数据和对话列表：切回时优先从缓存恢复 UI（秒开），
// 后台 IPC 完成后再更新最新数据。这是"切回秒开"的关键。
const _persistentEmployeeData = new Map<string, any>()
const _persistentConvList = new Map<string, Conversation[]>()

// 按 employeeId 缓存当前活动对话 ID：主 tab 切换（如 资料库→数字员工）后，
// EmployeeWorkbench 完全卸载再重新挂载，activeConversationId 状态丢失。
// 有了此缓存，initEmployee 可以直接恢复上次的对话，避免 selectConversation IPC。
const _persistentActiveConvId = new Map<string, string>()

// 按 conversationId 缓存输入框草稿：切换对话/员工时保留各自草稿，切回时恢复
const _persistentDrafts = new Map<string, string>()

// 获取或创建指定员工的消息缓存
const getOrCreateEmployeeMessagesCache = (employeeId: string): LRUCache<string, MessageWithThought[]> => {
  let cache = _persistentMessagesByEmployee.get(employeeId)
  if (!cache) {
    cache = createPersistentMessagesCache()
    _persistentMessagesByEmployee.set(employeeId, cache)
  }
  return cache
}

const useEmployeeChat = ({ id, message }: UseEmployeeChatParams) => {
  const { t } = useTranslation()

  const TOOL_DISPLAY_NAMES: Record<string, string> = useMemo(() => ({
    calculator: t('workbench.toolNames.calculator'),
    date_time: t('workbench.toolNames.date_time'),
    shell_exec: t('workbench.toolNames.shell_exec'),
    file: t('workbench.toolNames.file'),
    system_info: t('workbench.toolNames.system_info'),
    web_search: t('workbench.toolNames.web_search'),
    web_fetch: t('workbench.toolNames.web_fetch'),
    env_vars: t('workbench.toolNames.env_vars'),
    activate_skill: t('workbench.toolNames.activate_skill'),
    read_reference: t('workbench.toolNames.read_reference'),
    ask_user: t('workbench.toolNames.ask_user'),
    calendar_event_list: t('workbench.toolNames.calendar_event_list'),
    calendar_event_create: t('workbench.toolNames.calendar_event_create'),
    calendar_event_update: t('workbench.toolNames.calendar_event_update'),
    calendar_event_delete: t('workbench.toolNames.calendar_event_delete'),
    calendar_todo_list: t('workbench.toolNames.calendar_todo_list'),
    calendar_todo_create: t('workbench.toolNames.calendar_todo_create'),
    calendar_todo_update: t('workbench.toolNames.calendar_todo_update'),
    calendar_todo_delete: t('workbench.toolNames.calendar_todo_delete'),
    calendar_todo_complete: t('workbench.toolNames.calendar_todo_complete'),
    calendar_todo_stats: t('workbench.toolNames.calendar_todo_stats'),
  }), [t])

  const [employee, setEmployee] = useState<any | null>(null)
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [pendingHighPermission, setPendingHighPermission] = useState(false)
  const [messages, setMessages] = useState<MessageWithThought[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [inputDraft, setInputDraftState] = useState('')
  const [showSidePanel, setShowSidePanel] = useState(true)
  const [isComparisonMode, setIsComparisonMode] = useState(false)
  const [comparisonMessageIds, setComparisonMessageIds] = useState<string[]>([])
  const [pendingComparisonAggregation, setPendingComparisonAggregation] = useState<string[] | null>(null)

  const {
    providers,
    selectedLlmProviderId,
    selectedLlmModelId,
    handleLlmChange,
    enableThinking,
    setEnableThinking,
    selectedCollectionIds,
    setSelectedCollectionIds,
    minimalMode,
    setMinimalMode,
    loadProviders,
  } = useLlmSettings(id)

  const activeConvIdStorageKey = id ? `employeeWorkbench:activeConvId:${id}` : null

  const [editingConversationId, setEditingConversationId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [displayedCount, setDisplayedCount] = useState(CONVERSATION_PAGE_SIZE)
  const [allConversations, setAllConversations] = useState<Conversation[]>([])

  const conversations = useMemo(() => {
    const sorted = [...allConversations].sort((a, b) => {
      const aTime = a.last_message_at ?? a.created_at
      const bTime = b.last_message_at ?? b.created_at
      return bTime - aTime
    })
    return sorted.slice(0, displayedCount)
  }, [allConversations, displayedCount])

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
  // 初始用临时空 cache，useEffect 中按当前员工 id 切换到对应 cache
  const conversationMessagesRef = useRef<LRUCache<string, MessageWithThought[]>>(createPersistentMessagesCache())
  const activeConversationIdRef = useRef<string | null>(null)
  const isStreamingRef = useRef<boolean>(false)
  const initVersionRef = useRef(0)
  const selectConvVersionRef = useRef(0)
  // 新建对话后延迟发送的 setTimeout 句柄，组件卸载时清理避免 setState-after-unmount（B#7）
  const pendingSendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const deleteConvMessages = (convId: string) => {
    conversationMessagesRef.current.delete(convId)
  }

  useEffect(() => {
    if (id) {
      // 切换 conversationMessagesRef 指向当前员工的消息缓存
      // 旧员工的缓存保留在 _persistentMessagesByEmployee 中，切回时直接命中
      conversationMessagesRef.current = getOrCreateEmployeeMessagesCache(id)

      if (getPersistentEmployeeId() && getPersistentEmployeeId() !== id) {
        // 切换员工：重置可见状态，避免上一个员工的对话界面残留
        setEmployee(null)
        setMessages([])
        setActiveConversationId(null)
        activeConversationIdRef.current = null
        setIsStreaming(false)
        isStreamingRef.current = false
        setAllConversations([])
        setLoadingConversationId(null)
        setInputDraftState('')
        // 重置 pendingMessage 与延迟发送，避免跨员工串扰
        setPendingMessage(null)
        setPendingHighPermission(false)
        if (pendingSendTimeoutRef.current) {
          clearTimeout(pendingSendTimeoutRef.current)
          pendingSendTimeoutRef.current = null
        }
        // 重置 initializedRef，让新员工走完整的 selectConversation/startNewConversation 流程
        initializedRef.current = false

        const cleanup = getPersistentListenersCleanup()
        if (cleanup) {
          cleanup()
          setPersistentListenersCleanup(null)
        }
        // 仅清空流式状态映射（流式任务已通过 cleanup 关闭）
        // 不再清空 _persistentMessagesByEmployee，保留各员工的消息缓存
        _persistentStreamStates.clear()
      }
      setPersistentEmployeeId(id)
      initVersionRef.current++
      initEmployee()
    }
    return () => {
      // 保存当前活动对话 ID 到缓存，供下次 initEmployee 直接恢复
      if (activeConversationIdRef.current) {
        _persistentActiveConvId.set(id!, activeConversationIdRef.current)
        if (activeConvIdStorageKey) {
          localStorage.setItem(activeConvIdStorageKey, activeConversationIdRef.current)
        }
      }
    }
  }, [id])

  const initEmployee = async () => {
    const version = initVersionRef.current
    try {
      // === 增量式加载策略 ===
      // 核心原则：先让 UI 响应（显示框架），再填充数据（显示内容）
      // 避免同步恢复大量缓存数据导致 React 渲染阻塞、UI 冻结

      const cachedEmployee = _persistentEmployeeData.get(id!)
      const cachedConvList = _persistentConvList.get(id!)
      const cachedActiveConvId = _persistentActiveConvId.get(id!)

      // 阶段 1：立即恢复轻量状态（侧边栏可见、员工信息可见）
      if (cachedEmployee) setEmployee(cachedEmployee)
      if (cachedConvList) setAllConversations(cachedConvList)

      const hasFullCache = cachedEmployee && cachedConvList && cachedActiveConvId

      if (hasFullCache && !initializedRef.current) {
        // 缓存完整：先设 loading（显示转圈圈），再异步恢复消息
        initializedRef.current = true
        setActiveConversationId(cachedActiveConvId)
        activeConversationIdRef.current = cachedActiveConvId
        setLoadingConversationId(cachedActiveConvId)
        // 恢复该对话的草稿
        setInputDraftState(_persistentDrafts.get(cachedActiveConvId) || '')
        const convData = cachedConvList.find((c: Conversation) => c.id === cachedActiveConvId)
        if (convData) {
          setMinimalMode(!!(convData as any).minimal_mode)
        }
        // 让 UI 先渲染（侧边栏 + 转圈圈），下一个微任务再填充消息
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        if (version !== initVersionRef.current) {
          // 版本不匹配：新一次 initEmployee 已启动，清除本次 loading 避免永久转圈
          setLoadingConversationId(prev => prev === cachedActiveConvId ? null : prev)
          return
        }

        const msgsCache = conversationMessagesRef.current
        const cachedMsgs = msgsCache.get(cachedActiveConvId)
        if (cachedMsgs !== undefined) {
          // 缓存命中：从内存恢复，无需 IPC
          setMessages(cachedMsgs)
          setLoadingConversationId(null)
          const hasActiveStream = Array.from(streamStatesRef.current.values())
            .some(s => s.conversationId === cachedActiveConvId && s.isStreaming)
          setIsStreaming(hasActiveStream)
          isStreamingRef.current = hasActiveStream
        } else {
          // 消息未缓存：走 selectConversation 加载（已有 loading 状态）
          selectConversation(cachedActiveConvId)
        }
      }

      // 阶段 2：后台静默刷新最新数据
      const [result, convList] = await Promise.all([
        window.electronAPI.employee.get(id!),
        window.electronAPI.conversation.list({ employee_id: id! })
      ])
      if (version !== initVersionRef.current) {
        setLoadingConversationId(prev => prev === cachedActiveConvId ? null : prev)
        return
      }

      _persistentEmployeeData.set(id!, result)
      _persistentConvList.set(id!, convList)
      setEmployee(result)
      setAllConversations(convList)

      loadProviders()

      // 首次初始化（无缓存）：选择对话
      if (!hasFullCache && !initializedRef.current) {
        initializedRef.current = true
        const savedConvId = activeConvIdStorageKey ? localStorage.getItem(activeConvIdStorageKey) : null
        if (convList.length > 0) {
          const targetConv = savedConvId ? convList.find((c: Conversation) => c.id === savedConvId) : null
          selectConversation(targetConv ? savedConvId! : convList[0].id)
        } else {
          await startNewConversation()
        }
      }
    } catch {
      if (version !== initVersionRef.current) {
        // 版本不匹配时也要清除 loading
        setLoadingConversationId(null)
        return
      }
      setEmployee(null)
      setLoadingConversationId(null)
    }
  }

  useEffect(() => {
    return () => {
      // 清理未执行的延迟发送，避免卸载后触发 setState（B#7）
      if (pendingSendTimeoutRef.current) {
        clearTimeout(pendingSendTimeoutRef.current)
        pendingSendTimeoutRef.current = null
      }
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

  const { setupGlobalListeners } = useStreamListeners({
    streamStatesRef,
    conversationMessagesRef,
    activeConversationIdRef,
    activeConvIdStorageKey,
    updateConvMessages,
    setIsStreaming,
    isStreamingRef,
    updateConvLastMessageAt,
  })

  const setupGlobalListenersRef = useRef(setupGlobalListeners)
  setupGlobalListenersRef.current = setupGlobalListeners

  useEffect(() => {
    const savedConvId = activeConvIdStorageKey ? localStorage.getItem(activeConvIdStorageKey) : null
    if (!savedConvId) return

    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === savedConvId && s.isStreaming)

    // 仅更新 ref 和恢复流式监听器，不调用 setMessages/setActiveConversationId
    // initEmployee 是消息恢复的唯一入口，避免双轮渲染
    activeConversationIdRef.current = savedConvId

    if (hasActiveStream || getPersistentListenersCleanup()) {
      setupGlobalListenersRef.current()
    }

    if (hasActiveStream) {
      setIsStreaming(true)
    }
  }, [])

  const refreshConversationList = async () => {
    try {
      const result = await window.electronAPI.conversation.list({ employee_id: id! })
      if (id) _persistentConvList.set(id, result)
      setAllConversations(result)
    } catch {
    }
  }

  const loadMoreConversations = () => {
    setDisplayedCount(prev => prev + CONVERSATION_PAGE_SIZE)
  }

  const handleConversationListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    if (target.scrollHeight - target.scrollTop <= target.clientHeight + SCROLL_BOTTOM_THRESHOLD_PX) {
      if (conversations.length < allConversations.length) {
        loadMoreConversations()
      }
    }
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
      // 新对话无流式输出，按任务区分 isStreaming，避免沿用上一个任务的状态
      setIsStreaming(false)
      isStreamingRef.current = false
      // 新对话草稿为空
      setInputDraftState('')
      forceScrollToBottom()

      refreshConversationList()

      if (pendingMessage) {
        const msgContent = pendingMessage
        const msgHighPermission = pendingHighPermission
        setPendingMessage(null)
        setPendingHighPermission(false)
        pendingSendTimeoutRef.current = setTimeout(() => {
          pendingSendTimeoutRef.current = null
          sendMessage(convId, msgContent, undefined, undefined, { highPermission: msgHighPermission })
        }, 0)
      }

      return convId
    } catch {
      setPendingMessage(null)
      setPendingHighPermission(false)
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

    // 切换对话时同步恢复该对话的草稿，避免显示上一个对话的输入内容
    setInputDraftState(_persistentDrafts.get(convId) || '')

    const cachedMsgs = conversationMessagesRef.current.get(convId)
    if (cachedMsgs !== undefined) {
      // 缓存命中：先显示 loading（转圈圈），让 UI 先响应，
      // 再在下一个微任务填充消息，避免同步渲染大量消息导致 UI 冻结
      setLoadingConversationId(convId)
      setMessages([])
      const convData = allConversations.find(c => c.id === convId)
      if (convData) {
        setMinimalMode(!!(convData as any).minimal_mode)
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      if (version !== selectConvVersionRef.current) return
      setMessages(cachedMsgs)
      setLoadingConversationId(null)
      return
    }

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

    // 解析 JSON（这一步对长对话是耗时大头）
    // 注意：JSON.parse 是同步阻塞的，但通常 <50ms，无需 yieldToBrowser 让出
    let parsedMsgs: MessageWithThought[] = []
    try {
      parsedMsgs = (JSON.parse(fullConv?.messages_json || '[]') as MessageWithThought[])
    } catch {
      parsedMsgs = []
    }

    if (version !== selectConvVersionRef.current) {
      setLoadingConversationId(prev => prev === convId ? null : prev)
      return
    }

    // 合并 ensureSegments + patchMissingCompletedAt 为单次遍历
    const msgs = parsedMsgs.map(m => patchMissingCompletedAt(ensureSegments(m)))

    if (msgs.some((m, i) => m !== parsedMsgs[i])) {
      window.electronAPI.conversation.update({
        id: convId,
        messages_json: JSON.stringify(msgs),
        message_count: msgs.length,
      }).catch(() => {})
    }

    conversationMessagesRef.current.set(convId, msgs)

    if (version !== selectConvVersionRef.current) {
      setLoadingConversationId(prev => prev === convId ? null : prev)
      return
    }

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
      for (const [sessionId] of streamEntries) {
        streamStatesRef.current.delete(sessionId)
      }
      deleteConvMessages(convId)
      _persistentDrafts.delete(convId)

      await window.electronAPI.conversation.delete(convId)
      setAllConversations((prev) => prev.filter((c) => c.id !== convId))
      if (activeConversationId === convId) {
        setActiveConversationId(null)
        activeConversationIdRef.current = null
        setMessages([])
        setIsStreaming(false)
        setInputDraftState('')
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
        for (const [sessionId] of streamEntries) {
          streamStatesRef.current.delete(sessionId)
        }
        deleteConvMessages(convId)
        _persistentDrafts.delete(convId)
        await window.electronAPI.conversation.delete(convId)
      }
      setAllConversations((prev) => prev.filter((c) => !convIds.includes(c.id)))
      if (convIds.includes(activeConversationId || '')) {
        setActiveConversationId(null)
        setMessages([])
        setIsStreaming(false)
        setInputDraftState('')
      }
      message.success(t('workbench.deleteSuccess'))
    } catch {
      message.error(t('workbench.deleteFailed'))
    }
  }

  const deleteAllConversations = async () => {
    if (!id) return
    try {
      streamStatesRef.current.clear()
      conversationMessagesRef.current.clear()
      // 清理当前员工所有对话的草稿
      for (const conv of allConversations) {
        _persistentDrafts.delete(conv.id)
      }

      await window.electronAPI.conversation.deleteAll(id)
      setAllConversations([])
      setActiveConversationId(null)
      activeConversationIdRef.current = null
      setMessages([])
      setIsStreaming(false)
      setInputDraftState('')
      message.success(t('workbench.clearAllSuccess'))
    } catch {
      message.error(t('workbench.clearAllFailed'))
    }
  }

  /**
   * 将对话移动到其他数字员工名下。
   * - 调用后端 updateConversation 更新 employee_id（FTS 索引同步）
   * - 从当前员工对话列表移除
   * - 若是当前激活对话，清空消息区
   */
  const moveConversation = async (convId: string, targetEmployeeId: string): Promise<boolean> => {
    if (!convId || !targetEmployeeId) return false
    try {
      // 终止该对话相关的流式会话
      const streamEntries = Array.from(streamStatesRef.current.entries()).filter(([, s]) => s.conversationId === convId)
      for (const [sessionId] of streamEntries) {
        streamStatesRef.current.delete(sessionId)
      }
      deleteConvMessages(convId)
      _persistentDrafts.delete(convId)

      await window.electronAPI.conversation.update({ id: convId, employee_id: targetEmployeeId })
      setAllConversations((prev) => prev.filter((c) => c.id !== convId))
      if (activeConversationId === convId) {
        setActiveConversationId(null)
        activeConversationIdRef.current = null
        setMessages([])
        setIsStreaming(false)
        setInputDraftState('')
      }
      message.success(t('workbench.moveConversationSuccess'))
      return true
    } catch {
      message.error(t('workbench.moveConversationFailed'))
      return false
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
        options: { temperature: DEFAULT_TEMPERATURE, max_tokens: 1000 },
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

  const handleSend = async (content: string, images?: string[], models?: Array<{ providerId: string; modelId: string }>, options?: { highPermission?: boolean }) => {
    if (!content.trim() && (!images || images.length === 0)) return

    const currentConvId = activeConversationId
    if (!currentConvId) {
      if (isCreatingConversation) return
      setPendingMessage(content.trim())
      setPendingHighPermission(!!options?.highPermission)
      await startNewConversation()
      return
    }

    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === currentConvId && s.isStreaming)
    if (hasActiveStream) return

    sendMessage(currentConvId, content.trim(), images, models, { highPermission: !!options?.highPermission })
  }

  const sendMessage = async (convId: string, content: string, images?: string[], models?: Array<{ providerId: string; modelId: string }>, options?: { highPermission?: boolean }) => {
    const targetConvId = convId || activeConversationIdRef.current
    if (!targetConvId) return

    if (!content.trim() && (!images || images.length === 0)) return

    const highPermission = !!options?.highPermission

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
          assistantMessageId,
          segCounter: 0,
          toolCallCounter: 0,
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
            options: { temperature: DEFAULT_TEMPERATURE },
            use_skills: true,
            collection_ids: selectedCollectionIds,
            enable_thinking: enableThinking,
            conversation_id: targetConvId,
            minimal_mode: minimalMode,
            high_permission: highPermission,
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
        assistantMessageId,
        segCounter: 0,
        toolCallCounter: 0,
      }

      try {
        const messageHistory = buildEnrichedHistory(updatedMessagesRef)

        const result = await window.electronAPI.llm.employeeChatStream({
          employee_id: id!,
          provider_id: providerId,
          model_id: selectedLlmModelId || undefined,
          messages: messageHistory,
          options: { temperature: DEFAULT_TEMPERATURE },
          use_skills: true,
          collection_ids: selectedCollectionIds,
          enable_thinking: enableThinking,
          conversation_id: targetConvId,
          minimal_mode: minimalMode,
          high_permission: highPermission,
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

  /**
   * 提交消息变更并启动流式生成（M8 提取的共享流程）。
   * 三个重新生成场景（重新生成 / 切换模型重新生成 / 编辑后重发）共享：
   * 持久化消息 → 注册全局监听 → 标记流式状态 → 启动 employeeChatStream → 异常清理。
   * 调用方负责构建 newMessages、解析 providerId/modelId、计算上下文消息切片。
   */
  const commitAndStartStream = async (
    convId: string,
    newMessages: MessageWithThought[],
    contextMessages: MessageWithThought[],
    assistantMessageId: string,
    providerId: string,
    modelId: string | undefined,
  ) => {
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
      assistantMessageId,
      segCounter: 0,
      toolCallCounter: 0,
    }

    try {
      const messageHistory = buildEnrichedHistory(contextMessages)
      const result = await window.electronAPI.llm.employeeChatStream({
        employee_id: id!,
        provider_id: providerId,
        model_id: modelId || undefined,
        messages: messageHistory,
        options: { temperature: DEFAULT_TEMPERATURE },
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

    const providerId = selectedLlmProviderId || providers.find((p: any) => p.is_default)?.id
    if (!providerId) {
      message.warning(t('workbench.noLlmProvider'))
      return
    }

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

    await commitAndStartStream(
      convId,
      newMessages,
      newMessages.slice(0, msgIndex),
      msgId,
      providerId,
      selectedLlmModelId || undefined,
    )
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

    await commitAndStartStream(
      convId,
      newMessages,
      newMessages.slice(0, msgIndex),
      msgId,
      providerId,
      modelId,
    )
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

    const providerId = selectedLlmProviderId || providers.find((p: any) => p.is_default)?.id
    if (!providerId) {
      message.warning(t('workbench.noLlmProvider'))
      return
    }

    const editedUserMsg: MessageWithThought = {
      ...targetMsg,
      content: newContent.trim(),
      timestamp: Date.now(),
    }

    const assistantMsgIndex = msgIndex + 1
    const existingAssistantMsg = currentMsgs[assistantMsgIndex]
    let assistantMessageId: string

    const newMessages = [...currentMsgs]
    newMessages[msgIndex] = editedUserMsg

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
      assistantMessageId = `msg_${generateId()}`
      const assistantMessage: MessageWithThought = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
        segments: [],
      }
      newMessages.splice(assistantMsgIndex, 0, assistantMessage)
    }

    await commitAndStartStream(
      convId,
      newMessages,
      newMessages.slice(0, assistantMsgIndex),
      assistantMessageId,
      providerId,
      selectedLlmModelId || undefined,
    )
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

  // 草稿更新：同步到当前对话的持久化缓存，切回时能恢复
  const setInputDraft = useCallback((value: string) => {
    setInputDraftState(value)
    const convId = activeConversationIdRef.current
    if (convId) {
      _persistentDrafts.set(convId, value)
    }
  }, [])

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

    updateConvMessages(convId, (prev) =>
      prev.map(m => m.id === msgId ? { ...m, _comparisonBranchMsgs: allBranchMsgs } : m)
    )
  }

  const getComparisonMessages = useCallback((): MessageWithThought[] => {
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
  }, [comparisonMessageIds])

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
              segments: (m.segments || []).map(s => {
                if (s.type === 'tool_call' && !s.isToolComplete) {
                  // 用户停止生成时，工具调用可能处于两种中间态：
                  // 1) isToolArgsStreaming=true：LLM 仍在生成参数 JSON
                  // 2) isToolArgsStreaming=false, isToolComplete=false：工具正在执行
                  // 两种情况都需要标记为已取消，避免 UI 永远停留在"生成参数中"/"执行中"
                  // （handleStop 已删除 streamState，后端 done 事件无法触发 doneCleanup 兜底）
                  let parsedArgs = s.toolArgs
                  if (s.isToolArgsStreaming && !parsedArgs && s.toolArgsRaw) {
                    try { parsedArgs = JSON.parse(s.toolArgsRaw) } catch { /* JSON 不完整，保留 raw */ }
                  }
                  return {
                    ...s,
                    isStreaming: false,
                    isToolArgsStreaming: false,
                    isToolComplete: true,
                    toolArgs: parsedArgs,
                    toolError: t('workbench.toolCancelled'),
                    completedAt: s.completedAt || Date.now(),
                    collapsed: true,
                  }
                }
                return { ...s, isStreaming: false }
              }),
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

  const getToolDisplayName = useCallback((name: string) => TOOL_DISPLAY_NAMES[name] || name, [TOOL_DISPLAY_NAMES])

  const handleToggleSegment = useCallback((msgId: string, segId: string) => {
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
  }, [])

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
    inputDraft,
    setInputDraft,
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
    moveConversation,
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
    getToolDisplayName,
    isConversationStreaming,
    generateConversationTitle,
  }
}

export default useEmployeeChat
