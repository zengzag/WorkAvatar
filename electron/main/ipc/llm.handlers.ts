import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  LLMProviderCreateParams,
  LLMProviderUpdateParams,
  LLMTestConnectionParams,
  LLMChatParams,
  EmployeeChatStreamParams,
} from '../../shared/ipc-channels'
import type LLMClientService from '../services/llm-client.service'
import type EmployeeAgentService from '../services/employee-agent.service'
import UnifiedInteractionService, { interactionContext } from '../services/unified-interaction.service'
import { generateId } from '../services/common-utils'
import { safeHandle } from './_shared'

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

    interactionContext.run(
      {
        sessionId,
        employeeId: params.employee_id,
        conversationId: params.conversation_id,
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
            },
            {
              onChunk: (chunk: string) => {
                if (!abortController.signal.aborted) {
                  chunkBuffer.push(chunk)
                  scheduleFlush()
                }
              },
              onThought: (thought: string) => { if (!abortController.signal.aborted && !event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.LLM_THOUGHT, { sessionId, thought }) },
              onToolCall: (toolCall: { id: string; name: string; args: any }) => { if (!abortController.signal.aborted && !event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.AGENT_TOOL_CALL, { sessionId, id: toolCall.id, name: toolCall.name, args: toolCall.args }) },
              onToolResult: (toolResult: { name: string; result: any; rawResult?: any; generatedFiles?: any }) => {
                if (abortController.signal.aborted) return
                const { rawResult: _rawResult, ...safeResult } = toolResult
                if (!event.sender.isDestroyed()) {
                  event.sender.send(IPC_CHANNELS.AGENT_TOOL_RESULT, { sessionId, ...safeResult })
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
                if (!abortController.signal.aborted && !event.sender.isDestroyed()) {
                  event.sender.send(IPC_CHANNELS.LLM_CHAT_DONE, { sessionId, metadata: metadata || {} })
                }
                activeSessions.delete(sessionId)
              },
              onError: (error: string) => {
                flushChunks()
                if (!abortController.signal.aborted && !event.sender.isDestroyed()) {
                  event.sender.send(IPC_CHANNELS.LLM_CHAT_ERROR, { sessionId, error })
                  sentError = true
                }
                activeSessions.delete(sessionId)
              },
            },
            abortController.signal
          )
        } catch (error: any) {
          flushChunks()
          if (abortController.signal.aborted) {
            if (!event.sender.isDestroyed()) {
              event.sender.send(IPC_CHANNELS.LLM_CHAT_DONE, { sessionId })
            }
            activeSessions.delete(sessionId)
            return
          }
          // 避免与 onError 回调重复发送错误，仅当 onError 未处理时发送
          if (!sentError && !event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.LLM_CHAT_ERROR, { sessionId, error: error?.message || String(error) })
          }
          activeSessions.delete(sessionId)
        } finally {
          interactionService.unregisterSession(sessionId)
        }
      }
    ).catch(() => {
      // interactionContext.run 内部已 try-catch，此处仅兜底防止未捕获异常逃逸
    })

    return { success: true, sessionId }
  })
}
