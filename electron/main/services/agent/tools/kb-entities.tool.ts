import type { ToolDefinition } from '../tool.types'
import DatabaseService from '../../database.service'
import KnowledgeBaseService from '../../kb.service'

export function createKBEntitiesTool(allowedKbIds: string[]): ToolDefinition {
  const db = DatabaseService.getInstance()

  const validateKbId = (kbId: string | undefined): string | null => {
    if (!kbId) return allowedKbIds.length > 0 ? allowedKbIds[0] : null
    if (!allowedKbIds.includes(kbId)) return null
    return kbId
  }

  const kbOptionsDesc = allowedKbIds.length > 0
    ? `可选值: ${allowedKbIds.join(', ')}`
    : '当前项目未关联知识库'

  return {
    id: 'kb_list_entities',
    name: 'kb_list_entities',
    title: '浏览知识库实体',
    description: `浏览知识库中的实体列表，支持按类型筛选和搜索。当你需要了解知识库中包含哪些关键实体（人物、组织、地点、概念等）时使用此工具。

【使用场景】
- 了解知识库中有哪些关键人物、组织或概念
- 在提问前先了解知识库的实体覆盖范围
- 发现知识库中的核心主题和关键对象

【返回结果】
- 实体名称、类型、描述
- 提及次数（反映重要性）
- 首次出现的文档`,
    parameters: {
      type: 'object',
      properties: {
        kb_id: {
          type: 'string',
          description: `知识库ID（可选）。${kbOptionsDesc}`
        },
        type: {
          type: 'string',
          description: '实体类型筛选（可选值: person, organization, location, event, concept, tool, other）'
        },
        search: {
          type: 'string',
          description: '实体名称搜索关键词（可选）'
        },
        top_k: {
          type: 'number',
          description: '返回数量（1-50，默认20）',
          minimum: 1,
          maximum: 50,
          default: 20
        }
      },
      required: []
    },
    handler: async (args: any) => {
      try {
        const targetKbId = validateKbId(args.kb_id)
        if (!targetKbId) {
          return { success: true, output: '未关联知识库或无权访问该知识库，无法浏览实体。' }
        }

        const topK = Math.min(Math.max(args.top_k || 20, 1), 50)

        let sql = 'SELECT * FROM kb_entities WHERE kb_id = ?'
        const params: any[] = [targetKbId]

        if (args.type) {
          sql += ' AND type = ?'
          params.push(args.type)
        }

        if (args.search) {
          sql += ' AND (name LIKE ? OR description LIKE ?)'
          const likePattern = `%${args.search}%`
          params.push(likePattern, likePattern)
        }

        sql += ' ORDER BY mention_count DESC LIMIT ?'
        params.push(topK)

        const entities = db.getDb().prepare(sql).all(...params) as any[]

        if (entities.length === 0) {
          return {
            success: true,
            output: `知识库中${args.type ? `类型为"${args.type}"的` : ''}${args.search ? `包含"${args.search}"的` : ''}实体为空。建议先处理文档以生成知识图谱。`
          }
        }

        let output = `## 知识库实体列表${args.type ? ` (${args.type})` : ''}${args.search ? ` - 搜索: "${args.search}"` : ''}\n\n`
        output += `共 ${entities.length} 个实体:\n\n`

        for (let i = 0; i < entities.length; i++) {
          const e = entities[i]
          const aliases: string[] = JSON.parse(e.aliases_json || '[]')
          output += `[${i + 1}] **${e.name}** (${e.type})\n`
          if (e.description) output += `描述: ${e.description}\n`
          if (aliases.length > 0) output += `别名: ${aliases.join(', ')}\n`
          output += `提及次数: ${e.mention_count}\n`
          output += `[entity_id: ${e.id}]\n\n`
        }

        output += `### 下一步建议\n`
        output += `- 使用 query_knowledge_graph 查询某个实体的关系网络\n`
        output += `- 使用 kb_search 搜索与某个实体相关的文档内容\n`

        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `实体列表获取失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
}

export function createKBEntityDetailTool(allowedKbIds: string[]): ToolDefinition {
  const kbService = KnowledgeBaseService.getInstance()

  const validateKbId = (kbId: string | undefined): string | null => {
    if (!kbId) return allowedKbIds.length > 0 ? allowedKbIds[0] : null
    if (!allowedKbIds.includes(kbId)) return null
    return kbId
  }

  const kbOptionsDesc = allowedKbIds.length > 0
    ? `可选值: ${allowedKbIds.join(', ')}`
    : '当前项目未关联知识库'

  return {
    id: 'kb_entity_detail',
    name: 'kb_entity_detail',
    title: '获取实体详情',
    description: `获取某个实体的详细信息，包括描述、属性、关系网络和提及记录。当你需要深入了解某个特定实体时使用此工具。

【使用场景】
- 深入了解某个人物或组织的详细信息
- 查看实体之间的关系网络
- 追踪实体在文档中的出现位置`,
    parameters: {
      type: 'object',
      properties: {
        entity_name: {
          type: 'string',
          description: '实体名称'
        },
        kb_id: {
          type: 'string',
          description: `知识库ID（可选）。${kbOptionsDesc}`
        }
      },
      required: ['entity_name']
    },
    handler: async (args: any) => {
      try {
        const targetKbId = validateKbId(args.kb_id)
        if (!targetKbId) {
          return { success: true, output: '未关联知识库或无权访问该知识库，无法获取实体详情。' }
        }

        const entity = kbService.getEntityByName(targetKbId, args.entity_name)
        if (!entity) {
          const allEntities = kbService.getEntities(targetKbId)
          const matches = allEntities.filter((e: any) =>
            e.name.toLowerCase().includes(args.entity_name.toLowerCase()) ||
            (JSON.parse(e.aliases_json || '[]') as string[]).some((a: string) =>
              a.toLowerCase().includes(args.entity_name.toLowerCase())
            )
          ).slice(0, 5)

          if (matches.length === 0) {
            return {
              success: true,
              output: `未找到实体"${args.entity_name}"。请使用 kb_list_entities 查看所有实体，或检查名称拼写。`
            }
          }

          const matchList = matches.map((e: any) => `- ${e.name} (${e.type})`).join('\n')
          return {
            success: true,
            output: `未精确匹配"${args.entity_name}"，找到以下相似实体:\n${matchList}\n\n请使用精确的实体名称再次调用。`
          }
        }

        const aliases: string[] = JSON.parse(entity.aliases_json || '[]')
        const attributes: Record<string, string> = JSON.parse(entity.attributes_json || '{}')

        let output = `## 实体详情: ${entity.name}\n\n`
        output += `**类型**: ${entity.type}\n`
        output += `**描述**: ${entity.description || '无'}\n`
        output += `**提及次数**: ${entity.mention_count}\n`

        if (aliases.length > 0) {
          output += `**别名**: ${aliases.join(', ')}\n`
        }

        const attrEntries = Object.entries(attributes)
        if (attrEntries.length > 0) {
          output += `**属性**:\n`
          for (const [k, v] of attrEntries) {
            output += `  - ${k}: ${v}\n`
          }
        }

        // 关系网络
        const relations = kbService.getEntityRelations(entity.id, 2)
        if (relations.length > 0) {
          output += `\n### 关系网络\n\n`
          for (const rel of relations) {
            const direction = rel.source_entity_id === entity.id ? '→' : '←'
            const otherName = rel.source_entity_id === entity.id ? rel.target_name : rel.source_name
            const otherType = rel.source_entity_id === entity.id ? rel.target_type : rel.source_type
            output += `- ${direction} **${otherName}**(${otherType}) — ${rel.relation_type}${rel.description ? `: ${rel.description}` : ''}\n`
          }
        }

        // 提及记录
        const mentions = kbService.getEntityMentions(entity.id)
        if (mentions.length > 0) {
          output += `\n### 提及记录 (前10条)\n\n`
          for (let i = 0; i < Math.min(mentions.length, 10); i++) {
            const m = mentions[i]
            output += `[${i + 1}] ${m.document_name}${m.chapter_title ? ` > ${m.chapter_title}` : ''}\n`
            if (m.context_text) {
              output += `上下文: ${m.context_text.substring(0, 200)}${m.context_text.length > 200 ? '...' : ''}\n`
            }
            output += '\n'
          }
        }

        output += `\n### 下一步建议\n`
        output += `- 使用 query_knowledge_graph 查询该实体更深度的关系网络\n`
        output += `- 使用 kb_search 搜索与该实体相关的更多内容\n`
        output += `- 使用 kb_get_content 查看提及该实体的文档原文\n`

        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `实体详情获取失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
}

// 保留默认导出以兼容现有代码
export const kbListEntitiesTool = createKBEntitiesTool([])
export const kbEntityDetailTool = createKBEntityDetailTool([])
