import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import SkillRegistryService from './skill-registry.service'
import EmployeeMemoryService from './employee-memory.service'
import McpRegistryService from './mcp-registry.service'
import NotesService from './notes/notes.service'
import { EmployeeAgent } from './agent/business/employee-agent'
import type { EmployeeAgentConfig } from './agent/business/employee-agent'
import type { BaseAgentOptions } from './agent/core/base-agent'
import { allBuiltinTools, createKMSCollectionTools, officeExecTool, createKMSTools, createListAvailableToolsTool, createInvokeToolTool, type SearchScopeRef } from './agent/tools'
import { createConversationSearchTool } from './agent/tools/conversation-search.tool'
import { createConversationListTool } from './agent/tools/conversation-list.tool'
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
  high_permission?: boolean
}

interface EmployeeChatCallbacks {
  onChunk: (chunk: string) => void
  onThought: (thought: string) => void
  onToolCall: (toolCall: { id: string; name: string; args: any }) => void
  onToolCallDelta?: (delta: { index: number; id?: string; name?: string; arguments: string }) => void
  onToolResult: (toolResult: { name: string; result: any; generatedFiles?: any }) => void
  onToolProgress?: (progress: { toolCallId: string; name: string; progress: any }) => void
  onDone: (metadata?: any) => void
  onError: (error: string) => void
}

interface CachedAgentEntry {
  agent: EmployeeAgent
  conversationId: string | null
  collectionIdsRef: SearchScopeRef
  /** 该 agent 持有的 MCP client 引用释放函数，agent 缓存被清除时调用 */
  mcpRelease?: () => Promise<void>
}

class EmployeeAgentService {
  private db: DatabaseService
  private llmClient: LLMClientService
  private skillRegistry: SkillRegistryService
  private memoryService: EmployeeMemoryService
  private mcpRegistry: McpRegistryService
  private agentEntries: Map<string, CachedAgentEntry> = new Map()
  private static instance: EmployeeAgentService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
    this.skillRegistry = SkillRegistryService.getInstance()
    this.memoryService = EmployeeMemoryService.getInstance()
    this.mcpRegistry = McpRegistryService.getInstance()
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
        // 切换对话时清除旧缓存：先释放 MCP client 引用，再删除条目
        if (existing.mcpRelease) {
          existing.mcpRelease().catch(() => { /* ignore */ })
        }
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
      allowedSkillPaths: enabledSkillPaths,
      autoDiscoverSkills: true,
      debug: modelConfig?.debug ?? false,
      workspaceGuidance: (() => {
        const parts: string[] = []
        if (emp.workspace_path) parts.push(`\n## 工作区\n工作区根目录：${emp.workspace_path}`)
        const notesRoot = NotesService.getInstance().getVaultRoot()
        parts.push(`\n## 用户笔记\n笔记根目录：${notesRoot}\n用户的笔记以真实 .md 文件存储在该目录，可通过 file_read / file_write / file_edit 工具直接读写。更多文件操作（列出目录、搜索、创建文件夹、删除、移动、复制、重命名、查看信息）通过 list_available_tools 发现后用 invoke_tool 调用。`)
        return parts.join('\n')
      })(),
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

    const collectionIdsRef: SearchScopeRef = { current: { collectionIds: [] } }
    const kmsTools = createKMSTools(collectionIdsRef).filter(t => enabledToolIds.has(t.id))
    agent.registerTools(kmsTools)
    const kmsCollectionTools = createKMSCollectionTools(collectionIdsRef).filter(t => enabledToolIds.has(t.id))
    agent.registerTools(kmsCollectionTools)

    if (enabledToolIds.has('office_exec')) {
      agent.registerTools([officeExecTool])
    }

    if (enabledToolIds.has('search_conversations')) {
      const convSearchTools = createConversationSearchTool(employeeId)
      agent.registerTools(convSearchTools)
    }

    if (enabledToolIds.has('list_conversations') || enabledToolIds.has('get_conversation_detail')) {
      const convListTools = createConversationListTool(employeeId).filter(
        t => enabledToolIds.has(t.id),
      )
      agent.registerTools(convListTools)
    }

    // 注入员工已启用的外部 MCP server 工具（标记为按需工具）
    // 失败容忍：单个 server 失败不影响 agent 创建，仅记录日志
    let mcpRelease: (() => Promise<void>) | undefined
    try {
      const mcpResult = await this.mcpRegistry.buildAgentTools(employeeId)
      if (mcpResult.tools.length > 0) {
        const mcpOnDemandTools = mcpResult.tools.map(t => ({ ...t, onDemand: true }))
        agent.registerTools(mcpOnDemandTools)
        mcpRelease = mcpResult.release
        logger.info(`Injected ${mcpOnDemandTools.length} MCP tools for employee ${employeeId}`)
      }
    } catch (err: any) {
      logger.warn(`Failed to inject MCP tools for employee ${employeeId}: ${err?.message || err}`)
    }

