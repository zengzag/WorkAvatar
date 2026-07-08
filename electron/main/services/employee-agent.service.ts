import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import SkillRegistryService from './skill-registry.service'
import EmployeeMemoryService from './employee-memory.service'
import { EmployeeAgent } from './agent/business/employee-agent'
import type { EmployeeAgentConfig } from './agent/business/employee-agent'
import type { BaseAgentOptions } from './agent/core/base-agent'
import { allBuiltinTools, createKMSCollectionTools, createOfficeGuideTool, officeExecTool, createKMSTools, type CollectionIdsRef } from './agent/tools'
import type { ToolDefinition } from './agent/tools/types'
import type { Message } from './agent/core/types'
import type { LLMModelConfig } from '../../shared/types'
import type { DBEmployee, DBEmployeeTool } from '../../shared/db-types'
import { createLogger } from './logger'
import LLMLoggerService from './llm-logger.service'

const logger = createLogger('AgentEvent')

interface EmployeeChatStreamParams {
  employee_id: string
  provider_id: string
  model_id?: string
  messages: Array<{
    role: string
    content: string
    images?: string[]
    reasoning_content?: string
    toolCalls?: Array<{
      id: string
      name: string
      args: any
      result?: any
      isComplete?: boolean
    }>
    toolCallId?: string
  }>
  options?: {
    temperature?: number
    max_tokens?: number
  }
  use_skills?: boolean
  collection_ids?: string[]
  enable_thinking?: boolean
  conversation_id?: string
  minimal_mode?: boolean
}

interface EmployeeChatCallbacks {
  onChunk: (chunk: string) => void
  onThought: (thought: string) => void
  onToolCall: (toolCall: { id: string; name: string; args: any }) => void
  onToolResult: (toolResult: { name: string; result: any }) => void
  onToolProgress?: (progress: { toolCallId: string; name: string; progress: any }) => void
  onDone: (metadata?: any) => void
  onError: (error: string) => void
}

interface CachedAgentEntry {
  agent: EmployeeAgent
  conversationId: string | null
  collectionIdsRef: CollectionIdsRef
}

