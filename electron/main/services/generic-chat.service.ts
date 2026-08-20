import LLMClientService from './llm-client.service'
import { GenericAgent } from './agent/business/generic-agent'
import type { GenericAgentConfig } from './agent/business/generic-agent'
import type { BaseAgentOptions } from './agent/core/base-agent'
import type { Message } from './agent/core/types'
import type { ToolDefinition } from './agent/tools/types'
import type { LLMModelConfig, ThinkingLevel } from '../../shared/types'
import { createLogger } from './logger'
import LLMLoggerService from './llm-logger.service'

const logger = createLogger('GenericChat')

/**
 * 通用对话配置。
 * 数字员工与第三方插件都是它的参数化实例：
 * - 插件：systemPrompt 为插件自定义提示词，tools 为插件工具，不依赖员工
 * - 数字员工：systemPrompt 由员工 rules 拼装，tools 为员工工具集（含记忆/工作区/技能/委托）
 */
export interface GenericChatConfig {
  providerId: string
  modelId?: string
  enableThinking?: ThinkingLevel
  /** 系统提示词（直接使用，忽略员工 rules） */
  systemPrompt?: string
  /** 工具集（未提供时为空） */
  tools?: ToolDefinition[]
  /** 是否启用技能（需 allowedSkillPaths） */
  useSkills?: boolean
  /** 跨会话记忆提示词（可选） */
  memoryPrompt?: string
  /** 工作区上下文提示词（可选） */
  workspaceContextPrompt?: string
  /** 知识库范围提示词（可选） */
  kbContextPrompt?: string
  /** 允许的技能安装路径（可选） */
  allowedSkillPaths?: string[]
  /** 环境上下文（稳定不变的路径/权限信息） */
  workspaceGuidance?: string
  /** 会话 ID（用于 prompt cache 与 agent 缓存） */
  conversationId?: string
  minimalMode?: boolean
  /** 模型配置（provider 的 models_json 解析结果，可选） */
  modelConfig?: LLMModelConfig & Record<string, any> | null
  /** 日志归属名（如插件名）：LLM 调用日志按 <logName>/<conversationId> 分文件，便于定位 */
  logName?: string
}

export interface GenericChatCallbacks {
  onChunk: (chunk: string) => void
  onThought: (thought: string) => void
  onToolCall: (toolCall: { id: string; name: string; args: any }) => void
  onToolCallDelta?: (delta: { index: number; id?: string; name?: string; arguments: string }) => void
  onToolResult: (toolResult: { name: string; result: any; rawResult?: any; generatedFiles?: any; success?: boolean }) => void
  onToolProgress?: (progress: { toolCallId: string; name: string; progress: any }) => void
  onDone: (metadata?: any) => void
  onError: (error: string) => void
}

interface CachedAgentEntry {
  agent: GenericAgent
  conversationId: string | null
}

/** agent 缓存上限：超出时淘汰最旧会话（Map 保持插入序，首个 key 即最旧） */
const AGENT_CACHE_MAX = 50

class GenericChatService {
  private llmClient: LLMClientService
  private agentEntries: Map<string, CachedAgentEntry> = new Map()
  private static instance: GenericChatService

  private constructor() {
    this.llmClient = LLMClientService.getInstance()
  }

  static getInstance(): GenericChatService {
    if (!GenericChatService.instance) {
      GenericChatService.instance = new GenericChatService()
    }
    return GenericChatService.instance
  }

  private getModelConfig(config: any, modelId?: string): LLMModelConfig & Record<string, any> | null {
    if (!config?.models_json) return null
    try {
      const models: Array<LLMModelConfig & Record<string, any>> = JSON.parse(config.models_json)
      const matched = modelId
        ? models.find(m => m.id === modelId) || models.find(m => m.model === modelId)
        : models.find(m => m.is_default)
      return matched ?? null
    } catch {
      return null
    }
  }

