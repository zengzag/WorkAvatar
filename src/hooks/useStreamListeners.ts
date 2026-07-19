import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageWithThought } from '../components/workbench'
import type { LRUCache } from '../utils/lru-cache'
import {
  type ConversationStreamState,
  calcTotalOutputChars,
} from './chat-helpers'

export interface StreamListenerDeps {
  streamStatesRef: React.MutableRefObject<Map<string, ConversationStreamState>>
  conversationMessagesRef: React.MutableRefObject<LRUCache<string, MessageWithThought[]>>
  activeConversationIdRef: React.MutableRefObject<string | null>
  activeConvIdStorageKey: string | null
  updateConvMessages: (convId: string, updater: (prev: MessageWithThought[]) => MessageWithThought[]) => void
  setIsStreaming: (v: boolean) => void
  isStreamingRef: React.MutableRefObject<boolean>
  updateConvLastMessageAt: (convId: string, timestamp: number) => void
}

let _persistentListenersCleanup: (() => void) | null = null
let _persistentEmployeeId: string | null = null

export const getPersistentListenersCleanup = () => _persistentListenersCleanup
export const setPersistentListenersCleanup = (fn: (() => void) | null) => { _persistentListenersCleanup = fn }
export const getPersistentEmployeeId = () => _persistentEmployeeId
export const setPersistentEmployeeId = (id: string | null) => { _persistentEmployeeId = id }

