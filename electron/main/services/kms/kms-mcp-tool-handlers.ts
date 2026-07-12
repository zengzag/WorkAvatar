import KMSService from './kms.service'
import KMSDatabaseService from './kms-database.service'

/** 工具处理函数类型 */
export type ToolHandler = (args: Record<string, any>, kmsService: KMSService) => Promise<string>

/** 获取指定目录下的文件数 */
export function getFileCountByDir(dirId: string): number {
  const db = KMSDatabaseService.getInstance().getDb()
  const row = db.prepare('SELECT COUNT(*) as count FROM kms_files WHERE dir_id = ?').get(dirId) as any
  return row?.count || 0
}

/** 根据 fileId 获取文件基本信息 */
export function getFileById(fileId: string): any {
  const db = KMSDatabaseService.getInstance().getDb()
  return db.prepare('SELECT file_name, file_path FROM kms_files WHERE id = ?').get(fileId)
}

/**
 * 防御性剥离 ID 前缀
 * AI 可能误传 f:xxx / p:xxx 等带前缀格式（来源于旧版输出格式的歧义）
 */
export function stripIdPrefix(id: string): string {
  const trimmed = id.trim()
  const match = trimmed.match(/^[a-z]+:(.+)$/i)
  if (match) {
    return match[1].trim()
  }
  return trimmed
}

