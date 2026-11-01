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
import { createPiProvider } from '../services/agent/llm/pi-provider-factory'
import UnifiedInteractionService, { interactionContext } from '../services/unified-interaction.service'
import { generateId } from '../services/common-utils'
import { broadcastToOtherRenderers, safeHandle } from './_shared'
import { flushRunStream, hasOtherSessionViewer, registerSessionWebContents, sendToSessionWebContents, unregisterSessionWebContents } from './agent-run-events'
import SubAgentRuntime from '../services/agent-runtime/runtime'
import WorkspaceManagerService from '../services/workspace-manager.service'
import { clearResumableRun, getResumableRun, takeResumableRun } from '../services/agent/core/resumable-runs'
import LLMLoggerService from '../services/llm-logger.service'

export function registerLLMHandlers(
  llmClient: LLMClientService,
  employeeAgent: EmployeeAgentService
) {
  const activeSessions: Map<string, AbortController> = new Map()
  // 会话附带的员工/对话信息，供前端查询"仍在运行"的会话以恢复 UI（renderer 重载后状态丢失）
  const activeSessionsMeta: Map<string, { employeeId?: string; conversationId?: string }> = new Map()
  // 会话发起窗口：用于判断是否有其他窗口接入（接入方会自行落库，发起方不再覆盖）
  const sessionOwner: Map<string, Electron.WebContents> = new Map()
  const interactionService = UnifiedInteractionService.getInstance()

  const cleanupSession = (sessionId: string) => {
    activeSessions.delete(sessionId)
    activeSessionsMeta.delete(sessionId)
    unregisterSessionWebContents(sessionId)
    sessionOwner.delete(sessionId)
  }

  /**
   * 把"可原地续跑"状态与发起它的 IPC 会话/窗口绑定：错误推给前端后，
   * 前端点重试时据此把续跑事件继续推送到同一条助手消息。
   */
  const attachResumableContext = (conversationId: string | undefined, sessionId: string, sender: Electron.WebContents) => {
    if (!conversationId) return
    const run = getResumableRun(conversationId)
    if (!run) return
    run.sessionId = sessionId
    run.sender = sender
    run.interactionStore = interactionContext.getStore()
    run.logContext = LLMLoggerService.getInstance().getCurrentContext()
  }

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

  safeHandle(IPC_CHANNELS.LLM_LIST_ACTIVE_SESSIONS, (employeeId?: string) => {
    const sessions: { sessionId: string; employeeId?: string; conversationId?: string }[] = []
    for (const [sessionId, controller] of activeSessions) {
      // 已 abort 的会话视为已结束，不参与恢复
      if (controller.signal.aborted) continue
      const meta = activeSessionsMeta.get(sessionId)
      if (employeeId && meta?.employeeId !== employeeId) continue
      sessions.push({ sessionId, employeeId: meta?.employeeId, conversationId: meta?.conversationId })
    }
    return sessions
  })

  // 其他窗口接入仍在运行的会话：任务页打开小秘书等后台窗口发起的任务时，
  // 把后续流式事件同时推给当前窗口（不影响原发起窗口）
  ipcMain.handle(IPC_CHANNELS.LLM_ATTACH_SESSION, (event, sessionId?: string) => {
    if (!sessionId || !activeSessions.has(sessionId)) return { success: false }
    registerSessionWebContents(sessionId, event.sender)
    return { success: true }
  })

  // 运行中会话是否已有其他窗口接入（发起方据此让出收尾落库）
  safeHandle(IPC_CHANNELS.LLM_SESSION_ATTACHED, (sessionId?: string) => {
    if (!sessionId) return false
    return hasOtherSessionViewer(sessionId, sessionOwner.get(sessionId))
  })

  // 活跃子会话运行列表（renderer 重载后恢复运行面板/消息流用）
  safeHandle(IPC_CHANNELS.LLM_LIST_ACTIVE_RUNS, (params?: { employeeId?: string; parentConversationId?: string }) => {
    return SubAgentRuntime.getInstance().listActiveRuns(params || {})
  })

  // 中止单个子会话运行（级联其子树）
  safeHandle(IPC_CHANNELS.LLM_ABORT_RUN, (runId?: string) => {
    if (!runId) return { success: false, error: '缺少 runId' }
    return { success: SubAgentRuntime.getInstance().cancelRun(runId) }
  })

  // 查询子会话完整对话（审计入口）
  safeHandle(IPC_CHANNELS.LLM_GET_RUN_CONVERSATION, (runId?: string) => {
    if (!runId) return { success: false, error: '缺少 runId' }
    const run = SubAgentRuntime.getInstance().getRun(runId)
    if (!run?.conversationId) return { success: false, error: 'run 不存在或未关联会话' }
    const conv = WorkspaceManagerService.getInstance().getConversation(run.conversationId)
    if (!conv) return { success: false, error: '会话不存在' }
    return { success: true, conversation: conv, employeeName: run.employeeName, instruction: run.instruction }
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
      const provider = await createPiProvider(params.provider_id, params.model_id)
      if (!provider) {
        return { success: false, error: 'LLM Provider not found' }
      }
      const response = await provider.chat(params.messages as any, [], {
        temperature: params.options?.temperature,
        maxTokens: params.options?.max_tokens,
        logSource: 'llm_chat',
      })
      return { success: true, content: response.content }
    } catch (error: any) {
      return { success: false, error: error.message || String(error) }
    }
  })

  // 流式聊天：需要事件回调推送多种事件，保留 ipcMain.handle
  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_CHAT_STREAM, async (event, params: EmployeeChatStreamParams) => {
    const abortController = new AbortController()
    const sessionId = generateId()
    // 新的一次对话会取代该会话遗留的续跑状态
    clearResumableRun(params.conversation_id)
    activeSessions.set(sessionId, abortController)
    activeSessionsMeta.set(sessionId, { employeeId: params.employee_id, conversationId: params.conversation_id })
    sessionOwner.set(sessionId, event.sender)
    registerSessionWebContents(sessionId, event.sender)

    // 其他窗口若正打开同一任务，需要立即接入本会话（否则主窗口看不到小秘书的追问/回答）
    if (params.conversation_id) {
      broadcastToOtherRenderers(event.sender, IPC_CHANNELS.LLM_SESSION_STARTED, {
        sessionId,
        employeeId: params.employee_id,
        conversationId: params.conversation_id,
      })
    }

    interactionService.registerSession(sessionId, event.sender)

    // 流式增量统一按时间窗口合并推送（≈16fps）。
    // 逐条 IPC 会让渲染进程每个 token 都完整重渲染一次（markdown 全量解析、代码块重新高亮），
    // 这是输出期间 CPU 占用的主要来源；setImmediate 只能合并同一事件循环内的增量，实际≈逐条发送。
    const STREAM_FLUSH_INTERVAL_MS = 60

    // 正文增量
    let chunkBuffer = ''
    let chunkTimer: NodeJS.Timeout | null = null
    const flushChunks = () => {
      if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null }
      if (!chunkBuffer) return
      if (abortController.signal.aborted) { chunkBuffer = ''; return }
      const chunks = [chunkBuffer]
      chunkBuffer = ''
      try {
        sendToSessionWebContents(sessionId, IPC_CHANNELS.LLM_CHAT_CHUNK, { sessionId, chunks })
      } catch {
        // 定时器触发前窗口被销毁，WebFrameMain 已 dispose，忽略该竞态错误
      }
    }
    const scheduleChunkFlush = () => {
      if (!chunkTimer) chunkTimer = setTimeout(flushChunks, STREAM_FLUSH_INTERVAL_MS)
    }

    // 思考增量（推理模型输出密度同样很高）
    let thoughtBuffer = ''
    let thoughtTimer: NodeJS.Timeout | null = null
    const flushThoughts = () => {
      if (thoughtTimer) { clearTimeout(thoughtTimer); thoughtTimer = null }
      if (!thoughtBuffer) return
      if (abortController.signal.aborted) { thoughtBuffer = ''; return }
      const thought = thoughtBuffer
      thoughtBuffer = ''
      try {
        sendToSessionWebContents(sessionId, IPC_CHANNELS.LLM_THOUGHT, { sessionId, thought })
      } catch {
        // 同上：窗口销毁竞态
      }
    }
    const scheduleThoughtFlush = () => {
      if (!thoughtTimer) thoughtTimer = setTimeout(flushThoughts, STREAM_FLUSH_INTERVAL_MS)
    }

    // 工具参数增量：同一 index 在窗口内累积成一份完整片段
    const toolCallDeltaBuffer: Map<number, { index: number; id?: string; name?: string; arguments: string }> = new Map()
    let toolDeltaTimer: NodeJS.Timeout | null = null
    const flushToolCallDeltas = () => {
      if (toolDeltaTimer) { clearTimeout(toolDeltaTimer); toolDeltaTimer = null }
      if (toolCallDeltaBuffer.size === 0) return
      if (abortController.signal.aborted) { toolCallDeltaBuffer.clear(); return }
      const deltas = Array.from(toolCallDeltaBuffer.values())
      toolCallDeltaBuffer.clear()
      try {
        sendToSessionWebContents(sessionId, IPC_CHANNELS.AGENT_TOOL_CALL_DELTA, { sessionId, deltas })
      } catch {
        // 同上：窗口销毁竞态
      }
    }
    const scheduleToolCallDeltaFlush = () => {
      if (!toolDeltaTimer) toolDeltaTimer = setTimeout(flushToolCallDeltas, STREAM_FLUSH_INTERVAL_MS)
    }
    const flushAllStreams = () => {
      flushChunks()
      flushThoughts()
      flushToolCallDeltas()
    }

    interactionContext.run(
      {
        sessionId,
        // 根会话 = 本次 IPC 会话：委托逐级透传，嵌套子任务事件仍路由到此，前端才看得到
        rootSessionId: sessionId,
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
                  chunkBuffer += chunk
                  scheduleChunkFlush()
                }
              },
              onThought: (thought: string) => {
                if (abortController.signal.aborted) return
                thoughtBuffer += thought
                scheduleThoughtFlush()
              },
              onToolCallDelta: (delta: { index: number; id?: string; name?: string; arguments: string }) => {
                if (abortController.signal.aborted) return
                const prev = toolCallDeltaBuffer.get(delta.index)
                toolCallDeltaBuffer.set(delta.index, {
                  index: delta.index,
                  id: delta.id || prev?.id,
                  name: delta.name || prev?.name,
                  // 增量片段（agent 路径）直接拼接；整段快照（provider 的 toolcall_end）以新值为准
                  arguments: prev && !delta.arguments.startsWith(prev.arguments)
                    ? prev.arguments + delta.arguments
                    : delta.arguments,
                })
                scheduleToolCallDeltaFlush()
              },
              onToolCall: (toolCall: { id: string; name: string; args: any; iteration?: number }) => {
                if (!abortController.signal.aborted) {
                  flushAllStreams()
                  sendToSessionWebContents(sessionId, IPC_CHANNELS.AGENT_TOOL_CALL, { sessionId, id: toolCall.id, name: toolCall.name, args: toolCall.args, iteration: toolCall.iteration })
                }
              },
              onToolResult: (toolResult: { name: string; result: any; rawResult?: any; resultRaw?: string; generatedFiles?: any; images?: string[]; success?: boolean; isError?: boolean }) => {
                if (abortController.signal.aborted) return
                sendToSessionWebContents(sessionId, IPC_CHANNELS.AGENT_TOOL_RESULT, { sessionId, name: toolResult.name, result: toolResult.result, rawResult: toolResult.rawResult, resultRaw: toolResult.resultRaw, generatedFiles: toolResult.generatedFiles, images: toolResult.images, success: toolResult.success, isError: toolResult.isError })
              },
              onToolProgress: (progress: { toolCallId: string; name: string; progress: any }) => {
                if (abortController.signal.aborted) return
                sendToSessionWebContents(sessionId, IPC_CHANNELS.AGENT_TOOL_PROGRESS, { sessionId, ...progress })
              },
              onIterationStart: (iteration: number) => {
                if (abortController.signal.aborted) return
                sendToSessionWebContents(sessionId, IPC_CHANNELS.AGENT_ITERATION_START, { sessionId, iteration })
              },
              onDone: (metadata?: any) => {
                flushAllStreams() // 确保缓冲区中的增量不丢失
                // 子任务流式增量先于主管 done 下发，避免收尾后仍有零星 chunk 落到已结束的消息上
                flushRunStream(sessionId)
                // abort 时也发送 metadata（含 tokenUsage/contextStats），让前端能显示用量
                // 合并子会话 token 用量到主管会话 metadata（经 run 运行时聚合）
                const childUsage = SubAgentRuntime.getInstance().getAggregatedUsage(sessionId)
                const mergedMetadata = { ...(metadata || {}) }
                if (childUsage && (childUsage.totalTokens || childUsage.completionTokens || childUsage.promptTokens)) {
                  const base = metadata?.tokenUsage || {}
                  const cachedTokens = (base.cachedTokens || 0) + (childUsage.cachedTokens || 0)
                  const generationMs = (base.generationMs || 0) + (childUsage.generationMs || 0)
                  mergedMetadata.tokenUsage = {
                    promptTokens: (base.promptTokens || 0) + (childUsage.promptTokens || 0),
                    completionTokens: (base.completionTokens || 0) + (childUsage.completionTokens || 0),
                    totalTokens: (base.totalTokens || 0) + (childUsage.totalTokens || 0),
                    // 缓存命中必须与 prompt/completion 一样求和：混入子会话 prompt 却不计入其 cached，
                    // 会让 UI 的 cached/prompt 命中率被严重低估。
                    ...(cachedTokens > 0 ? { cachedTokens } : {}),
                    // 输出速度口径：子会话的生成耗时随 completionTokens 一并合并，避免平均速度被高估
                    ...(generationMs > 0 ? { generationMs } : {}),
                  }
                }
                const attachedElsewhere = hasOtherSessionViewer(sessionId, sessionOwner.get(sessionId))
                sendToSessionWebContents(sessionId, IPC_CHANNELS.LLM_CHAT_DONE, { sessionId, metadata: mergedMetadata, attachedElsewhere })
                cleanupSession(sessionId)
              },
              onError: (error: string) => {
                flushAllStreams()
                if (!abortController.signal.aborted) {
                  attachResumableContext(params.conversation_id, sessionId, event.sender)
                  const attachedElsewhere = hasOtherSessionViewer(sessionId, sessionOwner.get(sessionId))
                  sendToSessionWebContents(sessionId, IPC_CHANNELS.LLM_CHAT_ERROR, { sessionId, error, attachedElsewhere })
                  sentError = true
                }
                cleanupSession(sessionId)
              },
            },
            abortController.signal
          )
        } catch (error: any) {
          flushAllStreams()
          if (abortController.signal.aborted) {
            const attachedElsewhere = hasOtherSessionViewer(sessionId, sessionOwner.get(sessionId))
            sendToSessionWebContents(sessionId, IPC_CHANNELS.LLM_CHAT_DONE, { sessionId, attachedElsewhere })
            cleanupSession(sessionId)
            return
          }
          // 避免与 onError 回调重复发送错误，仅当 onError 未处理时发送
          if (!sentError) {
            const attachedElsewhere = hasOtherSessionViewer(sessionId, sessionOwner.get(sessionId))
            sendToSessionWebContents(sessionId, IPC_CHANNELS.LLM_CHAT_ERROR, { sessionId, error: error?.message || String(error), attachedElsewhere })
          }
          cleanupSession(sessionId)
        } finally {
          interactionService.unregisterSession(sessionId)
        }
      }
    ).catch(() => {
      // interactionContext.run 内部已 try-catch，此处仅兜底防止未捕获异常逃逸
    })

    return { success: true, sessionId }
  })

  /**
   * 原地重试：重新发起失败的那一次 LLM 请求。
   * agent 循环上下文仍保留在主进程内存中，不新增消息、不重建历史，
   * 续跑事件沿用原 sessionId 推回同一条助手消息，后续流程与未出错时一致。
   */
  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_CHAT_RESUME, async (event, conversationId?: string) => {
    try {
      if (!conversationId) return { success: false, error: '缺少会话 ID' }
      const run = takeResumableRun(conversationId)
      if (!run?.sessionId || !run.sender || run.sender.isDestroyed()) {
        return { success: false, error: 'no_resumable_run' }
      }
      const sessionId = run.sessionId
      if (activeSessions.has(sessionId)) return { success: false, error: 'already_running' }

      const abortController = new AbortController()
      activeSessions.set(sessionId, abortController)
      activeSessionsMeta.set(sessionId, { employeeId: run.interactionStore?.employeeId, conversationId })
      sessionOwner.set(sessionId, event.sender)
      registerSessionWebContents(sessionId, event.sender)
      interactionService.registerSession(sessionId, event.sender)

      // 续跑仍在原会话上下文里执行：权限确认/ask_user/委托路由都依赖它
      const store = {
        ...(run.interactionStore || {}),
        employeeId: run.interactionStore?.employeeId || '',
        sessionId,
        conversationId,
        abortSignal: abortController.signal,
      }
      const resume = () => run.resume(abortController.signal)
      const logger = LLMLoggerService.getInstance()

      void interactionContext.run(store, () => (
        run.logContext ? logger.runWithContext(run.logContext, resume) : resume()
      ))
        .catch(() => {})
        .finally(() => {
          cleanupSession(sessionId)
          interactionService.unregisterSession(sessionId)
        })

      return { success: true, sessionId }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
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
    conversation_id?: string
  }) => {
    return employeeAgent.getContextStats(params)
  })
}
