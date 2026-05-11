import type { ToolDefinition } from '../tool.types'
import DatabaseService from '../../database.service'
import KnowledgeBaseService from '../../kb.service'

export function createKBGetContentTool(allowedKbIds: string[]): ToolDefinition {
  const db = DatabaseService.getInstance()
  const kbService = KnowledgeBaseService.getInstance()

  return {
    id: 'kb_get_content',
    name: 'kb_get_content',
    title: '获取文档内容',
    description: `获取文档的完整内容或指定文本区间的内容。支持通过章节ID、字符偏移量或行号范围精准定位内容。这是获取知识库原始文件内容的唯一入口工具。

【使用场景】
- 查看某个文档的完整内容
- 基于搜索结果获取特定文本区间的上下文
- 获取某个章节的完整内容
- 精准定位到文档的某一段文字

【定位方式】
1. 仅传 document_id → 获取整个文档（超过10000字符自动截断）
2. 传 document_id + chapter_id → 获取指定章节
3. 传 document_id + start_offset + end_offset → 获取指定字符区间
4. 传 document_id + start_line + end_line → 获取指定行号范围

【返回结果】
- 请求的文本内容
- 内容在文档中的位置信息
- 相邻章节的导航信息`,
    parameters: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: '文档ID（必需）'
        },
        chapter_id: {
          type: 'string',
          description: '章节ID（可选，与偏移量/行号互斥）'
        },
        start_offset: {
          type: 'number',
          description: '起始字符偏移量（0-based，可选，与chapter_id互斥）'
        },
        end_offset: {
          type: 'number',
          description: '结束字符偏移量（可选，与start_offset配合使用）'
        },
        start_line: {
          type: 'number',
          description: '起始行号（1-based，可选，与chapter_id/偏移量互斥）'
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
        const doc = db.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(args.document_id) as any
        if (!doc) {
          return { success: false, error: '文档不存在' }
        }

        // 二次鉴权：验证文档所属的知识库是否在允许列表中
        if (!allowedKbIds.includes(doc.kb_id)) {
          return { success: false, error: '无权访问该文档，文档不属于当前数字员工可访问的知识库' }
        }

        if (doc.parse_status !== 'completed') {
          return { success: false, error: '文档尚未解析完成' }
        }

        const content = kbService.getDocumentContent(args.document_id) || ''
        if (!content) {
          return { success: false, error: '文档内容为空' }
        }

        // 方式1: 通过章节ID获取
        if (args.chapter_id) {
          const chapters = kbService.getChapters(args.document_id)
          const chapter = chapters.find((ch: any) => ch.id === args.chapter_id)
          if (!chapter) {
            return { success: false, error: '章节不存在' }
          }

          let output = `## ${chapter.title}\n\n`
          output += chapter.content

          const entities: any[] = JSON.parse(chapter.entities_json || '[]')
          if (entities.length > 0) {
            output += `\n\n### 本章实体\n${entities.map((e: any) => `- ${e.name}(${e.type})`).join('\n')}`
          }

          // 添加章节导航
          const chapterIndex = chapters.findIndex((ch: any) => ch.id === args.chapter_id)
          output += '\n\n### 章节导航\n'
          if (chapterIndex > 0) {
            const prev = chapters[chapterIndex - 1]
            output += `← 上一章: ${prev.title} [chapter_id: ${prev.id}]\n`
          }
          if (chapterIndex < chapters.length - 1) {
            const next = chapters[chapterIndex + 1]
            output += `→ 下一章: ${next.title} [chapter_id: ${next.id}]\n`
          }

          return { success: true, output }
        }

        // 方式2: 通过行号范围获取
        if (args.start_line !== undefined) {
          const lines = content.split('\n')
          const startLine = Math.max(1, args.start_line)
          const endLine = args.end_line !== undefined ? Math.min(args.end_line, lines.length) : startLine + 49
          const contextChars = args.context_chars || 200

          // 计算行号对应的字符偏移
          let startOffset = 0
          for (let i = 0; i < startLine - 1; i++) {
            startOffset += lines[i].length + 1
          }
          let endOffset = startOffset
          for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
            endOffset += lines[i].length + 1
          }

          // 添加上下文
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

        // 方式3: 通过字符偏移量获取
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

        // 方式4: 获取整个文档
        let output = content.substring(0, 10000)
        if (content.length > 10000) {
          output += '\n\n...(内容过长，已截断至前10000字符。如需查看特定部分，请使用 chapter_id、start_offset/end_offset 或 start_line/end_line 参数精准定位)'
        }

        const chapters = kbService.getChapters(args.document_id)
        if (chapters.length > 0) {
          output += `\n\n### 文档章节列表\n${chapters.map((ch: any) => `- ${ch.title} [chapter_id: ${ch.id}, offset: ${ch.start_offset}-${ch.end_offset}]`).join('\n')}`
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
