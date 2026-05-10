import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  LLMProviderCreateParams,
  LLMProviderUpdateParams,
  LLMTestConnectionParams,
  LLMChatStreamParams,
  LLMChatStreamWithRAGParams,
} from '../../shared/ipc-channels'
import type LLMClientService from '../services/llm-client.service'
import type RAGService from '../services/rag.service'
import type EmployeeAgentService from '../services/employee-agent.service'

export function registerLLMHandlers(
  llmClient: LLMClientService,
  ragService: RAGService,
  employeeAgent: EmployeeAgentService
) {
  let activeAbortController: AbortController | null = null

  ipcMain.handle('llm:abort-chat', () => {
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
      (chunk: string) => { event.sender.send('llm:chat-chunk', chunk) },
      () => { event.sender.send('llm:chat-done') },
      (error: Error) => { event.sender.send('llm:chat-error', error.message) },
      params.model_id ? { ...params.options, model: params.model_id } : params.options,
      undefined,
      (thoughtChunk: string) => { event.sender.send('llm:thought', thoughtChunk) },
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
          use_rag: params.use_rag !== false,
        },
        {
          onChunk: (chunk: string) => { if (!abortController.signal.aborted) event.sender.send('llm:chat-chunk', chunk) },
          onThought: (thought: string) => { if (!abortController.signal.aborted) event.sender.send('llm:thought', thought) },
          onToolCall: (toolCall: { name: string; args: any }) => { if (!abortController.signal.aborted) event.sender.send('agent:tool-call', toolCall) },
          onToolResult: (toolResult: { name: string; result: any; rawResult?: any }) => {
            if (abortController.signal.aborted) return
            event.sender.send('agent:tool-result', toolResult)
            if (toolResult.name === 'query_rag' && toolResult.rawResult?.success && toolResult.rawResult?.results) {
              event.sender.send('llm:rag-results', toolResult.rawResult.results)
            }
          },
          onDone: () => { if (!abortController.signal.aborted) event.sender.send('llm:chat-done'); activeAbortController = null },
          onError: (error: string) => { if (!abortController.signal.aborted) event.sender.send('llm:chat-error', error); activeAbortController = null },
        },
        abortController.signal
      )
      return { success: true }
    } catch (error: any) {
      if (abortController.signal.aborted) {
        event.sender.send('llm:chat-done')
        return { success: true, aborted: true }
      }
      event.sender.send('llm:chat-error', error.message || String(error))
      activeAbortController = null
      return { success: false, error: error.message || String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.LLM_CHAT_STREAM_WITH_RAG, async (event, params: LLMChatStreamWithRAGParams) => {
    try {
      const lastMessage = params.messages[params.messages.length - 1]
      const query = lastMessage?.content || ''

      const searchResults = await ragService.search(
        params.project_id,
        query,
        params.rag_options?.top_k || 5,
        params.rag_options?.min_score || 0.5
      )

      event.sender.send('llm:rag-results', searchResults)

      const ragContext = searchResults.length > 0
        ? '\n\n【参考知识】\n' + searchResults.map((r, i) => `${i + 1}. [${r.source.file_name}] ${r.text}`).join('\n')
        : ''

      const systemMessage = params.messages.find(m => m.role === 'system')
      const otherMessages = params.messages.filter(m => m.role !== 'system')
      const enhancedMessages: Array<{ role: string; content: string }> = []

      if (systemMessage) {
        enhancedMessages.push({ role: 'system', content: systemMessage.content + ragContext })
      } else if (ragContext) {
        enhancedMessages.push({ role: 'system', content: '你是专业的数字员工助手。请基于以下参考知识回答用户问题。' + ragContext })
      }

      enhancedMessages.push(...otherMessages)

      await llmClient.chatStream(
        params.provider_id,
        enhancedMessages,
        (chunk: string) => { event.sender.send('llm:chat-chunk', chunk) },
        () => { event.sender.send('llm:chat-done') },
        (error: Error) => { event.sender.send('llm:chat-error', error.message) },
        params.model_id ? { ...params.options, model: params.model_id } : params.options,
        undefined,
        (thoughtChunk: string) => { event.sender.send('llm:thought', thoughtChunk) },
      )
      return { success: true }
    } catch (error: any) {
      event.sender.send('llm:chat-error', error.message)
      return { success: false, error: error.message }
    }
  })
}