import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import ToolEngineService from './tool-engine.service'
import SkillRegistryService from './skill-registry.service'
import KnowledgeBaseService from './kb.service'
import EmployeeMemoryService from './employee-memory.service'
import { EmployeeAgent } from './agent/business/employee-agent'
import type { EmployeeAgentConfig } from './agent/business/employee-agent'
import type { BaseAgentOptions } from './agent/core/base-agent'
import { allBuiltinTools, createKBAgentTools, createWorkspaceTools, getWorkspacePrompt, createOfficeGuideTool, officeExecTool } from './agent/tools'
import type { ToolDefinition } from './agent/tools/types'
import type { KbIdsRef } from './agent/tools/kb-agent-tools'
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
  messages: Array<{ role: string; content: string; images?: string[] }>
  options?: {
    temperature?: number
    max_tokens?: number
  }
  use_skills?: boolean
  kb_ids?: string[]
  enable_thinking?: boolean
  conversation_id?: string
  minimal_mode?: boolean
}

interface EmployeeChatCallbacks {
  onChunk: (chunk: string) => void
  onThought: (thought: string) => void
  onToolCall: (toolCall: { name: string; args: any }) => void
  onToolResult: (toolResult: { name: string; result: any }) => void
  onDone: (metadata?: any) => void
  onError: (error: string) => void
}

interface CachedAgentEntry {
  agent: EmployeeAgent
  conversationId: string | null
  kbIdsRef: KbIdsRef
}

class EmployeeAgentService {
  private db: DatabaseService
  private llmClient: LLMClientService
  private skillRegistry: SkillRegistryService
  private kbService: KnowledgeBaseService
  private memoryService: EmployeeMemoryService
  private agentEntries: Map<string, CachedAgentEntry> = new Map()
  private static instance: EmployeeAgentService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
    this.skillRegistry = SkillRegistryService.getInstance()
    this.kbService = KnowledgeBaseService.getInstance()
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
    conversationId?: string
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

    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as DBEmployee | undefined
    if (!employee) {
      throw new Error(`Employee ${employeeId} not found`)
    }

    const config = await this.llmClient.getProviderConfig(providerId)
    if (!config) {
      throw new Error(`Provider ${providerId} not found`)
    }

    let instructions = '你是专业数字员工，基于知识库和工具为用户提供服务。'
    let role: string | undefined
    if (employee.profile_json) {
      try {
        const profile = JSON.parse(employee.profile_json)
        if (profile.roleDescription) {
          instructions = profile.roleDescription
        }
        if (profile.roleName) {
          role = profile.roleName
        }
      } catch {
      }
    } else if (employee.description) {
      instructions = employee.description
    }

    const workspaceGuidance = getWorkspacePrompt(employee.workspace_path || '')

    const employeeSkills = this.skillRegistry.getEmployeeSkills(employeeId)

    const enabledSkillPaths = employeeSkills.enabled.map(skill => skill.installPath)

    const modelConfig = this.getModelConfig(config, modelId)

    const resolvedModelName = modelConfig?.model || modelId || config.model

    const memoryEnabled = employee.memory_enabled === 1
    const memoryPrompt = memoryEnabled
      ? (this.memoryService.formatMemoriesForPrompt(
          this.memoryService.listMemories(employeeId)
        ) || undefined)
      : undefined

    const agentConfig: EmployeeAgentConfig = {
      name: employee.name,
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
      workspaceGuidance: workspaceGuidance || undefined,
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

    const employeeTools = this.getEmployeeTools(employeeId)
    agent.registerTools(employeeTools)

    const kbIdsRef: KbIdsRef = { current: [] }
    const knowledgeTools = this.getKnowledgeTools(kbIdsRef).filter(t => enabledToolIds.has(t.id))
    agent.registerTools(knowledgeTools)

    const workspaceTools = createWorkspaceTools(employee.workspace_path || '')
    if (workspaceTools.length > 0) {
      agent.registerTools(workspaceTools)
    }

    const officeGuideTool = createOfficeGuideTool(employee.workspace_path || '')
    agent.registerTools([officeGuideTool, officeExecTool])

    agent.getMemoryManager().setLLMSummaryFn(async (msgs) => {
      return this.memoryService.generateLLMSummary(msgs, providerId, modelId)
    })

    if (memoryPrompt) {
      agent.updateMemoryPrompt(memoryPrompt)
    }

    this.agentEntries.set(cacheKey, {
      agent,
      conversationId: conversationId || null,
      kbIdsRef,
    })
    return { agent, conversationId: conversationId || null, kbIdsRef }
  }

