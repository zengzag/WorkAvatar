import { useState, useEffect, useRef, useCallback } from 'react'
import type { MessageWithThought } from '../components/workbench'
import { ensureSegments, patchMissingCompletedAt } from '../components/workbench'
import { generateId } from '../utils/format'
import { buildEnrichedHistory, type ConversationStreamState, type EnrichedHistoryMessage } from './chat-helpers'

/**
 * 通用对话事件（由调用方的事件源转换为统一格式）。
 * 宿主场景：window.electronAPI.llm.onChunk 等 → 转换为本事件
 * 插件场景：dm.onChatEvent → 转换为本事件
 */
export type GenericChatEvent =
  | { type: 'chunk'; sessionId: string; text: string }
  | { type: 'thought'; sessionId: string; thought: string }
  | { type: 'tool-call'; sessionId: string; toolCall: { id: string; name: string; args: any } }
  | { type: 'tool-call-delta'; sessionId: string; deltas: Array<{ index: number; id?: string; name?: string; arguments: string }> }
  | { type: 'tool-result'; sessionId: string; name: string; result: any; rawResult?: any; generatedFiles?: any; success?: boolean }
  | { type: 'tool-progress'; sessionId: string; toolCallId: string; name: string; progress: any }
  | { type: 'done'; sessionId: string; metadata?: any }
  | { type: 'error'; sessionId: string; error: string }

export interface GenericChatSendParams {
  messages: EnrichedHistoryMessage[]
  providerId: string
  modelId?: string
  conversationId?: string
}

export interface UseGenericChatParams {
  /** 发送消息（由调用方实现，返回 sessionId 或 conversationId） */
  send: (params: GenericChatSendParams) => Promise<{ sessionId?: string; conversationId?: string }>
  /** 订阅流式事件（由调用方实现，返回取消订阅函数） */
  subscribe: (handler: (event: GenericChatEvent) => void) => () => void
  /** 会话持久化（可选，由调用方实现） */
  persist?: (conversationId: string, messages: MessageWithThought[]) => void
  /** 当前对话 id（可选，外部控制） */
  conversationId?: string | null
}

/**
 * 通用对话 hook：不依赖数字员工，通过参数注入发送函数与事件源。
 * 提供对话/消息/流式/分支/对比/压缩等通用能力，宿主与插件均可复用。
 */
