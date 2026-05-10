import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import ToolEngineService from './tool-engine.service'
import SkillRegistryService from './skill-registry.service'
import RAGService from './rag.service'
import KnowledgeBaseService from './kb.service'
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
  private ragService: RAGService
  private kbService: KnowledgeBaseService
  private agents: Map<string, LightAgent> = new Map()
  private static instance: EmployeeAgentService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
    this.skillRegistry = SkillRegistryService.getInstance()
    this.ragService = RAGService.getInstance()
    this.kbService = KnowledgeBaseService.getInstance()
  }

  static getInstance(): EmployeeAgentService {
    if (!EmployeeAgentService.instance) {
      EmployeeAgentService.instance = new EmployeeAgentService()
    }
    return EmployeeAgentService.instance
  }

  private async getOrCreateAgent(employeeId: string, providerId: string, modelId?: string, _useWiki?: boolean, useRag = true): Promise<LightAgent> {
    const cacheKey = `${employeeId}:${providerId}:${modelId || 'default'}:r${useRag}`
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

    const knowledgeGuidance = useRag
      ? `\n\n## 知识查询策略（渐进式推理）\n\n当用户提出知识相关问题时，请按以下渐进式策略进行推理和查询：\n\n1. **问题分析**：分析用户问题的类型和所需信息范围\n2. **知识库概览**：如果不确定知识库中有哪些文件，先调用 kb_overview 获取知识库中所有文件的列表和摘要，判断哪些文件与问题相关\n3. **全局定位**：调用 query_global_summary 了解知识库整体结构和核心主题\n4. **实体查询**：如果问题涉及特定实体（人物、组织、事件等），调用 query_knowledge_graph 查询实体关系\n5. **章节检索**：调用 query_chapters 定位相关章节摘要，缩小查找范围\n6. **深度检索**：如果需要具体细节，调用 query_fulltext 进行全文语义检索\n7. **内容获取**：如果需要完整上下文，调用 get_document_content 获取文档或章节完整内容\n8. **时间线生成**：如果问题涉及发展历程或变化过程，调用 generate_timeline\n\n注意：\n- 不确定知识库有哪些内容 → 优先 kb_overview\n- 专业知识/业务规则/概念定义 → 优先 query_chapters\n- 人物/组织关系 → query_knowledge_graph\n- 具体文档段落/细节 → query_fulltext\n- 发展历程/变化过程 → generate_timeline\n- 需要查看某个文件的完整内容 → get_document_content（传入 document_id）\n- 不要一次性调用所有工具，根据问题类型选择最合适的工具\n- 回答时标注信息来源，格式为 [文档名称-章节名称]`
      : ''

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

    const knowledgeTools = this.getKnowledgeTools(employee.project_id, useRag)
    agent.registerTools(knowledgeTools)

    this.agents.set(cacheKey, agent)
    return agent
  }

  private getKnowledgeTools(projectId: string, useRag = true): ToolDefinition[] {
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
      description: '获取知识库的整体概览，包括知识库中包含哪些文件、每个文件的大致介绍（摘要）、文件类型和大小等信息。当你需要了解知识库中有什么内容、判断哪些文件可能与用户问题相关时，优先调用此工具。返回结果包含每个文件的 document_id，你可以用 get_document_content 获取完整文件内容。',
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
            return { success: true, output: '未关联知识库，无法获取概览。' }
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
          output += `- 使用 get_document_content 并传入 document_id 可获取某个文件的完整内容\n`
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
      description: '查询整个知识库的全局摘要，了解知识库的核心主题、整体结构和关键实体。在回答复杂问题前，先调用此工具了解全局信息，确定问题相关的文档和主题范围。返回结果会包含关键实体名称，你可以进一步用 query_knowledge_graph 查询实体关系。',
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
          const output = `## 全局知识摘要\n\n${globalSummary.summary}\n\n### 核心主题\n${keyTopics.map(t => `- ${t}`).join('\n')}\n\n### 关键实体\n${keyEntities.map(e => `- ${e.name}(${e.type}): ${e.description || ''}`).join('\n')}\n\n### 下一步查询建议\n- 如果问题涉及某个实体，请使用 query_knowledge_graph 查询该实体的关系网络\n- 如果需要定位具体章节，请使用 query_chapters 按关键词检索\n- 如果需要查看原始文档内容，请使用 get_document_content 获取`
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
      description: '查询知识图谱中特定实体的信息和关系网络。当问题涉及人物、组织、事件等实体之间的关系时，使用此工具。返回结果会包含关联实体和关系类型，你可以进一步用 query_chapters 或 query_fulltext 深入查询相关内容。',
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
            output += `\n### 下一步查询建议\n- 使用 query_knowledge_graph 查询上述关联实体的详细关系\n- 使用 query_chapters 搜索与"${entity.name}"相关的章节\n- 使用 query_fulltext 进行语义检索获取具体段落`
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
      description: '根据查询内容检索相关的章节摘要，用于定位问题相关的文档章节。在查询具体细节前，先使用此工具定位相关章节，再决定是否需要深入查看原文。返回结果包含 document_id 和 chapter_id，你可以用 get_document_content 获取完整内容。',
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
          return { success: true, output: output + '\n\n提示: 使用 get_document_content 并传入 document_id 或 chapter_id 可获取完整内容。' }
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
      title: '全文语义检索',
      description: '在原始文档中进行语义检索，获取最相关的文本片段。当需要查找具体段落、细节信息，或章节摘要不够详细时使用。支持跨文档检索。返回结果包含 document_id，你可以用 get_document_content 获取完整文档内容。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索查询语句'
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
            if (useRag) {
              const results = await this.ragService.search(projectId, args.query, args.top_k || 5, 0.3)
              if (results.length === 0) {
                return { success: true, output: '未找到相关内容。' }
              }
              const output = results.map((r, i) =>
                `[${i + 1}] ${r.source.file_name || '未知文件'} (相关度: ${(r.score * 100).toFixed(1)}%)\n${r.text}`
              ).join('\n\n---\n\n')
              return { success: true, output }
            }
            return { success: true, output: '未关联知识库，无法进行全文检索。' }
          }
          const results = await this.ragService.searchKB(targetKbId, args.query, {
            topK: args.top_k || 5,
            documentIds: args.document_ids,
            contextSize: 200,
          })
          if (results.length === 0) {
            return { success: true, output: '全文检索未找到相关内容。' }
          }
          const output = results.map((r, i) => {
            const layerLabel = r.source.layer === 'chapter_summary' ? '[章节摘要]' : r.source.layer === 'document_summary' ? '[文档摘要]' : '[原文片段]'
            const sourceInfo = r.source.document_name ? `${r.source.document_name}${r.source.chapter_title ? ' - ' + r.source.chapter_title : ''}` : ''
            const docIdInfo = r.source.document_id ? `[document_id: ${r.source.document_id}]` : ''
            const chapterIdInfo = r.source.chapter_id ? `[chapter_id: ${r.source.chapter_id}]` : ''
            return `[${i + 1}] ${layerLabel} ${sourceInfo} (相关度: ${(r.score * 100).toFixed(1)}%)\n${r.text}\n${docIdInfo} ${chapterIdInfo}`
          }).join('\n\n---\n\n')
          return { success: true, output: output + '\n\n提示: 使用 get_document_content 并传入 document_id 可获取完整文档内容。' }
        } catch (error: any) {
          return { success: false, error: `全文检索失败: ${error.message}` }
        }
      },
      source: 'builtin'
    }
    tools.push(fulltextSearchTool)

    const docContentTool: ToolDefinition = {
      id: 'get_document_content',
      name: 'get_document_content',
      title: '获取文档内容',
      description: '获取特定文档或章节的完整内容。当需要查看完整上下文，或检索结果不够详细时，使用此工具获取原始文档内容。你可以从 query_chapters 或 query_fulltext 的返回结果中获取 document_id 和 chapter_id。',
      parameters: {
        type: 'object',
        properties: {
          document_id: {
            type: 'string',
            description: '文档ID'
          },
          chapter_id: {
            type: 'string',
            description: '章节ID（可选，不提供则获取整个文档内容）'
          }
        },
        required: ['document_id']
      },
      handler: async (args: any) => {
        try {
          if (args.chapter_id) {
            const chapters = this.kbService.getChapters(args.document_id)
            const chapter = chapters.find((ch: any) => ch.id === args.chapter_id)
            if (!chapter) {
              return { success: false, error: '章节不存在' }
            }
            let output = `## ${chapter.title}\n\n${chapter.content}`
            const entities: any[] = JSON.parse(chapter.entities_json || '[]')
            if (entities.length > 0) {
              output += `\n\n### 本章实体\n${entities.map(e => `- ${e.name}(${e.type})`).join('\n')}`
              output += '\n\n提示: 使用 query_knowledge_graph 可查询上述实体的关系网络。'
            }
            return { success: true, output }
          }
          const content = this.kbService.getDocumentContent(args.document_id)
          if (!content) {
            return { success: false, error: '文档内容为空或不存在' }
          }
          let output = content.substring(0, 10000) + (content.length > 10000 ? '\n\n...(内容过长，已截断，可使用 chapter_id 获取特定章节)' : '')
          const chapters = this.kbService.getChapters(args.document_id)
          if (chapters.length > 0) {
            output += `\n\n### 文档章节列表\n${chapters.map((ch: any) => `- ${ch.title} [chapter_id: ${ch.id}]`).join('\n')}`
            output += '\n\n提示: 使用 get_document_content 并传入 chapter_id 可获取特定章节的完整内容。'
          }
          return { success: true, output }
        } catch (error: any) {
          return { success: false, error: `获取文档内容失败: ${error.message}` }
        }
      },
      source: 'builtin'
    }
    tools.push(docContentTool)

    const timelineTool: ToolDefinition = {
      id: 'generate_timeline',
      name: 'generate_timeline',
      title: '生成时间线',
      description: '生成特定主题或实体的事件时间线。当用户询问"发展历程"、"变化过程"、"先后顺序"等涉及时间维度的问题时使用。',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: '主题或实体名称'
          },
          kb_id: {
            type: 'string',
            description: `知识库ID（可选）。可选值: ${projectKBs.map((kb: any) => `${kb.id}(${kb.name})`).join(', ')}`
          }
        },
        required: ['topic']
      },
      handler: async (args: any) => {
        try {
          const targetKbId = validateKbId(args.kb_id)
          if (!targetKbId) {
            return { success: true, output: '未关联知识库，无法生成时间线。' }
          }
          const timeline = this.kbService.generateTimeline(targetKbId, args.topic)
          if (timeline.length === 0) {
            return { success: true, output: `未找到与"${args.topic}"相关的时间线事件。` }
          }
          const output = `## "${args.topic}" 时间线\n\n` + timeline.map((e: any) =>
            `- **${e.time}**: ${e.event} (来源: ${e.source})`
          ).join('\n')
          return { success: true, output }
        } catch (error: any) {
          return { success: false, error: `时间线生成失败: ${error.message}` }
        }
      },
      source: 'builtin'
    }
    tools.push(timelineTool)

    return tools
  }

  private getEnabledBuiltinToolIds(employeeId: string): Set<string> {
    const allBuiltinToolIds = new Set(createBuiltinTools().map(t => t.id))

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
    const { employee_id, provider_id, model_id, messages, use_skills = true, use_rag = true } = params

    const agent = await this.getOrCreateAgent(employee_id, provider_id, model_id, undefined, use_rag)

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
