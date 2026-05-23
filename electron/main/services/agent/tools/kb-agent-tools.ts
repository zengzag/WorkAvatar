import KnowledgeBaseService from '../../kb.service'
import DatabaseService from '../../database.service'
import KBDatabaseService from '../../kb-database.service'
import { ToolDefinition } from './types'
import { createKBSearchTool, createKBGetContentTool } from './index'
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
  let allKBs: any[] = []
  if (linkedKbIds.length > 0) {
    const placeholders = linkedKbIds.map(() => '?').join(',')
    allKBs = kbDb.getDb().prepare(`
      SELECT kb.*, (SELECT COUNT(*) FROM kb_documents WHERE kb_id = kb.id) as doc_count
      FROM knowledge_bases kb
      WHERE kb.id IN (${placeholders})
      ORDER BY kb.name
    `).all(...linkedKbIds) as any[]
  }

  const kbIds = allKBs.map((kb: any) => kb.id)
  const validateKbId = createKbIdValidator(kbIds)

  // ============================================================
  // kb_list - 知识库列表
  // ============================================================
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
        if (allKBs.length === 0) {
          return { success: true, output: '当前员工未关联任何知识库。' }
        }

        let output = `## 可访问的知识库\n\n`
        output += `当前可访问 ${allKBs.length} 个知识库：\n\n`

        for (let i = 0; i < allKBs.length; i++) {
          const kb = allKBs[i]
          output += `[${i + 1}] **${kb.name}**\n`
          output += `- ID: ${kb.id}\n`
          if (kb.description) {
            output += `- 描述: ${kb.description}\n`
          }
          output += `- 文档数: ${kb.doc_count || 0}\n`

          const globalSummary = kbService.getGlobalSummary(kb.id)
          if (globalSummary) {
            const keyTopics: string[] = JSON.parse(globalSummary.key_topics_json || '[]')
            if (keyTopics.length > 0) {
              output += `- 核心主题: ${keyTopics.join('、')}\n`
            }
          }
          output += '\n'
        }

        output += `请使用 kb_overview 并传入 kb_id 查看知识库详情和文档列表。`
        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `知识库列表获取失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
  tools.push(kbListTool)

  // ============================================================
  // kb_overview - 知识库概览（需传kb_id）
  // ============================================================
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
          description: `知识库ID（必需）。可选值: ${formatKBOptions(allKBs)}`
        }
      },
      required: ['kb_id']
    },
    handler: async (args: any) => {
      try {
        const targetKbId = validateKbId(args.kb_id)
        if (!targetKbId) {
          return { success: true, output: '未关联知识库或无权访问该知识库。' }
        }

        const kb = kbService.getKB(targetKbId)
        if (!kb) {
          return { success: true, output: '知识库不存在。' }
        }

        let output = `## ${kb.name}\n\n`
        if (kb.description) {
          output += `${kb.description}\n\n`
        }

        const globalSummary = kbService.getGlobalSummary(targetKbId)
        if (globalSummary) {
          const keyTopics: string[] = JSON.parse(globalSummary.key_topics_json || '[]')
          output += `### 全局摘要\n${globalSummary.summary}\n\n`
          if (keyTopics.length > 0) {
            output += `### 核心主题\n${keyTopics.map(t => `- ${t}`).join('\n')}\n\n`
          }
        }

        const docs = kbService.getDocumentList(targetKbId) as any[]
        const completedDocs = docs.filter((d: any) => d.parse_status === 'completed')

        if (completedDocs.length === 0) {
          output += `该知识库中暂无已解析的文档。`
          return { success: true, output }
        }

        output += `### 文档列表（${completedDocs.length}个）\n\n`
        for (const doc of completedDocs) {
          output += `[${completedDocs.indexOf(doc) + 1}] **${doc.original_name}**\n`
          output += `- ID: ${doc.id}\n`
          output += `- 类型: ${doc.type}\n`

          const docSummary = kbService.getDocumentSummary(doc.id)
          if (docSummary) {
            const topics: string[] = JSON.parse(docSummary.main_topics_json || '[]')
            output += `- 摘要: ${docSummary.summary || '无摘要'}\n`
            if (topics.length > 0) {
              output += `- 主题: ${topics.join('、')}\n`
            }
          } else {
            output += `- 摘要: 尚未进行知识处理\n`
          }
          output += '\n'
        }

        output += `请使用 kb_get_toc 并传入 document_id 查看文档目录结构，或使用 kb_search 检索具体内容。`
        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `知识库概览获取失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
  tools.push(kbOverviewTool)

  // ============================================================
  // kb_get_toc - 获取文档目录
  // ============================================================
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
        const doc = kbDb.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(args.document_id) as any
        if (!doc) {
          return { success: false, error: '文档不存在' }
        }

        if (!kbIds.includes(doc.kb_id)) {
          return { success: false, error: '无权访问该文档' }
        }

        if (doc.parse_status !== 'completed') {
          return { success: false, error: '文档尚未解析完成' }
        }

        const paragraphs = kbDb.getDb().prepare(
          'SELECT * FROM kb_paragraphs WHERE document_id = ? ORDER BY paragraph_index'
        ).all(args.document_id) as any[]

        if (paragraphs.length === 0) {
          return { success: true, output: '该文档暂无段落目录。' }
        }

        let output = `## 文档目录: ${doc.original_name}\n\n`
        output += `共 ${paragraphs.length} 个段落：\n\n`

        const indent = (level: number): string => {
          const depth = Math.max(0, level - 1)
          return '│  '.repeat(depth)
        }

        for (const p of paragraphs) {
          const prefix = indent(p.level)
          const branch = p.level > 1 ? '├── ' : ''
          const levelTag = `L${p.level}`
          const line = `${prefix}${branch}[${p.paragraph_index}] ${p.title}`
          output += line + '\n'
          output += `${prefix}    [${levelTag}] paragraph_id: ${p.id}, offset: ${p.start_offset}-${p.end_offset}\n`
          if (p.summary) {
            const shortSummary = p.summary.length > 80 ? p.summary.substring(0, 80) + '...' : p.summary
            output += `${prefix}    摘要: ${shortSummary}\n`
          }
          output += '\n'
        }

        output += `请使用 kb_get_paragraphs 传入感兴趣的 paragraph_id 数组获取详细摘要，或使用 kb_get_content 传入 paragraph_id 获取完整内容。`
        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `获取文档目录失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
  tools.push(kbGetTocTool)

  // ============================================================
  // kb_get_paragraphs - 批量获取段落摘要
  // ============================================================
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

        let output = `## 段落摘要\n\n`

        for (let i = 0; i < paragraphs.length; i++) {
          const p = paragraphs[i]
          output += `[${i + 1}] **${p.title_path || p.title}** (L${p.level})\n`
          output += `- 文档: ${p.document_name}\n`
          if (p.summary) {
            output += `- 摘要: ${p.summary}\n`
          } else {
            output += `- 摘要: (无)\n`
          }
          const preview = p.content ? p.content.substring(0, 200) : ''
          if (preview) {
            output += `- 预览: ${preview}${p.content.length > 200 ? '...' : ''}\n`
          }
          output += `[document_id: ${p.document_id}, paragraph_id: ${p.id}, offset: ${p.start_offset}-${p.end_offset}]\n\n`
          output += '---\n\n'
        }

        output += `共 ${paragraphs.length} 个段落。请使用 kb_get_content 传入 paragraph_id 获取完整内容。`
        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `获取段落摘要失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
  tools.push(kbGetParagraphsTool)

  tools.push(createKBSearchTool(kbIds))
  tools.push(createKBGetContentTool(kbIds))

  return tools
}