    // 注册元工具（常驻 LLM tools 数组）：list_available_tools + invoke_tool
    agent.registerTools([
      createListAvailableToolsTool(agent.getToolRegistry(), emp.workspace_path || ''),
      createInvokeToolTool(agent.getToolDispatcher(), agent.getToolRegistry()),
    ])

    if (memoryPrompt) {
      agent.updateMemoryPrompt(memoryPrompt)
    }

    this.agentEntries.set(cacheKey, {
      agent,
      conversationId: conversationId || null,
      collectionIdsRef,
      mcpRelease,
    })
    return { agent, conversationId: conversationId || null, collectionIdsRef }
  }

  private getEnabledBuiltinToolIds(employeeId: string): Set<string> {
    const allBuiltinToolIds = new Set(allBuiltinTools.map(t => t.id))
    const kmsToolIds = [
      'kms_search',
      'kms_get_content',
      'kms_list_collections',
    ]
    for (const id of kmsToolIds) {
      allBuiltinToolIds.add(id)
    }

    const officeToolIds = [
      'office_exec',
    ]
    for (const id of officeToolIds) {
      allBuiltinToolIds.add(id)
    }

    const agentToolIds = ['search_conversations', 'list_conversations', 'get_conversation_detail']
    for (const id of agentToolIds) {
      allBuiltinToolIds.add(id)
    }

    const calendarToolIds = [
      'calendar_event_list',
      'calendar_event_create',
      'calendar_event_update',
      'calendar_event_delete',
      'calendar_todo_list',
      'calendar_todo_create',
      'calendar_todo_update',
      'calendar_todo_delete',
      'calendar_todo_complete',
      'calendar_todo_stats',
    ]
    for (const id of calendarToolIds) {
      allBuiltinToolIds.add(id)
    }

    const automationToolIds = [
      'automation_list_employees',
      'automation_list_providers',
      'automation_task_list',
      'automation_task_create',
      'automation_task_update',
      'automation_task_delete',
      'automation_task_toggle',
      'automation_task_run_now',
      'automation_task_preview',
      'automation_run_list',
    ]
    for (const id of automationToolIds) {
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
    const { employee_id, provider_id, model_id, messages, use_skills = true, collection_ids = [], enable_thinking, conversation_id, minimal_mode = false, high_permission = false } = params

    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employee_id) as DBEmployee | undefined
    const employeeName = employee?.name || 'unknown'

    logger.info(`Chat stream started: employee="${employeeName}"(${employee_id}), conversation=${conversation_id || 'none'}, msgs=${messages.length}, skills=${use_skills}, thinking=${enable_thinking ?? 'auto'}, minimal=${minimal_mode}, highPerm=${high_permission}`)

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
      entry.collectionIdsRef.current.collectionIds = collection_ids || []

      const history: Message[] = this.expandFrontendMessages(messages.slice(0, -1))
      const lastMsg = messages[messages.length - 1]
      const query = lastMsg?.content || ''
      const queryImages = lastMsg?.images

      const systemPromptCached = await this.prepareSystemPrompt(agent, conversation_id, collection_ids, minimal_mode)
      const maxIterations = await this.resolveMaxIterations(provider_id, model_id)

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

      this.persistSystemPrompt(conversation_id, agent, systemPromptCached)
    })
  }

  private async prepareSystemPrompt(
    agent: EmployeeAgent,
    conversationId: string | undefined,
    collectionIds: string[],
    minimalMode: boolean,
  ): Promise<boolean> {
    if (conversationId) {
      const conv = this.db.getDb().prepare(
        `SELECT system_prompt FROM conversations WHERE id = ?`
      ).get(conversationId) as { system_prompt?: string } | undefined
      if (conv?.system_prompt) {
        agent.setCachedSystemPrompt(conv.system_prompt)
        agent.updateKBContextPrompt(undefined)
        return true
      }
    }

    if (minimalMode) {
      agent.updateKBContextPrompt(undefined)
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
    } catch (err: any) {
      logger.warn(`Failed to parse models_json for max_iterations (provider=${providerId}):`, err?.message || err)
    }
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
      for (const [key, entry] of this.agentEntries.entries()) {
        if (key.startsWith(`${employeeId}:`)) {
          // 释放该 agent 持有的 MCP client 引用，避免连接泄漏
          if (entry.mcpRelease) {
            entry.mcpRelease().catch(() => { /* ignore */ })
          }
          this.agentEntries.delete(key)
        }
      }
    } else {
      // 清空所有缓存：先释放全部 MCP 引用
      for (const entry of this.agentEntries.values()) {
        if (entry.mcpRelease) {
          entry.mcpRelease().catch(() => { /* ignore */ })
        }
      }
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

}

export default EmployeeAgentService
