import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { Conversation } from '../types'
import type { MessageWithThought, MessageBranch, ModelSelection } from '../components/workbench'
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
import { useStreamListeners, getPersistentListenersCleanup, getPersistentEmployeeId, setPersistentEmployeeId } from './useStreamListeners'

interface UseEmployeeChatParams {
  id: string | undefined
  message: ReturnType<typeof import('antd').App.useApp>['message']
  /** 跳过自动选择对话/新建对话，由外部页面控制对话选择（任务页使用） */
  skipAutoInit?: boolean
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

/** 剥离消息中仅供 UI 使用的运行时字段，用于分支/保存等持久化场景。
 *  buildEnrichedHistory 不读取这些字段，剥离不会影响 LLM 上下文一致性。 */
function stripMessageRuntimeFields(m: MessageWithThought): MessageWithThought {
  const copy: any = { ...m }
  delete copy.isStreaming
  delete copy._comparisonBranchMsgs
  if (Array.isArray(copy.segments)) {
    copy.segments = copy.segments.map((s: any) => {
      const seg = { ...s }
      delete seg.isStreaming
      delete seg.isToolArgsStreaming
      delete seg.toolArgsRaw
      delete seg.toolProgress
      return seg
    })
  }
  return copy
}

// 按 employeeId 缓存当前活动对话 ID：主 tab 切换（如 资料库→任务）后，
// 页面完全卸载再重新挂载，activeConversationId 状态丢失。
// 有了此缓存，initEmployee 可以直接恢复上次的对话，避免 selectConversation IPC。
const _persistentActiveConvId = new Map<string, string>()

// 按 conversationId 缓存输入框草稿：切换对话/员工时保留各自草稿，切回时恢复
const _persistentDrafts = new Map<string, string>()

// 按 conversationId 缓存输入框选中的模型：切换对话时恢复各自模型选择，避免跨任务串扰
const _persistentModels = new Map<string, ModelSelection[]>()

// 按 conversationId 绑定输入框默认模型（模型按钮）：各任务独立，切换对话时恢复各自绑定的模型
const _persistentDefaultModels = new Map<string, { providerId: string; modelId: string }>()

// 解析对话绑定的默认模型（default_model_json，DB 持久化），无效/空返回 null
const parseConvDefaultModel = (conv: any): { providerId: string; modelId: string } | null => {
  const raw = conv?.default_model_json
  if (!raw) return null
  try {
    const obj = JSON.parse(raw)
    if (obj && obj.providerId && obj.modelId) return { providerId: obj.providerId, modelId: obj.modelId }
  } catch {
    // JSON 解析失败忽略
  }
  return null
}

// 按 conversationId 缓存上下文用量：切换窗口/员工后真空期 onDone 更新不会丢失，
// 组件重挂载时优先从此缓存恢复，避免 DB 查询竞争条件导致显示 0/0
const _persistentContextStats = new Map<string, any>()

// 获取或创建指定员工的消息缓存
const getOrCreateEmployeeMessagesCache = (employeeId: string): LRUCache<string, MessageWithThought[]> => {
  let cache = _persistentMessagesByEmployee.get(employeeId)
  if (!cache) {
    cache = createPersistentMessagesCache()
    _persistentMessagesByEmployee.set(employeeId, cache)
  }
  return cache
}

const useEmployeeChat = ({ id, message, skipAutoInit }: UseEmployeeChatParams) => {
  const { t } = useTranslation()

  const TOOL_DISPLAY_NAMES: Record<string, string> = useMemo(() => ({
    date_time: t('workbench.toolNames.date_time'),
    shell_exec: t('workbench.toolNames.shell_exec'),
    file: t('workbench.toolNames.file'),
    web_search: t('workbench.toolNames.web_search'),
    web_fetch: t('workbench.toolNames.web_fetch'),
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
  const [contextStats, setContextStats] = useState<Record<string, any>>({})
  const [isCompacting, setIsCompacting] = useState(false)
  const inputDraftRef = useRef('')
  const inputModelsRef = useRef<ModelSelection[]>([])
  const inputDefaultModelRef = useRef<{ providerId: string; modelId: string } | null>(null)
  // 分支任务创建中的防抖标记，避免重复点击创建多个任务
  const isBranchingRef = useRef(false)
  // 响应式默认模型状态：与 inputDefaultModelRef 同步，供 ChatInput 展示并触发重渲染
  const [inputDefaultModel, setInputDefaultModelState] = useState<{ providerId: string; modelId: string } | null>(null)
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
  // 新建对话后延迟发送的微任务标记，组件卸载时清理避免 setState-after-unmount（B#7）
  // 用微任务而非 setTimeout：保证 sendMessage 内消息持久化先于任务列表刷新（IPC 顺序）
  const pendingSendMicrotaskRef = useRef(false)

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])
  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  const currentContextStats = useMemo(() => {
    if (!activeConversationId) return undefined
    const stats = contextStats[activeConversationId]
    if (!stats) return undefined
    if ((stats.actualPromptTokens === 0 || stats.actualPromptTokens === undefined) &&
        (stats.estimatedTokens === 0 || stats.estimatedTokens === undefined) &&
        (stats.maxTokens === 0 || stats.maxTokens === undefined)) {
      return undefined
    }
    return stats
  }, [contextStats, activeConversationId])

  // 定位会话所属员工的消息缓存：切走员工后，仍在后台运行（自动续跑）的会话
  // 其流事件要写回原员工缓存，而非当前活动的员工缓存，保证结果不丢失/不串位
  const resolveConvCache = (convId: string): LRUCache<string, MessageWithThought[]> => {
    for (const cache of _persistentMessagesByEmployee.values()) {
      if (cache.get(convId) !== undefined) return cache
    }
    return conversationMessagesRef.current
  }

  const updateConvMessages = (convId: string, updater: (prev: MessageWithThought[]) => MessageWithThought[]) => {
    const targetCache = resolveConvCache(convId)
    const prev = targetCache.get(convId)
    const base = prev || []
    const next = updater(base)
    if (next !== base) {
      targetCache.set(convId, next)
    }
    if (convId === activeConversationIdRef.current) {
      setMessages(next)
    }
  }

  const setConvMessages = (convId: string, msgs: MessageWithThought[]) => {
    const targetCache = resolveConvCache(convId)
    targetCache.set(convId, msgs)
    if (convId === activeConversationIdRef.current) {
      setMessages(msgs)
    }
  }

  const deleteConvMessages = (convId: string) => {
    resolveConvCache(convId).delete(convId)
  }

  /**
   * 后端运行中会话重建：renderer 重载/异常导致前端丢失运行跟踪后，
   * 查询后端仍未结束的流式会话，为其重建 streamState 与会话内占位 assistant 消息，
   * 恢复 isStreaming，避免"前端显示完成但后端仍运行 → 重发 already running"的陈旧状态。
   */
  async function reconcileRunningStreams(employeeId: string) {
    let sessions: Array<{ sessionId: string; employeeId?: string; conversationId?: string }> = []
    try {
      sessions = await window.electronAPI.llm.listActiveSessions(employeeId)
    } catch {
      return
    }
    if (!Array.isArray(sessions) || sessions.length === 0) return
    for (const s of sessions) {
      if (!s.conversationId) continue
      // 已跟踪的活跃流跳过（正常运行时由 sendMessage 建立，无需重建）
      const already = Array.from(streamStatesRef.current.values())
        .some(ss => ss.conversationId === s.conversationId && ss.isStreaming)
      if (already) continue

      const assistantMessageId = `msg_${generateId()}`
      const placeholder: MessageWithThought = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
        segments: [],
      }
      // 幂等：从缓存取历史（未加载时从 DB 获取，避免空缓存写回 DB 覆盖既有消息），
      // 追加占位消息后写回缓存与 DB，保证 onChunk 能匹配到目标消息、不丢内容
      const cache = resolveConvCache(s.conversationId)
      let base = cache.get(s.conversationId)
      if (base === undefined) {
        try {
          const fullConv = await window.electronAPI.conversation.get(s.conversationId)
          base = (JSON.parse(fullConv?.messages_json || '[]') as MessageWithThought[]) || []
        } catch {
          base = []
        }
      }
      if (!base.some(m => m.id === assistantMessageId)) {
        const next = [...base, placeholder]
        setConvMessages(s.conversationId, next)
        window.electronAPI.conversation.update({
          id: s.conversationId,
          messages_json: JSON.stringify(next),
          message_count: next.length,
        }).catch(() => {})
      }

      streamStatesRef.current.set(s.sessionId, {
        isStreaming: true,
        conversationId: s.conversationId,
        assistantMessageId,
        segCounter: 0,
        toolCallCounter: 0,
      })
      if (s.conversationId === activeConversationIdRef.current) {
        setIsStreaming(true)
        isStreamingRef.current = true
      }
    }
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
        inputDraftRef.current = ''
        inputModelsRef.current = []
        inputDefaultModelRef.current = null
        setInputDefaultModelState(null)
        // 重置 pendingMessage 与延迟发送，避免跨员工串扰
        setPendingMessage(null)
        setPendingHighPermission(false)
        pendingSendMicrotaskRef.current = false
        // 重置 initializedRef，让新员工走完整的 selectConversation/startNewConversation 流程
        initializedRef.current = false

        // 不中断仍在运行的任务：后端应持续自动运行（全局监听按 sessionId 路由到所属员工缓存）。
        // 因此不再 abort 流式会话、不再清理监听器/清空 _persistentStreamStates，
        // 切回该员工时根据流式状态恢复 UI，避免运行中的任务被主动中断。
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
        // 从缓存 convList 恢复所有对话的 contextStats
        const restoredStatsFromCache: Record<string, any> = {}
        for (const conv of cachedConvList) {
          if ((conv as any).context_stats_json) {
            try {
              const stats = JSON.parse((conv as any).context_stats_json)
              if (stats && typeof stats === 'object') {
                restoredStatsFromCache[conv.id] = stats
              }
            } catch {
              // JSON 解析失败忽略
            }
          }
        }
        // 持久化内存缓存优先级最高（真空期 onDone 更新可能只写入了这里）
        for (const [cid, s] of _persistentContextStats) {
          if (s && typeof s === 'object') restoredStatsFromCache[cid] = s
        }
        if (Object.keys(restoredStatsFromCache).length > 0) {
          setContextStats(prev => ({ ...prev, ...restoredStatsFromCache }))
        }

        // 缓存完整：先设 loading（显示转圈圈），再异步恢复消息
        initializedRef.current = true
        if (skipAutoInit) {
          // 任务模式：不自动恢复上次对话，由外部页面控制
        } else {
        setActiveConversationId(cachedActiveConvId)
        activeConversationIdRef.current = cachedActiveConvId
        setLoadingConversationId(cachedActiveConvId)
        // 恢复该对话的草稿与模型选择
        inputDraftRef.current = _persistentDrafts.get(cachedActiveConvId) || ''
        inputModelsRef.current = _persistentModels.get(cachedActiveConvId) || []
        const convData = cachedConvList.find((c: Conversation) => c.id === cachedActiveConvId)
        inputDefaultModelRef.current = _persistentDefaultModels.get(cachedActiveConvId) || (convData ? parseConvDefaultModel(convData) : null) || null
        setInputDefaultModelState(inputDefaultModelRef.current)
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
        } // end skipAutoInit else
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

      // 从 convList 恢复各对话绑定的默认模型（仅本会话未显式设置过的）
      for (const conv of convList) {
        if (_persistentDefaultModels.has(conv.id)) continue
        const dbModel = parseConvDefaultModel(conv)
        if (dbModel) _persistentDefaultModels.set(conv.id, dbModel)
      }
      // 当前激活对话若尚未恢复模型（selectConversation 早于 convList 加载），从缓存补齐
      if (activeConversationIdRef.current && !inputDefaultModelRef.current) {
        const dbModel = _persistentDefaultModels.get(activeConversationIdRef.current)
        if (dbModel) {
          inputDefaultModelRef.current = dbModel
          setInputDefaultModelState(dbModel)
        }
      }

      // 从 convList 恢复所有对话的 contextStats
      const restoredStats: Record<string, any> = {}
      for (const conv of convList) {
        if ((conv as any).context_stats_json) {
          try {
            const stats = JSON.parse((conv as any).context_stats_json)
            if (stats && typeof stats === 'object') {
              restoredStats[conv.id] = stats
            }
          } catch {
            // JSON 解析失败忽略
          }
        }
      }
      // 持久化内存缓存优先级最高（真空期 onDone 更新可能先于 DB 查询到达）
      for (const [cid, s] of _persistentContextStats) {
        if (s && typeof s === 'object') restoredStats[cid] = s
      }
      if (Object.keys(restoredStats).length > 0) {
        setContextStats(prev => ({ ...prev, ...restoredStats }))
      }

      loadProviders()

      // 首次初始化（无缓存）：选择对话
      if (!hasFullCache && !initializedRef.current) {
        initializedRef.current = true
        if (skipAutoInit) {
          // 任务模式：由外部页面控制对话选择，不自动选择或新建
        } else {
          const savedConvId = activeConvIdStorageKey ? localStorage.getItem(activeConvIdStorageKey) : null
          if (convList.length > 0) {
            const targetConv = savedConvId ? convList.find((c: Conversation) => c.id === savedConvId) : null
            selectConversation(targetConv ? savedConvId! : convList[0].id)
          } else {
            await startNewConversation()
          }
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
    // 重建后端仍在运行、但前端已丢失跟踪的流式会话（renderer 重载/异常导致）。
    // 必须在 initEmployee 完成对话/消息恢复后再执行，避免与 selectConversation 的加载竞态。
    if (version === initVersionRef.current) {
      reconcileRunningStreams(id!).catch(() => {})
    }
  }

  useEffect(() => {
    return () => {
      // 清理未执行的延迟发送，避免卸载后触发 setState（B#7）
      pendingSendMicrotaskRef.current = false
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
    onContextStats: (convId, stats) => {
      _persistentContextStats.set(convId, stats)
      setContextStats(prev => ({ ...prev, [convId]: stats }))
      window.electronAPI.conversation.update({
        id: convId,
        context_stats_json: JSON.stringify(stats),
      }).catch(() => {})
    },
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

  const startNewConversation = async (opts?: {
    message?: string
    images?: string[]
    models?: Array<{ providerId: string; modelId: string }>
    highPermission?: boolean
  }): Promise<string | null> => {
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
      setIsStreaming(false)
      isStreamingRef.current = false
      inputDraftRef.current = ''
      inputModelsRef.current = []
      if (selectedLlmProviderId) {
        inputDefaultModelRef.current = { providerId: selectedLlmProviderId, modelId: selectedLlmModelId }
        _persistentDefaultModels.set(convId, inputDefaultModelRef.current)
        setInputDefaultModelState(inputDefaultModelRef.current)
        // 新对话绑定默认模型持久化到 DB，切换任务/重启后仍恢复各自模型
        window.electronAPI.conversation.update({
          id: convId,
          default_model_json: JSON.stringify(inputDefaultModelRef.current),
        }).catch(() => {})
      } else {
        inputDefaultModelRef.current = null
        setInputDefaultModelState(null)
      }
      forceScrollToBottom()

      refreshConversationList()

      // 优先使用参数传递的消息（避免 React state 异步更新导致丢失），fallback 到 state（兼容其他场景）
      const msgContent = opts?.message ?? pendingMessage
      const msgImages = opts?.images
      const msgModels = opts?.models
      const msgHighPermission = opts?.highPermission ?? pendingHighPermission

      if (msgContent || (msgImages && msgImages.length > 0)) {
        setPendingMessage(null)
        setPendingHighPermission(false)
        pendingSendMicrotaskRef.current = true
        Promise.resolve().then(() => {
          if (!pendingSendMicrotaskRef.current) return
          pendingSendMicrotaskRef.current = false
          sendMessage(convId, msgContent || '', msgImages, msgModels, { highPermission: msgHighPermission })
        })
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

    // 切换对话时同步恢复该对话的草稿与模型选择，避免显示上一个对话的输入内容/模型
    inputDraftRef.current = _persistentDrafts.get(convId) || ''
    inputModelsRef.current = _persistentModels.get(convId) || []
    // 优先内存缓存（本会话最新选择），其次 DB 持久化的 default_model_json，保证跨任务/重启隔离
    const cachedDefaultModel = _persistentDefaultModels.get(convId)
    const defaultModelConvData = allConversations.find(c => c.id === convId)
    inputDefaultModelRef.current = cachedDefaultModel || parseConvDefaultModel(defaultModelConvData) || null
    setInputDefaultModelState(inputDefaultModelRef.current)

    const cachedMsgs = conversationMessagesRef.current.get(convId)
    if (cachedMsgs !== undefined) {
      // 缓存命中：先显示 loading（转圈圈），让 UI 先响应，
      // 再在下一个微任务填充消息，避免同步渲染大量消息导致 UI 冻结
      setLoadingConversationId(convId)
      setMessages([])
      const convData = allConversations.find(c => c.id === convId)
      if (convData) {
        setMinimalMode(!!(convData as any).minimal_mode)
        // 从 convList 恢复 contextStats，优先使用持久化内存缓存（真空期数据不丢失）
        const persistentStats = _persistentContextStats.get(convId)
        if (persistentStats && typeof persistentStats === 'object') {
          setContextStats(prev => ({ ...prev, [convId]: persistentStats }))
        } else {
          try {
            if ((convData as any).context_stats_json) {
              const savedStats = JSON.parse((convData as any).context_stats_json)
              if (savedStats && typeof savedStats === 'object') {
                setContextStats(prev => ({ ...prev, [convId]: savedStats }))
              }
            }
          } catch {
            // JSON 解析失败忽略
          }
        }
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
      // 恢复 contextStats，优先使用持久化内存缓存（真空期数据不丢失）
      const persistentStats = _persistentContextStats.get(convId)
      if (persistentStats && typeof persistentStats === 'object') {
        setContextStats(prev => ({ ...prev, [convId]: persistentStats }))
      } else {
        try {
          if (fullConv.context_stats_json) {
            const savedStats = JSON.parse(fullConv.context_stats_json)
            if (savedStats && typeof savedStats === 'object') {
              setContextStats(prev => ({ ...prev, [convId]: savedStats }))
            }
          }
        } catch {
          // JSON 解析失败忽略
        }
      }
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

  /** 中止指定对话的所有活跃流式会话，确保后端 agent signal 被置为 aborted */
  const abortConvStreams = async (convId: string) => {
    const streamEntries = Array.from(streamStatesRef.current.entries()).filter(([, s]) => s.conversationId === convId)
    for (const [sessionId, ss] of streamEntries) {
      ss.isStreaming = false
      // 不删除 streamState，让后端 onDone 接管清理并写入 tokenUsage（与 handleStop 一致），
      // 避免消息停留在 isStreaming 状态导致按钮/用量不显示
      try { await window.electronAPI.llm.abortChat(sessionId) } catch { /* ignore */ }
    }
  }

  const deleteConversation = async (convId: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    try {
      await abortConvStreams(convId)
      deleteConvMessages(convId)
      _persistentDrafts.delete(convId)
      _persistentModels.delete(convId)
      _persistentDefaultModels.delete(convId)

      await window.electronAPI.conversation.delete(convId)
      setAllConversations((prev) => prev.filter((c) => c.id !== convId))
      if (activeConversationId === convId) {
        setActiveConversationId(null)
        activeConversationIdRef.current = null
        setMessages([])
        setIsStreaming(false)
        inputDraftRef.current = ''
        inputModelsRef.current = []
        inputDefaultModelRef.current = null
        setInputDefaultModelState(null)
      }
      message.success(t('workbench.deleteSuccess'))
    } catch {
      message.error(t('workbench.deleteFailed'))
    }
  }

  const deleteSelectedConversations = async (convIds: string[]) => {
    try {
      for (const convId of convIds) {
        await abortConvStreams(convId)
        deleteConvMessages(convId)
        _persistentDrafts.delete(convId)
        _persistentModels.delete(convId)
        _persistentDefaultModels.delete(convId)
        await window.electronAPI.conversation.delete(convId)
      }
      setAllConversations((prev) => prev.filter((c) => !convIds.includes(c.id)))
      if (convIds.includes(activeConversationId || '')) {
        setActiveConversationId(null)
        setMessages([])
        setIsStreaming(false)
        inputDraftRef.current = ''
        inputModelsRef.current = []
        inputDefaultModelRef.current = null
        setInputDefaultModelState(null)
      }
      message.success(t('workbench.deleteSuccess'))
    } catch {
      message.error(t('workbench.deleteFailed'))
    }
  }

  const deleteAllConversations = async () => {
    if (!id) return
    try {
      // 中止所有活跃流式会话
      for (const [sessionId, ss] of streamStatesRef.current) {
        if (ss.isStreaming) {
          ss.isStreaming = false
          try { await window.electronAPI.llm.abortChat(sessionId) } catch { /* ignore */ }
        }
      }
      streamStatesRef.current.clear()
      conversationMessagesRef.current.clear()
      // 清理当前员工所有对话的草稿
      for (const conv of allConversations) {
        _persistentDrafts.delete(conv.id)
        _persistentModels.delete(conv.id)
        _persistentDefaultModels.delete(conv.id)
      }

      await window.electronAPI.conversation.deleteAll(id)
      setAllConversations([])
      setActiveConversationId(null)
      activeConversationIdRef.current = null
      setMessages([])
      setIsStreaming(false)
      inputDraftRef.current = ''
      inputModelsRef.current = []
      inputDefaultModelRef.current = null
      setInputDefaultModelState(null)
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
      await abortConvStreams(convId)
      deleteConvMessages(convId)
      _persistentDrafts.delete(convId)
      _persistentModels.delete(convId)
      _persistentDefaultModels.delete(convId)

      await window.electronAPI.conversation.update({ id: convId, employee_id: targetEmployeeId })
      setAllConversations((prev) => prev.filter((c) => c.id !== convId))
      if (activeConversationId === convId) {
        setActiveConversationId(null)
        activeConversationIdRef.current = null
        setMessages([])
        setIsStreaming(false)
        inputDraftRef.current = ''
        inputModelsRef.current = []
        inputDefaultModelRef.current = null
        setInputDefaultModelState(null)
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
      // 兜底：quick 场景模型 → 默认 provider → 第一个 provider
      const providerId = quickModel?.provider_id
        || providers.find((p: any) => p.is_default)?.id
        || providers[0]?.id
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
          // 通知外部页面（任务列表）刷新，让新标题立即可见
          window.dispatchEvent(new CustomEvent('conversation-title-updated', {
            detail: { conversationId, title },
          }))
        }
      }
    } catch (e) { console.error('Failed to generate conversation title:', e) }
  }

  const handleSend = async (content: string, images?: string[], models?: Array<{ providerId: string; modelId: string }>, options?: { highPermission?: boolean }) => {
    const trimmedContent = content.trim()
    if (!trimmedContent && (!images || images.length === 0)) return

    const currentConvId = activeConversationId
    if (!currentConvId) {
      if (isCreatingConversation) return
      // 直接传参数给 startNewConversation，避免 React state 异步更新导致消息丢失
      await startNewConversation({
        message: trimmedContent,
        images,
        models,
        highPermission: !!options?.highPermission,
      })
      return
    }

    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === currentConvId && s.isStreaming)
    if (hasActiveStream) return

    sendMessage(currentConvId, trimmedContent, images, models, { highPermission: !!options?.highPermission })
  }

  // 实际执行模型：优先当前对话绑定的默认模型（输入框模型按钮），其次员工级默认/默认 provider
  // 保证发送/重发/编辑重发/压缩使用与输入框显示一致的模型
  const resolveExecModel = () => {
    const bound = inputDefaultModelRef.current
    const providerId = bound?.providerId || selectedLlmProviderId || providers.find((p: any) => p.is_default)?.id
    const modelId = bound?.modelId || selectedLlmModelId || undefined
    return { providerId: providerId || '', modelId }
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
    // 立即持久化用户消息（含 message_count），让任务列表能马上看到该对话
    window.electronAPI.conversation.update({
      id: targetConvId,
      messages_json: JSON.stringify(updatedMessagesRef),
      message_count: updatedMessagesRef.length,
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
      const { providerId, modelId } = resolveExecModel()
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
        comparisonProviderId: providerId,
        comparisonModelId: modelId,
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
          model_id: modelId,
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

    const { providerId, modelId } = resolveExecModel()
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

    const { providerId, modelId } = resolveExecModel()
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
        comparisonProviderId: providerId,
        comparisonModelId: modelId,
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
        comparisonProviderId: providerId,
        comparisonModelId: modelId,
      }
      newMessages.splice(assistantMsgIndex, 0, assistantMessage)
    }

    await commitAndStartStream(
      convId,
      newMessages,
      newMessages.slice(0, assistantMsgIndex),
      assistantMessageId,
      providerId,
      modelId,
    )
  }

  // 草稿更新：同步到当前对话的持久化缓存，切回时能恢复
  // 仅更新 ref，不触发顶层 setState，避免输入时整个页面重渲染
  const setInputDraft = useCallback((value: string) => {
    inputDraftRef.current = value
    const convId = activeConversationIdRef.current
    if (convId) {
      _persistentDrafts.set(convId, value)
    }
  }, [])

  const getInputDraft = useCallback(() => inputDraftRef.current, [])

  // 模型选择更新：同步到当前对话的持久化缓存，切换对话时能恢复各自模型选择
  const setInputModels = useCallback((models: ModelSelection[]) => {
    inputModelsRef.current = models
    const convId = activeConversationIdRef.current
    if (convId) {
      _persistentModels.set(convId, models)
    }
  }, [])

  const getInputModels = useCallback(() => inputModelsRef.current, [])

  // 默认模型更新：绑定到当前对话，各任务独立存储，切换对话时恢复各自默认模型
  const setInputDefaultModel = useCallback((providerId: string, modelId: string) => {
    const value = { providerId, modelId }
    inputDefaultModelRef.current = value
    const convId = activeConversationIdRef.current
    if (convId) {
      _persistentDefaultModels.set(convId, value)
      // 持久化到 DB，保证重启后仍按对话恢复各自的默认模型
      window.electronAPI.conversation.update({
        id: convId,
        default_model_json: JSON.stringify(value),
      }).catch(() => {})
    }
    setInputDefaultModelState(value)
  }, [])

  // 清除当前激活对话（用于新建任务时重置状态，避免新消息发到旧对话）
  const clearActiveConversation = useCallback(() => {
    setActiveConversationId(null)
    activeConversationIdRef.current = null
    setMessages([])
    setIsStreaming(false)
    isStreamingRef.current = false
    inputDraftRef.current = ''
    inputModelsRef.current = []
    inputDefaultModelRef.current = null
    setInputDefaultModelState(null)
    setIsComparisonMode(false)
    setComparisonMessageIds([])
  }, [])

  const handleToggleMinimalMode = useCallback((enabled: boolean) => {
    const convId = activeConversationIdRef.current
    if (!convId) {
      // 新任务模式（无 activeConversationId）：允许切换，值会在创建新对话时使用
      setMinimalMode(enabled)
      return
    }
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

  // 从消息处创建分支任务：复制到该条（含本条）的所有上下文，复用原任务工作区目录（保持 KV cache 前缀一致）
  const handleBranchMessage = async (msgId: string) => {
    const convId = activeConversationIdRef.current
    if (!convId || !id) return
    // 流式生成中禁止分支，避免复制到未完成占位消息
    const hasActiveStream = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === convId && s.isStreaming)
    if (hasActiveStream) return
    if (isBranchingRef.current) return
    isBranchingRef.current = true

    try {
      const currentMsgs = conversationMessagesRef.current.get(convId) || []
      const branchIndex = currentMsgs.findIndex(m => m.id === msgId)
      if (branchIndex < 0) return
      const prefix = currentMsgs.slice(0, branchIndex + 1).map(stripMessageRuntimeFields)

      let origConv: any = null
      try {
        origConv = await window.electronAPI.conversation.get(convId)
      } catch {}
      if (!origConv) return

      const result = (await window.electronAPI.conversation.create({
        employee_id: id,
        title: t('workbench.branchTitle', { title: origConv.title || '' }),
        minimal_mode: !!origConv.minimal_mode,
        workspace_path: origConv.workspace_path || undefined,
      })) as Conversation
      const newConvId = result.id

      // 继承原任务的默认模型绑定（default_model_json），保证上下文模型一致
      const defaultModelJson = origConv.default_model_json
        || (inputDefaultModelRef.current ? JSON.stringify(inputDefaultModelRef.current) : undefined)
      if (defaultModelJson) {
        _persistentDefaultModels.set(newConvId, JSON.parse(defaultModelJson))
      }
      await window.electronAPI.conversation.update({
        id: newConvId,
        messages_json: JSON.stringify(prefix),
        message_count: prefix.length,
        default_model_json: defaultModelJson,
        minimal_mode: !!origConv.minimal_mode,
      }).catch(() => {})

      refreshConversationList()
      await selectConversation(newConvId)
      message.success(t('workbench.branchSuccess'))
    } finally {
      isBranchingRef.current = false
    }
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

  const handleDeleteComparisonMessage = (msgId: string) => {
    const convId = activeConversationIdRef.current
    if (!convId) return
    const currentMsgs = conversationMessagesRef.current.get(convId) || []

    // 场景1：临时对比（多个独立消息 id）
    if (comparisonMessageIds.length > 1) {
      if (!comparisonMessageIds.includes(msgId) || comparisonMessageIds.length <= 1) return
      const newIds = comparisonMessageIds.filter(id => id !== msgId)
      updateConvMessages(convId, (prev) => {
        const newMessages = prev.filter(m => m.id !== msgId)
        window.electronAPI.conversation.update({
          id: convId, messages_json: JSON.stringify(newMessages), message_count: newMessages.length,
        }).catch(() => {})
        return newMessages
      })
      if (newIds.length <= 1) {
        setIsComparisonMode(false)
        setComparisonMessageIds([])
      } else {
        setComparisonMessageIds(newIds)
      }
      return
    }

    // 场景2：已聚合对比（单 id + _comparisonBranchMsgs）
    const targetMsgId = comparisonMessageIds[0]
    if (!targetMsgId) return
    const targetMsg = currentMsgs.find(m => m.id === targetMsgId)
    if (!targetMsg?._comparisonBranchMsgs) return

    const branchMsgs = targetMsg._comparisonBranchMsgs
    if (branchMsgs.length <= 1) return

    const deleteIndex = branchMsgs.findIndex(m => m.id === msgId)
    if (deleteIndex < 0) return

    const branches = targetMsg.branches || []
    let newBranches: MessageBranch[]
    const { _comparisonBranchMsgs: _omit, ...baseMsg } = targetMsg

    if (deleteIndex < branches.length) {
      newBranches = branches.filter((_, idx) => idx !== deleteIndex)
      let newActiveIndex = baseMsg.activeBranchIndex ?? branches.length
      if (newActiveIndex === deleteIndex) {
        newActiveIndex = newBranches.length
      } else if (newActiveIndex > deleteIndex) {
        newActiveIndex -= 1
      }
      baseMsg.branches = newBranches
      baseMsg.activeBranchIndex = newActiveIndex
    } else {
      // 删除本体，用最后一个 branch 提升为本体
      if (branches.length === 0) return
      const lastBranch = branches[branches.length - 1]
      newBranches = branches.slice(0, -1)
      baseMsg.content = lastBranch.content
      baseMsg.segments = lastBranch.segments
      baseMsg.thought = lastBranch.thought
      baseMsg.tokenUsage = lastBranch.tokenUsage
      baseMsg.isError = lastBranch.isError
      baseMsg.comparisonProviderId = lastBranch.comparisonProviderId
      baseMsg.comparisonModelId = lastBranch.comparisonModelId
      baseMsg.branches = newBranches.length > 0 ? newBranches : undefined
      baseMsg.activeBranchIndex = newBranches.length
    }

    // 只剩一个回复（无 branch）→ 关闭对比，保留为本体
    if (newBranches.length === 0) {
      const finalMsg: MessageWithThought = { ...baseMsg, branches: undefined, activeBranchIndex: undefined }
      updateConvMessages(convId, (prev) => {
        const newMessages = prev.map(m => m.id === targetMsgId ? finalMsg : m)
        window.electronAPI.conversation.update({
          id: convId, messages_json: JSON.stringify(newMessages), message_count: newMessages.length,
        }).catch(() => {})
        return newMessages
      })
      setIsComparisonMode(false)
      setComparisonMessageIds([])
      return
    }

    // 重新生成 _comparisonBranchMsgs
    const newBranchMsgs: MessageWithThought[] = newBranches.map((branch, i) => ({
      ...baseMsg,
      id: `${baseMsg.id}_branch_${i}`,
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
      _comparisonBranchMsgs: undefined,
    }))
    newBranchMsgs.push({
      ...baseMsg,
      id: `${baseMsg.id}_branch_${newBranches.length}`,
      branches: undefined,
      activeBranchIndex: undefined,
      _comparisonBranchMsgs: undefined,
    })

    const newTargetMsg: MessageWithThought = { ...baseMsg, _comparisonBranchMsgs: newBranchMsgs }
    updateConvMessages(convId, (prev) => {
      const newMessages = prev.map(m => m.id === targetMsgId ? newTargetMsg : m)
      window.electronAPI.conversation.update({
        id: convId, messages_json: JSON.stringify(newMessages), message_count: newMessages.length,
      }).catch(() => {})
      return newMessages
    })
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
      // 仅标记 isStreaming=false，不删除 streamState，让后端 onDone 接管清理并写入 tokenUsage
      streamState.isStreaming = false
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
                  // 两种情况都需要立即标记为已取消，让 UI 即时停止；
                  // 后端 onDone 到达时 doneCleanup 会写入 tokenUsage（已取消标记不会被覆盖）
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

      // delegation 子段折叠：segId 格式为 `${delSegId}__sub__${subSegId}`
      const subMatch = segId.match(/^(.+?)__sub__(.+)$/)
      if (subMatch) {
        const delSegId = subMatch[1]
        const subSegId = subMatch[2]
        const newSegs = m.segments.map(s => {
          if (s.type !== 'delegation' || s.id !== delSegId || !s.subSegments) return s
          return {
            ...s,
            subSegments: s.subSegments.map(ss =>
              ss.id === subSegId ? { ...ss, collapsed: !ss.collapsed } : ss
            ),
          }
        })
        return { ...m, segments: newSegs }
      }

      const newSegs = m.segments.map(s =>
        s.id === segId ? { ...s, collapsed: !s.collapsed } : s
      )
      return { ...m, segments: newSegs }
    }))
  }, [])

  const isConversationStreaming = useCallback((convId: string) => {
    return Array.from(streamStatesRef.current.values()).some(s => s.conversationId === convId && s.isStreaming)
  }, [])

  const handleCompact = useCallback(async () => {
    const convId = activeConversationIdRef.current
    if (!convId || !id || isCompacting || isStreaming) return

    const { providerId, modelId } = resolveExecModel()
    if (!providerId) return

    setIsCompacting(true)
    try {
      const currentMsgs = conversationMessagesRef.current.get(convId) || []
      // 先去掉旧的分隔符和旧的摘要 assistant 消息（它们本身是 UI 注入的，不应参与新一轮压缩）
      const compactSepIds = new Set<string>()
      const compactSummaryIds = new Set<string>()
      for (let i = 0; i < currentMsgs.length; i++) {
        const m = currentMsgs[i]
        if (m.isCompactSummary) {
          compactSepIds.add(m.id)
          if (i + 1 < currentMsgs.length && currentMsgs[i + 1].id.startsWith('msg_compact_summary_')) {
            compactSummaryIds.add(currentMsgs[i + 1].id)
          }
        }
      }
      const cleanMsgs = currentMsgs.filter(m => !compactSepIds.has(m.id) && !compactSummaryIds.has(m.id))
      const messageHistory = buildEnrichedHistory(cleanMsgs)

      const result = await window.electronAPI.llm.compactConversation({
        employee_id: id,
        provider_id: providerId,
        model_id: modelId,
        messages: messageHistory,
        conversation_id: convId,
        collection_ids: selectedCollectionIds,
        enable_thinking: enableThinking,
        minimal_mode: minimalMode,
      })

      const summaryContent = (result?.summary || '').trim()
      if (summaryContent) {
        const now = Date.now()
        // UI消息完全保留（cleanMsgs），在末尾追加：分隔符 + 摘要消息
        const compactedMsgs = [
          ...cleanMsgs,
          {
            id: `msg_compact_sep_${now}`,
            role: 'system' as const,
            content: '',
            timestamp: now,
            isCompactSummary: true,
          } as MessageWithThought,
          {
            id: `msg_compact_summary_${now}`,
            role: 'assistant' as const,
            content: summaryContent,
            timestamp: now,
            segments: [{ id: `seg_summary_${now}`, type: 'answer' as const, content: summaryContent }],
          } as MessageWithThought,
        ]

        updateConvMessages(convId, () => compactedMsgs)
        setMessages(compactedMsgs)

        await window.electronAPI.conversation.update({
          id: convId,
          messages_json: JSON.stringify(compactedMsgs),
          message_count: compactedMsgs.length,
          last_message_at: Math.floor(Date.now() / 1000),
        }).catch(() => {})
      }

      if (result?.stats) {
        _persistentContextStats.set(convId, result.stats)
        setContextStats(prev => ({ ...prev, [convId]: result.stats }))
      }
    } catch (err) {
      console.error('Compact failed:', err)
    } finally {
      setIsCompacting(false)
    }
  }, [id, isCompacting, isStreaming, selectedLlmProviderId, selectedLlmModelId, providers, selectedCollectionIds, enableThinking, minimalMode, updateConvMessages, conversationMessagesRef, activeConversationIdRef])

  return {
    employee,
    conversations,
    allConversations,
    activeConversationId,
    messages,
    isStreaming,
    isCreatingConversation,
    loadingConversationId,
    getInputDraft,
    setInputDraft,
    getInputModels,
    setInputModels,
    inputDefaultModel,
    setInputDefaultModel,
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
    handleDeleteComparisonMessage,
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
    clearActiveConversation,
    deleteConversation,
    deleteSelectedConversations,
    deleteAllConversations,
    moveConversation,
    startEditTitle,
    saveEditTitle,
    cancelEditTitle,
    handleEditKeyDown,
    startNewConversation,
    refreshConversationList,
    loadMoreConversations,
    handleConversationListScroll,
    handleCopy,
    handleDeleteMessage,
    handleRegenerate,
    handleSwitchModelRegenerate,
    handleEditAndResubmit,
    handleExportConversation,
    handleSwitchBranch,
    handleBranchMessage,
    handleToggleSegment,
    getToolDisplayName,
    isConversationStreaming,
    generateConversationTitle,
    contextStats: currentContextStats,
    isCompacting,
    handleCompact,
  }
}

export default useEmployeeChat