  private getKnowledgeTools(kbIdsRef: KbIdsRef): ToolDefinition[] {
    return createKBAgentTools(this.kbService, kbIdsRef)
  }

  private getEnabledBuiltinToolIds(employeeId: string): Set<string> {
    const allBuiltinToolIds = new Set(allBuiltinTools.map(t => t.id))
    const kbToolIds = [
      'kb_list',
      'kb_overview',
      'kb_search',
      'kb_get_toc',
      'kb_get_paragraphs',
      'kb_get_content',
    ]
    for (const id of kbToolIds) {
      allBuiltinToolIds.add(id)
    }

    const workspaceToolIds = [
      'workspace_list_files',
      'workspace_read_file',
      'workspace_write_file',
      'workspace_create_folder',
      'workspace_delete_item',
      'workspace_rename_item',
    ]
    for (const id of workspaceToolIds) {
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

  private getEmployeeTools(employeeId: string): ToolDefinition[] {
    const toolEngine = ToolEngineService.getInstance()
    const assignedTools = toolEngine.getToolsForEmployee(employeeId)

    return assignedTools.map((t) => ({
      id: t.id,
      name: t.name,
      title: t.name,
      description: t.description || '',
      parameters: {
        type: 'object' as const,
        properties: (t.parameters as any)?.properties || {},
        required: (t.parameters as any)?.required,
      },
      handler: async (args: any) => {
        const result = await toolEngine.executeTool(t.id, args)
        return result.success ? result.output : { error: result.error }
      },
      source: t.source as ToolDefinition['source'],
    }))
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
    const { employee_id, provider_id, model_id, messages, use_skills = true, kb_ids = [], enable_thinking, conversation_id, minimal_mode = false } = params

    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employee_id) as DBEmployee | undefined
    const employeeName = employee?.name || 'unknown'

    const logCtx = {
      employeeId: employee_id,
      employeeName,
      conversationId: conversation_id,
      source: 'chat',
    }

    await LLMLoggerService.getInstance().runWithContext(logCtx, async () => {
      const entry = await this.getOrCreateAgent(employee_id, provider_id, model_id, enable_thinking, conversation_id)
      const agent = entry.agent
      agent.setMinimalMode(minimal_mode)
      entry.kbIdsRef.current = kb_ids || []

      const history: Message[] = messages.slice(0, -1).map(m => ({
        role: m.role as any,
        content: m.content,
        images: m.images,
      }))

      const lastMsg = messages[messages.length - 1]
      const query = lastMsg?.content || ''
      const queryImages = lastMsg?.images

      if (minimal_mode) {
        agent.updateKBContextPrompt(undefined)
        agent.updateToolPlanningPrompt(null)
      } else {
        if (kb_ids.length > 0) {
          const kbDb = require('./kb-database.service').default.getInstance()
          const placeholders = kb_ids.map(() => '?').join(',')
          const kbList = kbDb.getDb().prepare(
            `SELECT id, name FROM knowledge_bases WHERE id IN (${placeholders})`
          ).all(...kb_ids) as any[]
          const kbNames = kbList.map((kb: any) => kb.name).join('、')
          agent.updateKBContextPrompt(`当前对话可使用的知识库: ${kbNames}`)
        } else {
          agent.updateKBContextPrompt(undefined)
        }

        const toolPlanningHint = await agent.buildToolPlanningHint(query).catch(() => null)
        agent.updateToolPlanningPrompt(toolPlanningHint)
      }

      const config = await this.llmClient.getProviderConfig(provider_id)
      let maxIterations = 100
      if (config?.models_json) {
        try {
          const models: LLMModelConfig[] = JSON.parse(config.models_json)
          const matched = model_id
            ? models.find(m => m.id === model_id) || models.find(m => m.model === model_id)
            : models.find(m => m.is_default)
          if (matched?.max_retry !== undefined) {
            maxIterations = matched.max_retry
          }
        } catch {}
      }

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
    })
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

  getRelevantMemoriesForPrompt(employeeId: string, query: string): string {
    const memories = this.memoryService.getRelevantMemories(employeeId, query)
    return this.memoryService.formatMemoriesForPrompt(memories)
  }
}

export default EmployeeAgentService