  private async getOrCreateAgent(config: GenericChatConfig): Promise<CachedAgentEntry> {
    const cacheKey = `${config.providerId}:${config.modelId || 'default'}:${config.enableThinking || 'no-thinking'}:${config.conversationId || 'no-conv'}`

    const existing = this.agentEntries.get(cacheKey)
    if (existing) return existing

    const providerConfig = await this.llmClient.getProviderConfig(config.providerId)
    if (!providerConfig) {
      throw new Error(`Provider ${config.providerId} not found`)
    }

    const modelConfig = config.modelConfig ?? this.getModelConfig(providerConfig, config.modelId)
    const resolvedModelName = modelConfig?.model || config.modelId || providerConfig.model

    const agentConfig: GenericAgentConfig = {
      name: '智能助手',
      systemPrompt: config.systemPrompt,
      instructions: config.systemPrompt,
      model: resolvedModelName,
      apiKey: providerConfig.api_key,
      baseUrl: providerConfig.base_url || this.llmClient.getBaseURL(providerConfig),
      providerType: providerConfig.provider_type,
      enableThinking: config.enableThinking ?? modelConfig?.enable_thinking ?? false,
      sessionId: config.conversationId,
      allowedSkillPaths: config.allowedSkillPaths,
      autoDiscoverSkills: !!config.allowedSkillPaths && config.useSkills !== false,
      workspaceGuidance: config.workspaceGuidance,
    }

    const agentOptions: BaseAgentOptions = {
      memoryConfig: {
        maxTokens: modelConfig?.context_window ?? (modelConfig?.max_tokens ? modelConfig.max_tokens * 4 : 128000),
        strategy: modelConfig?.memory_strategy ?? 'sliding_window_with_summary',
        recentTurnsToKeep: modelConfig?.recent_turns_to_keep ?? 10,
      },
      toolTimeoutMs: modelConfig?.tool_timeout_ms ?? 30000,
      toolMaxRetries: modelConfig?.tool_max_retries ?? 2,
      toolMaxResultSize: modelConfig?.tool_max_result_size ?? 50000,
      onEvent: (event, data) => {
        logger.info(`${event}`, data)
      },
    }

    const agent = new GenericAgent(agentConfig, agentOptions)

    if (config.tools && config.tools.length > 0) {
      agent.registerTools(config.tools)
    }

    agent.setMinimalMode(!!config.minimalMode)
    if (config.memoryPrompt) agent.updateMemoryPrompt(config.memoryPrompt)
    if (config.workspaceContextPrompt) agent.updateWorkspaceContextPrompt(config.workspaceContextPrompt)
    if (config.kbContextPrompt) agent.updateKBContextPrompt(config.kbContextPrompt)

    this.agentEntries.set(cacheKey, {
      agent,
      conversationId: config.conversationId || null,
    })
    // 超出上限时淘汰最旧会话，避免长会话累积导致内存无限增长
    while (this.agentEntries.size > AGENT_CACHE_MAX) {
      const oldestKey = this.agentEntries.keys().next().value as string | undefined
      if (!oldestKey) break
      this.agentEntries.delete(oldestKey)
    }
    return { agent, conversationId: config.conversationId || null }
  }

  private expandFrontendMessages(
    messages: Array<{
      role: string
      content: string
      images?: string[]
      reasoning_content?: string
      toolCalls?: Array<{ id: string; name: string; args: any; result?: any; isComplete?: boolean }>
      toolCallId?: string
    }>
  ): Message[] {
    const result: Message[] = []
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const validToolCalls = m.toolCalls.filter(tc => tc.id && tc.name && tc.isComplete !== false)
        const assistantMsg: Message = {
          role: 'assistant',
          content: m.content,
          images: m.images,
          reasoning_content: m.reasoning_content,
          toolCalls: validToolCalls.length > 0
            ? validToolCalls.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.name,
                  arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
                },
              }))
            : undefined,
        }
        result.push(assistantMsg)

        for (const tc of validToolCalls) {
          const toolContent = tc.result === undefined || tc.result === null
            ? ''
            : (typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result))
          result.push({
            role: 'tool',
            toolCallId: tc.id,
            content: toolContent || '工具执行完成，无返回值',
          })
        }
      } else {
        result.push({
          role: m.role as Message['role'],
          content: m.content,
          images: m.images,
          reasoning_content: m.reasoning_content,
          toolCallId: m.toolCallId,
        })
      }
    }
    return result
  }

  async chatStream(
    config: GenericChatConfig,
    messages: Array<{
      role: string
      content: string
      images?: string[]
      reasoning_content?: string
      toolCalls?: Array<{ id: string; name: string; args: any; result?: any; isComplete?: boolean }>
      toolCallId?: string
    }>,
    callbacks: GenericChatCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    const logCtx = {
      conversationId: config.conversationId,
      // 复用 employeeName 字段实现按归属名分文件（与数字员工日志一致）
      employeeName: config.logName,
      source: 'generic-chat',
    }

    await LLMLoggerService.getInstance().runWithContext(logCtx, async () => {
      const entry = await this.getOrCreateAgent(config)
      const agent = entry.agent

      const history: Message[] = this.expandFrontendMessages(messages.slice(0, -1))
      const lastMsg = messages[messages.length - 1]
      const query = lastMsg?.content || ''
      const queryImages = lastMsg?.images

      const maxIterations = config.modelConfig?.max_retry ?? 100

      await agent.runStream(
        {
          query,
          history,
          useSkills: config.useSkills !== false,
          maxIterations,
          metadata: { queryImages },
        },
        {
          onChunk: callbacks.onChunk,
          onThought: callbacks.onThought,
          onToolCall: callbacks.onToolCall,
          onToolCallDelta: callbacks.onToolCallDelta,
          onToolResult: callbacks.onToolResult,
          onToolProgress: callbacks.onToolProgress,
          onDone: (metadata?: any) => {
            callbacks.onDone(metadata)
          },
          onError: callbacks.onError,
        },
        signal
      )
    })
  }

  async compactConversation(
    config: GenericChatConfig,
    messages: Array<{ role: string; content: string }>
  ): Promise<{ summary: string; stats: any }> {
    const entry = await this.getOrCreateAgent(config)
    const agent = entry.agent
    const history = this.expandFrontendMessages(messages)
    const { summary, stats } = await agent.compactConversation(history)
    return { summary, stats }
  }

  getContextStats(config: GenericChatConfig): any {
    const cacheKey = `${config.providerId}:${config.modelId || 'default'}:${config.enableThinking || 'no-thinking'}:${config.conversationId || 'no-conv'}`
    const entry = this.agentEntries.get(cacheKey)
    if (!entry) return null
    return entry.agent.getContextStats()
  }

  clearAgentCache(): void {
    this.agentEntries.clear()
  }
}

export default GenericChatService