class EmployeeAgentService {
  private db: DatabaseService
  private llmClient: LLMClientService
  private skillRegistry: SkillRegistryService
  private memoryService: EmployeeMemoryService
  private agentEntries: Map<string, CachedAgentEntry> = new Map()
  private static instance: EmployeeAgentService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
    this.skillRegistry = SkillRegistryService.getInstance()
    this.memoryService = EmployeeMemoryService.getInstance()
  }

  static getInstance(): EmployeeAgentService {
    if (!EmployeeAgentService.instance) {
      EmployeeAgentService.instance = new EmployeeAgentService()
    }
    return EmployeeAgentService.instance
  }

  private async getOrCreateAgent(
    employeeId: string,
    providerId: string,
    modelId?: string,
    enableThinking?: boolean,
    conversationId?: string,
    employee?: DBEmployee
  ): Promise<CachedAgentEntry> {
    const cacheKey = `${employeeId}:${providerId}:${modelId || 'default'}:${enableThinking ? 'thinking' : 'no-thinking'}`

    const existing = this.agentEntries.get(cacheKey)
    if (existing) {
      if (conversationId && existing.conversationId !== conversationId) {
        this.agentEntries.delete(cacheKey)
      } else {
        return existing
      }
    }

    const emp = employee ?? this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as DBEmployee | undefined
    if (!emp) {
      throw new Error(`Employee ${employeeId} not found`)
    }

    const config = await this.llmClient.getProviderConfig(providerId)
    if (!config) {
      throw new Error(`Provider ${providerId} not found`)
    }

    let instructions = '你是专业数字员工，基于资料库和工具为用户提供服务。'
    let role: string | undefined
    if (emp.profile_json) {
      try {
        const profile = JSON.parse(emp.profile_json)
        if (profile.roleDescription) {
          instructions = profile.roleDescription
        }
        if (profile.roleName) {
          role = profile.roleName
        }
      } catch (error) {
        logger.warn('Failed to parse employee profile_json, using default instructions', error)
      }
    } else if (emp.description) {
      instructions = emp.description
    }

    const employeeSkills = this.skillRegistry.getEmployeeSkills(employeeId)

    const enabledSkillPaths = employeeSkills.enabled.map(skill => skill.installPath)

    const modelConfig = this.getModelConfig(config, modelId)

    const resolvedModelName = modelConfig?.model || modelId || config.model

    const memoryEnabled = emp.memory_enabled === 1
    const memoryPrompt = memoryEnabled
      ? (this.memoryService.formatMemoriesForPrompt(
          this.memoryService.listMemories(employeeId)
        ) || undefined)
      : undefined

    const agentConfig: EmployeeAgentConfig = {
      name: emp.name,
      instructions,
      role,
      model: resolvedModelName,
      apiKey: config.api_key,
      baseUrl: config.base_url || this.llmClient.getBaseURL(config),
      providerType: config.provider_type,
      enableThinking: enableThinking ?? modelConfig?.enable_thinking ?? false,
      treeOfThought: modelConfig?.tree_of_thought ?? false,
      totModel: modelConfig?.tot_model,
      totApiKey: modelConfig?.tot_api_key ?? config.api_key,
      totBaseUrl: modelConfig?.tot_base_url ?? (config.base_url || this.llmClient.getBaseURL(config)),
      totProviderType: modelConfig?.tot_provider_type ?? config.provider_type,
      planningStrategy: modelConfig?.planning_strategy,
      allowedSkillPaths: enabledSkillPaths,
      autoDiscoverSkills: true,
      debug: modelConfig?.debug ?? false,
      workspaceGuidance: emp.workspace_path ? `\n## 工作区\n工作区根目录：${emp.workspace_path}` : undefined,
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

    const agent = new EmployeeAgent(agentConfig, agentOptions)

    for (const skill of employeeSkills.enabled) {
      const skillDef: ToolDefinition = {
        id: `skill_${skill.id}`,
        name: `skill_${skill.name}`,
        title: skill.name,
        description: skill.description || '',
        parameters: {
          type: 'object',
          properties: {},
        },
        handler: async () => {
          return this.skillRegistry.getSkillPrompt(skill.id)
        },
        source: 'skill',
      }
      agent.registerTools([skillDef])
    }

    const enabledToolIds = this.getEnabledBuiltinToolIds(employeeId)
    const builtinTools = allBuiltinTools.filter(t => enabledToolIds.has(t.id))
    agent.registerTools(builtinTools)

    const collectionIdsRef: CollectionIdsRef = { current: [] }
    const kmsTools = createKMSTools(collectionIdsRef).filter(t => enabledToolIds.has(t.id))
    agent.registerTools(kmsTools)
    const kmsCollectionTools = createKMSCollectionTools(collectionIdsRef).filter(t => enabledToolIds.has(t.id))
    agent.registerTools(kmsCollectionTools)

    const officeGuideTool = createOfficeGuideTool(emp.workspace_path || '')
    agent.registerTools([officeGuideTool, officeExecTool])

    if (memoryPrompt) {
      agent.updateMemoryPrompt(memoryPrompt)
    }

    this.agentEntries.set(cacheKey, {
      agent,
      conversationId: conversationId || null,
      collectionIdsRef,
    })
    return { agent, conversationId: conversationId || null, collectionIdsRef }
  }

  private getEnabledBuiltinToolIds(employeeId: string): Set<string> {
    const allBuiltinToolIds = new Set(allBuiltinTools.map(t => t.id))
    const kmsToolIds = [
      'kms_search',
      'kms_agent_search',
      'kms_get_content',
      'kms_list_collections',
      'kms_collection_overview',
      'kms_get_toc',
      'kms_get_paragraphs',
    ]
    for (const id of kmsToolIds) {
      allBuiltinToolIds.add(id)
    }

    const officeToolIds = [
      'office_exec',
      'office_guide',
    ]
    for (const id of officeToolIds) {
      allBuiltinToolIds.add(id)
    }

    const enabledRows = this.db.getDb().prepare(
      'SELECT tool_id, is_enabled FROM employee_tools WHERE employee_id = ?'
    ).all(employeeId) as DBEmployeeTool[]

    if (enabledRows.length === 0) {
      return allBuiltinToolIds
    }

    const result = new Set<string>()
    const enabledRowIds = new Set<string>()
    for (const row of enabledRows) {
      enabledRowIds.add(row.tool_id)
      if (allBuiltinToolIds.has(row.tool_id) && row.is_enabled === 1) {
        result.add(row.tool_id)
      }
    }

    for (const id of allBuiltinToolIds) {
      if (!enabledRowIds.has(id)) {
        result.add(id)
      }
    }

    return result
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

  async chatStream(params: EmployeeChatStreamParams, callbacks: EmployeeChatCallbacks, signal?: AbortSignal): Promise<void> {
    const { employee_id, provider_id, model_id, messages, use_skills = true, collection_ids = [], enable_thinking, conversation_id, minimal_mode = false } = params

    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employee_id) as DBEmployee | undefined
    const employeeName = employee?.name || 'unknown'

    const logCtx = {
      employeeId: employee_id,
      employeeName,
      conversationId: conversation_id,
      source: 'chat',
    }

    await LLMLoggerService.getInstance().runWithContext(logCtx, async () => {
      const entry = await this.getOrCreateAgent(employee_id, provider_id, model_id, enable_thinking, conversation_id, employee)
      const agent = entry.agent
      agent.setMinimalMode(minimal_mode)
      entry.collectionIdsRef.current = collection_ids || []

      const history: Message[] = this.expandFrontendMessages(messages.slice(0, -1))
      const lastMsg = messages[messages.length - 1]
      const query = lastMsg?.content || ''
      const queryImages = lastMsg?.images

      const systemPromptCached = await this.prepareSystemPrompt(agent, conversation_id, collection_ids, minimal_mode, query)
      const maxIterations = await this.resolveMaxIterations(provider_id, model_id)
      const memoryEnabled = employee?.memory_enabled === 1

      await agent.runStream(
        {
          query,
          history,
          useSkills: use_skills,
          maxIterations,
          metadata: { queryImages },
        },
        {
          onChunk: callbacks.onChunk,
          onThought: callbacks.onThought,
          onToolCall: callbacks.onToolCall,
          onToolResult: callbacks.onToolResult,
          onToolProgress: callbacks.onToolProgress,
          onDone: (metadata?: any) => {
            callbacks.onDone(metadata)
            if (memoryEnabled) {
              this.extractMemoriesAsync(employee_id, messages, provider_id, model_id, conversation_id, employeeName)
            }
          },
          onError: callbacks.onError,
        },
        signal
      )

      this.persistSystemPrompt(conversation_id, agent, systemPromptCached)
    })
  }

  private async prepareSystemPrompt(
    agent: EmployeeAgent,
    conversationId: string | undefined,
    collectionIds: string[],
    minimalMode: boolean,
    query: string
  ): Promise<boolean> {
    if (conversationId) {
      const conv = this.db.getDb().prepare(
        `SELECT system_prompt FROM conversations WHERE id = ?`
      ).get(conversationId) as { system_prompt?: string } | undefined
      if (conv?.system_prompt) {
        agent.setCachedSystemPrompt(conv.system_prompt)
        agent.updateKBContextPrompt(undefined)
        agent.updateToolPlanningPrompt(null)
        return true
      }
    }

    if (minimalMode) {
      agent.updateKBContextPrompt(undefined)
      agent.updateToolPlanningPrompt(null)
    } else {
      if (collectionIds.length > 0) {
        const kmsService = require('./kms/kms.service').default.getInstance()
        const allCollections = kmsService.listCollections() as any[]
        const selected = allCollections.filter((c: any) => collectionIds.includes(c.id))
        if (selected.length > 0) {
          const names = selected.map((c: any) => c.name).join('、')
          agent.updateKBContextPrompt(`当前对话可使用的资料库合集: ${names}（检索默认限定在此范围内）`)
        } else {
          agent.updateKBContextPrompt(undefined)
        }
      } else {
        agent.updateKBContextPrompt(undefined)
      }
      const toolPlanningHint = await agent.buildToolPlanningHint(query).catch(() => null)
      agent.updateToolPlanningPrompt(toolPlanningHint)
    }
    return false
  }

  private async resolveMaxIterations(providerId: string, modelId?: string): Promise<number> {
    const config = await this.llmClient.getProviderConfig(providerId)
    if (!config?.models_json) return 100
    try {
      const models: LLMModelConfig[] = JSON.parse(config.models_json)
      const matched = modelId
        ? models.find(m => m.id === modelId) || models.find(m => m.model === modelId)
        : models.find(m => m.is_default)
      if (matched?.max_retry !== undefined) {
        return matched.max_retry
      }
    } catch {}
    return 100
  }

  private persistSystemPrompt(
    conversationId: string | undefined,
    agent: EmployeeAgent,
    systemPromptCached: boolean
  ): void {
    if (!conversationId || systemPromptCached) return
    const cachedPrompt = agent.getCachedSystemPrompt()
    if (cachedPrompt) {
      this.db.getDb().prepare(
        `UPDATE conversations SET system_prompt = ? WHERE id = ?`
      ).run(cachedPrompt, conversationId)
    }
  }

  clearAgentCache(employeeId?: string): void {
    if (employeeId) {
      for (const key of this.agentEntries.keys()) {
        if (key.startsWith(`${employeeId}:`)) {
          this.agentEntries.delete(key)
        }
      }
    } else {
      this.agentEntries.clear()
    }
  }

  private expandFrontendMessages(
    messages: EmployeeChatStreamParams['messages']
  ): Message[] {
    const result: Message[] = []
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const assistantMsg: Message = {
          role: 'assistant',
          content: m.content,
          images: m.images,
          reasoning_content: m.reasoning_content,
          toolCalls: m.toolCalls
            .filter(tc => tc.id && tc.name) // 必须有 id 和 name
            .map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
              },
            })),
        }
        result.push(assistantMsg)

        for (const tc of m.toolCalls) {
          if (tc.isComplete !== false && tc.result !== undefined && tc.id) {
            result.push({
              role: 'tool',
              toolCallId: tc.id,
              content: typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result),
            })
          }
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

  private extractMemoriesAsync(
    employeeId: string,
    messages: Array<{ role: string; content: string }>,
    providerId: string,
    modelId?: string,
    conversationId?: string,
    employeeName?: string
  ): void {
    const logCtx = {
      employeeId,
      employeeName: employeeName || 'unknown',
      conversationId,
      source: 'memory',
    }
    LLMLoggerService.getInstance().runWithContext(logCtx, () => {
      this.memoryService.extractMemoriesFromConversation(
        employeeId,
        messages,
        providerId,
        modelId,
        conversationId
      ).then(() => {
        this.memoryService.removeStaleMemories(employeeId)
        return this.memoryService.autoConsolidateIfNeeded(employeeId, providerId, modelId)
      }).catch(err => {
        logger.error(`Background memory extraction failed: ${err.message}`)
      })
    })
  }

}

export default EmployeeAgentService
