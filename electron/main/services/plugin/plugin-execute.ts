/**
 * 插件统一执行入口实现（services.execute）。
 * 用 kind 区分执行形态，分发到宿主执行引擎。
 * 依赖注入设计，便于单元测试 mock。
 */
import type {
  PluginExecuteRequest,
  PluginExecuteCallbacks,
} from '../../../../plugins/plugin-sdk/src'

/** 宿主执行引擎依赖（由 plugin-host 注入真实实现，测试注入 mock） */
export interface ExecuteDeps {
  /** 委派数字员工执行任务（agent-task） */
  runAgentTask(
    params: {
      employeeId: string
      prompt: string
      conversationId?: string
    },
    callbacks?: PluginExecuteCallbacks,
    signal?: AbortSignal
  ): Promise<{ conversationId?: string; text: string }>
  /** 底层对话流式执行（agent-chat），返回会话 id（新建或复用）。
   *  员工模式：传 employeeId，走员工 agent（员工 rules/工具/记忆/工作区）。
   *  通用模式：不传 employeeId，传 system + tools，走通用对话引擎（不绑定员工）。 */
  runAgentChat(
    params: {
      employeeId?: string
      providerId: string
      modelId?: string
      messages: Array<{ role: string; content: string; images?: string[] }>
      conversationId?: string
      useSkills?: boolean
      enableThinking?: boolean
      minimalMode?: boolean
      highPermission?: boolean
      system?: string
      tools?: any[]
    },
    callbacks?: PluginExecuteCallbacks,
    signal?: AbortSignal
  ): Promise<{ conversationId: string }>
  /** 受控 LLM 单次调用（llm-chat） */
  runLlmChat(
    params: { prompt: string; system?: string; providerId?: string; modelId?: string }
  ): Promise<string>
  /** 受控 LLM 流式调用（llm-stream） */
  runLlmStream(
    params: {
      prompt: string
      history?: string[]
      system?: string
      providerId?: string
      modelId?: string
      temperature?: number
      maxTokens?: number
    },
    callbacks?: PluginExecuteCallbacks,
    signal?: AbortSignal
  ): Promise<string>
}

/** 构建统一执行服务 */
export function createExecuteService(deps: ExecuteDeps) {
  return {
    async execute<T = unknown>(
      request: PluginExecuteRequest,
      callbacks?: PluginExecuteCallbacks,
      signal?: AbortSignal
    ): Promise<T> {
      switch (request.kind) {
        case 'agent-task': {
          if (!request.employeeId) throw new Error('agent-task 需要 employeeId')
          if (!request.prompt) throw new Error('agent-task 需要 prompt')
          const result = await deps.runAgentTask(
            {
              employeeId: request.employeeId,
              prompt: request.prompt,
              conversationId: request.conversationId,
            },
            callbacks,
            signal,
          )
          return result as T
        }
        case 'agent-chat': {
          if (!request.providerId) throw new Error('agent-chat 需要 providerId')
          if (!request.messages || request.messages.length === 0) throw new Error('agent-chat 需要 messages')
          // 通用模式：不传 employeeId，传 system + tools（不绑定员工）
          if (!request.employeeId && !request.system) throw new Error('agent-chat 通用模式需要 system')
          return await deps.runAgentChat(
            {
              employeeId: request.employeeId,
              providerId: request.providerId,
              modelId: request.modelId,
              messages: request.messages,
              conversationId: request.conversationId,
              useSkills: request.useSkills,
              enableThinking: request.enableThinking,
              minimalMode: request.minimalMode,
              highPermission: request.highPermission,
              system: request.system,
              tools: request.tools,
            },
            callbacks,
            signal,
          ) as T
        }
        case 'llm-chat': {
          if (!request.prompt) throw new Error('llm-chat 需要 prompt')
          return await deps.runLlmChat(
            {
              prompt: request.prompt,
              system: request.system,
              providerId: request.providerId,
              modelId: request.modelId,
            },
          ) as T
        }
        case 'llm-stream': {
          if (!request.prompt) throw new Error('llm-stream 需要 prompt')
          return await deps.runLlmStream(
            {
              prompt: request.prompt,
              history: request.history,
              system: request.system,
              providerId: request.providerId,
              modelId: request.modelId,
              temperature: request.temperature,
              maxTokens: request.maxTokens,
            },
            callbacks,
            signal,
          ) as T
        }
        default:
          throw new Error(`未知执行类型: ${(request as { kind?: string }).kind}`)
      }
    },
  }
}
