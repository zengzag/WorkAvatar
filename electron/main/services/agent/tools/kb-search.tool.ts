import KnowledgeBaseService from '../../kb.service'
import SearchEngineService from '../../search-engine.service'
import { ToolDefinition } from './types'
import { createKbIdValidator } from './utils'

interface SearchResult {
  document_id: string
  document_name: string
  paragraph_id?: string
  paragraph_title?: string
  text: string
  score: number
  match_type: string
  start_offset?: number
  end_offset?: number
  start_line?: number
  end_line?: number
}

export function createKBSearchTool(allowedKbIds: string[]): ToolDefinition {
  const kbService = KnowledgeBaseService.getInstance()
  const searchEngine = SearchEngineService.getInstance()
  const validateKbId = createKbIdValidator(allowedKbIds)



  const kbOptionsDesc = allowedKbIds.length > 0
    ? `可选值: ${allowedKbIds.join(', ')}`
    : '当前员工未关联知识库'

  return {
    id: 'kb_search',
    name: 'kb_search',
    title: '智能知识库检索',
    description: `对知识库进行智能检索，支持关键词搜索和语义搜索，搜索标题、摘要、段落、关键词和内容。`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索查询语句，支持空格分隔多个关键词'
        },
        top_k: {
          type: 'number',
          description: '返回结果数量（1-20，默认10）',
          minimum: 1,
          maximum: 20,
          default: 10
        },
        kb_id: {
          type: 'string',
          description: `知识库ID（可选，不提供则使用默认知识库）。${kbOptionsDesc}`
        },
        document_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '限定检索的文档ID列表（可选）'
        },
        use_semantic: {
          type: 'boolean',
          description: '是否启用语义搜索（需要Embedding API支持，默认false）',
          default: false
        }
      },
      required: ['query']
    },
    handler: async (args: any) => {
      try {
        const targetKbId = validateKbId(args.kb_id)
        if (!targetKbId) {
          return { success: true, output: '未关联知识库或无权访问该知识库，无法进行检索。' }
        }

        const query = String(args.query || '').trim()
        if (!query || query.length < 2) {
          return { success: true, output: '请输入至少2个字符的查询内容。' }
        }

        const topK = Math.min(Math.max(args.top_k || 10, 1), 20)
        const documentIds = args.document_ids

        let results: SearchResult[]

        if (args.use_semantic) {
          results = await kbService.searchWithEmbedding(targetKbId, query, topK, documentIds) as SearchResult[]
        } else {
          results = searchEngine.search(targetKbId, query, topK, documentIds) as SearchResult[]
        }

        if (results.length === 0) {
          return {
            success: true,
            output: `未找到与"${query}"相关的内容。建议：\n1. 尝试使用更通用的关键词\n2. 启用语义搜索(use_semantic=true)获取语义匹配结果\n3. 使用 kb_overview 查看知识库中有哪些文档\n4. 检查文档是否已完成解析和知识处理`
          }
        }

        let output = `## 知识库检索结果: "${query}"\n\n`
        output += `共找到 ${results.length} 条相关结果${args.use_semantic ? '（语义搜索）' : '（关键词搜索）'}:\n\n`

        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const typeLabel = {
            document_title: '文档标题',
            document_summary: '文档摘要',
            paragraph: '段落摘要',
            content_paragraph: '原文内容',
            hybrid: '混合匹配',
          }[r.match_type] || r.match_type

          output += `[${i + 1}] **${typeLabel}**\n`
          output += `来源: ${r.document_name}${r.paragraph_title ? ` > ${r.paragraph_title}` : ''}\n`
          output += `${r.text}\n`

          const locParts: string[] = []
          if (r.document_id) locParts.push(`document_id: ${r.document_id}`)
          if (r.paragraph_id) locParts.push(`paragraph_id: ${r.paragraph_id}`)
          if (r.start_line !== undefined && r.end_line !== undefined) {
            locParts.push(`line: ${r.start_line}-${r.end_line}`)
          }
          if (r.start_offset !== undefined && r.end_offset !== undefined) {
            locParts.push(`offset: ${r.start_offset}-${r.end_offset}`)
          }
          if (locParts.length > 0) {
            output += `[${locParts.join(', ')}]\n`
          }
          output += '\n---\n\n'
        }

        output += `### 下一步建议\n`
        output += `- 使用 kb_get_content 获取某个文档或段落的完整内容（支持 paragraph_id / start_offset+end_offset / start_line+end_line 精准定位）\n`
        output += `- 使用 query_paragraphs 按关键词检索相关段落摘要\n`
        if (!args.use_semantic) {
          output += `- 启用语义搜索(use_semantic=true)可获取语义匹配结果，提升搜索召回率\n`
        }

        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `知识库检索失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
}
