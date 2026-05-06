import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import ToolEngineService from './tool-engine.service'
import SkillRegistryService from './skill-registry.service'
import LLMWikiService from './llm-wiki.service'
import RAGService from './rag.service'
import { LightAgent } from './agent/agent'
import { createBuiltinTools } from './agent/builtin-tools'
import { ToolDefinition } from './agent/tool.types'
import { Message } from './agent/agent.types'

export interface EmployeeChatStreamParams {
  employee_id: string
  provider_id: string
  model_id?: string
  messages: Array<{ role: string; content: string }>
  options?: {
    temperature?: number
    max_tokens?: number
  }
  use_skills?: boolean
  use_wiki?: boolean
  use_rag?: boolean
}

export interface EmployeeChatCallbacks {
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
  private wikiService: LLMWikiService
  private ragService: RAGService
  private agents: Map<string, LightAgent> = new Map()
  private static instance: EmployeeAgentService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
    this.skillRegistry = SkillRegistryService.getInstance()
    this.wikiService = LLMWikiService.getInstance()
    this.ragService = RAGService.getInstance()
  }

  static getInstance(): EmployeeAgentService {
    if (!EmployeeAgentService.instance) {
      EmployeeAgentService.instance = new EmployeeAgentService()
    }
    return EmployeeAgentService.instance
  }

  private async getOrCreateAgent(employeeId: string, providerId: string, modelId?: string, useWiki = true, useRag = true): Promise<LightAgent> {
    const cacheKey = `${employeeId}:${providerId}:${modelId || 'default'}:w${useWiki}:r${useRag}`
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

    const builtinTools = createBuiltinTools()
    agent.registerTools(builtinTools)

    const skillTools = agent.createSkillTools()
    agent.registerTools(skillTools)

    const employeeTools = this.getEmployeeTools(employeeId)
    agent.registerTools(employeeTools)

    const knowledgeTools = this.getKnowledgeTools(employee.project_id, useWiki, useRag)
    agent.registerTools(knowledgeTools)

    this.agents.set(cacheKey, agent)
    return agent
  }

  private getKnowledgeTools(projectId: string, useWiki = true, useRag = true): ToolDefinition[] {
    const tools: ToolDefinition[] = []

    if (!projectId) return tools

    if (useWiki) {
      const wikiTool: ToolDefinition = {
        id: 'query_wiki',
        name: 'query_wiki',
        title: '查询Wiki知识库',
        description: '当用户询问的问题可能涉及项目知识、业务规则、概念定义、实体信息时，调用此工具查询Wiki知识库。工具会根据查询关键词返回相关的Wiki页面内容。当用户的问题涉及专业知识、历史资料、项目背景时，优先使用此工具。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '查询关键词或问题，用于在Wiki知识库中搜索相关内容。应尽量提取用户问题的核心概念。'
            },
            top_k: {
              type: 'number',
              description: '返回结果数量（1-10，默认5）',
              minimum: 1,
              maximum: 10
            }
          },
          required: ['query']
        },
        handler: async (args: any) => {
          try {
            const results = await this.wikiService.searchWiki(projectId, args.query, args.top_k || 5)
            if (results.length === 0) {
              return { success: true, output: 'Wiki知识库中未找到相关内容。' }
            }
            const output = results.map((r, i) => {
              return `[${i + 1}] ${r.page.title} (相关度: ${(r.relevance * 100).toFixed(0)}%)\n类型: ${r.page.type}\n标签: ${r.page.tags.join(', ')}\n内容:\n${r.page.content.substring(0, 1200)}${r.page.content.length > 1200 ? '...' : ''}`
            }).join('\n\n---\n\n')
            return { success: true, output, results }
          } catch (error: any) {
            return { success: false, error: `Wiki查询失败: ${error.message}` }
          }
        },
        source: 'builtin'
      }
      tools.push(wikiTool)
    }

    if (useRag) {
      const ragTool: ToolDefinition = {
        id: 'query_rag',
        name: 'query_rag',
        title: '查询RAG向量知识库',
        description: '当用户询问的问题需要从原始文档中查找具体段落、细节信息，或Wiki知识库未能提供足够信息时，调用此工具进行RAG向量检索。此工具基于语义相似度搜索原始文档的分块内容。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '查询语句，用于语义检索原始文档中的相关内容'
            },
            top_k: {
              type: 'number',
              description: '返回结果数量（1-10，默认5）',
              minimum: 1,
              maximum: 10
            }
          },
          required: ['query']
        },
        handler: async (args: any) => {
          try {
            const results = await this.ragService.search(projectId, args.query, args.top_k || 5, 0.5)
            if (results.length === 0) {
              return { success: true, output: 'RAG知识库中未找到相关内容。' }
            }
            const output = results.map((r, i) => {
              return `[${i + 1}] ${r.source.file_name} (相关度: ${(r.score * 100).toFixed(1)}%)\n内容:\n${r.text}`
            }).join('\n\n---\n\n')
            return { success: true, output, results }
          } catch (error: any) {
            return { success: false, error: `RAG查询失败: ${error.message}` }
          }
        },
        source: 'builtin'
      }
      tools.push(ragTool)
    }

    return tools
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

  async chatStream(params: EmployeeChatStreamParams, callbacks: EmployeeChatCallbacks): Promise<void> {
    const { employee_id, provider_id, model_id, messages, use_skills = true, use_wiki = true, use_rag = true } = params

    const agent = await this.getOrCreateAgent(employee_id, provider_id, model_id, use_wiki, use_rag)

    const history: Message[] = messages.slice(0, -1).map(m => ({
      role: m.role as any,
      content: m.content,
    }))

    const query = messages[messages.length - 1]?.content || ''

    await agent.runStream(
      {
        query,
        history,
        useSkills: use_skills,
        maxRetry: 10,
      },
      {
        onChunk: callbacks.onChunk,
        onThought: callbacks.onThought,
        onToolCall: callbacks.onToolCall,
        onToolResult: callbacks.onToolResult,
        onDone: callbacks.onDone,
        onError: callbacks.onError,
      }
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