export const useStreamListeners = (deps: StreamListenerDeps) => {
  const { t } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t
  const depsRef = useRef(deps)
  depsRef.current = deps

  const setupGlobalListeners = useCallback(() => {
    if (_persistentListenersCleanup) {
      _persistentListenersCleanup()
      _persistentListenersCleanup = null
    }

    const {
      streamStatesRef,
      activeConvIdStorageKey,
      updateConvMessages,
      setIsStreaming,
      isStreamingRef,
      updateConvLastMessageAt,
    } = depsRef.current

    const tt = tRef.current

    const chunkCleanup = window.electronAPI.llm.onChunk((data: { sessionId: string; chunk?: string; chunks?: string[] }) => {
      const { sessionId } = data
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

    const toolCallDeltaCleanup = window.electronAPI.llm.onToolCallDelta((data: { sessionId: string; deltas: Array<{ index: number; id?: string; name?: string; arguments: string }> }) => {
      const { sessionId, deltas } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      updateConvMessages(streamState.conversationId, (prev) =>
        prev.map((m) => {
          if (m.id !== streamState.assistantMessageId) return m
          const segs = [...(m.segments || [])]

          for (const delta of deltas) {
            const { index, id, name, arguments: argsText } = delta

            let targetIndex = -1
            if (id) {
              targetIndex = segs.findIndex(s => s.type === 'tool_call' && s.toolCallId === id)
            }
            if (targetIndex === -1) {
              targetIndex = segs.findIndex(s => s.type === 'tool_call' && s.isToolArgsStreaming && s.toolCallId === `delta_${index}`)
            }
            if (targetIndex === -1 && name) {
              targetIndex = segs.findIndex(s => s.type === 'tool_call' && s.isToolArgsStreaming && s.toolName === name && !s.isToolComplete)
            }

            // 关闭正在流式输出的 answer/thinking 段
            const lastSeg = segs[segs.length - 1]
            if (lastSeg && lastSeg.type === 'answer' && lastSeg.isStreaming) {
              segs[segs.length - 1] = { ...lastSeg, isStreaming: false, completedAt: Date.now() }
            }
            if (lastSeg && lastSeg.type === 'thinking' && lastSeg.isStreaming) {
              segs[segs.length - 1] = { ...lastSeg, isStreaming: false, collapsed: true, completedAt: Date.now() }
            }

            if (targetIndex !== -1) {
              segs[targetIndex] = {
                ...segs[targetIndex],
                toolName: name || segs[targetIndex].toolName,
                toolCallId: id || segs[targetIndex].toolCallId,
                toolArgsRaw: argsText,
              }
            } else {
              segs.push({
                type: 'tool_call',
                id: `${streamState.assistantMessageId}_tool_${streamState.toolCallCounter++}`,
                toolName: name || '',
                toolCallId: id || `delta_${index}`,
                isToolArgsStreaming: true,
                toolArgsRaw: argsText,
                isToolComplete: false,
                collapsed: false,
                timestamp: Date.now(),
              })
            }
          }
          return { ...m, segments: segs }
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

          // 优先复用 delta 阶段已创建的 streaming segment
          let targetIndex = segs.findIndex(s =>
            s.type === 'tool_call' && s.isToolArgsStreaming &&
            (s.toolCallId === toolCallId || (s.toolName === name && !s.isToolComplete))
          )

          if (targetIndex !== -1) {
            segs[targetIndex] = {
              ...segs[targetIndex],
              toolName: name,
              toolArgs: args,
              toolArgsRaw: undefined,
              isToolArgsStreaming: false,
              toolCallId,
              isToolComplete: false,
              collapsed: true,
            }
          } else {
            // 无 delta 预创建的 segment，走原有逻辑
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
          }
          return { ...m, segments: segs }
        })
      )
    })

    const toolResultCleanup = window.electronAPI.llm.onToolResult((data: { sessionId: string; name: string; result: any; generatedFiles?: any }) => {
      const { sessionId, name, result, generatedFiles } = data
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
          segs[actualIndex] = {
            ...segs[actualIndex],
            toolResult: result,
            isToolComplete: true,
            // 清除可能残留的 toolError（如 doneCleanup 标记的中断态），优先展示真实结果
            toolError: undefined,
            collapsed: true,
            completedAt: Date.now(),
            generatedFiles: generatedFiles && generatedFiles.length > 0 ? generatedFiles : undefined,
          }
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
          // 清理参数流式生成残留状态（LLM 中断或异常时 delta segment 可能未转为执行态）
          if (s.type === 'tool_call' && s.isToolArgsStreaming) {
            let parsedArgs = s.toolArgs
            if (!parsedArgs && s.toolArgsRaw) {
              try { parsedArgs = JSON.parse(s.toolArgsRaw) } catch { /* incomplete JSON, keep raw */ }
            }
            return {
              ...s,
              isStreaming: false,
              isToolArgsStreaming: false,
              isToolComplete: true,
              toolArgs: parsedArgs,
              toolError: tt('workbench.toolCancelled'),
              completedAt,
              collapsed: true,
            }
          }
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
      streamStatesRef.current.delete(sessionId)

      const anyStreaming = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === streamState.conversationId && s.isStreaming)
      if (!anyStreaming) {
        setIsStreaming(false)
        isStreamingRef.current = false
        if (activeConvIdStorageKey && localStorage.getItem(activeConvIdStorageKey) === streamState.conversationId) {
          localStorage.removeItem(activeConvIdStorageKey)
        }
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
            ? {
                ...m,
                content: tt('workbench.errorMsg', { error }),
                isStreaming: false,
                isError: true,
                segments: (m.segments || []).map(s => {
                  // 工具调用未完成时标记为失败，避免 UI 永远停留在"生成参数中"/"执行中"
                  if (s.type === 'tool_call' && !s.isToolComplete) {
                    let parsedArgs = s.toolArgs
                    if (s.isToolArgsStreaming && !parsedArgs && s.toolArgsRaw) {
                      try { parsedArgs = JSON.parse(s.toolArgsRaw) } catch { /* JSON 不完整 */ }
                    }
                    return {
                      ...s,
                      isStreaming: false,
                      isToolArgsStreaming: false,
                      isToolComplete: true,
                      toolArgs: parsedArgs,
                      toolError: tt('workbench.toolFailed'),
                      completedAt: s.completedAt || Date.now(),
                      collapsed: true,
                    }
                  }
                  return { ...s, isStreaming: false, isToolArgsStreaming: false, completedAt: s.completedAt || Date.now() }
                }),
              }
            : m
        )
      )

      streamState.isStreaming = false
      streamStatesRef.current.delete(sessionId)

      const anyStreaming = Array.from(streamStatesRef.current.values()).some(s => s.conversationId === streamState.conversationId && s.isStreaming)
      if (!anyStreaming) {
        setIsStreaming(false)
        isStreamingRef.current = false
        if (activeConvIdStorageKey && localStorage.getItem(activeConvIdStorageKey) === streamState.conversationId) {
          localStorage.removeItem(activeConvIdStorageKey)
        }
        updateConvLastMessageAt(streamState.conversationId, Math.floor(Date.now() / 1000))
      }
    })

    const cleanup = () => {
      chunkCleanup()
      thoughtCleanup()
      toolCallDeltaCleanup()
      toolCallCleanup()
      toolResultCleanup()
      toolProgressCleanup()
      doneCleanup()
      errorCleanup()
    }
    _persistentListenersCleanup = cleanup
  }, [])

  return { setupGlobalListeners }
}
