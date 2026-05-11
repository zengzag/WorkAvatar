import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  LLMProviderCreateParams,
  LLMProviderUpdateParams,
  LLMTestConnectionParams,
  LLMChatStreamParams,
} from '../../shared/ipc-channels'
import type LLMClientService from '../services/llm-client.service'
import type EmployeeAgentService from '../services/employee-agent.service'

export function registerLLMHandlers(
  llmClient: LLMClientService,
  employeeAgent: EmployeeAgentService
) {
  let activeAbortController: AbortController | null = null

  ipcMain.handle(IPC_CHANNELS.LLM_ABORT_CHAT, () => {
    if (activeAbortController) {
      activeAbortController.abort()
      activeAbortController = null
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

  ipcMain.handle(IPC_CHANNELS.LLM_CHAT_STREAM, async (event, params: LLMChatStreamParams) => {
    await llmClient.chatStream(
      params.provider_id,
      params.messages,
      (chunk: string) => { event.sender.send(IPC_CHANNELS.LLM_CHAT_CHUNK, chunk) },
      () => { event.sender.send(IPC_CHANNELS.LLM_CHAT_DONE) },
      (error: Error) => { event.sender.send(IPC_CHANNELS.LLM_CHAT_ERROR, error.message) },
      params.model_id ? { ...params.options, model: params.model_id } : params.options,
      undefined,
      (thoughtChunk: string) => { event.sender.send(IPC_CHANNELS.LLM_THOUGHT, thoughtChunk) },
    )
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_CHAT_STREAM, async (event, params: any) => {
    const abortController = new AbortController()
    activeAbortController = abortController
    try {
      await employeeAgent.chatStream(
        {
          employee_id: params.employee_id,
          provider_id: params.provider_id,
          model_id: params.model_id,
          messages: params.messages,
          use_skills: params.use_skills !== false,
        },
        {
          onChunk: (chunk: string) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.LLM_CHAT_CHUNK, chunk) },
          onThought: (thought: string) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.LLM_THOUGHT, thought) },
          onToolCall: (toolCall: { name: string; args: any }) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.AGENT_TOOL_CALL, toolCall) },
          onToolResult: (toolResult: { name: string; result: any; rawResult?: any }) => {
            if (abortController.signal.aborted) return
            event.sender.send(IPC_CHANNELS.AGENT_TOOL_RESULT, toolResult)
          },
          onDone: () => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.LLM_CHAT_DONE); activeAbortController = null },
          onError: (error: string) => { if (!abortController.signal.aborted) event.sender.send(IPC_CHANNELS.LLM_CHAT_ERROR, error); activeAbortController = null },
        },
        abortController.signal
      )
      return { success: true }
    } catch (error: any) {
      if (abortController.signal.aborted) {
        event.sender.send(IPC_CHANNELS.LLM_CHAT_DONE)
        return { success: true, aborted: true }
      }
      event.sender.send(IPC_CHANNELS.LLM_CHAT_ERROR, error.message || String(error))
      activeAbortController = null
      return { success: false, error: error.message || String(error) }
    }
  })
}
