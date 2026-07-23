import KMSService from '../../kms/kms.service'
import type { ToolDefinition, ToolHandlerContext } from './types'

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

  // 复杂查询关键词，命中时 auto 模式走深度检索
  const DEEP_HINT_KEYWORDS = ['分析', '总结', '趋势', '对比', '梳理', '综合', '深度', '详细', '归纳', '概述', '比较', '异同', '原因', '影响']

  function shouldUseDeepMode(query: string): boolean {
    if (query.length > 20) return true
    return DEEP_HINT_KEYWORDS.some(kw => query.includes(kw))
  }

  const kmsSearchTool: ToolDefinition = {
    id: 'kms_search',
    name: 'kms_search',
    title: '本地资料检索',
    description: '对本地资料库进行检索。支持 PDF、Word、Excel、PPT、Markdown、TXT 等格式。mode=simple 单次检索（快速，返回匹配片段与定位）；mode=deep 调用检索子智能体多轮检索（自动识别查询意图，输出结论与溯源，适合复杂分析）；mode=auto 由系统根据查询复杂度自动选择。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索查询语句或自然语言问题',
        },
        mode: {
          type: 'string',
          enum: ['simple', 'deep', 'auto'],
          description: '检索模式：simple 单次检索（快速） / deep 深度检索（子智能体多轮，适合综合分析） / auto 自动判断（默认）',
          default: 'auto',
        },
        search_mode: {
          type: 'string',
          enum: ['keyword', 'hybrid'],
          description: 'simple 模式下的检索方式：keyword 关键词检索（默认） / hybrid 关键词+向量混合检索（兼顾精确匹配与语义相似，概念性查询建议）',
          default: 'keyword',
        },
        top_k: {
          type: 'number',
          description: 'simple 模式返回结果数量（1-20，默认5）',
          minimum: 1,
          maximum: 20,
          default: 5,
        },
        max_rounds: {
          type: 'number',
          description: 'deep 模式最大检索轮次（1-5，默认3）',
          minimum: 1,
          maximum: 5,
          default: 3,
        },
        collection_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '限定检索的合集ID列表（可选）。传入后只在指定合集内的文件中检索。不传则按会话默认范围或全部索引文件。',
        },
        file_extensions: {
          type: 'array',
          items: { type: 'string' },
          description: '限定文件扩展名（simple 模式可选，如 ["pdf", "docx", "md"]）',
        },
      },
      required: ['query'],
    },
    timeoutMs: 600000, // deep 模式可能多轮检索，统一 10 分钟超时
    handler: async (args: any, context?: ToolHandlerContext) => {
      try {
        const query = String(args.query || '').trim()
        if (!query || query.length < 1) {
          return { success: true, output: '请输入查询内容。' }
        }

        const rawMode = String(args.mode || 'auto')
        const mode = rawMode === 'simple' || rawMode === 'deep' ? rawMode : (shouldUseDeepMode(query) ? 'deep' : 'simple')
        const collectionIds = resolveCollectionIds(args)

        // ====== deep 模式：检索子智能体多轮检索 ======
        if (mode === 'deep') {
          const maxRounds = Math.min(Math.max(args.max_rounds || 3, 1), 5)
          const result = await kmsService.agentSearch(query, {
            maxRounds,
            collectionIds,
            onProgress: (step) => {
              context?.onProgress?.(step)
            },
          })

          let output = `【${result.queryTypeLabel}】${result.searchRounds}轮检索\n\n`
          output += `${result.conclusion}\n`

          if (result.sources.length > 0) {
            output += '\n--- 来源 ---\n'
            for (let i = 0; i < result.sources.length; i++) {
              const s = result.sources[i]
              output += `[${i + 1}] ${s.fileName}`
              if (s.paragraphTitle) output += ` > ${s.paragraphTitle}`
              output += '\n'
              output += `路径: ${s.filePath}\n`
              output += `file_id: ${s.fileId}\n`
              if (s.paragraphId) output += `paragraph_id: ${s.paragraphId}\n`
              if (s.startLine !== undefined && s.endLine !== undefined) {
                output += `lines: ${s.startLine}-${s.endLine}\n`
              }
              if (s.startOffset !== undefined && s.endOffset !== undefined) {
                output += `offset: ${s.startOffset}-${s.endOffset}\n`
              }
              output += '\n'
            }
          }

          return { success: true, output }
        }

        // ====== simple 模式：单次检索 ======
        const topK = Math.min(Math.max(args.top_k || 5, 1), 20)
        const useSemantic = String(args.search_mode || 'keyword') === 'hybrid'
        const dirIds = resolveDirIds()
        const fileExtensions = resolveFileExtensions(args)

        const results = await kmsService.search(query, {
          topK,
          useSemantic,
          collectionIds,
          dirIds,
          fileExtensions,
        })

        if (results.length === 0) {
          let msg = `本地搜索无结果："${query}"。`
          if (collectionIds && collectionIds.length > 0) {
            msg += ' 当前限定在指定合集中检索，可尝试不传 collection_ids 搜索全部资料库。'
          }
          if (!useSemantic) {
            msg += ' 建议：尝试混合检索(search_mode:"hybrid")，或使用深度检索(mode:"deep")'
          }
          return { success: true, output: msg }
        }

        const typeLabels: Record<string, string> = {
          file_title: '标题',
          file_summary: '摘要',
          paragraph: '段落',
          content_paragraph: '原文',
          hybrid: '混合',
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

        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `本地搜索失败: ${error.message}` }
      }
    },
    source: 'builtin',
  }

  const kmsGetContentTool: ToolDefinition = {
    id: 'kms_get_content',
    name: 'kms_get_content',
    title: '获取本地文件内容',
    description: '获取本地资料库中文件的完整内容或指定片段。支持按段落ID、字符偏移、行号定位读取。需先通过 kms_search 获取 file_id。注意：file_id 是纯ID字符串（如 "8170964a"），不要带 "f:" 等前缀。',
    parameters: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: '文件ID，来自 kms_search 结果中的 "file_id" 字段（如 "8170964a"），不要带 "f:" 前缀',
        },
        paragraph_id: {
          type: 'string',
          description: '段落ID（可选，指定后返回该段落内容。来自结果中的 "paragraph_id" 字段，不要带 "p:" 前缀）',
        },
        start_offset: {
          type: 'number',
          description: '起始字符偏移（可选）',
        },
        end_offset: {
          type: 'number',
          description: '结束字符偏移（可选）',
        },
        start_line: {
          type: 'number',
          description: '起始行号（可选）',
        },
        max_chars: {
          type: 'number',
          description: '最大返回字符数（默认5000）',
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
        // 防御性剥离前缀（AI 可能误传 f:xxx 格式）
        const prefixMatch = fileId.match(/^[a-z]+:(.+)$/i)
        if (prefixMatch) {
          fileId = prefixMatch[1].trim()
        }

        let paragraphId: string | undefined
        if (args.paragraph_id) {
          let pId = String(args.paragraph_id).trim()
          const pMatch = pId.match(/^[a-z]+:(.+)$/i)
          if (pMatch) pId = pMatch[1].trim()
          paragraphId = pId
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
  }

  const kmsKnowledgeCardTool: ToolDefinition = {
    id: 'kms_knowledge_card',
    name: 'kms_knowledge_card',
    title: '知识卡片查询',
    description: '查找本地资料库中已沉淀的知识卡片。知识卡片是基于用户高频搜索自动生成的主题摘要，包含结构化的要点和原文引用。对于常见问题可快速获取答案，无需重新检索全文。建议在 kms_search 之前先查询知识卡片，若卡片已包含答案则无需再搜索。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '查询主题，将与卡片关键词进行精确和语义匹配',
        },
        top_k: {
          type: 'number',
          description: '返回卡片数量（1-5，默认3）',
          minimum: 1,
          maximum: 5,
          default: 3,
        },
      },
      required: ['query'],
    },
    handler: async (args: any) => {
      try {
        const query = String(args.query || '').trim()
        if (!query) {
          return { success: true, output: '请提供查询主题。' }
        }
        const topK = Math.min(Math.max(args.top_k || 3, 1), 5)
        const cards = await kmsService.searchKnowledgeCards(query, topK)

        if (cards.length === 0) {
          return { success: true, output: `未找到与"${query}"匹配的知识卡片。可使用 kms_search 进行全文检索。` }
        }

        let output = `找到 ${cards.length} 张知识卡片：\n\n`
        for (let i = 0; i < cards.length; i++) {
          const c = cards[i]
          output += `[${i + 1}] ${c.displayKeyword}（搜索${c.searchCount}次，${c.status === 'stale' ? '需刷新' : '活跃'}）\n`
          output += `${c.summary}\n`
          if (c.keyPoints.length > 0) {
            output += '要点：\n'
            for (const kp of c.keyPoints) {
              const citation = c.citations[kp.sourceIndex]
              const source = citation ? `（来源：${citation.fileName}）` : ''
              output += `- ${kp.point}${source}\n`
            }
          }
          if (c.citations.length > 0) {
            output += `引用来源：\n`
            for (let j = 0; j < c.citations.length; j++) {
              const cite = c.citations[j]
              output += `  [${j}] ${cite.fileName}`
              if (cite.paragraphTitle) output += ` > ${cite.paragraphTitle}`
              if (cite.startLine !== undefined && cite.endLine !== undefined) {
                output += ` (行${cite.startLine}-${cite.endLine})`
              }
              output += `\n    ${cite.snippet}\n`
            }
          }
          output += '\n'
        }

        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `知识卡片查询失败: ${error.message}` }
      }
    },
    source: 'builtin',
  }

  return [kmsSearchTool, kmsGetContentTool, kmsKnowledgeCardTool]
}
