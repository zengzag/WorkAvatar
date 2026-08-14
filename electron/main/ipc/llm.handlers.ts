import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  LLMProviderCreateParams,
  LLMProviderUpdateParams,
  LLMTestConnectionParams,
  LLMChatParams,
  EmployeeChatStreamParams,
} from '../../shared/ipc-channels'
import type { ThinkingLevel } from '../../shared/types'
import type LLMClientService from '../services/llm-client.service'
import type EmployeeAgentService from '../services/employee-agent.service'
import UnifiedInteractionService, { interactionContext } from '../services/unified-interaction.service'
import { generateId } from '../services/common-utils'
import { safeHandle } from './_shared'

/** 主管会话 → webContents 映射，供 delegate 工具转发子员工事件到主管前端 */
const sessionWebContents: Map<string, Electron.WebContents> = new Map()

/**
 * 委托事件转发：delegate 工具调用此函数把子员工 chatStream 的事件推给主管前端。
 * 由 delegate.tool.ts 引用，避免工具 handler 内重复持有 IPC 上下文。
 */
export function forwardDelegationEvent(
  parentSessionId: string,
  delegationId: string,
  eventType: string,
  data: any
): void {
  const wc = sessionWebContents.get(parentSessionId)
  if (!wc || wc.isDestroyed()) return
  wc.send(IPC_CHANNELS.AGENT_DELEGATION_EVENT, { parentSessionId, delegationId, eventType, data })
}

