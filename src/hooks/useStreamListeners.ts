import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageWithThought } from '../components/workbench'
import type { MessageSegment } from '../components/workbench/types'
import type { GeneratedFileInfo } from '../types'
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
  onContextStats?: (convId: string, stats: any) => void
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
                // argsText 是 JSON 字符串的增量片段，需累加成完整 JSON 字符串
                toolArgsRaw: (segs[targetIndex].toolArgsRaw || '') + argsText,
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

          // delegate_to_employee 特殊处理：创建 delegation segment 而非普通 tool_call
          if (name === 'delegate_to_employee') {
            // 移除 delta 阶段残留的 tool_call segment（通过 toolCallId 或 toolName 匹配）
            let filteredSegs = segs.filter(s => {
              if (s.type !== 'tool_call' || !s.isToolArgsStreaming) return true
              if (toolCallId && s.toolCallId === toolCallId) return false
              if (s.toolName === name) return false
              return true
            })

            // 防御：run start 事件可能先于 onToolCall 到达并已建卡（start 早到时已带 runId/名称）。
            // 若已存在同一委托的绑定卡，则复用并把工具参数补全上去，不再新建裸卡，避免出现
            // "正常委托卡 + 委托给未知员工卡"的重复卡。
            // 匹配优先级：toolCallId / targetEmployeeId / 尚未绑定工具调用的 start 裸卡（当前委托只此一张）。
            const existingIdx = filteredSegs.findIndex(s =>
              s.type === 'delegation' &&
              (s.runId || s.delegationId) &&
              (
                s.toolCallId === toolCallId ||
                (args?.target_employee_id && s.targetEmployeeId === args.target_employee_id) ||
                (!s.toolCallId && (s.delegationStatus === 'queued' || s.delegationStatus === 'streaming'))
              )
            )
            if (existingIdx !== -1) {
              filteredSegs[existingIdx] = {
                ...filteredSegs[existingIdx],
                toolCallId,
                toolName: name,
                toolArgs: args,
                instruction: args?.instruction ?? filteredSegs[existingIdx].instruction,
                targetEmployeeId: args?.target_employee_id ?? filteredSegs[existingIdx].targetEmployeeId,
              }
              return { ...m, segments: filteredSegs }
            }

            // 清理本 toolCall 残留的"未绑定 runId"裸 delegation 卡（start 先到又未被复用的脏数据），
            // 保证任意时序下同一次委托只存在一张卡。
            filteredSegs = filteredSegs.filter(s => !(s.type === 'delegation' && s.toolCallId === toolCallId))

            // 关闭正在流式输出的 answer/thinking 段
            const lastSeg = filteredSegs[filteredSegs.length - 1]
            if (lastSeg && lastSeg.type === 'answer' && lastSeg.isStreaming) {
              filteredSegs[filteredSegs.length - 1] = { ...lastSeg, isStreaming: false, completedAt: Date.now() }
            }
            if (lastSeg && lastSeg.type === 'thinking' && lastSeg.isStreaming) {
              filteredSegs[filteredSegs.length - 1] = { ...lastSeg, isStreaming: false, collapsed: true, completedAt: Date.now() }
            }
            filteredSegs.push({
              type: 'delegation',
              id: `${streamState.assistantMessageId}_del_${streamState.toolCallCounter++}`,
              toolCallId,
              toolName: name,
              toolArgs: args,
              instruction: args?.instruction,
              targetEmployeeId: args?.target_employee_id,
              delegationStatus: 'streaming',
              subSegments: [],
              isToolComplete: false,
              collapsed: false,
              timestamp: Date.now(),
            })
            return { ...m, segments: filteredSegs }
          }

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

    const toolResultCleanup = window.electronAPI.llm.onToolResult((data: { sessionId: string; name: string; result: any; rawResult?: any; generatedFiles?: any; success?: boolean }) => {
      const { sessionId, name, result, rawResult, generatedFiles, success } = data
      const streamState = streamStatesRef.current.get(sessionId)
      if (!streamState) return

      updateConvMessages(streamState.conversationId, (prev) =>
        prev.map((m) => {
          if (m.id !== streamState.assistantMessageId) return m
          const segs = [...(m.segments || [])]

          // launch_agents 特殊处理：按 runIds 建立/更新并行组 delegation 段（同组横排渲染）
          if (name === 'launch_agents') {
            // 收尾 launch_agents 自身的工具调用卡（并行派发立即返回，不代表子任务完成；
            // 各子任务状态由 run 事件独立驱动），避免该卡片永远停留在"执行中"
            const wrapperIdx = segs.findIndex(s => s.type === 'tool_call' && s.toolName === 'launch_agents' && !s.isToolComplete)
            if (wrapperIdx !== -1) {
              segs[wrapperIdx] = {
                ...segs[wrapperIdx],
                toolResult: result,
                isToolComplete: true,
                toolError: undefined,
                collapsed: true,
                completedAt: Date.now(),
              }
            }
            const runIds: string[] = Array.isArray(rawResult?.runIds) ? rawResult.runIds : []
            if (runIds.length > 0) {
              const groupRunId = `grp_${streamState.assistantMessageId}_${streamState.groupSeq++}`
              const parallelTotal = runIds.length
              for (let gi = 0; gi < runIds.length; gi++) {
                const rid = runIds[gi]
                const existingIdx = segs.findIndex(s => s.type === 'delegation' && (s.runId === rid || s.delegationId === rid))
                if (existingIdx !== -1) {
                  segs[existingIdx] = { ...segs[existingIdx], groupRunId, runGroupIndex: gi, parallelTotal }
                } else {
                  const lastSeg = segs[segs.length - 1]
                  if (lastSeg && lastSeg.type === 'answer' && lastSeg.isStreaming) {
                    segs[segs.length - 1] = { ...lastSeg, isStreaming: false, completedAt: Date.now() }
                  }
                  if (lastSeg && lastSeg.type === 'thinking' && lastSeg.isStreaming) {
                    segs[segs.length - 1] = { ...lastSeg, isStreaming: false, collapsed: true, completedAt: Date.now() }
                  }
                  segs.push({
                    type: 'delegation',
                    id: `${streamState.assistantMessageId}_run_${streamState.runCounter++}`,
                    runId: rid,
                    delegationId: rid,
                    runGroupIndex: gi,
                    parallelTotal,
                    groupRunId,
                    delegationStatus: 'queued',
                    subSegments: [],
                    isToolComplete: false,
                    collapsed: false,
                    timestamp: Date.now(),
                  })
                }
              }
              return { ...m, segments: segs }
            }
          }

          // delegate_to_employee 特殊处理：从 rawResult 提取 delegationId/tokenUsage/targetEmployeeName
          if (name === 'delegate_to_employee') {
            const delId = rawResult?.delegationId
            let delIdx = delId
              ? segs.findIndex(s => s.type === 'delegation' && (s.delegationId === delId || s.runId === delId))
              : -1
            if (delIdx === -1) {
              // fallback：取最后一个尚未收尾的 delegation segment
              delIdx = segs.findIndex(s => s.type === 'delegation' && (s.delegationStatus === 'streaming' || s.delegationStatus === 'queued'))
            }
            if (delIdx === -1) return m
            // delegate 业务成功判断：优先从 rawResult.success（delegate.tool 返回的业务结果）
            // 顶层 success 是"工具调用是否成功"（基于 isError），不代表委派业务成功
            const isSuccess = rawResult?.success !== undefined ? !!rawResult.success : (success !== undefined ? success : true)
            const targetName = rawResult?.targetEmployeeName || segs[delIdx].targetEmployeeName
            segs[delIdx] = {
              ...segs[delIdx],
              delegationId: delId || segs[delIdx].delegationId,
              targetEmployeeName: targetName,
              delegationStatus: isSuccess ? 'completed' : 'failed',
              resultSummary: typeof result === 'string' ? result : (rawResult?.output || rawResult?.error),
              toolResult: result,
              isToolComplete: true,
              toolError: isSuccess ? undefined : (rawResult?.error || (typeof result === 'string' ? result : undefined)),
              delegationTokenUsage: rawResult?.tokenUsage || segs[delIdx].delegationTokenUsage,
              collapsed: true,
              completedAt: Date.now(),
            }
            return { ...m, segments: segs }
          }

          const lastIncompleteIndex = [...segs].reverse().findIndex(
            s => s.type === 'tool_call' && s.toolName === name && !s.isToolComplete
          )
          if (lastIncompleteIndex === -1) return m
          const actualIndex = segs.length - 1 - lastIncompleteIndex
          // 优先用顶层 success 字段判断工具执行结果，无则默认成功（保持兼容）
          const toolSuccess = success !== undefined ? success : true
          segs[actualIndex] = {
            ...segs[actualIndex],
            toolResult: result,
            isToolComplete: true,
            toolError: toolSuccess ? undefined : (typeof result === 'string' ? result : (rawResult?.error || undefined)),
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

    // ---- 委托事件路由：将子员工 chatStream 事件写入对应 delegation segment 的 subSegments ----

    /** 将子员工事件应用到 delegation segment 的 subSegments 数组（复用主管事件处理逻辑，目标改为 subSegments） */
    const applyRunSubEvent = (
      subSegs: MessageSegment[],
      eventType: string,
      data: any,
      idPrefix: string
    ): MessageSegment[] => {
      const segs = [...subSegs]

      switch (eventType) {
        case 'start':
          return segs

        case 'thought': {
          const thought = typeof data === 'string' ? data : data?.thought
          if (!thought) return segs
          for (let i = 0; i < segs.length; i++) {
            if (segs[i].isStreaming && segs[i].type !== 'thinking') {
              segs[i] = { ...segs[i], isStreaming: false, completedAt: Date.now() }
            }
          }
          const last = segs[segs.length - 1]
          if (last && last.type === 'thinking' && last.isStreaming) {
            segs[segs.length - 1] = { ...last, content: (last.content || '') + thought }
          } else {
            segs.push({
              type: 'thinking',
              id: `${idPrefix}_th_${Date.now()}`,
              content: thought,
              isStreaming: true,
              collapsed: false,
              timestamp: Date.now(),
            })
          }
          return segs
        }

        case 'chunk': {
          const chunk = typeof data === 'string' ? data : data?.chunk
          if (!chunk) return segs
          for (let i = 0; i < segs.length; i++) {
            if (segs[i].isStreaming && segs[i].type === 'thinking') {
              segs[i] = { ...segs[i], isStreaming: false, collapsed: true, completedAt: Date.now() }
            }
          }
          const last = segs[segs.length - 1]
          if (last && last.type === 'answer' && last.isStreaming) {
            segs[segs.length - 1] = { ...last, content: (last.content || '') + chunk }
          } else {
            segs.push({
              type: 'answer',
              id: `${idPrefix}_an_${Date.now()}`,
              content: chunk,
              isStreaming: true,
              timestamp: Date.now(),
            })
          }
          return segs
        }

        case 'tool_call_delta': {
          const deltas: Array<{ index: number; id?: string; name?: string; arguments: string }> =
            data?.deltas || (Array.isArray(data) ? data : [data])
          const last = segs[segs.length - 1]
          if (last && last.type === 'answer' && last.isStreaming) {
            segs[segs.length - 1] = { ...last, isStreaming: false, completedAt: Date.now() }
          }
          if (last && last.type === 'thinking' && last.isStreaming) {
            segs[segs.length - 1] = { ...last, isStreaming: false, collapsed: true, completedAt: Date.now() }
          }
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
            if (targetIndex !== -1) {
              segs[targetIndex] = {
                ...segs[targetIndex],
                toolName: name || segs[targetIndex].toolName,
                toolCallId: id || segs[targetIndex].toolCallId,
                // argsText 是 JSON 字符串的增量片段，需累加成完整 JSON 字符串
                toolArgsRaw: (segs[targetIndex].toolArgsRaw || '') + argsText,
              }
            } else {
              segs.push({
                type: 'tool_call',
                id: `${idPrefix}_tc_${Date.now()}_${index}`,
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
          return segs
        }

        case 'tool_call': {
          const { id: toolCallId, name, args } = data
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
            const last = segs[segs.length - 1]
            if (last && last.type === 'answer' && last.isStreaming) {
              segs[segs.length - 1] = { ...last, isStreaming: false, completedAt: Date.now() }
            }
            if (last && last.type === 'thinking' && last.isStreaming) {
              segs[segs.length - 1] = { ...last, isStreaming: false, collapsed: true, completedAt: Date.now() }
            }
            segs.push({
              type: 'tool_call',
              id: `${idPrefix}_tc_${Date.now()}`,
              toolName: name,
              toolArgs: args,
              toolCallId,
              isToolComplete: false,
              collapsed: true,
              timestamp: Date.now(),
            })
          }
          return segs
        }

        case 'tool_result': {
          const { name, result } = data
          const lastIncompleteIndex = [...segs].reverse().findIndex(
            s => s.type === 'tool_call' && s.toolName === name && !s.isToolComplete
          )
          if (lastIncompleteIndex === -1) return segs
          const actualIndex = segs.length - 1 - lastIncompleteIndex
          segs[actualIndex] = {
            ...segs[actualIndex],
            toolResult: result,
            isToolComplete: true,
            toolError: undefined,
            collapsed: true,
            completedAt: Date.now(),
          }
          return segs
        }

        case 'tool_progress': {
          const { toolCallId, name, progress } = data
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
          if (targetIndex === -1) return segs
          const existingProgress = segs[targetIndex].toolProgress || []
          segs[targetIndex] = {
            ...segs[targetIndex],
            toolProgress: [...existingProgress, progress],
          }
          return segs
        }

        case 'done': {
          // 关闭子员工所有流式段
          for (let i = 0; i < segs.length; i++) {
            if (segs[i].isStreaming || segs[i].isToolArgsStreaming) {
              segs[i] = {
                ...segs[i],
                isStreaming: false,
                isToolArgsStreaming: false,
                isToolComplete: segs[i].isToolComplete ?? true,
                completedAt: segs[i].completedAt || Date.now(),
                ...(segs[i].type === 'thinking' ? { collapsed: true } : {}),
              }
            }
          }
          return segs
        }

        case 'error': {
          const error = typeof data === 'string' ? data : data?.error
          for (let i = 0; i < segs.length; i++) {
            if (segs[i].type === 'tool_call' && !segs[i].isToolComplete) {
              segs[i] = {
                ...segs[i],
                isStreaming: false,
                isToolArgsStreaming: false,
                isToolComplete: true,
                toolError: error || tt('workbench.toolFailed'),
                completedAt: segs[i].completedAt || Date.now(),
                collapsed: true,
              }
            } else if (segs[i].isStreaming) {
              segs[i] = { ...segs[i], isStreaming: false, completedAt: segs[i].completedAt || Date.now() }
            }
          }
          return segs
        }

        default:
          return segs
      }
    }

    const runCleanup = window.electronAPI.llm.onRunEvent((event: {
      parentSessionId: string
      runId: string
      eventType: string
      data: any
    }) => {
      const { parentSessionId, runId, eventType, data: eventData } = event
      const streamState = streamStatesRef.current.get(parentSessionId)
      if (!streamState) return

      updateConvMessages(streamState.conversationId, (prev) =>
        prev.map((m) => {
          if (m.id !== streamState.assistantMessageId) return m
          const segs = [...(m.segments || [])]

          // 定位 run 段：优先按 runId（delegationId 兼容）；start 事件到达时兜底
          let idx = segs.findIndex(s => s.type === 'delegation' && (s.runId === runId || s.delegationId === runId))
          if (idx === -1 && eventType === 'start') {
            // 先尝试绑定 toolCall 阶段预创建的 delegation 段（无 runId 的 streaming/queued 段），
            // 避免 delegate_to_employee 出现"工具调用卡片 + run 事件卡片"重复卡片
            const pendingIdx = segs.findIndex(s =>
              s.type === 'delegation' && !s.runId && !s.delegationId &&
              (s.delegationStatus === 'streaming' || s.delegationStatus === 'queued')
            )
            if (pendingIdx !== -1) {
              idx = pendingIdx
              segs[pendingIdx] = {
                ...segs[pendingIdx],
                runId,
                delegationId: runId,
                targetEmployeeId: eventData?.targetEmployeeId || segs[pendingIdx].targetEmployeeId,
                targetEmployeeName: eventData?.targetEmployeeName || segs[pendingIdx].targetEmployeeName,
                targetAvatarType: eventData?.targetAvatarType || segs[pendingIdx].targetAvatarType,
                instruction: eventData?.instruction || segs[pendingIdx].instruction,
              }
            } else {
              const lastSeg = segs[segs.length - 1]
              if (lastSeg && lastSeg.type === 'answer' && lastSeg.isStreaming) {
                segs[segs.length - 1] = { ...lastSeg, isStreaming: false, completedAt: Date.now() }
              }
              if (lastSeg && lastSeg.type === 'thinking' && lastSeg.isStreaming) {
                segs[segs.length - 1] = { ...lastSeg, isStreaming: false, collapsed: true, completedAt: Date.now() }
              }
              segs.push({
                type: 'delegation',
                id: `${streamState.assistantMessageId}_run_${streamState.runCounter++}`,
                runId,
                delegationId: runId,
                targetEmployeeId: eventData?.targetEmployeeId,
                targetEmployeeName: eventData?.targetEmployeeName || tt('workbench.delegationUnknown'),
                targetAvatarType: eventData?.targetAvatarType,
                instruction: eventData?.instruction,
                delegationStatus: 'queued',
                subSegments: [],
                isToolComplete: false,
                collapsed: false,
                timestamp: Date.now(),
              })
              idx = segs.length - 1
            }
          }
          if (idx === -1) return m

          const cur = segs[idx]

          // start：回填目标信息，叠加到现有段（并行组信息在 launch 工具 result 中补充）
          if (eventType === 'start') {
            segs[idx] = {
              ...cur,
              targetEmployeeId: eventData?.targetEmployeeId || cur.targetEmployeeId,
              targetEmployeeName: eventData?.targetEmployeeName || cur.targetEmployeeName,
              targetAvatarType: eventData?.targetAvatarType || cur.targetAvatarType,
              instruction: eventData?.instruction || cur.instruction,
              delegationStatus: cur.delegationStatus === 'queued' ? cur.delegationStatus : cur.delegationStatus,
            }
            return { ...m, segments: segs }
          }

          // status：状态迁移（queued → running → ...）
          if (eventType === 'status') {
            segs[idx] = {
              ...cur,
              delegationStatus: eventData?.status === 'running' ? 'streaming' : cur.delegationStatus,
            }
            return { ...m, segments: segs }
          }

          // result：结构化结果收尾（独立于工具 result，双通道幂等）
          if (eventType === 'result') {
            const st = eventData?.status
            const finalStatus = st === 'completed' ? 'completed' : st === 'cancelled' ? 'cancelled' : 'failed'
            const gen: GeneratedFileInfo[] = eventData?.generatedFiles || []
            const auto: GeneratedFileInfo[] = eventData?.autoDetectedFiles || []
            segs[idx] = {
              ...cur,
              delegationStatus: finalStatus,
              resultSummary: eventData?.summary || cur.resultSummary,
              runResult: {
                summary: eventData?.summary,
                generatedFiles: gen,
                autoDetectedFiles: auto,
                references: eventData?.references,
              },
              generatedFiles: [...gen, ...auto],
              delegationTokenUsage: eventData?.tokenUsage || cur.delegationTokenUsage,
              toolError: finalStatus === 'failed' ? (eventData?.error || cur.toolError) : cur.toolError,
              isToolComplete: true,
              collapsed: true,
              completedAt: Date.now(),
            }
            return { ...m, segments: segs }
          }

          // cancelled：显示已取消
          if (eventType === 'cancelled') {
            segs[idx] = {
              ...cur,
              delegationStatus: 'cancelled',
              toolError: eventData?.error || cur.toolError,
              isToolComplete: true,
              collapsed: true,
              completedAt: Date.now(),
            }
            return { ...m, segments: segs }
          }

          // error：记录错误（最终状态由后续 result 确认；若进程中断则展示失败）
          if (eventType === 'error') {
            segs[idx] = { ...cur, toolError: eventData?.error || cur.toolError }
            if (cur.delegationStatus !== 'completed' && cur.delegationStatus !== 'cancelled' && !segs[idx].isToolComplete) {
              segs[idx] = { ...segs[idx], delegationStatus: 'failed' }
            }
          }

          // done：更新 tokenUsage
          if (eventType === 'done') {
            segs[idx] = { ...segs[idx], delegationTokenUsage: eventData?.tokenUsage || segs[idx].delegationTokenUsage }
          }

          // 其余子会话内层事件 → subSegments
          const updatedSubSegs = applyRunSubEvent(
            segs[idx].subSegments || [],
            eventType,
            eventData,
            runId
          )
          segs[idx] = { ...segs[idx], subSegments: updatedSubSegs }
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
          // delegation 段兜底：主管会话结束时若委托仍在进行中，标记为失败（排队中则标记取消）
          if (s.type === 'delegation' && (s.delegationStatus === 'streaming' || s.delegationStatus === 'queued')) {
            const cancelled = s.delegationStatus === 'queued'
            return {
              ...s,
              delegationStatus: cancelled ? 'cancelled' as const : 'failed' as const,
              isToolComplete: true,
              toolError: s.toolError || tt(cancelled ? 'workbench.runCancelled' : 'workbench.toolCancelled'),
              completedAt,
              collapsed: true,
              subSegments: (s.subSegments || []).map(ss => ({
                ...ss,
                isStreaming: false,
                isToolArgsStreaming: false,
                isToolComplete: ss.isToolComplete ?? true,
                completedAt: ss.completedAt || completedAt,
                ...(ss.type === 'thinking' ? { collapsed: true } : {}),
              })),
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
          // 中止（用户停止/切换/异常中断）时标记，UI 展示中断提醒
          isAborted: metadata?.aborted === true,
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

      if (metadata?.contextStats) {
        depsRef.current.onContextStats?.(streamState.conversationId, metadata.contextStats)
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
                  // delegation 段兜底：主管出错时若委托仍在进行中，标记为失败（排队中则标记取消）
                  if (s.type === 'delegation' && (s.delegationStatus === 'streaming' || s.delegationStatus === 'queued')) {
                    const cancelled = s.delegationStatus === 'queued'
                    return {
                      ...s,
                      delegationStatus: cancelled ? 'cancelled' as const : 'failed' as const,
                      isToolComplete: true,
                      toolError: s.toolError || tt(cancelled ? 'workbench.runCancelled' : 'workbench.toolFailed'),
                      completedAt: s.completedAt || Date.now(),
                      collapsed: true,
                      subSegments: (s.subSegments || []).map(ss => ({
                        ...ss,
                        isStreaming: false,
                        isToolArgsStreaming: false,
                        isToolComplete: ss.isToolComplete ?? true,
                        completedAt: ss.completedAt || Date.now(),
                        ...(ss.type === 'thinking' ? { collapsed: true } : {}),
                      })),
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
      runCleanup()
      doneCleanup()
      errorCleanup()
    }
    _persistentListenersCleanup = cleanup
  }, [])

  return { setupGlobalListeners }
}
