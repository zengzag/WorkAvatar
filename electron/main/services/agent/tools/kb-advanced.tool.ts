import SearchEngineService from '../../search-engine.service'
import type { ToolDefinition } from './types'

export function createKBAdvancedSearchTool(allowedKbIds: string[]): ToolDefinition {
  const searchEngine = SearchEngineService.getInstance()

  const validateKbId = (kbId: string | undefined): string | null => {
    if (!kbId) return allowedKbIds.length > 0 ? allowedKbIds[0] : null
    if (!allowedKbIds.includes(kbId)) return null
    return kbId
  }

  const kbOptionsDesc = allowedKbIds.length > 0
    ? `可选值: ${allowedKbIds.join(', ')}`
    : '当前员工未关联知识库'

  return {
    id: 'kb_advanced_search',
    name: 'kb_advanced_search',
    title: '高级知识库检索',
    description: `高级知识库检索，支持精确短语、排除词、文档类型过滤。基于FTS5全文索引，性能优异。`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '高级查询语句，支持 "精确短语"、+必须包含、-排除词'
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
          description: `知识库ID（可选）。${kbOptionsDesc}`
        },
        document_type: {
          type: 'string',
          description: '限定文档类型，如 pdf, docx, xlsx, txt, md（可选）'
        }
      },
      required: ['query']
    },
    handler: async (args: any) => {
      try {
        const targetKbId = validateKbId(args.kb_id)
        if (!targetKbId) {
          return { success: true, output: '未关联知识库或无权访问该知识库，无法进行高级检索。' }
        }

        const query = String(args.query || '').trim()
        if (!query || query.length < 2) {
          return { success: true, output: '请输入至少2个字符的查询内容。' }
        }

        const topK = Math.min(Math.max(args.top_k || 10, 1), 20)

        const results = searchEngine.advancedFtsSearch(targetKbId, query, topK, {
          documentType: args.document_type
        })

        if (results.length === 0) {
          return {
            success: true,
            output: `未找到符合高级查询条件的内容。\n查询条件: ${query}\n建议放宽条件或减少排除词。`
          }
        }

        let output = `## 高级检索结果\n\n`
        output += `查询: "${query}"\n`
        output += `\n共找到 ${results.length} 条结果:\n\n`

        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const typeLabel = {
            document_title: '文档标题',
            document_summary: '文档摘要',
            chapter: '章节摘要',
            entity: '知识实体',
            content_paragraph: '原文内容',
            hybrid: '混合匹配',
          }[r.match_type] || r.match_type

          output += `[${i + 1}] **${r.document_name}** (${typeLabel})\n`
          output += `${r.text}\n`

          const locParts: string[] = []
          if (r.document_id) locParts.push(`document_id: ${r.document_id}`)
          if (r.chapter_id) locParts.push(`chapter_id: ${r.chapter_id}`)
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
        output += `- 使用 kb_get_content 获取完整文档或指定文本区间（支持 start_offset+end_offset / start_line+end_line）\n`
        output += `- 使用 kb_search 进行更广泛的关键词检索\n`

        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `高级检索失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
}