export function registerLLMHandlers(
  llmClient: LLMClientService,
  employeeAgent: EmployeeAgentService
) {
  const activeSessions: Map<string, AbortController> = new Map()
  const interactionService = UnifiedInteractionService.getInstance()

  safeHandle(IPC_CHANNELS.LLM_ABORT_CHAT, (sessionId?: string) => {
    if (sessionId) {
      const controller = activeSessions.get(sessionId)
      if (controller) {
        controller.abort()
        activeSessions.delete(sessionId)
      }
    } else {
      for (const [, controller] of activeSessions) {
        controller.abort()
      }
      activeSessions.clear()
    }
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.LLM_PROVIDER_LIST, () => {
    return llmClient.getProviderList()
  })

  safeHandle(IPC_CHANNELS.LLM_PROVIDER_CREATE, async (params: LLMProviderCreateParams) => {
    return llmClient.createProvider(params)
  })

  safeHandle(IPC_CHANNELS.LLM_PROVIDER_UPDATE, async (params: LLMProviderUpdateParams) => {
    const { id, ...data } = params
    return llmClient.updateProvider(id, data)
  })

  safeHandle(IPC_CHANNELS.LLM_PROVIDER_DELETE, async (id: string) => {
    return llmClient.deleteProvider(id)
  })

  safeHandle(IPC_CHANNELS.LLM_TEST_CONNECTION, async (params: LLMTestConnectionParams) => {
    return llmClient.testConnection(params.provider_id)
  })

  // 业务语义错误返回 { success: false, error }，保留原 try-catch
  ipcMain.handle(IPC_CHANNELS.LLM_CHAT, async (_, params: LLMChatParams) => {
    try {
      const result = await llmClient.chat(
        params.provider_id,
        params.messages,
        params.model_id ? { ...params.options, model: params.model_id } : params.options
      )
      return { success: true, content: result }
    } catch (error: any) {
      return { success: false, error: error.message || String(error) }
    }
  })

  // 流式聊天：需要事件回调推送多种事件，保留 ipcMain.handle
  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_CHAT_STREAM, async (event, params: EmployeeChatStreamParams) => {
    const abortController = new AbortController()
    const sessionId = generateId()
    activeSessions.set(sessionId, abortController)
    sessionWebContents.set(sessionId, event.sender)

    interactionService.registerSession(sessionId, event.sender)

    // chunk 批量合并缓冲：避免 100+ tokens/sec 触发 100+ 次 IPC 往返
    // 用 setImmediate 在当前事件循环结束后批量发送，渲染端一次性接收多 token
    const chunkBuffer: string[] = []
    let flushScheduled = false
    const flushChunks = () => {
      flushScheduled = false
      if (chunkBuffer.length === 0) return
      if (abortController.signal.aborted) { chunkBuffer.length = 0; return }
      const chunks = chunkBuffer.splice(0)
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.LLM_CHAT_CHUNK, { sessionId, chunks })
      }
    }
    const scheduleFlush = () => {
      if (!flushScheduled) {
        flushScheduled = true
        setImmediate(flushChunks)
      }
    }

    // tool_call delta 批量缓冲：LLM 生成工具参数时可能产生大量增量，合并后发送
    const toolCallDeltaBuffer: Map<number, { index: number; id?: string; name?: string; arguments: string }> = new Map()
    let toolCallDeltaFlushScheduled = false
    const flushToolCallDeltas = () => {
      toolCallDeltaFlushScheduled = false
      if (toolCallDeltaBuffer.size === 0) return
      if (abortController.signal.aborted) { toolCallDeltaBuffer.clear(); return }
      const deltas = Array.from(toolCallDeltaBuffer.values())
      toolCallDeltaBuffer.clear()
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.AGENT_TOOL_CALL_DELTA, { sessionId, deltas })
      }
    }
    const scheduleToolCallDeltaFlush = () => {
      if (!toolCallDeltaFlushScheduled) {
        toolCallDeltaFlushScheduled = true
        setImmediate(flushToolCallDeltas)
      }
    }

    interactionContext.run(
      {
        sessionId,
        employeeId: params.employee_id,
        conversationId: params.conversation_id,
        highPermission: params.high_permission === true,
        delegationDepth: 0,
        delegationChain: [],
        abortSignal: abortController.signal,
        enableThinking: params.enable_thinking ?? false,
      },
      async () => {
        // 标记 onError 是否已处理过错误，避免 catch 块重复发送 LLM_CHAT_ERROR
        let sentError = false
        try {
          await employeeAgent.chatStream(
            {
              employee_id: params.employee_id,
              provider_id: params.provider_id,
              model_id: params.model_id,
              messages: params.messages,
              use_skills: params.use_skills !== false,
              collection_ids: params.collection_ids || [],
              enable_thinking: params.enable_thinking,
              conversation_id: params.conversation_id,
              minimal_mode: params.minimal_mode,
              high_permission: params.high_permission === true,
            },
            {
              onChunk: (chunk: string) => {
                if (!abortController.signal.aborted) {
                  chunkBuffer.push(chunk)
                  scheduleFlush()
                }
              },
              onThought: (thought: string) => { if (!abortController.signal.aborted && !event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.LLM_THOUGHT, { sessionId, thought }) },
              onToolCallDelta: (delta: { index: number; id?: string; name?: string; arguments: string }) => {
                if (!abortController.signal.aborted) {
                  toolCallDeltaBuffer.set(delta.index, delta)
                  scheduleToolCallDeltaFlush()
                }
              },
              onToolCall: (toolCall: { id: string; name: string; args: any }) => {
                if (!abortController.signal.aborted && !event.sender.isDestroyed()) {
                  flushToolCallDeltas()
                  event.sender.send(IPC_CHANNELS.AGENT_TOOL_CALL, { sessionId, id: toolCall.id, name: toolCall.name, args: toolCall.args })
                }
              },
              onToolResult: (toolResult: { name: string; result: any; rawResult?: any; generatedFiles?: any; success?: boolean }) => {
                if (abortController.signal.aborted) return
                if (!event.sender.isDestroyed()) {
                  event.sender.send(IPC_CHANNELS.AGENT_TOOL_RESULT, { sessionId, name: toolResult.name, result: toolResult.result, rawResult: toolResult.rawResult, generatedFiles: toolResult.generatedFiles, success: toolResult.success })
                }
              },
              onToolProgress: (progress: { toolCallId: string; name: string; progress: any }) => {
                if (abortController.signal.aborted) return
                if (!event.sender.isDestroyed()) {
                  event.sender.send(IPC_CHANNELS.AGENT_TOOL_PROGRESS, { sessionId, ...progress })
                }
              },
              onDone: (metadata?: any) => {
                flushChunks() // 确保缓冲区中的 token 不丢失
                flushToolCallDeltas()
                // abort 时也发送 metadata（含 tokenUsage/contextStats），让前端能显示用量
                if (!event.sender.isDestroyed()) {
                  // 合并子员工 token 用量到主管会话 metadata
                  const ctx = interactionContext.getStore()
                  const childUsage = ctx?.childTokenUsage
                  const mergedMetadata = { ...(metadata || {}) }
                  if (childUsage && (childUsage.totalTokens || childUsage.completionTokens || childUsage.promptTokens)) {
                    const base = metadata?.tokenUsage || {}
                    mergedMetadata.tokenUsage = {
                      promptTokens: (base.promptTokens || 0) + (childUsage.promptTokens || 0),
                      completionTokens: (base.completionTokens || 0) + (childUsage.completionTokens || 0),
                      totalTokens: (base.totalTokens || 0) + (childUsage.totalTokens || 0),
                      cachedTokens: base.cachedTokens || childUsage.cachedTokens,
                    }
                  }
                  event.sender.send(IPC_CHANNELS.LLM_CHAT_DONE, { sessionId, metadata: mergedMetadata })
                }
                activeSessions.delete(sessionId)
                sessionWebContents.delete(sessionId)
              },
              onError: (error: string) => {
                flushChunks()
                flushToolCallDeltas()
                if (!abortController.signal.aborted && !event.sender.isDestroyed()) {
                  event.sender.send(IPC_CHANNELS.LLM_CHAT_ERROR, { sessionId, error })
                  sentError = true
                }
                activeSessions.delete(sessionId)
                sessionWebContents.delete(sessionId)
              },
            },
            abortController.signal
          )
        } catch (error: any) {
          flushChunks()
          flushToolCallDeltas()
          if (abortController.signal.aborted) {
            if (!event.sender.isDestroyed()) {
              event.sender.send(IPC_CHANNELS.LLM_CHAT_DONE, { sessionId })
            }
            activeSessions.delete(sessionId)
            sessionWebContents.delete(sessionId)
            return
          }
          // 避免与 onError 回调重复发送错误，仅当 onError 未处理时发送
          if (!sentError && !event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.LLM_CHAT_ERROR, { sessionId, error: error?.message || String(error) })
          }
          activeSessions.delete(sessionId)
          sessionWebContents.delete(sessionId)
        } finally {
          interactionService.unregisterSession(sessionId)
        }
      }
    ).catch(() => {
      // interactionContext.run 内部已 try-catch，此处仅兜底防止未捕获异常逃逸
    })

    return { success: true, sessionId }
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_COMPACT_CONVERSATION, async (params: {
    employee_id: string
    provider_id: string
    model_id?: string
    messages: any[]
    conversation_id?: string
    collection_ids?: string[]
    enable_thinking?: ThinkingLevel
    minimal_mode?: boolean
  }) => {
    return employeeAgent.compactConversation(params)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_GET_CONTEXT_STATS, (params: {
    employee_id: string
    provider_id: string
    model_id?: string
    enable_thinking?: ThinkingLevel
  }) => {
    return employeeAgent.getContextStats(params)
  })
}
