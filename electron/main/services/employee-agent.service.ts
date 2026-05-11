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

  private async getOrCreateAgent(employeeId: string, providerId: string, modelId?: string): Promise<LightAgent> {
    const cacheKey = `${employeeId}:${providerId}:${modelId || 'default'}`
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

    const knowledgeGuidance = `\n\n## 知识查询策略（渐进式推理）\n\n当用户提出知识相关问题时，请按以下渐进式策略进行推理和查询：\n\n### 快速检索首选\n- **kb_search**（智能知识库检索）：当你不确定具体检索维度，或需要快速获取与主题相关的所有信息时，优先使用此工具。它会同时搜索文档标题、摘要、章节、关键词、实体和原始内容，返回最相关的结果。\n- **kb_advanced_search**（高级检索）：当你需要精确短语匹配、排除某些词、或限定文档类型时使用。支持 "精确短语"、+必须包含、-排除词 语法。\n\n### 分层查询工具\n1. **知识库概览**：如果不确定知识库中有哪些文件，先调用 kb_overview 获取知识库中所有文件的列表和摘要，判断哪些文件与问题相关\n2. **全局定位**：调用 query_global_summary 了解知识库整体结构和核心主题\n3. **实体浏览**：调用 kb_list_entities 浏览知识库中的关键实体（人物、组织、概念等），了解知识覆盖范围\n4. **实体详情**：调用 kb_entity_detail 获取某个实体的详细信息、属性、关系网络和提及记录\n5. **实体关系**：如果问题涉及特定实体关系，调用 query_knowledge_graph 查询实体关系网络\n6. **章节检索**：调用 query_chapters 定位相关章节摘要，缩小查找范围\n7. **深度检索**：如果需要具体细节，调用 query_fulltext 进行全文关键词检索\n8. **内容获取**：如果需要完整上下文，调用 kb_get_content 获取文档或章节完整内容。支持4种定位方式：仅传document_id获取整个文档、传chapter_id获取指定章节、传start_offset/end_offset获取字符区间、传start_line/end_line获取行号范围\n9. **文档对比**：调用 kb_compare_documents 对比多个文档的主题重叠和差异\n\n### 工具选择指南\n- 不确定知识库有哪些内容 → 优先 kb_overview\n- 快速全面了解某主题 → kb_search\n- 需要精确匹配或排除词 → kb_advanced_search\n- 想了解知识库有哪些实体 → kb_list_entities\n- 深入了解某个实体 → kb_entity_detail\n- 专业知识/业务规则/概念定义 → 优先 query_chapters\n- 人物/组织关系 → query_knowledge_graph 或 kb_entity_detail\n- 具体文档段落/细节 → query_fulltext\n- 需要查看某个文件的完整内容或指定区间 → kb_get_content（支持 chapter_id / start_offset+end_offset / start_line+end_line）\n- 对比多个文档 → kb_compare_documents\n- 不要一次性调用所有工具，根据问题类型选择最合适的1-2个工具\n- 回答时标注信息来源，格式为 [文档名称-章节名称]`

    instructions += knowledgeGuidance

    const skillsDir = this.skillRegistry.getSkillsDir()
    const employeeSkills = this.skillRegistry.getEmployeeSkills(employeeId)

    const agent = new LightAgent({
      name: employee.name,
      instructions,
      role,
      model: modelId || config.model,
      apiKey: config.api_key,
      baseUrl: config.base_url || this.llmClient.getBaseURL(config),
      skillsDirectories: [skillsDir],
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
      'kb_compare_documents',
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

  async chatStream(params: EmployeeChatStreamParams, callbacks: EmployeeChatCallbacks, signal?: AbortSignal): Promise<void> {
    const { employee_id, provider_id, model_id, messages, use_skills = true } = params

    const agent = await this.getOrCreateAgent(employee_id, provider_id, model_id)

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