/** 解析 JSON 字符串数组，失败返回空数组 */
function parseJsonArray(json: string | undefined): any[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/**
 * 工具处理字典：将工具名映射到对应的处理函数
 * 每个处理函数接收 (args, kmsService) 参数，返回 Promise<string>
 */
export const toolHandlers: Record<string, ToolHandler> = {
  'kms_list_dirs': async (_args, kmsService) => {
    const dirs = kmsService.listIndexDirs() as any[]
    if (dirs.length === 0) {
      return 'No index directories configured.'
    }

    let output = `${dirs.length} index directory(ies):\n`
    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i]
      const fileCount = getFileCountByDir(dir.id)
      output += `${i + 1}. ${dir.display_name || dir.dir_path} [${dir.id}] ${fileCount} files`
      if (dir.enabled === 0) output += ' (disabled)'
      output += `\n   ${dir.dir_path}\n`
    }
    return output
  },

  'kms_stats': async (_args, kmsService) => {
    const stats = kmsService.getStats()
    let output = 'KMS Statistics:\n'
    output += `Directories: ${stats.dirs.total} (enabled: ${stats.dirs.enabled})\n`
    output += `Collections: ${stats.collections?.total ?? 0}\n`
    output += `Files: ${stats.files.total}\n`
    output += `  Status: ${JSON.stringify(stats.files.byStatus)}\n`
    output += `  Tier: ${JSON.stringify(stats.files.byTier)}\n`
    output += `  Extensions: ${JSON.stringify(stats.files.byExt)}\n`
    output += `Index entries: ${stats.index.totalEntries}\n`
    output += `  By type: ${JSON.stringify(stats.index.byType)}\n`
    output += `Embeddings: ${stats.index.embeddingCount}\n`
    return output
  },

  'kms_search': async (args, kmsService) => {
    const query = String(args.query || '').trim()
    if (!query || query.length < 2) {
      return 'Please enter at least 2 characters for the query.'
    }

    const topK = Math.min(Math.max(args.top_k || 10, 1), 50)
    const useSemantic = Boolean(args.use_semantic)

    const results = await kmsService.search(query, {
      topK,
      useSemantic,
      fileExtensions: args.file_extensions,
      // time_range 单位为毫秒，kmsService.search() 内部统一转换为 unix 秒
      timeRangeStart: args.time_range_start,
      timeRangeEnd: args.time_range_end,
      dirIds: args.dir_ids,
      collectionIds: args.collection_ids,
    })

    if (results.length === 0) {
      let msg = `No results for "${query}".`
      if (!useSemantic) msg += ' Suggestions: enable semantic search (use_semantic:true)'
      return msg
    }

    let output = `${results.length} result(s)${useSemantic ? ' (semantic)' : ' (keyword)'}:\n\n`
    const typeLabels: Record<string, string> = {
      file_title: 'Title',
      file_summary: 'Summary',
      paragraph: 'Paragraph',
      content_paragraph: 'Content',
      hybrid: 'Hybrid',
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i] as any
      const typeLabel = typeLabels[r.match_type as string] || r.match_type

      output += `[${i + 1}] ${typeLabel} | ${r.file_name}`
      if (r.paragraph_title) output += ` > ${r.paragraph_title}`
      output += '\n'
      output += `${r.text}\n`
      output += `file_id: ${r.file_id}\n`
      if (r.paragraph_id) output += `paragraph_id: ${r.paragraph_id}\n`
      if (r.start_line !== undefined && r.end_line !== undefined) {
        output += `lines: ${r.start_line}-${r.end_line}\n`
      }
      if (r.start_offset !== undefined && r.end_offset !== undefined) {
        output += `offset: ${r.start_offset}-${r.end_offset}\n`
      }
      output += `path: ${r.file_path}\n\n`
    }

    return output
  },

  'kms_agent_search': async (args, kmsService) => {
    const query = String(args.query || '').trim()
    if (!query || query.length < 2) {
      return 'Please enter at least 2 characters for the query.'
    }

    const result = await kmsService.agentSearch(query, {
      maxRounds: args.max_rounds,
      topK: args.top_k,
      dirIds: args.dir_ids,
      collectionIds: args.collection_ids,
      fileExtensions: args.file_extensions,
      timeRangeStart: args.time_range_start,
      timeRangeEnd: args.time_range_end,
    })

    let output = `Query Type: ${result.queryTypeLabel}\n`
    output += `Search Rounds: ${result.searchRounds}\n\n`
    output += `Conclusion:\n${result.conclusion}\n`

    if (result.sources.length > 0) {
      output += '\nSources:\n'
      for (let i = 0; i < result.sources.length; i++) {
        const s = result.sources[i]
        output += `[${i + 1}] ${s.fileName}`
        if (s.paragraphTitle) output += ` > ${s.paragraphTitle}`
        output += '\n'
        output += `file_id: ${s.fileId}\n`
        if (s.paragraphId) output += `paragraph_id: ${s.paragraphId}\n`
        if (s.startLine !== undefined && s.endLine !== undefined) {
          output += `lines: ${s.startLine}-${s.endLine}\n`
        }
        if (s.startOffset !== undefined && s.endOffset !== undefined) {
          output += `offset: ${s.startOffset}-${s.endOffset}\n`
        }
        output += `path: ${s.filePath}\n`
        if (s.snippet) output += `snippet: ${s.snippet.substring(0, 150)}...\n`
        output += '\n'
      }
    }

    return output
  },

  'kms_get_content': async (args, kmsService) => {
    let fileId = String(args.file_id || '').trim()
    if (!fileId) {
      return 'Please provide file_id.'
    }
    fileId = stripIdPrefix(fileId)

    const content = await kmsService.getFileContent(fileId, {
      paragraphId: stripIdPrefix(String(args.paragraph_id || '')) || undefined,
      startOffset: args.start_offset,
      endOffset: args.end_offset,
      startLine: args.start_line,
      maxChars: args.max_chars || 5000,
    })

    const file = getFileById(fileId)
    if (!file) {
      return 'File not found.'
    }

    let output = `${file.file_name}\n`
    output += `file_id: ${fileId}\n`
    if (args.paragraph_id) output += `paragraph_id: ${stripIdPrefix(String(args.paragraph_id))}\n`
    if (args.start_offset !== undefined && args.end_offset !== undefined) {
      output += `offset: ${args.start_offset}-${args.end_offset}\n`
    }
    if (args.start_line !== undefined) {
      output += `line: ${args.start_line}\n`
    }
    output += `path: ${file.file_path}\n\n`
    output += content
    return output
  },

  'kms_get_summary': async (args, kmsService) => {
    let fileId = String(args.file_id || '').trim()
    if (!fileId) {
      return 'Please provide file_id.'
    }
    fileId = stripIdPrefix(fileId)

    const summary = kmsService.getFileSummary(fileId) as any
    if (!summary) {
      return 'No summary available. Summary is only generated for hot data files.'
    }

    let output = `File Summary:\n`
    output += `${summary.summary || '(empty)'}\n`
    const keywords = parseJsonArray(summary.keywords_json)
    if (keywords.length > 0) {
      output += `\nKeywords: ${keywords.join(', ')}\n`
    }
    const topics = parseJsonArray(summary.main_topics_json)
    if (topics.length > 0) {
      output += `Main Topics: ${topics.join(', ')}\n`
    }

    return output
  },

  'kms_list_collections': async (_args, kmsService) => {
    const collections = kmsService.listCollections() as any[]
    if (collections.length === 0) {
      return 'No collections available. Collections are curated groups of files created via the WorkAvatar UI.'
    }

    let output = `${collections.length} collection(s):\n`
    for (let i = 0; i < collections.length; i++) {
      const c = collections[i]
      output += `${i + 1}. ${c.name} [${c.id}] ${c.file_count || 0} files`
      if (c.description) output += ` - ${c.description}`
      output += '\n'
    }
    return output
  },

  'kms_list_files_in_collection': async (args, kmsService) => {
    const collectionId = String(args.collection_id || '').trim()
    if (!collectionId) {
      return 'Please provide collection_id.'
    }

    const files = kmsService.listFilesInCollection(collectionId) as any[]
    if (files.length === 0) {
      return 'Collection is empty or not found.'
    }

    let output = `${files.length} file(s) in collection:\n\n`
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      output += `[${i + 1}] ${f.file_name} [${f.id}]\n`
      output += `  ext: ${f.file_ext || 'N/A'}, size: ${f.file_size || 0}, status: ${f.index_status}\n`
      output += `  path: ${f.file_path}\n`
      if (f.light_summary) {
        output += `  summary: ${f.light_summary.substring(0, 200)}${f.light_summary.length > 200 ? '...' : ''}\n`
      }
      output += '\n'
    }
    return output
  },

  'kms_get_collection_summary': async (args, kmsService) => {
    const collectionId = String(args.collection_id || '').trim()
    if (!collectionId) {
      return 'Please provide collection_id.'
    }

    const summary = kmsService.getCollectionSummary(collectionId) as any
    if (!summary) {
      return 'No summary available for this collection.'
    }

    let output = `Collection Summary:\n`
    output += `${summary.summary || '(empty)'}\n`
    const topics = parseJsonArray(summary.key_topics_json)
    if (topics.length > 0) {
      output += `\nKey Topics: ${topics.join(', ')}\n`
    }
    return output
  },

  'kms_get_toc': async (args, kmsService) => {
    let fileId = String(args.file_id || '').trim()
    if (!fileId) {
      return 'Please provide file_id.'
    }
    fileId = stripIdPrefix(fileId)

    const toc = kmsService.getFileToc(fileId) as any[]
    if (!toc || toc.length === 0) {
      return 'No table of contents available. TOC is generated when the file is indexed as hot data.'
    }

    let output = `Table of Contents (${toc.length} entries):\n\n`
    for (const entry of toc) {
      const indent = '  '.repeat(Math.max(0, (entry.level || 1) - 1))
      output += `${indent}- ${entry.title || '(untitled)'}`
      output += ` [paragraph_id: ${entry.id}]`
      if (entry.startOffset !== undefined && entry.endOffset !== undefined) {
        output += ` offset: ${entry.startOffset}-${entry.endOffset}`
      }
      output += '\n'
    }
    return output
  },

  'kms_get_paragraphs': async (args, kmsService) => {
    let fileId = String(args.file_id || '').trim()
    if (!fileId) {
      return 'Please provide file_id.'
    }
    fileId = stripIdPrefix(fileId)

    const paragraphs = kmsService.getFileParagraphs(fileId) as any[]
    if (!paragraphs || paragraphs.length === 0) {
      return 'No paragraphs available. Paragraphs are generated when the file is indexed as hot data.'
    }

    let output = `${paragraphs.length} paragraph(s):\n\n`
    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i]
      const indent = '  '.repeat(Math.max(0, (p.level || 1) - 1))
      output += `[${i + 1}] ${indent}${p.title || '(untitled)'} [paragraph_id: ${p.id}]\n`
      if (p.summary) {
        output += `  summary: ${p.summary}\n`
      }
      if (p.start_offset !== undefined && p.end_offset !== undefined) {
        output += `  offset: ${p.start_offset}-${p.end_offset}\n`
      }
      const keywords = parseJsonArray(p.keywords_json)
      if (keywords.length > 0) {
        output += `  keywords: ${keywords.join(', ')}\n`
      }
      output += '\n'
    }
    return output
  },

  'kms_knowledge_card': async (args, kmsService) => {
    const query = String(args.query || '').trim()
    if (!query) {
      return 'Please provide a query topic.'
    }
    const topK = Math.min(Math.max(Number(args.top_k) || 3, 1), 5)
    const cards = await kmsService.searchKnowledgeCards(query, topK)

    if (cards.length === 0) {
      return `No knowledge cards found matching "${query}". Use kms_search for full-text search.`
    }

    let output = `${cards.length} knowledge card(s) found:\n\n`
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i] as any
      output += `[${i + 1}] ${c.displayKeyword} (searched ${c.searchCount} times, ${c.status === 'stale' ? 'needs refresh' : 'active'})\n`
      output += `${c.summary}\n`
      if (c.keyPoints && c.keyPoints.length > 0) {
        output += 'Key points:\n'
        for (const kp of c.keyPoints) {
          const citation = c.citations[kp.sourceIndex]
          const source = citation ? ` (source: ${citation.fileName})` : ''
          output += `- ${kp.point}${source}\n`
        }
      }
      if (c.citations && c.citations.length > 0) {
        output += 'Citations:\n'
        for (let j = 0; j < c.citations.length; j++) {
          const cite = c.citations[j]
          output += `  [${j}] ${cite.fileName}`
          if (cite.paragraphTitle) output += ` > ${cite.paragraphTitle}`
          if (cite.startLine !== undefined && cite.endLine !== undefined) {
            output += ` (lines ${cite.startLine}-${cite.endLine})`
          }
          output += `\n    ${cite.snippet}\n`
        }
      }
      output += '\n'
    }
    return output
  },
}

/** 执行指定工具 */
export async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  const kmsService = KMSService.getInstance()
  const handler = toolHandlers[name]
  if (!handler) {
    return `Unknown tool: ${name}`
  }
  return handler(args, kmsService)
}
