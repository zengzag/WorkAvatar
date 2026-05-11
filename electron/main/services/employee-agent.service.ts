import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import ToolEngineService from './tool-engine.service'
import SkillRegistryService from './skill-registry.service'
import KnowledgeBaseService from './kb.service'
import { LightAgent } from './agent/agent'
import { createBuiltinTools, createKBSearchTool, createKBAdvancedSearchTool, createKBDocumentCompareTool, createKBEntitiesTool, createKBEntityDetailTool, createKBGetContentTool } from './agent/builtin-tools'
import { ToolDefinition } from './agent/tool.types'
import { Message } from './agent/agent.types'
import type { LLMModelConfig } from '../../shared/types'

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
    const tools: ToolDefinition[] = []
    if (!projectId) return tools

    const projectKBs = this.kbService.getKBsForProject(projectId) as any[]
    const kbIds = projectKBs.map((kb: any) => kb.id)

    const validateKbId = (kbId: string | undefined): string | null => {
      if (!kbId) return kbIds.length > 0 ? kbIds[0] : null
      if (!kbIds.includes(kbId)) return null
      return kbId
    }

    const kbOverviewTool: ToolDefinition = {
      id: 'kb_overview',
      name: 'kb_overview',
      title: '知识库概览',
      description: `获取知识库的整体概览。当你需要了解知识库中有什么内容、判断哪些文件可能与用户问题相关时，优先调用此工具。
【使用说明】
1. 如果不传 kb_id，将返回所有可访问知识库的列表（包含每个知识库的介绍和ID），方便你了解有哪些知识库可选
2. 如果传入 kb_id，将返回该知识库中所有已解析完成的文档列表，包含文档摘要、核心主题和章节信息
3. 返回结果包含每个文件的 document_id，你可以用 kb_get_content 获取完整文件内容或指定文本区间
【可选知识库】${projectKBs.map((kb: any) => `${kb.id}(${kb.name})`).join(', ')}`,
      parameters: {
        type: 'object',
        properties: {
          kb_id: {
            type: 'string',
            description: `知识库ID（可选）。不传则返回所有可访问知识库列表；传入则返回该知识库的文档详情。可选值: ${projectKBs.map((kb: any) => `${kb.id}(${kb.name})`).join(', ')}`
          }
        },
        required: []
      },
      handler: async (args: any) => {
        try {
          // 如果不传 kb_id，返回所有可访问知识库的列表
          if (!args.kb_id) {
            if (projectKBs.length === 0) {
              return { success: true, output: '当前项目未关联任何知识库。' }
            }

            let output = `## 可访问的知识库列表\n\n`
            output += `当前数字员工可访问 ${projectKBs.length} 个知识库，请根据问题选择最合适的知识库进行查询：\n\n`

            for (let i = 0; i < projectKBs.length; i++) {
              const kb = projectKBs[i]
              output += `[${i + 1}] **${kb.name}**\n`
              output += `- **知识库ID**: ${kb.id}\n`
              if (kb.description) {
                output += `- **介绍**: ${kb.description}\n`
              }
              output += `- **文档数量**: ${kb.doc_count || 0}\n`

              // 获取该知识库的全局摘要（如果有）
              const globalSummary = this.kbService.getGlobalSummary(kb.id)
              if (globalSummary) {
                const keyTopics: string[] = JSON.parse(globalSummary.key_topics_json || '[]')
                if (keyTopics.length > 0) {
                  output += `- **核心主题**: ${keyTopics.join('、')}\n`
                }
              }
              output += '\n'
            }

            output += `### 使用建议\n`
            output += `- 请根据用户问题选择最相关的知识库，传入其 kb_id 获取详细文档列表\n`
            output += `- 如果不确定哪个知识库包含答案，可以依次查询每个知识库\n`
            output += `- 也可以使用 kb_search 工具直接在所有知识库中搜索（会自动选择第一个知识库）\n`

            return { success: true, output }
          }

          // 传入了 kb_id，返回该知识库的文档详情
          const targetKbId = validateKbId(args.kb_id)
          if (!targetKbId) {
            return { success: true, output: '未关联知识库或无权访问该知识库，无法获取概览。' }
          }

          const kb = this.kbService.getKB(targetKbId)
          if (!kb) {
            return { success: true, output: '知识库不存在。' }
          }

          const docs = this.kbService.getDocumentList(targetKbId) as any[]
          const completedDocs = docs.filter((d: any) => d.parse_status === 'completed')

          if (completedDocs.length === 0) {
            return { success: true, output: `知识库"${kb.name}"中暂无已解析的文档。` }
          }

          let output = `## 知识库概览: ${kb.name}\n\n`
          if (kb.description) {
            output += `**描述**: ${kb.description}\n\n`
          }
          output += `**文档总数**: ${completedDocs.length}\n\n`
          output += `### 文档列表\n\n`

          for (const doc of completedDocs) {
            output += `#### ${doc.original_name}\n`
            output += `- **文档ID**: ${doc.id}\n`
            output += `- **类型**: ${doc.type}\n`

            const docSummary = this.kbService.getDocumentSummary(doc.id)
            if (docSummary) {
              const topics: string[] = JSON.parse(docSummary.main_topics_json || '[]')
              output += `- **摘要**: ${docSummary.summary || '无摘要'}\n`
              if (topics.length > 0) {
                output += `- **主题**: ${topics.join('、')}\n`
              }
            } else {
              output += `- **摘要**: 尚未进行知识处理，请先处理文档\n`
            }

            const chapters = this.kbService.getChapters(doc.id)
            if (chapters.length > 0) {
              output += `- **章节**: ${chapters.map((ch: any) => ch.title).join('、')}\n`
            }

            output += '\n'
          }

          output += `### 下一步查询建议\n`
          output += `- 使用 kb_get_content 并传入 document_id 可获取某个文件的完整内容或指定区间\n`
          output += `- 使用 kb_search 进行智能综合检索快速定位相关内容\n`
          output += `- 使用 query_chapters 按关键词检索相关章节\n`
          output += `- 使用 query_global_summary 获取知识库的全局摘要和核心主题\n`
          output += `- 使用 query_knowledge_graph 查询特定实体的关系网络\n`

          return { success: true, output }
        } catch (error: any) {
          return { success: false, error: `知识库概览获取失败: ${error.message}` }
        }
      },
      source: 'builtin'
    }
    tools.push(kbOverviewTool)

    const globalSummaryTool: ToolDefinition = {
      id: 'query_global_summary',
      name: 'query_global_summary',
      title: '查询全局知识摘要',
      description: '查询整个知识库的全局摘要，了解知识库的核心主题、整体结构和关键实体。在回答复杂问题前，先调用此工具了解全局信息，确定问题相关的文档和主题范围。\n【实现说明】返回知识库的全局摘要、核心主题列表和关键实体，帮助进行问题范围定位。\n返回结果会包含关键实体名称，你可以进一步用 query_knowledge_graph 查询实体关系。',
      parameters: {
        type: 'object',
        properties: {
          kb_id: {
            type: 'string',
            description: `知识库ID（可选，不提供则使用默认知识库）。可选值: ${projectKBs.map((kb: any) => `${kb.id}(${kb.name})`).join(', ')}`
          }
        },
        required: []
      },
      handler: async (args: any) => {
        try {
          const targetKbId = validateKbId(args.kb_id)
          if (!targetKbId) {
            return { success: true, output: '未关联知识库，无法查询全局摘要。' }
          }
          const globalSummary = this.kbService.getGlobalSummary(targetKbId)
          if (!globalSummary) {
            return { success: true, output: '知识库尚未生成全局摘要，请先处理文档并构建全局知识。' }
          }
          const keyTopics: string[] = JSON.parse(globalSummary.key_topics_json || '[]')
          const keyEntities: any[] = JSON.parse(globalSummary.key_entities_json || '[]')
          const output = `## 全局知识摘要\n\n${globalSummary.summary}\n\n### 核心主题\n${keyTopics.map(t => `- ${t}`).join('\n')}\n\n### 关键实体\n${keyEntities.map(e => `- ${e.name}(${e.type}): ${e.description || ''}`).join('\n')}\n\n### 下一步查询建议\n- 如果问题涉及某个实体，请使用 query_knowledge_graph 查询该实体的关系网络\n- 如果需要定位具体章节，请使用 query_chapters 按关键词检索\n- 如果需要查看原始文档内容，请使用 kb_get_content 获取完整文档或指定文本区间`
          return { success: true, output }
        } catch (error: any) {
          return { success: false, error: `全局摘要查询失败: ${error.message}` }
        }
      },
      source: 'builtin'
    }
    tools.push(globalSummaryTool)

    const knowledgeGraphTool: ToolDefinition = {
      id: 'query_knowledge_graph',
      name: 'query_knowledge_graph',
      title: '查询知识图谱',
      description: '查询知识图谱中特定实体的信息和关系网络。当问题涉及人物、组织、事件等实体之间的关系时，使用此工具。\n【实现说明】支持实体名称模糊匹配，如果未找到精确匹配的实体会自动返回相似实体列表，支持查询1-3度的关系网络。\n返回结果会包含关联实体和关系类型，你可以进一步用 kb_search、query_chapters 或 kb_get_content 深入查询相关内容。',
      parameters: {
        type: 'object',
        properties: {
          entity_name: {
            type: 'string',
            description: '实体名称'
          },
          relation_type: {
            type: 'string',
            description: '关系类型过滤（可选）'
          },
          depth: {
            type: 'number',
            description: '查询深度，1表示直接关系，2表示二度关系（默认1）',
            minimum: 1,
            maximum: 3
          },
          kb_id: {
            type: 'string',
            description: `知识库ID（可选）。可选值: ${projectKBs.map((kb: any) => `${kb.id}(${kb.name})`).join(', ')}`
          }
        },
        required: ['entity_name']
      },
      handler: async (args: any) => {
        try {
          const targetKbId = validateKbId(args.kb_id)
          if (!targetKbId) {
            return { success: true, output: '未关联知识库，无法查询知识图谱。' }
          }
          const entity = this.kbService.getEntityByName(targetKbId, args.entity_name)
          if (!entity) {
            const entities = this.kbService.getEntities(targetKbId)
            const matches = entities.filter((e: any) =>
              e.name.toLowerCase().includes(args.entity_name.toLowerCase()) ||
              (JSON.parse(e.aliases_json || '[]') as string[]).some(a => a.toLowerCase().includes(args.entity_name.toLowerCase()))
            ).slice(0, 5)
            if (matches.length === 0) {
              return { success: true, output: `未找到实体"${args.entity_name}"。你可以用 query_chapters 搜索相关内容。` }
            }
            const matchInfo = matches.map((e: any) =>
              `${e.name}(${e.type}): ${e.description || '无描述'}`
            ).join('\n')
            return { success: true, output: `未精确匹配"${args.entity_name}"，但找到以下相似实体：\n${matchInfo}\n\n请使用精确的实体名称再次调用 query_knowledge_graph 查询关系。` }
          }

          const depth = args.depth || 1
          const relations = this.kbService.getEntityRelations(entity.id, depth)

          let output = `## 实体: ${entity.name}\n\n**类型**: ${entity.type}\n**描述**: ${entity.description || '无'}\n**别名**: ${JSON.parse(entity.aliases_json || '[]').join(', ') || '无'}\n**提及次数**: ${entity.mention_count}\n\n`

          if (relations.length > 0) {
            output += `### 关系网络 (深度${depth})\n\n`
            for (const rel of relations) {
              const direction = rel.source_entity_id === entity.id ? '→' : '←'
              const otherName = rel.source_entity_id === entity.id ? rel.target_name : rel.source_name
              const otherType = rel.source_entity_id === entity.id ? rel.target_type : rel.source_type
              output += `- ${direction} **${otherName}**(${otherType}) — ${rel.relation_type}: ${rel.description || ''}\n`
            }
            output += `\n### 下一步查询建议\n- 使用 query_knowledge_graph 查询上述关联实体的详细关系\n- 使用 query_chapters 搜索与"${entity.name}"相关的章节\n- 使用 kb_search 进行智能综合检索获取相关内容\n- 使用 kb_get_content 获取提及该实体的文档原文`
          } else {
            output += '### 关系网络\n\n暂无已知关系。\n\n### 下一步查询建议\n- 使用 query_chapters 搜索与该实体相关的章节内容'
          }

          return { success: true, output }
        } catch (error: any) {
          return { success: false, error: `知识图谱查询失败: ${error.message}` }
        }
      },
      source: 'builtin'
    }
    tools.push(knowledgeGraphTool)

    const chapterSearchTool: ToolDefinition = {
      id: 'query_chapters',
      name: 'query_chapters',
      title: '检索章节摘要',
      description: '根据查询内容检索相关的章节摘要，用于定位问题相关的文档章节。在查询具体细节前，先使用此工具定位相关章节，再决定是否需要深入查看原文。\n【实现说明】基于关键词模糊匹配+权重计分实现：\n- 支持空格分隔多个关键词，多个关键词会同时匹配计分\n- 标题包含关键词 +5分/词，章节标注关键词包含 +3分/词，摘要包含关键词 +2分/词\n- 按总分降序排序返回最相关结果\n返回结果包含 document_id 和 chapter_id，你可以用 kb_get_content 获取完整内容或指定文本区间。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '查询关键词或问题'
          },
          top_k: {
            type: 'number',
            description: '返回最相关的章节数量（1-10，默认5）',
            minimum: 1,
            maximum: 10
          },
          kb_id: {
            type: 'string',
            description: `知识库ID（可选）。可选值: ${projectKBs.map((kb: any) => `${kb.id}(${kb.name})`).join(', ')}`
          }
        },
        required: ['query']
      },
      handler: async (args: any) => {
        try {
          const targetKbId = validateKbId(args.kb_id)
          if (!targetKbId) {
            return { success: true, output: '未关联知识库，无法检索章节。' }
          }
          const chapters = this.kbService.searchChapters(targetKbId, args.query, args.top_k || 5)
          if (chapters.length === 0) {
            return { success: true, output: '未找到相关章节摘要。你可以用 query_fulltext 进行语义检索。' }
          }
          const output = chapters.map((ch: any, i: number) => {
            const entities: any[] = JSON.parse(ch.entities_json || '[]')
            const entityNames = entities.map((e: any) => `${e.name}(${e.type})`).join(', ')
            return `[${i + 1}] 文档: ${ch.document_name} | 章节: ${ch.title}\n摘要: ${ch.summary || '无摘要'}\n关键词: ${JSON.parse(ch.keywords_json || '[]').join(', ')}\n实体: ${entityNames}\n[document_id: ${ch.document_id}, chapter_id: ${ch.id}]`
          }).join('\n\n---\n\n')
          return { success: true, output: output + '\n\n提示: 使用 kb_get_content 并传入 document_id 或 chapter_id 可获取完整内容；传入 start_offset/end_offset 或 start_line/end_line 可获取指定文本区间。' }
        } catch (error: any) {
          return { success: false, error: `章节检索失败: ${error.message}` }
        }
      },
      source: 'builtin'
    }
    tools.push(chapterSearchTool)

    const fulltextSearchTool: ToolDefinition = {
      id: 'query_fulltext',
      name: 'query_fulltext',
      title: '全文关键词检索',
      description: '在原始文档内容中进行关键词检索，获取包含关键词的文本片段。当需要查找具体段落、细节信息，或章节摘要不够详细时使用。支持跨文档检索。\n【实现说明】基于关键词模糊匹配+权重计分实现：\n- 支持空格分隔多个关键词，多个关键词会同时匹配计分\n- 段落中每个关键词匹配 +1分，匹配越多越相关\n- 返回包含关键词的上下文片段（约200字符）\n返回结果包含 document_id，你可以用 kb_get_content 获取完整文档或指定文本区间。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索查询语句（支持空格分隔多个关键词）'
          },
          top_k: {
            type: 'number',
            description: '返回结果数量（1-10，默认5）',
            minimum: 1,
            maximum: 10
          },
          document_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '限定检索的文档ID列表（可选）'
          },
          kb_id: {
            type: 'string',
            description: `知识库ID（可选）。可选值: ${projectKBs.map((kb: any) => `${kb.id}(${kb.name})`).join(', ')}`
          }
        },
        required: ['query']
      },
      handler: async (args: any) => {
        try {
          const targetKbId = validateKbId(args.kb_id)
          if (!targetKbId) {
            return { success: true, output: '未关联知识库，无法进行全文检索。' }
          }

          const queryWords = args.query.toLowerCase().split(/\s+/).filter((w: string) => w.length > 1)
          if (queryWords.length === 0) {
            return { success: true, output: '请输入有效的查询关键词（至少2个字符）。' }
          }

          let docsSql = 'SELECT id, original_name as document_name FROM kb_documents WHERE kb_id = ? AND parse_status = "completed"'
          const params: any[] = [targetKbId]

          if (args.document_ids && args.document_ids.length > 0) {
            docsSql += ' AND id IN (' + args.document_ids.map(() => '?').join(',') + ')'
            params.push(...args.document_ids)
          }

          const docs = this.db.getDb().prepare(docsSql).all(...params) as any[]
          if (docs.length === 0) {
            return { success: true, output: '未找到符合条件的文档。' }
          }

          interface MatchResult {
            document_id: string
            document_name: string
            text: string
            score: number
          }
          const results: MatchResult[] = []

          for (const doc of docs) {
            const content = this.kbService.getDocumentContent(doc.id)
            if (!content) continue

            const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 20)
            for (const para of paragraphs) {
              const paraLower = para.toLowerCase()
              let score = 0
              for (const word of queryWords) {
                if (paraLower.includes(word)) {
                  score += 1
                }
              }
              if (score > 0) {
                const startIdx = Math.max(0, paraLower.indexOf(queryWords[0]) - 100)
                const endIdx = Math.min(para.length, startIdx + 200)
                let snippet = para.substring(startIdx, endIdx)
                if (startIdx > 0) snippet = '...' + snippet
                if (endIdx < para.length) snippet = snippet + '...'

                results.push({
                  document_id: doc.id,
                  document_name: doc.document_name,
                  text: snippet,
                  score
                })
              }
            }
          }

          results.sort((a, b) => b.score - a.score)
          const topResults = results.slice(0, args.top_k || 5)

          if (topResults.length === 0) {
            return { success: true, output: '全文检索未找到相关内容。' }
          }

          const output = topResults.map((r, i) =>
            `[${i + 1}] ${r.document_name} (匹配关键词数: ${r.score})\n${r.text}\n[document_id: ${r.document_id}]`
          ).join('\n\n---\n\n')

          return { success: true, output: output + '\n\n提示: 使用 kb_get_content 并传入 document_id 可获取完整文档；传入 start_offset/end_offset 或 start_line/end_line 可获取指定文本区间。' }
        } catch (error: any) {
          return { success: false, error: `全文检索失败: ${error.message}` }
        }
      },
      source: 'builtin'
    }
    tools.push(fulltextSearchTool)

    // 使用工厂函数创建带有权限控制的知识库工具
    tools.push(createKBSearchTool(kbIds))
    tools.push(createKBAdvancedSearchTool(kbIds))
    tools.push(createKBDocumentCompareTool(kbIds))
    tools.push(createKBEntitiesTool(kbIds))
    tools.push(createKBEntityDetailTool(kbIds))
    tools.push(createKBGetContentTool(kbIds))

    return tools
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
