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
   * 让 LLM 一次拿到文档片段 + 已沉淀的卡片结论，无需单独调用 kms_knowledge_card
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
   * 让 LLM 一次拿到文档片段 + 合集整体结论，无需单独调用 kms_collection_overview
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
    summary: '检索本地资料库内容（PDF/Word/Excel/PPT/Markdown等），结果自动附加相关知识卡片与合集摘要。需要查找资料库文档、获取文档片段时使用。',
    description: '对本地资料库进行检索。支持 PDF、Word、Excel、PPT、Markdown、TXT 等格式。支持关键词检索（keyword）与关键词+向量混合检索（hybrid，兼顾精确匹配与语义相似，概念性查询建议）。检索结果会自动附加匹配的知识卡片（已沉淀的高频主题摘要）与合集摘要，无需单独调用其他工具。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索查询语句或自然语言问题',
        },
        search_mode: {
          type: 'string',
          enum: ['keyword', 'hybrid'],
          description: '检索方式：keyword 关键词检索（默认） / hybrid 关键词+向量混合检索（兼顾精确匹配与语义相似，概念性查询建议）',
          default: 'keyword',
        },
        top_k: {
          type: 'number',
          description: '返回结果数量（1-20，默认5）',
          minimum: 1,
          maximum: 20,
          default: 5,
        },
        collection_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '限定检索的合集ID列表（可选）。传入后只在指定合集内的文件中检索。不传则按会话默认范围或全部索引文件。',
        },
        dir_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '限定检索的索引目录ID列表（可选）',
        },
        file_extensions: {
          type: 'array',
          items: { type: 'string' },
          description: '限定文件扩展名（可选，如 ["pdf", "docx", "md"]）',
        },
        time_range_start: {
          type: 'number',
          description: '文件修改时间范围起始（毫秒时间戳，可选）',
        },
        time_range_end: {
          type: 'number',
          description: '文件修改时间范围结束（毫秒时间戳，可选）',
        },
      },
      required: ['query'],
    },
    timeoutMs: 120000,
    handler: async (args: any) => {
      try {
        const query = String(args.query || '').trim()
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
    summary: '读取资料库中文件的正文、目录或段落信息。需先用 kms_search 获取 file_id。',
    description: '获取本地资料库中文件的内容。通过 view 参数切换不同视图：view=content（默认）获取文件正文片段，支持按段落ID、字符偏移、行号定位；view=toc 获取文件的层级目录结构（章节标题与段落ID）；view=paragraphs 获取文件所有段落的摘要与元信息。需先通过 kms_search 获取 file_id。注意：file_id 是纯ID字符串（如 "8170964a"），不要带 "f:" 等前缀。',
    parameters: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: '文件ID，来自 kms_search 结果中的 "file_id" 字段（如 "8170964a"），不要带 "f:" 前缀',
        },
        view: {
          type: 'string',
          enum: ['content', 'toc', 'paragraphs'],
          description: '视图模式：content 文件正文（默认） / toc 文件目录结构 / paragraphs 文件所有段落摘要',
          default: 'content',
        },
        paragraph_id: {
          type: 'string',
          description: '段落ID（view=content 时可选，指定后返回该段落内容。来自结果中的 "paragraph_id" 字段，不要带 "p:" 前缀）',
        },
        paragraph_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '段落ID数组（view=content 时可选，批量获取多个段落的摘要与元信息，来自 kms_search 结果或 view=toc 的输出）',
        },
        start_offset: {
          type: 'number',
          description: '起始字符偏移（view=content 时可选）',
        },
        end_offset: {
          type: 'number',
          description: '结束字符偏移（view=content 时可选）',
        },
        start_line: {
          type: 'number',
          description: '起始行号（view=content 时可选）',
        },
        max_chars: {
          type: 'number',
          description: '最大返回字符数（view=content 时生效，默认5000）',
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