export const useGenericChat = ({ send, subscribe, persist, conversationId: externalConvId }: UseGenericChatParams) => {
  const [messages, setMessages] = useState<MessageWithThought[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(externalConvId ?? null)
  const [chatError, setChatError] = useState<string | null>(null)

  const messagesRef = useRef<MessageWithThought[]>([])
  const isStreamingRef = useRef(false)
  const conversationIdRef = useRef<string | null>(externalConvId ?? null)
  const streamStatesRef = useRef<Map<string, ConversationStreamState>>(new Map())
  const segCounterRef = useRef(0)
  const toolCallCounterRef = useRef(0)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])
  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  const updateMessages = useCallback((updater: (prev: MessageWithThought[]) => MessageWithThought[]) => {
    setMessages((prev) => {
      const next = updater(prev)
      messagesRef.current = next
      return next
    })
  }, [])

  const persistMessages = useCallback((convId: string, msgs: MessageWithThought[]) => {
    persist?.(convId, msgs)
  }, [persist])

  // 订阅流式事件
  useEffect(() => {
    const unsub = subscribe((event) => {
      const streamState = streamStatesRef.current.get(event.sessionId)
      if (!streamState) return

      switch (event.type) {
        case 'chunk': {
          updateMessages((prev) =>
            prev.map((m) => {
              if (m.id !== streamState.assistantMessageId) return m
              const segs = [...(m.segments || [])]
              const lastSeg = segs[segs.length - 1]
              if (lastSeg && lastSeg.type === 'answer' && lastSeg.isStreaming) {
                segs[segs.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + event.text }
              } else {
                segs.push({
                  type: 'answer',
                  id: `${streamState.assistantMessageId}_seg_${segCounterRef.current++}`,
                  content: event.text,
                  isStreaming: true,
                  timestamp: Date.now(),
                })
              }
              return { ...m, segments: segs, content: (m.content || '') + event.text }
            })
          )
          break
        }
        case 'thought': {
          updateMessages((prev) =>
            prev.map((m) => {
              if (m.id !== streamState.assistantMessageId) return m
              const segs = [...(m.segments || [])]
              const lastSeg = segs[segs.length - 1]
              if (lastSeg && lastSeg.type === 'thinking' && lastSeg.isStreaming) {
                segs[segs.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + event.thought }
              } else {
                segs.push({
                  type: 'thinking',
                  id: `${streamState.assistantMessageId}_seg_${segCounterRef.current++}`,
                  content: event.thought,
                  isStreaming: true,
                  collapsed: false,
                  timestamp: Date.now(),
                })
              }
              return { ...m, segments: segs, thought: (m.thought || '') + event.thought }
            })
          )
          break
        }
        case 'tool-call': {
          updateMessages((prev) =>
            prev.map((m) => {
              if (m.id !== streamState.assistantMessageId) return m
              const segs = [...(m.segments || [])]
              segs.push({
                type: 'tool_call',
                id: `${streamState.assistantMessageId}_tool_${toolCallCounterRef.current++}`,
                toolName: event.toolCall.name,
                toolCallId: event.toolCall.id,
                toolArgs: event.toolCall.args,
                isToolComplete: false,
                collapsed: true,
                timestamp: Date.now(),
              })
              return { ...m, segments: segs }
            })
          )
          break
        }
        case 'tool-result': {
          updateMessages((prev) =>
            prev.map((m) => {
              if (m.id !== streamState.assistantMessageId) return m
              const segs = [...(m.segments || [])]
              const lastIncompleteIndex = [...segs].reverse().findIndex(
                s => s.type === 'tool_call' && s.toolName === event.name && !s.isToolComplete
              )
              if (lastIncompleteIndex === -1) return m
              const actualIndex = segs.length - 1 - lastIncompleteIndex
              segs[actualIndex] = {
                ...segs[actualIndex],
                toolResult: event.result,
                isToolComplete: true,
                toolError: event.success === false ? (typeof event.result === 'string' ? event.result : undefined) : undefined,
                collapsed: true,
                completedAt: Date.now(),
                generatedFiles: event.generatedFiles && event.generatedFiles.length > 0 ? event.generatedFiles : undefined,
              }
              return { ...m, segments: segs }
            })
          )
          break
        }
        case 'done': {
          updateMessages((prev) => {
            const assistantMsg = prev.find((m) => m.id === streamState.assistantMessageId)
            if (!assistantMsg) return prev
            const segs = (assistantMsg.segments || []).map(s => ({
              ...s,
              isStreaming: false,
              completedAt: s.completedAt || Date.now(),
              ...(s.type === 'thinking' ? { collapsed: true } : {}),
            }))
            const savedMsg: MessageWithThought = {
              ...assistantMsg,
              isStreaming: false,
              segments: segs,
              tokenUsage: event.metadata?.tokenUsage,
              isAborted: event.metadata?.aborted === true,
            }
            const next = prev.map((m) => (m.id === streamState.assistantMessageId ? savedMsg : m))
            persistMessages(streamState.conversationId, next)
            return next
          })
          streamState.isStreaming = false
          streamStatesRef.current.delete(event.sessionId)
          const anyStreaming = Array.from(streamStatesRef.current.values()).some(s => s.isStreaming)
          if (!anyStreaming) {
            setIsStreaming(false)
            isStreamingRef.current = false
          }
          break
        }
        case 'error': {
          updateMessages((prev) =>
            prev.map((m) =>
              m.id === streamState.assistantMessageId
                ? { ...m, content: event.error, isStreaming: false, isError: true }
                : m
            )
          )
          streamState.isStreaming = false
          streamStatesRef.current.delete(event.sessionId)
          const anyStreaming = Array.from(streamStatesRef.current.values()).some(s => s.isStreaming)
          if (!anyStreaming) {
            setIsStreaming(false)
            isStreamingRef.current = false
          }
          setChatError(event.error)
          break
        }
      }
    })
    return unsub
  }, [subscribe, updateMessages, persistMessages])

  const handleSend = useCallback(async (content: string, providerId: string, modelId?: string) => {
    const trimmed = content.trim()
    if (!trimmed || isStreamingRef.current) return

    const userMessage: MessageWithThought = {
      id: `msg_${generateId()}`,
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    }
    const assistantMessage: MessageWithThought = {
      id: `msg_${generateId()}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      segments: [],
    }

    const currentMsgs = messagesRef.current
    const updated = [...currentMsgs, userMessage, assistantMessage]
    updateMessages(() => updated)
    setIsStreaming(true)
    isStreamingRef.current = true
    setChatError(null)

    const streamState: ConversationStreamState = {
      isStreaming: true,
      conversationId: conversationIdRef.current || '',
      assistantMessageId: assistantMessage.id,
      segCounter: 0,
      toolCallCounter: 0,
      runCounter: 0,
      groupSeq: 0,
    }

    try {
      const history = buildEnrichedHistory([...currentMsgs, userMessage])
      const result = await send({
        messages: history,
        providerId,
        modelId,
        conversationId: conversationIdRef.current || undefined,
      })
      if (result?.sessionId) {
        streamStatesRef.current.set(result.sessionId, streamState)
      }
      if (result?.conversationId) {
        setConversationId(result.conversationId)
        conversationIdRef.current = result.conversationId
        streamState.conversationId = result.conversationId
      }
    } catch (e: any) {
      streamState.isStreaming = false
      setIsStreaming(false)
      isStreamingRef.current = false
      setChatError(e?.message || String(e))
    }
  }, [send, updateMessages])

  const handleStop = useCallback(() => {
    for (const [, ss] of streamStatesRef.current) {
      if (ss.isStreaming) {
        ss.isStreaming = false
        // 调用方需提供 abort 能力（通过 send 返回的 sessionId 关联）
        // 宿主场景：window.electronAPI.llm.abortChat(sessionId)
        // 插件场景：dm.cancelChat()
      }
    }
    setIsStreaming(false)
    isStreamingRef.current = false
  }, [])

  const newChat = useCallback(() => {
    setMessages([])
    messagesRef.current = []
    setConversationId(null)
    conversationIdRef.current = null
    setIsStreaming(false)
    isStreamingRef.current = false
    setChatError(null)
    streamStatesRef.current.clear()
  }, [])

  const loadHistory = useCallback((msgs: MessageWithThought[], convId: string) => {
    const normalized = msgs.map(m => patchMissingCompletedAt(ensureSegments(m)))
    setMessages(normalized)
    messagesRef.current = normalized
    setConversationId(convId)
    conversationIdRef.current = convId
  }, [])

  return {
    messages,
    isStreaming,
    conversationId,
    chatError,
    handleSend,
    handleStop,
    newChat,
    loadHistory,
  }
}
