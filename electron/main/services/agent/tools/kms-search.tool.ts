import KMSService from '../../kms/kms.service'
import type { ToolDefinition } from './types'

export interface SearchScopeRef {
  current: {
    collectionIds: string[]
    dirIds?: string[]
    fileExtensions?: string[]
  }
}

export function createKMSTools(scopeRef?: SearchScopeRef): ToolDefinition[] {
  const kmsService = KMSService.getInstance()

  function resolveCollectionIds(args: any): string[] | undefined {
    const explicit = Array.isArray(args?.collection_ids) ? args.collection_ids as string[] : []
    if (explicit.length > 0) return explicit
    const ref = scopeRef?.current.collectionIds || []
    return ref.length > 0 ? ref : undefined
  }

  function resolveDirIds(): string[] | undefined {
    const ref = scopeRef?.current.dirIds
    return ref && ref.length > 0 ? ref : undefined
  }

  function resolveFileExtensions(args: any): string[] | undefined {
    const explicit = Array.isArray(args?.file_extensions) ? args.file_extensions as string[] : undefined
    if (explicit && explicit.length > 0) return explicit
    const ref = scopeRef?.current.fileExtensions
    return ref && ref.length > 0 ? ref : undefined
  }

  // 剥离 ID 前缀（如 f:xxx / p:xxx），防御 LLM 误传
  function stripIdPrefix(id: string): string {
    const trimmed = id.trim()
    const match = trimmed.match(/^[a-z]+:(.+)$/i)
    return match ? match[1].trim() : trimmed
  }

  /**
   * 附加搜索知识卡片：在 kms_search 主结果后追加匹配的知识卡片摘要
   * 让 LLM 一次拿到文档片段 + 已沉淀的卡片结论
   */
  async function appendKnowledgeCards(query: string): Promise<string> {
    try {
      const cards = await kmsService.searchKnowledgeCards(query, 2)
      if (cards.length === 0) return ''
      let output = '\n--- 知识卡片 ---\n'
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i] as any
        output += `[卡片${i + 1}] ${c.displayKeyword}（搜索${c.searchCount}次，${c.status === 'stale' ? '需刷新' : '活跃'}）\n`
        output += `${c.summary}\n`
        if (c.keyPoints && c.keyPoints.length > 0) {
          output += '要点：\n'
          for (const kp of c.keyPoints) {
            const citation = c.citations[kp.sourceIndex]
            const source = citation ? `（来源：${citation.fileName}）` : ''
            output += `- ${kp.point}${source}\n`
          }
        }
        output += '\n'
      }
      return output
    } catch {
      return ''
    }
  }

  /**
   * 附加搜索合集摘要：在 kms_search 主结果后追加匹配的合集摘要
   * 让 LLM 一次拿到文档片段 + 合集整体结论
   */
  function appendCollectionSummaries(query: string): string {
    try {
      const hits = kmsService.searchCollectionSummaries(query, 2)
      if (hits.length === 0) return ''
      let output = '\n--- 相关合集摘要 ---\n'
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i]
        output += `[合集${i + 1}] ${h.collectionName} [${h.collectionId}] ${h.fileCount}篇`
        if (h.keyTopics.length > 0) output += ` | ${h.keyTopics.join('、')}`
        output += '\n'
        output += `${h.summary}\n\n`
      }
      return output
    } catch {
      return ''
    }
  }

  const kmsSearchTool: ToolDefinition = {
    id: 'kms_search',
    name: 'kms_search',
    title: '本地资料检索',
    summary: 'Search the local knowledge base (PDF/Word/Excel/PPT/Markdown) with keyword or hybrid retrieval; results include related knowledge cards and collection summaries.',
    description: 'Search the local knowledge base. Supports PDF, Word, Excel, PowerPoint, Markdown, and TXT. Use keyword retrieval (keyword) for exact terms or hybrid retrieval (hybrid) for conceptual questions that need semantic similarity. Results include matching knowledge cards and collection summaries, so no separate tool call is needed.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query or natural-language question',
        },
        search_mode: {
          type: 'string',
          enum: ['keyword', 'hybrid'],
          description: 'Retrieval mode: keyword (default) for exact terms; hybrid combines keywords with vector search for conceptual queries',
          default: 'keyword',
        },
        top_k: {
          type: 'number',
          description: 'Number of results to return (1-20, default 5)',
          minimum: 1,
          maximum: 20,
          default: 5,
        },
        collection_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional collection ids to restrict the search to. Omit to use the conversation scope or all indexed files.',
        },
        dir_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional indexed directory ids to restrict the search to',
        },
        file_extensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file extensions to include (e.g. ["pdf", "docx", "md"])',
        },
        time_range_start: {
          type: 'number',
          description: 'Optional file modification time lower bound (epoch milliseconds)',
        },
        time_range_end: {
          type: 'number',
          description: 'Optional file modification time upper bound (epoch milliseconds)',
        },
      },
      required: ['query'],
    },
    timeoutMs: 120000,
    handler: async (args: any) => {
      try {
        // 兼容不同模型/文本形式工具调用对查询参数的命名差异（query 为标准 schema 命名，keyword 为部分模型习惯）
        const query = String(args.query ?? args.keyword ?? '').trim()
        if (!query || query.length < 1) {
          return { success: true, output: '请输入查询内容。' }
        }

        const collectionIds = resolveCollectionIds(args)
        const dirIds = args.dir_ids && Array.isArray(args.dir_ids) && args.dir_ids.length > 0 ? args.dir_ids : resolveDirIds()
        const fileExtensions = resolveFileExtensions(args)
        const timeRangeStart = typeof args.time_range_start === 'number' ? args.time_range_start : undefined
        const timeRangeEnd = typeof args.time_range_end === 'number' ? args.time_range_end : undefined

        const topK = Math.min(Math.max(args.top_k || 5, 1), 20)
        const useSemantic = String(args.search_mode || 'keyword') === 'hybrid'

        const results = await kmsService.search(query, {
          topK,
          useSemantic,
          collectionIds,
          dirIds,
          fileExtensions,
          timeRangeStart,
          timeRangeEnd,
        })

        if (results.length === 0) {
          let msg = `本地搜索无结果："${query}"。`
          if (collectionIds && collectionIds.length > 0) {
            msg += ' 当前限定在指定合集中检索，可尝试不传 collection_ids 搜索全部资料库。'
          }
          if (!useSemantic) {
            msg += ' 建议：尝试混合检索(search_mode:"hybrid")'
          }
          // 即使文件无结果，仍尝试附加卡片和合集摘要
          const cardsOutput = await appendKnowledgeCards(query)
          const collectionsOutput = appendCollectionSummaries(query)
          if (cardsOutput || collectionsOutput) {
            msg += '\n但找到相关知识：'
            msg += cardsOutput + collectionsOutput
          }
          return { success: true, output: msg }
        }

        const typeLabels: Record<string, string> = {
          document: '文档',
          file_title: '标题',
          file_summary: '摘要',
          paragraph: '段落',
          content_paragraph: '原文',
          hybrid: '混合',
          file_name: '文件名',
        }

        const scopeLabel = collectionIds && collectionIds.length > 0 ? `(合集${collectionIds.length}个)` : ''
        let output = `${results.length} 条结果${useSemantic ? '(混合)' : '(关键词)'}${scopeLabel}:\n\n`
        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const typeLabel = typeLabels[r.match_type] || r.match_type

          output += `[${i + 1}] ${typeLabel} | ${r.file_name}`
          if (r.paragraph_title) output += ` > ${r.paragraph_title}`
          output += '\n'
          output += `路径: ${r.file_path}\n`
          output += `${r.text}\n`
          output += `file_id: ${r.file_id}\n`
          if (r.paragraph_id) output += `paragraph_id: ${r.paragraph_id}\n`
          if (r.start_line !== undefined && r.end_line !== undefined) {
            output += `lines: ${r.start_line}-${r.end_line}\n`
          }
          if (r.start_offset !== undefined && r.end_offset !== undefined) {
            output += `offset: ${r.start_offset}-${r.end_offset}\n`
          }
          output += '\n'
        }

        // 附加知识卡片和合集摘要
        output += await appendKnowledgeCards(query)
        output += appendCollectionSummaries(query)

        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `本地搜索失败: ${error.message}` }
      }
    },
    source: 'builtin',
    onDemand: true,
  }

  const kmsGetContentTool: ToolDefinition = {
    id: 'kms_get_content',
    name: 'kms_get_content',
    title: '获取本地文件内容',
    summary: 'Read a file\'s content, table of contents, or paragraph summaries from the knowledge base. Obtain file_id from kms_search first.',
    description: 'Get a knowledge-base file\'s content. The view parameter selects the view: content (default) returns body text and supports targeting by paragraph id, character offset, or start_line (reads a fixed window from that line); toc returns the heading hierarchy with paragraph ids; paragraphs returns all paragraph summaries and metadata. Obtain file_id from kms_search first. file_id is a plain id such as "8170964a", without prefixes like "f:".',
    parameters: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'File id from the "file_id" field of kms_search, e.g. "8170964a" (no "f:" prefix)',
        },
        view: {
          type: 'string',
          enum: ['content', 'toc', 'paragraphs'],
          description: 'View: content (default body text) / toc (heading hierarchy) / paragraphs (all paragraph summaries)',
          default: 'content',
        },
        paragraph_id: {
          type: 'string',
          description: 'Optional paragraph id for view=content, from the "paragraph_id" field (no "p:" prefix)',
        },
        paragraph_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional paragraph id array for view=content, to batch-read summaries and metadata',
        },
        start_offset: {
          type: 'number',
          description: 'Optional start character offset for view=content',
        },
        end_offset: {
          type: 'number',
          description: 'Optional end character offset for view=content',
        },
        start_line: {
          type: 'number',
          description: 'Optional start line for view=content',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return for view=content (default 5000)',
          default: 5000,
        },
      },
      required: ['file_id'],
    },
    handler: async (args: any) => {
      try {
        let fileId = String(args.file_id || '').trim()
        if (!fileId) {
          return { success: true, output: '请提供 file_id。' }
        }
        fileId = stripIdPrefix(fileId)

        const view = String(args.view || 'content')

        // ====== view=toc：获取文件目录结构 ======
        if (view === 'toc') {
          const toc = kmsService.getFileToc(fileId) as any[]
          if (!toc || toc.length === 0) {
            return { success: true, output: '该文件暂无段落目录。' }
          }

          const fileSummary = kmsService.getFileSummary(fileId)
          const fileName = fileSummary?.file_name || fileId

          let output = `${fileName} (${toc.length}段, #后为段落ID):\n`
          for (const p of toc) {
            const indent = '  '.repeat(Math.max(0, (p.level || 1) - 1))
            output += `${indent}${p.title} #${p.id}\n`
          }
          return { success: true, output }
        }

        // ====== view=paragraphs：获取文件所有段落摘要 ======
        if (view === 'paragraphs') {
          const paragraphs = kmsService.getFileParagraphs(fileId) as any[]
          if (!paragraphs || paragraphs.length === 0) {
            return { success: true, output: '该文件暂无段落摘要（仅热数据文件有摘要）。' }
          }

          // 限制输出条目数，防止大文档产生超大响应
          const MAX_PARAGRAPHS = 200
          const displayParagraphs = paragraphs.length > MAX_PARAGRAPHS ? paragraphs.slice(0, MAX_PARAGRAPHS) : paragraphs
          let output = `${paragraphs.length}个段落`
          if (paragraphs.length > MAX_PARAGRAPHS) output += ` (仅显示前 ${MAX_PARAGRAPHS} 个)`
          output += ':\n'
          for (let i = 0; i < displayParagraphs.length; i++) {
            const p = displayParagraphs[i]
            output += `[${i + 1}] ${p.title_path || p.title || '(无标题)'} [${p.id}]`
            if (p.summary) output += ` ${p.summary}`
            output += `\n    file:${p.file_id || fileId} off:${p.start_offset}-${p.end_offset}\n`
          }
          return { success: true, output }
        }

        // ====== view=content（默认）：获取文件正文 ======
        // 优先级：paragraph_ids 批量段落摘要 > paragraph_id 单段定位 > offset/line 范围读取 > 全文
        if (Array.isArray(args.paragraph_ids) && args.paragraph_ids.length > 0) {
          const ids = args.paragraph_ids.map((id: any) => stripIdPrefix(String(id)))
          const paragraphs = kmsService.getParagraphsByIds(ids)
          if (paragraphs.length === 0) {
            return { success: true, output: '未找到匹配的段落。请检查 paragraph_id 是否正确。' }
          }
          let output = `${paragraphs.length}个段落:\n`
          for (let i = 0; i < paragraphs.length; i++) {
            const p = paragraphs[i]
            output += `[${i + 1}] ${p.title_path || p.title} [${p.id}]`
            if (p.summary) output += ` ${p.summary}`
            const keywords = (() => { try { const arr = JSON.parse(p.keywords_json || '[]'); return Array.isArray(arr) ? arr : [] } catch { return [] } })()
            if (keywords.length > 0) {
              output += ` | 关键词: ${keywords.join('、')}`
            }
            output += `\n    file:${p.file_id} (${p.file_name || ''}) off:${p.start_offset}-${p.end_offset}\n`
          }
          return { success: true, output }
        }

        let paragraphId: string | undefined
        if (args.paragraph_id) {
          paragraphId = stripIdPrefix(String(args.paragraph_id))
        }

        const content = await kmsService.getFileContent(fileId, {
          paragraphId,
          startOffset: args.start_offset,
          endOffset: args.end_offset,
          startLine: args.start_line,
          maxChars: args.max_chars || 5000,
        })

        return { success: true, output: content }
      } catch (error: any) {
        return { success: false, error: `获取文件内容失败: ${error.message}` }
      }
    },
    source: 'builtin',
    onDemand: true,
  }

  return [kmsSearchTool, kmsGetContentTool]
}
