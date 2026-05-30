import KnowledgeBaseService from '../../kb.service'
import KBDatabaseService from '../../kb-database.service'
import { ToolDefinition } from './types'
import { createKBSearchTool, createKBGetContentTool } from './index'
import { createKbIdValidator } from './utils'

export interface KbIdsRef {
  current: string[]
}

export function createKBAgentTools(
    kbService: KnowledgeBaseService,
    kbIdsRef: KbIdsRef
): ToolDefinition[] {
  const tools: ToolDefinition[] = []

  const validateKbId = createKbIdValidator(kbIdsRef)

  const kbListTool: ToolDefinition = {
    id: 'kb_list',
    name: 'kb_list',
    title: '知识库列表',
    description: '列出当前可访问的所有知识库，了解各知识库的主题和文档规模。',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async () => {
      try {
        const currentKbIds = kbIdsRef.current
        if (!currentKbIds || currentKbIds.length === 0) {
          return { success: true, output: '当前对话未选择任何知识库。' }
        }

        const kbDb = KBDatabaseService.getInstance()
        const placeholders = currentKbIds.map(() => '?').join(',')
        const allKBs = kbDb.getDb().prepare(`
          SELECT kb.*, (SELECT COUNT(*) FROM kb_documents WHERE kb_id = kb.id) as doc_count
          FROM knowledge_bases kb
          WHERE kb.id IN (${placeholders})
          ORDER BY kb.name
        `).all(...currentKbIds) as any[]

        if (allKBs.length === 0) {
          return { success: true, output: '当前对话未选择任何知识库。' }
        }

        let output = `${allKBs.length}个知识库:\n`
        for (let i = 0; i < allKBs.length; i++) {
          const kb = allKBs[i]
          output += `${i + 1}. ${kb.name} [${kb.id}] ${kb.doc_count || 0}篇`
          const globalSummary = kbService.getGlobalSummary(kb.id)
          if (globalSummary) {
            const keyTopics: string[] = JSON.parse(globalSummary.key_topics_json || '[]')
            if (keyTopics.length > 0) {
              output += ` | ${keyTopics.join('、')}`
            }
          }
          if (kb.description) {
            output += `\n   ${kb.description}`
          }
          output += '\n'
        }
        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `知识库列表获取失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
  tools.push(kbListTool)

  const kbOverviewTool: ToolDefinition = {
    id: 'kb_overview',
    name: 'kb_overview',
    title: '知识库概览',
    description: '查看知识库的全局摘要、核心主题和文档摘要列表，帮助确定要深入的目标文档。',
    parameters: {
      type: 'object',
      properties: {
        kb_id: {
          type: 'string',
          description: '知识库ID（必需）。请先使用 kb_list 查看可用的知识库ID'
        }
      },
      required: ['kb_id']
    },
    handler: async (args: any) => {
      try {
        const targetKbId = validateKbId(args.kb_id)
        if (!targetKbId) {
          return { success: true, output: '当前对话未选择任何知识库，或无权访问该知识库。' }
        }

        const kb = kbService.getKB(targetKbId)
        if (!kb) {
          return { success: true, output: '知识库不存在。' }
        }

        let output = kb.name
        if (kb.description) {
          output += ` - ${kb.description}`
        }
        output += '\n'

        const globalSummary = kbService.getGlobalSummary(targetKbId)
        if (globalSummary) {
          output += `摘要: ${globalSummary.summary}\n`
          const keyTopics: string[] = JSON.parse(globalSummary.key_topics_json || '[]')
          if (keyTopics.length > 0) {
            output += `主题: ${keyTopics.join('、')}\n`
          }
        }

        const docs = kbService.getDocumentList(targetKbId) as any[]
        const completedDocs = docs.filter((d: any) => d.parse_status === 'completed')

        if (completedDocs.length === 0) {
          output += '暂无已解析文档。'
          return { success: true, output }
        }

        output += `\n${completedDocs.length}篇文档:\n`
        for (const doc of completedDocs) {
          output += `- ${doc.original_name} [${doc.id}]`
          const docSummary = kbService.getDocumentSummary(doc.id)
          if (docSummary) {
            if (docSummary.summary) output += ` ${docSummary.summary}`
            const topics: string[] = JSON.parse(docSummary.main_topics_json || '[]')
            if (topics.length > 0) {
              output += ` | ${topics.join('、')}`
            }
          }
          output += '\n'
        }
        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `知识库概览获取失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
  tools.push(kbOverviewTool)

  const kbGetTocTool: ToolDefinition = {
    id: 'kb_get_toc',
    name: 'kb_get_toc',
    title: '获取文档目录',
    description: '获取文档的层级目录结构，包含每个章节的 paragraph_id、标题路径和内容偏移范围。',
    parameters: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: '文档ID（必需）'
        }
      },
      required: ['document_id']
    },
    handler: async (args: any) => {
      try {
        const kbDb = KBDatabaseService.getInstance()
        const doc = kbDb.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(args.document_id) as any
        if (!doc) {
          return { success: false, error: '文档不存在' }
        }

        const currentKbIds = kbIdsRef.current
        if (!currentKbIds.includes(doc.kb_id)) {
          return { success: false, error: '无权访问该文档' }
        }

        if (doc.parse_status !== 'completed') {
          return { success: false, error: '文档尚未解析完成' }
        }

        const paragraphs = kbDb.getDb().prepare(
          'SELECT id, title, level FROM kb_paragraphs WHERE document_id = ? ORDER BY paragraph_index'
        ).all(args.document_id) as any[]

        if (paragraphs.length === 0) {
          return { success: true, output: '该文档暂无段落目录。' }
        }

        let output = `${doc.original_name} (${paragraphs.length}段, #后为段落ID):\n`

        for (const p of paragraphs) {
          const indent = '  '.repeat(Math.max(0, p.level - 1))
          output += `${indent}${p.title} #${p.id}\n`
        }
        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `获取文档目录失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
  tools.push(kbGetTocTool)

  const kbGetParagraphsTool: ToolDefinition = {
    id: 'kb_get_paragraphs',
    name: 'kb_get_paragraphs',
    title: '获取段落摘要',
    description: '批量获取多个段落的详细摘要和内容预览，用于在了解目录结构后深入查看感兴趣章节。',
    parameters: {
      type: 'object',
      properties: {
        paragraph_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '段落ID数组（必需），从 kb_get_toc 或 kb_search 结果中获取'
        }
      },
      required: ['paragraph_ids']
    },
    handler: async (args: any) => {
      try {
        const ids: string[] = args.paragraph_ids || []
        if (ids.length === 0) {
          return { success: true, output: '请提供至少一个段落ID。' }
        }

        const kbDb = KBDatabaseService.getInstance()
        const placeholders = ids.map(() => '?').join(',')
        const paragraphs = kbDb.getDb().prepare(
          `SELECT p.*, d.original_name as document_name
           FROM kb_paragraphs p
           LEFT JOIN kb_documents d ON d.id = p.document_id
           WHERE p.id IN (${placeholders})
           ORDER BY p.document_id, p.paragraph_index`
        ).all(...ids) as any[]

        if (paragraphs.length === 0) {
          return { success: true, output: '未找到匹配的段落。请检查 paragraph_id 是否正确。' }
        }

        let output = `${paragraphs.length}个段落:\n`

        for (let i = 0; i < paragraphs.length; i++) {
          const p = paragraphs[i]
          output += `[${i + 1}] ${p.title_path || p.title} [${p.id}]`
          if (p.summary) {
            output += ` ${p.summary}`
          }
          const preview = p.content ? p.content.substring(0, 200) : ''
          if (preview) {
            output += `\n    ${preview}${p.content.length > 200 ? '...' : ''}`
          }
          output += `\n    doc:${p.document_id} off:${p.start_offset}-${p.end_offset}\n`
        }
        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `获取段落摘要失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
  tools.push(kbGetParagraphsTool)

  tools.push(createKBSearchTool(kbIdsRef))
  tools.push(createKBGetContentTool(kbIdsRef))

  return tools
}
