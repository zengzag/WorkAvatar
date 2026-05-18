import KnowledgeBaseService from '../../kb.service'
import DatabaseService from '../../database.service'
import KBDatabaseService from '../../kb-database.service'
import SearchEngineService from '../../search-engine.service'
import { ToolDefinition } from './types'
import { createKBSearchTool, createKBAdvancedSearchTool, createKBGetContentTool } from './index'
import { createKbIdValidator } from './utils'

function formatKBOptions(kbs: any[]): string {
  return kbs.map(kb => `${kb.id}(${kb.name})`).join(', ')
}
export function createKBAgentTools(
    kbService: KnowledgeBaseService,
    db: DatabaseService,
    employeeId?: string
): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  if (!employeeId) return tools

  const kbDb = KBDatabaseService.getInstance()
  const links = db.getDb().prepare(
    'SELECT kb_id FROM employee_kb_links WHERE employee_id = ?'
  ).all(employeeId) as any[]

  const linkedKbIds = links.map((l) => l.kb_id)
  let employeeKBs: any[] = []
  if (linkedKbIds.length > 0) {
    const placeholders = linkedKbIds.map(() => '?').join(',')
    employeeKBs = kbDb.getDb().prepare(`
      SELECT kb.*, (SELECT COUNT(*) FROM kb_documents WHERE kb_id = kb.id) as doc_count
      FROM knowledge_bases kb
      WHERE kb.id IN (${placeholders})
      ORDER BY kb.name
    `).all(...linkedKbIds) as any[]
  }

  const allKBs = employeeKBs

  const kbIds = allKBs.map((kb: any) => kb.id)

  const validateKbId = createKbIdValidator(kbIds)

  const kbOverviewTool: ToolDefinition = {
    id: 'kb_overview',
    name: 'kb_overview',
    title: '知识库概览',
    description: `获取知识库概览。不传kb_id返回知识库列表，传入则返回该知识库文档详情。`,
    parameters: {
      type: 'object',
      properties: {
        kb_id: {
          type: 'string',
          description: `知识库ID（可选）。不传则返回所有可访问知识库列表；传入则返回该知识库的文档详情。可选值: ${formatKBOptions(allKBs)}`
        }
      },
      required: []
    },
    handler: async (args: any) => {
      try {
        if (!args.kb_id) {
          if (allKBs.length === 0) {
            return { success: true, output: '当前员工未关联任何知识库。' }
          }

          let output = `## 可访问的知识库列表\n\n`
          output += `当前数字员工可访问 ${allKBs.length} 个知识库，请根据问题选择最合适的知识库进行查询：\n\n`

          for (let i = 0; i < allKBs.length; i++) {
            const kb = allKBs[i]
            output += `[${i + 1}] **${kb.name}**\n`
            output += `- **知识库ID**: ${kb.id}\n`
            if (kb.description) {
              output += `- **介绍**: ${kb.description}\n`
            }
            output += `- **文档数量**: ${kb.doc_count || 0}\n`

            const globalSummary = kbService.getGlobalSummary(kb.id)
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

        const targetKbId = validateKbId(args.kb_id)
        if (!targetKbId) {
          return { success: true, output: '未关联知识库或无权访问该知识库，无法获取概览。' }
        }

        const kb = kbService.getKB(targetKbId)
        if (!kb) {
          return { success: true, output: '知识库不存在。' }
        }

        const docs = kbService.getDocumentList(targetKbId) as any[]
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

          const docSummary = kbService.getDocumentSummary(doc.id)
          if (docSummary) {
            const topics: string[] = JSON.parse(docSummary.main_topics_json || '[]')
            output += `- **摘要**: ${docSummary.summary || '无摘要'}\n`
            if (topics.length > 0) {
              output += `- **主题**: ${topics.join('、')}\n`
            }
          } else {
            output += `- **摘要**: 尚未进行知识处理，请先处理文档\n`
          }

          const paragraphs = kbService.getParagraphs(doc.id)
          if (paragraphs.length > 0) {
            output += `- **段落**: ${paragraphs.map((p: any) => p.title_path || p.title).join('、')}\n`
          }

          output += '\n'
        }

        output += `### 下一步查询建议\n`
        output += `- 使用 kb_get_content 并传入 document_id 可获取某个文件的完整内容或指定区间\n`
        output += `- 使用 kb_search 进行智能综合检索快速定位相关内容\n`
        output += `- 使用 query_paragraphs 按关键词检索相关段落摘要\n`
        output += `- 使用 query_global_summary 获取知识库的全局摘要和核心主题\n`

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
    description: '查询知识库全局摘要和核心主题。',
    parameters: {
      type: 'object',
      properties: {
        kb_id: {
          type: 'string',
          description: `知识库ID（可选，不提供则使用默认知识库）。可选值: ${formatKBOptions(allKBs)}`
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
        const globalSummary = kbService.getGlobalSummary(targetKbId)
        if (!globalSummary) {
          return { success: true, output: '知识库尚未生成全局摘要，请先处理文档并构建全局知识。' }
        }
        const keyTopics: string[] = JSON.parse(globalSummary.key_topics_json || '[]')
        const output = `## 全局知识摘要\n\n${globalSummary.summary}\n\n### 核心主题\n${keyTopics.map(t => `- ${t}`).join('\n')}\n\n### 下一步查询建议\n- 如果需要定位具体段落，请使用 query_paragraphs 按关键词检索\n- 如果需要查看原始文档内容，请使用 kb_get_content 获取完整文档或指定文本区间`
        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `全局摘要查询失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
  tools.push(globalSummaryTool)

  const paragraphSearchTool: ToolDefinition = {
    id: 'query_paragraphs',
    name: 'query_paragraphs',
    title: '检索段落摘要',
    description: '按关键词检索相关段落摘要，定位文档内容。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '查询关键词或问题'
        },
        top_k: {
          type: 'number',
          description: '返回最相关的段落数量（1-10，默认5）',
          minimum: 1,
          maximum: 10
        },
        kb_id: {
          type: 'string',
          description: `知识库ID（可选）。可选值: ${formatKBOptions(allKBs)}`
        }
      },
      required: ['query']
    },
    handler: async (args: any) => {
      try {
        const targetKbId = validateKbId(args.kb_id)
        if (!targetKbId) {
          return { success: true, output: '未关联知识库，无法检索段落。' }
        }
        const paragraphs = kbService.searchParagraphs(targetKbId, args.query, args.top_k || 5)
        if (paragraphs.length === 0) {
          return { success: true, output: '未找到相关段落摘要。你可以用 query_fulltext 进行语义检索。' }
        }
        const output = paragraphs.map((p: any, i: number) => {
          const titlePath = p.title_path || p.paragraph_title || p.title || ''
          return `[${i + 1}] 文档: ${p.document_name} | 路径: ${titlePath}\n摘要: ${p.text || '无摘要'}\n[document_id: ${p.document_id}${p.paragraph_id ? `, paragraph_id: ${p.paragraph_id}` : ''}]`
        }).join('\n\n---\n\n')
        return { success: true, output: output + '\n\n提示: 使用 kb_get_content 并传入 document_id 可获取完整内容；传入 start_offset/end_offset 或 start_line/end_line 可获取指定文本区间。' }
      } catch (error: any) {
        return { success: false, error: `段落检索失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
  tools.push(paragraphSearchTool)

  const fulltextSearchTool: ToolDefinition = {
    id: 'query_fulltext',
    name: 'query_fulltext',
    title: '全文关键词检索',
    description: '在文档内容中检索关键词，返回匹配的文本片段。基于FTS5全文索引，支持大规模数据毫秒级检索。',
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
          maximum: 10,
          default: 5
        },
        document_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '限定检索的文档ID列表（可选）'
        },
        kb_id: {
          type: 'string',
          description: `知识库ID（可选）。可选值: ${formatKBOptions(allKBs)}`
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

        const query = String(args.query || '').trim()
        if (!query || query.length < 2) {
          return { success: true, output: '请输入有效的查询关键词（至少2个字符）。' }
        }

        const topK = Math.min(Math.max(args.top_k || 5, 1), 10)
        const searchEngine = SearchEngineService.getInstance()

        const results = searchEngine.ftsSearch(targetKbId, query, topK, {
          documentIds: args.document_ids,
          sourceTypes: ['content_paragraph']
        })

        if (results.length === 0) {
          return { success: true, output: '全文检索未找到相关内容。' }
        }

        const output = results.map((r, i) => {
          const locParts: string[] = []
          if (r.start_line !== undefined && r.end_line !== undefined) {
            locParts.push(`line: ${r.start_line}-${r.end_line}`)
          }
          if (r.start_offset !== undefined && r.end_offset !== undefined) {
            locParts.push(`offset: ${r.start_offset}-${r.end_offset}`)
          }
          const locStr = locParts.length > 0 ? ` [${locParts.join(', ')}]` : ''
          return `[${i + 1}] ${r.document_name}\n${r.text}\n[document_id: ${r.document_id}]${locStr}`
        }).join('\n\n---\n\n')

        return { success: true, output: output + '\n\n提示: 使用 kb_get_content 并传入 document_id 可获取完整文档；传入 start_offset/end_offset 或 start_line/end_line 可获取指定文本区间。' }
      } catch (error: any) {
        return { success: false, error: `全文检索失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
  tools.push(fulltextSearchTool)

  tools.push(createKBSearchTool(kbIds))
  tools.push(createKBAdvancedSearchTool(kbIds))
  tools.push(createKBGetContentTool(kbIds))

  return tools
}
