import type { ToolDefinition } from './types'
import KBDatabaseService from '../../kb-database.service'
import KnowledgeBaseService from '../../kb.service'

export function createKBGetContentTool(kbIdsRef: { current: string[] }): ToolDefinition {
  const kbDb = KBDatabaseService.getInstance()
  const kbService = KnowledgeBaseService.getInstance()

  return {
    id: 'kb_get_content',
    name: 'kb_get_content',
    title: '获取文档内容',
    description: `获取文档内容，支持通过段落ID、字符偏移量或行号定位。`,
    parameters: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: '文档ID（必需）'
        },
        paragraph_id: {
          type: 'string',
          description: '段落ID（可选，与偏移量/行号互斥）'
        },
        start_offset: {
          type: 'number',
          description: '起始字符偏移量（0-based，可选，与paragraph_id互斥）'
        },
        end_offset: {
          type: 'number',
          description: '结束字符偏移量（可选，与start_offset配合使用）'
        },
        start_line: {
          type: 'number',
          description: '起始行号（1-based，可选，与paragraph_id/偏移量互斥）'
        },
        end_line: {
          type: 'number',
          description: '结束行号（可选，与start_line配合使用）'
        },
        context_chars: {
          type: 'number',
          description: '上下文扩展字符数（默认200，当使用偏移量或行号时，向前后扩展的字符数）',
          default: 200
        }
      },
      required: ['document_id']
    },
    handler: async (args: any) => {
      try {
        const doc = kbDb.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(args.document_id) as any
        if (!doc) {
          return { success: false, error: '文档不存在' }
        }

        const currentKbIds = kbIdsRef.current
        if (!currentKbIds.includes(doc.kb_id)) {
          return { success: false, error: '无权访问该文档，文档不属于当前对话可访问的知识库' }
        }

        if (doc.parse_status !== 'completed') {
          return { success: false, error: '文档尚未解析完成' }
        }

        const content = kbService.getDocumentContent(args.document_id) || ''
        if (!content) {
          return { success: false, error: '文档内容为空' }
        }

        if (args.paragraph_id) {
          const paragraphs = kbService.getParagraphs(args.document_id)
          const paragraph = paragraphs.find((p: any) => p.id === args.paragraph_id)
          if (!paragraph) {
            return { success: false, error: '段落不存在' }
          }

          let output = `## ${paragraph.title_path || paragraph.title}\n\n`
          output += paragraph.content

          const paragraphIndex = paragraphs.findIndex((p: any) => p.id === args.paragraph_id)
          output += '\n\n### 段落导航\n'
          if (paragraphIndex > 0) {
            const prev = paragraphs[paragraphIndex - 1]
            output += `← 上一段: ${prev.title_path || prev.title} [paragraph_id: ${prev.id}]\n`
          }
          if (paragraphIndex < paragraphs.length - 1) {
            const next = paragraphs[paragraphIndex + 1]
            output += `→ 下一段: ${next.title_path || next.title} [paragraph_id: ${next.id}]\n`
          }

          return { success: true, output }
        }

        if (args.start_line !== undefined) {
          const lines = content.split('\n')
          const startLine = Math.max(1, args.start_line)
          const endLine = args.end_line !== undefined ? Math.min(args.end_line, lines.length) : startLine + 49
          const contextChars = args.context_chars || 200

          let startOffset = 0
          for (let i = 0; i < startLine - 1; i++) {
            startOffset += lines[i].length + 1
          }
          let endOffset = startOffset
          for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
            endOffset += lines[i].length + 1
          }

          const actualStart = Math.max(0, startOffset - contextChars)
          const actualEnd = Math.min(content.length, endOffset + contextChars)

          let output = content.substring(actualStart, actualEnd)
          if (actualStart > 0) output = '...' + output
          if (actualEnd < content.length) output = output + '...'

          return {
            success: true,
            output: `## 内容片段 [${doc.original_name}]\n\n**行号范围**: ${startLine}-${endLine}\n**字符位置**: ${actualStart}-${actualEnd}\n\n${output}\n\n[document_id: ${args.document_id}]`
          }
        }

        if (args.start_offset !== undefined) {
          const startOffset = Math.max(0, args.start_offset)
          const endOffset = args.end_offset !== undefined ? Math.min(args.end_offset, content.length) : Math.min(startOffset + 2000, content.length)
          const contextChars = args.context_chars || 200

          const actualStart = Math.max(0, startOffset - contextChars)
          const actualEnd = Math.min(content.length, endOffset + contextChars)

          let output = content.substring(actualStart, actualEnd)
          if (actualStart > 0) output = '...' + output
          if (actualEnd < content.length) output = output + '...'

          return {
            success: true,
            output: `## 内容片段 [${doc.original_name}]\n\n**字符范围**: ${startOffset}-${endOffset}\n**实际展示**: ${actualStart}-${actualEnd}\n\n${output}\n\n[document_id: ${args.document_id}]`
          }
        }

        let output = content.substring(0, 10000)
        if (content.length > 10000) {
          output += '\n\n...(内容过长，已截断至前10000字符。如需查看特定部分，请使用 paragraph_id、start_offset/end_offset 或 start_line/end_line 参数精准定位)'
        }

        const paragraphs = kbService.getParagraphs(args.document_id)
        if (paragraphs.length > 0) {
          output += `\n\n### 文档段落列表\n${paragraphs.map((p: any) => `- ${p.title_path || p.title} [paragraph_id: ${p.id}, offset: ${p.start_offset}-${p.end_offset}]`).join('\n')}`
        }

        return {
          success: true,
          output: `## ${doc.original_name}\n\n${output}\n\n[document_id: ${args.document_id}]`
        }
      } catch (error: any) {
        return { success: false, error: `获取文档内容失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
}
