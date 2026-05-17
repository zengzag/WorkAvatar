import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  LLMProviderCreateParams,
  LLMProviderUpdateParams,
  LLMTestConnectionParams,
  LLMChatParams,
  LLMChatStreamParams,
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

  ipcMain.handle(IPC_CHANNELS.LLM_PROVIDER_GET, (_, id: string) => {
    return llmClient.getProvider(id)
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

  ipcMain.handle(IPC_CHANNELS.LLM_CHAT_STREAM, async (event, params: LLMChatStreamParams) => {
    await llmClient.chatStream(
      params.provider_id,
      params.messages,
      (chunk: string) => { event.sender.send(IPC_CHANNELS.LLM_CHAT_CHUNK, chunk) },
      () => { event.sender.send(IPC_CHANNELS.LLM_CHAT_DONE) },
      (error: Error) => { event.sender.send(IPC_CHANNELS.LLM_CHAT_ERROR, error.message) },
      params.model_id ? { ...params.options, model: params.model_id, enable_thinking: params.enable_thinking } : { ...params.options, enable_thinking: params.enable_thinking },
      undefined,
      (thoughtChunk: string) => { event.sender.send(IPC_CHANNELS.LLM_THOUGHT, thoughtChunk) },
    )
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_CHAT_STREAM, async (event, params: any) => {
    const abortController = new AbortController()
    const sessionId = params.conversation_id || generateId()
    activeSessions.set(sessionId, abortController)

    interactionService.registerSession(sessionId, event.sender)

    try {
      await interactionContext.run(
        {
          sessionId,
          employeeId: params.employee_id,
        },
        async () => {
          await employeeAgent.chatStream(
            {
              employee_id: params.employee_id,
              provider_id: params.provider_id,
              model_id: params.model_id,
              messages: params.messages,
              use_skills: params.use_skills !== false,
              enable_thinking: params.enable_thinking,
            },
            {
              onChunk: (chunk: string) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.LLM_CHAT_CHUNK, { sessionId, chunk }) },
              onThought: (thought: string) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.LLM_THOUGHT, { sessionId, thought }) },
              onToolCall: (toolCall: { name: string; args: any }) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.AGENT_TOOL_CALL, { sessionId, ...toolCall }) },
              onToolResult: (toolResult: { name: string; result: any; rawResult?: any }) => {
                if (abortController.signal.aborted) return
                event.sender.send(IPC_CHANNELS.AGENT_TOOL_RESULT, { sessionId, ...toolResult })
              },
              onDone: () => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.LLM_CHAT_DONE, { sessionId }); activeSessions.delete(sessionId) },
              onError: (error: string) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.LLM_CHAT_ERROR, { sessionId, error }); activeSessions.delete(sessionId) },
            },
            abortController.signal
          )
        }
      )
      return { success: true, sessionId }
    } catch (error: any) {
      if (abortController.signal.aborted) {
        event.sender.send(IPC_CHANNELS.LLM_CHAT_DONE, { sessionId })
        activeSessions.delete(sessionId)
        return { success: true, aborted: true }
      }
      event.sender.send(IPC_CHANNELS.LLM_CHAT_ERROR, { sessionId, error: error.message || String(error) })
      activeSessions.delete(sessionId)
      return { success: false, error: error.message || String(error) }
    } finally {
      interactionService.unregisterSession(sessionId)
    }
  })
}
