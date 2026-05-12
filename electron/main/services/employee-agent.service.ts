import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import ToolEngineService from './tool-engine.service'
import SkillRegistryService from './skill-registry.service'
import KnowledgeBaseService from './kb.service'
import { LightAgent } from './agent/agent'
import { createBuiltinTools } from './agent/builtin-tools'
import { createKBAgentTools } from './agent/tools/kb-agent-tools'
import { ToolDefinition } from './agent/tool.types'
import { Message } from './agent/agent.types'
import type { LLMModelConfig } from '../../shared/types'

interface EmployeeChatStreamParams {
  employee_id: string
  provider_id: string
  model_id?: string
  messages: Array<{ role: string; content: string }>
  options?: {
    temperature?: number
    max_tokens?: number
  }
  use_skills?: boolean
  enable_thinking?: boolean
}

interface EmployeeChatCallbacks {
  onChunk: (chunk: string) => void
  onThought: (thought: string) => void
  onToolCall: (toolCall: { name: string; args: any }) => void
  onToolResult: (toolResult: { name: string; result: any }) => void
  onDone: () => void
  onError: (error: string) => void
}

class EmployeeAgentService {
  private db: DatabaseService
  private llmClient: LLMClientService
  private skillRegistry: SkillRegistryService
  private kbService: KnowledgeBaseService
  private agents: Map<string, LightAgent> = new Map()
  private static instance: EmployeeAgentService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
    this.skillRegistry = SkillRegistryService.getInstance()
    this.kbService = KnowledgeBaseService.getInstance()
  }

  static getInstance(): EmployeeAgentService {
    if (!EmployeeAgentService.instance) {
      EmployeeAgentService.instance = new EmployeeAgentService()
    }
    return EmployeeAgentService.instance
  }

  private async getOrCreateAgent(employeeId: string, providerId: string, modelId?: string, enableThinking?: boolean): Promise<LightAgent> {
    const cacheKey = `${employeeId}:${providerId}:${modelId || 'default'}:${enableThinking ? 'thinking' : 'no-thinking'}`
    if (this.agents.has(cacheKey)) {
      return this.agents.get(cacheKey)!
    }

    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as any
    if (!employee) {
      throw new Error(`Employee ${employeeId} not found`)
    }

    const config = await this.llmClient.getProviderConfig(providerId)
    if (!config) {
      throw new Error(`Provider ${providerId} not found`)
    }

    let instructions = '你是专业的数字员工助手。'
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
        if (profile.responsibilities?.length > 0) {
          instructions += '\n\n## 核心职责\n' + profile.responsibilities.map((r: string, i: number) => `${i + 1}. ${r}`).join('\n')
        }
        if (profile.personalityTraits?.length > 0) {
          instructions += '\n\n## 性格特质\n' + profile.personalityTraits.join('、')
        }
        if (profile.workingStyle) {
          instructions += '\n\n## 工作风格\n' + profile.workingStyle
        }
      } catch {
        // ignore
      }
    } else if (employee.description) {
      instructions = employee.description
    }

    const knowledgeGuidance = `\n\n当用户提出知识相关问题时，使用知识库工具渐进式查询知识，先了解概述再检索再精准定位。`

    instructions += knowledgeGuidance

    const skillsDir = this.skillRegistry.getSkillsDir()
    const employeeSkills = this.skillRegistry.getEmployeeSkills(employeeId)
    
    // 只收集已分配技能的安装路径
    const assignedSkillPaths = employeeSkills.assigned.map(skill => skill.installPath)

    const agent = new LightAgent({
      name: employee.name,
      instructions,
      role,
      model: modelId || config.model,
      apiKey: config.api_key,
      baseUrl: config.base_url || this.llmClient.getBaseURL(config),
      providerType: config.provider_type,
      enableThinking: enableThinking ?? this.getModelThinkingConfig(config, modelId),
      skillsDirectories: [skillsDir],
      allowedSkillPaths: assignedSkillPaths,
      autoDiscoverSkills: true,
      debug: false,
    })

    for (const skill of employeeSkills.assigned) {
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

    const allBuiltinTools = createBuiltinTools()
    const enabledToolIds = this.getEnabledBuiltinToolIds(employeeId)
    const builtinTools = allBuiltinTools.filter(t => enabledToolIds.has(t.id))
    agent.registerTools(builtinTools)

    const skillTools = agent.createSkillTools()
    agent.registerTools(skillTools)

    const employeeTools = this.getEmployeeTools(employeeId)
    agent.registerTools(employeeTools)

    const knowledgeTools = this.getKnowledgeTools(employee.project_id).filter(t => enabledToolIds.has(t.id))
    agent.registerTools(knowledgeTools)

    this.agents.set(cacheKey, agent)
    return agent
  }

  private getKnowledgeTools(projectId: string): ToolDefinition[] {
    return createKBAgentTools(this.kbService, this.db, projectId)
  }

  private getEnabledBuiltinToolIds(employeeId: string): Set<string> {
    const allBuiltinToolIds = new Set(createBuiltinTools().map(t => t.id))
    // 添加知识库工具ID（这些工具由 getKnowledgeTools 动态创建）
    const kbToolIds = [
      'kb_search',
      'kb_advanced_search',
      'kb_list_entities',
      'kb_entity_detail',
      'kb_get_content',
      'kb_overview',
      'query_global_summary',
      'query_knowledge_graph',
      'query_chapters',
      'query_fulltext',
    ]
    for (const id of kbToolIds) {
      allBuiltinToolIds.add(id)
    }

    const enabledRows = this.db.getDb().prepare(
      'SELECT tool_id, is_enabled FROM employee_tools WHERE employee_id = ?'
    ).all(employeeId) as any[]

    if (enabledRows.length === 0) {
      return allBuiltinToolIds
    }

    const result = new Set<string>()
    const disabledSet = new Set<string>()
    for (const row of enabledRows) {
      if (allBuiltinToolIds.has(row.tool_id)) {
        if (row.is_enabled === 1) {
          result.add(row.tool_id)
        } else {
          disabledSet.add(row.tool_id)
        }
      }
    }

    for (const id of allBuiltinToolIds) {
      if (!disabledSet.has(id) && !result.has(id)) {
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
      source: t.source as any,
    }))
  }

  private getModelThinkingConfig(config: any, modelId?: string): boolean {
    if (!config?.models_json) return false
    try {
      const models: LLMModelConfig[] = JSON.parse(config.models_json)
      const matched = modelId
        ? models.find(m => m.model === modelId)
        : models.find(m => m.is_default)
      return matched?.enable_thinking ?? false
    } catch {
      return false
    }
  }

  async chatStream(params: EmployeeChatStreamParams, callbacks: EmployeeChatCallbacks, signal?: AbortSignal): Promise<void> {
    const { employee_id, provider_id, model_id, messages, use_skills = true, enable_thinking } = params

    const agent = await this.getOrCreateAgent(employee_id, provider_id, model_id, enable_thinking)

    const history: Message[] = messages.slice(0, -1).map(m => ({
      role: m.role as any,
      content: m.content,
    }))

    const query = messages[messages.length - 1]?.content || ''

    let maxRetry = 100
    if (model_id) {
      const config = await this.llmClient.getProviderConfig(provider_id)
      if (config?.models_json) {
        try {
          const models: LLMModelConfig[] = JSON.parse(config.models_json)
          const matched = models.find(m => m.model === model_id)
          if (matched?.max_retry !== undefined) {
            maxRetry = matched.max_retry
          }
        } catch {}
      }
    }

    await agent.runStream(
      {
        query,
        history,
        useSkills: use_skills,
        maxRetry,
      },
      {
        onChunk: callbacks.onChunk,
        onThought: callbacks.onThought,
        onToolCall: callbacks.onToolCall,
        onToolResult: callbacks.onToolResult,
        onDone: callbacks.onDone,
        onError: callbacks.onError,
      },
      signal
    )
  }

  clearAgentCache(employeeId?: string): void {
    if (employeeId) {
      for (const key of this.agents.keys()) {
        if (key.startsWith(`${employeeId}:`)) {
          this.agents.delete(key)
        }
      }
    } else {
      this.agents.clear()
    }
  }
}

export default EmployeeAgentService
