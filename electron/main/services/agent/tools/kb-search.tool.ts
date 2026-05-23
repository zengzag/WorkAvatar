import KnowledgeBaseService from '../../kb.service'
import SearchEngineService from '../../search-engine.service'
import type { SourceType } from '../../search-engine.service'
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

const SEARCH_IN_OPTIONS = ['all', 'document_titles', 'document_summaries', 'paragraph_summaries', 'content'] as const
type SearchIn = typeof SEARCH_IN_OPTIONS[number]

const SEARCH_IN_LABELS: Record<SearchIn, string> = {
  all: '全部内容',
  document_titles: '文档标题',
  document_summaries: '文档摘要',
  paragraph_summaries: '段落摘要',
  content: '原文内容',
}

function parseSearchIn(value: string | undefined): { sourceTypes: SourceType[]; label: string } {
  if (value && SEARCH_IN_OPTIONS.includes(value as SearchIn)) {
    const si = value as SearchIn
    switch (si) {
      case 'document_titles': return { sourceTypes: ['document_title'], label: SEARCH_IN_LABELS[si] }
      case 'document_summaries': return { sourceTypes: ['document_summary'], label: SEARCH_IN_LABELS[si] }
      case 'paragraph_summaries': return { sourceTypes: ['paragraph'], label: SEARCH_IN_LABELS[si] }
      case 'content': return { sourceTypes: ['content_paragraph'], label: SEARCH_IN_LABELS[si] }
      case 'all': return { sourceTypes: ['document_title', 'document_summary', 'paragraph', 'content_paragraph'], label: SEARCH_IN_LABELS[si] }
    }
  }
  return { sourceTypes: ['document_title', 'document_summary', 'paragraph', 'content_paragraph'], label: SEARCH_IN_LABELS.all }
}

export function createKBSearchTool(kbIdsRef: { current: string[] }): ToolDefinition {
  const kbService = KnowledgeBaseService.getInstance()
  const searchEngine = SearchEngineService.getInstance()
  const validateKbId = createKbIdValidator(kbIdsRef)

  return {
    id: 'kb_search',
    name: 'kb_search',
    title: '智能知识库检索',
    description: `对知识库进行智能检索，支持关键词搜索和语义搜索，可通过search_in参数精确控制搜索范围（文档标题、摘要、段落摘要、原文内容）。`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索查询语句，支持空格分隔多个关键词'
        },
        top_k: {
          type: 'number',
          description: '返回结果数量（1-20，默认5）',
          minimum: 1,
          maximum: 20,
          default: 5
        },
        kb_id: {
          type: 'string',
          description: '知识库ID（可选，不提供则使用默认知识库）。请先使用 kb_list 查看可用的知识库ID'
        },
        document_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '限定检索的文档ID列表（可选）'
        },
        search_in: {
          type: 'string',
          description: '检索范围（可选，默认"all"搜索全部）。可选值: all(全部), document_titles(文档标题), document_summaries(文档摘要), paragraph_summaries(段落摘要), content(原文内容)',
          enum: SEARCH_IN_OPTIONS as unknown as string[],
          default: 'all'
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
          return { success: true, output: '当前对话未选择任何知识库，无法进行检索。' }
        }

        const query = String(args.query || '').trim()
        if (!query || query.length < 2) {
          return { success: true, output: '请输入至少2个字符的查询内容。' }
        }

        const topK = Math.min(Math.max(args.top_k || 5, 1), 20)
        const documentIds = args.document_ids
        const { sourceTypes, label } = parseSearchIn(args.search_in)

        let results: SearchResult[]

        if (args.use_semantic) {
          results = await kbService.searchWithEmbedding(targetKbId, query, topK, documentIds) as SearchResult[]
          results = results.slice(0, topK)
        } else {
          results = searchEngine.ftsSearch(targetKbId, query, topK, {
            documentIds,
            sourceTypes,
          }) as SearchResult[]
        }

        if (results.length === 0) {
          const searchScope = args.search_in && !args.use_semantic ? `（范围: ${label}）` : ''
          return {
            success: true,
            output: `未找到与"${query}"相关的内容${searchScope}。建议：\n1. 尝试使用更通用的关键词\n2. 扩大搜索范围（search_in: "all"）\n3. 启用语义搜索(use_semantic=true)获取语义匹配结果\n4. 使用 kb_list 查看可访问的知识库\n5. 使用 kb_overview 查看知识库中的文档列表\n6. 检查文档是否已完成解析和知识处理`
          }
        }

        let output = `## 知识库检索结果: "${query}"\n\n`
        output += `共找到 ${results.length} 条相关结果（${args.use_semantic ? '语义搜索' : `范围: ${label}, 关键词搜索`}）:\n\n`

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
        output += `- 使用 kb_get_toc 获取相关文档的目录结构，了解文档章节组织\n`
        output += `- 使用 kb_get_paragraphs 批量获取感兴趣的段落详细摘要\n`
        output += `- 使用 kb_get_content 获取完整文档或段落内容（支持 paragraph_id / start_offset+end_offset / start_line+end_line 精准定位）\n`
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
