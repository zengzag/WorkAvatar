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

export function registerLLMHandlers(
  llmClient: LLMClientService,
  employeeAgent: EmployeeAgentService
) {
  const activeSessions: Map<string, AbortController> = new Map()
  const interactionService = UnifiedInteractionService.getInstance()

  ipcMain.handle(IPC_CHANNELS.LLM_ABORT_CHAT, (_, sessionId?: string) => {
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
  ipcMain.handle(IPC_CHANNELS.LLM_PROVIDER_LIST, () => {
    return llmClient.getProviderList()
  })

  ipcMain.handle(IPC_CHANNELS.LLM_PROVIDER_CREATE, async (_, params: LLMProviderCreateParams) => {
    return llmClient.createProvider(params)
  })

  ipcMain.handle(IPC_CHANNELS.LLM_PROVIDER_UPDATE, async (_, params: LLMProviderUpdateParams) => {
    const { id, ...data } = params
    return llmClient.updateProvider(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.LLM_PROVIDER_DELETE, async (_, id: string) => {
    return llmClient.deleteProvider(id)
  })

  ipcMain.handle(IPC_CHANNELS.LLM_TEST_CONNECTION, async (_, params: LLMTestConnectionParams) => {
    return llmClient.testConnection(params.provider_id)
  })

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

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_CHAT_STREAM, async (event, params: EmployeeChatStreamParams) => {
    const abortController = new AbortController()
    const sessionId = generateId()
    activeSessions.set(sessionId, abortController)

    interactionService.registerSession(sessionId, event.sender)

    interactionContext.run(
      {
        sessionId,
        employeeId: params.employee_id,
      },
      async () => {
        try {
          await employeeAgent.chatStream(
            {
              employee_id: params.employee_id,
              provider_id: params.provider_id,
              model_id: params.model_id,
              messages: params.messages,
              use_skills: params.use_skills !== false,
              use_kb: params.use_kb !== false,
              enable_thinking: params.enable_thinking,
              conversation_id: params.conversation_id,
            },
            {
              onChunk: (chunk: string) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.LLM_CHAT_CHUNK, { sessionId, chunk }) },
              onThought: (thought: string) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.LLM_THOUGHT, { sessionId, thought }) },
              onToolCall: (toolCall: { name: string; args: any }) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.AGENT_TOOL_CALL, { sessionId, ...toolCall }) },
              onToolResult: (toolResult: { name: string; result: any; rawResult?: any }) => {
                if (abortController.signal.aborted) return
                const { rawResult: _, ...safeResult } = toolResult
                event.sender.send(IPC_CHANNELS.AGENT_TOOL_RESULT, { sessionId, ...safeResult })
              },
              onDone: (metadata?: any) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.LLM_CHAT_DONE, { sessionId, metadata: metadata || {} }); activeSessions.delete(sessionId) },
              onError: (error: string) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.LLM_CHAT_ERROR, { sessionId, error }); activeSessions.delete(sessionId) },
            },
            abortController.signal
          )
        } catch (error: any) {
          if (abortController.signal.aborted) {
            event.sender.send(IPC_CHANNELS.LLM_CHAT_DONE, { sessionId })
            activeSessions.delete(sessionId)
            return
          }
          event.sender.send(IPC_CHANNELS.LLM_CHAT_ERROR, { sessionId, error: error.message || String(error) })
          activeSessions.delete(sessionId)
        } finally {
          interactionService.unregisterSession(sessionId)
        }
      }
    ).catch(() => {})

    return { success: true, sessionId }
  })
}
