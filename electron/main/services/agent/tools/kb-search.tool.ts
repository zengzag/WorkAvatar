import fs from 'fs'
import type { ToolDefinition } from '../tool.types'
import DatabaseService from '../../database.service'

interface SearchResult {
  document_id: string
  document_name: string
  chapter_id?: string
  chapter_title?: string
  text: string
  score: number
  match_type: 'title' | 'summary' | 'keywords' | 'content' | 'entity'
  start_offset?: number
  end_offset?: number
  start_line?: number
  end_line?: number
}

export function createKBSearchTool(allowedKbIds: string[]): ToolDefinition {
  const db = DatabaseService.getInstance()

  const validateKbId = (kbId: string | undefined): string | null => {
    if (!kbId) return allowedKbIds.length > 0 ? allowedKbIds[0] : null
    if (!allowedKbIds.includes(kbId)) return null
    return kbId
  }

  const kbOptionsDesc = allowedKbIds.length > 0
    ? `可选值: ${allowedKbIds.join(', ')}`
    : '当前项目未关联知识库'

  return {
    id: 'kb_search',
    name: 'kb_search',
    title: '智能知识库检索',
    description: `对知识库进行智能检索，搜索标题、摘要、章节、关键词、实体和内容。`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索查询语句，支持空格分隔多个关键词'
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
          description: `知识库ID（可选，不提供则使用默认知识库）。${kbOptionsDesc}`
        },
        document_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '限定检索的文档ID列表（可选）'
        }
      },
      required: ['query']
    },
    handler: async (args: any) => {
      try {
        const targetKbId = validateKbId(args.kb_id)
        if (!targetKbId) {
          return { success: true, output: '未关联知识库或无权访问该知识库，无法进行检索。' }
        }

        const query = String(args.query || '').trim()
        if (!query || query.length < 2) {
          return { success: true, output: '请输入至少2个字符的查询内容。' }
        }

        const topK = Math.min(Math.max(args.top_k || 10, 1), 20)
        const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
        if (queryWords.length === 0) {
          return { success: true, output: '请输入有效的查询关键词。' }
        }

        let docFilter = ''
        const docFilterParams: any[] = []
        if (args.document_ids && args.document_ids.length > 0) {
          docFilter = ' AND d.id IN (' + args.document_ids.map(() => '?').join(',') + ')'
          docFilterParams.push(...args.document_ids)
        }

        const results: SearchResult[] = []

        // 1. 搜索文档标题
        const docs = db.getDb().prepare(
          `SELECT id, original_name, content_text, content_path FROM kb_documents WHERE kb_id = ? AND parse_status = 'completed'${docFilter}`
        ).all(targetKbId, ...docFilterParams) as any[]

        for (const doc of docs) {
          const nameLower = doc.original_name.toLowerCase()
          let titleScore = 0
          for (const word of queryWords) {
            if (nameLower.includes(word)) titleScore += 10
          }
          if (titleScore > 0) {
            results.push({
              document_id: doc.id,
              document_name: doc.original_name,
              text: `文档标题匹配: ${doc.original_name}`,
              score: titleScore,
              match_type: 'title'
            })
          }
        }

        // 2. 搜索文档摘要
        const summaries = db.getDb().prepare(
          `SELECT ds.*, d.original_name as document_name, d.id as document_id
           FROM kb_document_summaries ds
           JOIN kb_documents d ON ds.document_id = d.id
           WHERE ds.kb_id = ?${docFilter.replace(/d\.id/g, 'd.id')}`
        ).all(targetKbId, ...docFilterParams) as any[]

        for (const ds of summaries) {
          const summaryLower = (ds.summary || '').toLowerCase()
          const keywords: string[] = JSON.parse(ds.keywords_json || '[]')
          const topics: string[] = JSON.parse(ds.main_topics_json || '[]')

          let summaryScore = 0
          for (const word of queryWords) {
            if (summaryLower.includes(word)) summaryScore += 4
            for (const kw of keywords) {
              if (kw.toLowerCase().includes(word)) summaryScore += 5
            }
            for (const topic of topics) {
              if (topic.toLowerCase().includes(word)) summaryScore += 6
            }
          }

          if (summaryScore > 0) {
            const snippet = (ds.summary || '').substring(0, 300)
            results.push({
              document_id: ds.document_id,
              document_name: ds.document_name,
              text: `文档摘要: ${snippet}${(ds.summary || '').length > 300 ? '...' : ''}`,
              score: summaryScore,
              match_type: 'summary'
            })
          }
        }

        // 3. 搜索章节
        const chapters = db.getDb().prepare(
          `SELECT c.*, d.original_name as document_name
           FROM kb_chapters c
           JOIN kb_documents d ON c.document_id = d.id
           WHERE c.kb_id = ? AND c.summary IS NOT NULL${docFilter.replace(/d\.id/g, 'c.document_id')}`
        ).all(targetKbId, ...docFilterParams) as any[]

        for (const ch of chapters) {
          const titleLower = ch.title.toLowerCase()
          const summaryLower = (ch.summary || '').toLowerCase()
          const keywords: string[] = JSON.parse(ch.keywords_json || '[]')
          const entities: any[] = JSON.parse(ch.entities_json || '[]')

          let chapterScore = 0
          for (const word of queryWords) {
            if (titleLower.includes(word)) chapterScore += 8
            if (summaryLower.includes(word)) chapterScore += 3
            for (const kw of keywords) {
              if (kw.toLowerCase().includes(word)) chapterScore += 4
            }
            for (const e of entities) {
              if (e.name && e.name.toLowerCase().includes(word)) chapterScore += 5
            }
          }

          if (chapterScore > 0) {
            const snippet = (ch.summary || ch.content || '').substring(0, 300)
            results.push({
              document_id: ch.document_id,
              document_name: ch.document_name,
              chapter_id: ch.id,
              chapter_title: ch.title,
              text: `章节「${ch.title}」: ${snippet}${snippet.length > 300 ? '...' : ''}`,
              score: chapterScore,
              match_type: 'keywords',
              start_offset: ch.start_offset,
              end_offset: ch.end_offset
            })
          }
        }

        // 4. 搜索实体
        const entities = db.getDb().prepare(
          `SELECT * FROM kb_entities WHERE kb_id = ? ORDER BY mention_count DESC`
        ).all(targetKbId) as any[]

        for (const entity of entities) {
          const nameLower = entity.name.toLowerCase()
          const descLower = (entity.description || '').toLowerCase()
          const aliases: string[] = JSON.parse(entity.aliases_json || '[]')

          let entityScore = 0
          for (const word of queryWords) {
            if (nameLower === word) entityScore += 15
            else if (nameLower.includes(word)) entityScore += 10
            if (descLower.includes(word)) entityScore += 3
            for (const alias of aliases) {
              if (alias.toLowerCase().includes(word)) entityScore += 8
            }
          }

          if (entityScore > 0) {
            results.push({
              document_id: entity.first_seen_doc_id || '',
              document_name: '知识图谱实体',
              text: `实体「${entity.name}」(${entity.type}): ${entity.description || '无描述'} | 提及次数: ${entity.mention_count}`,
              score: entityScore,
              match_type: 'entity'
            })
          }
        }

        // 5. 搜索原始内容片段（带行号和偏移量）
        const contentDocs = db.getDb().prepare(
          `SELECT id, original_name, content_text, content_path FROM kb_documents WHERE kb_id = ? AND parse_status = 'completed' AND (content_text IS NOT NULL OR content_path IS NOT NULL)${docFilter}`
        ).all(targetKbId, ...docFilterParams) as any[]

        for (const doc of contentDocs) {
          const content = doc.content_path && fs.existsSync(doc.content_path)
            ? fs.readFileSync(doc.content_path, 'utf-8')
            : ''
          if (!content) continue
          const lines = content.split('\n')
          const paragraphs = content.split(/\n\n+/).filter((p: string) => p.trim().length > 30)

          // 预计算每段落的行号范围
          let currentOffset = 0
          const lineRanges: { startLine: number; endLine: number; startOffset: number; endOffset: number }[] = []
          for (const para of paragraphs) {
            const paraStartOffset = content.indexOf(para, currentOffset)
            const paraEndOffset = paraStartOffset + para.length
            // 计算行号
            let startLine = 1
            let endLine = 1
            let offset = 0
            for (let i = 0; i < lines.length; i++) {
              if (offset <= paraStartOffset && paraStartOffset < offset + lines[i].length + 1) {
                startLine = i + 1
              }
              if (offset < paraEndOffset && paraEndOffset <= offset + lines[i].length + 1) {
                endLine = i + 1
                break
              }
              offset += lines[i].length + 1
            }
            lineRanges.push({
              startLine,
              endLine,
              startOffset: paraStartOffset,
              endOffset: paraEndOffset
            })
            currentOffset = paraEndOffset
          }

          for (let pi = 0; pi < paragraphs.length; pi++) {
            const para = paragraphs[pi]
            const paraLower = para.toLowerCase()
            let contentScore = 0
            let matchedWords = 0
            for (const word of queryWords) {
              if (paraLower.includes(word)) {
                contentScore += 2
                matchedWords++
              }
            }
            // 提升多关键词同时命中的分数
            if (matchedWords > 1) contentScore += matchedWords * 2

            if (contentScore > 0) {
              const firstMatchWord = queryWords.find(w => paraLower.includes(w)) || queryWords[0]
              const matchIndex = paraLower.indexOf(firstMatchWord)
              const startIdx = Math.max(0, matchIndex - 80)
              const endIdx = Math.min(para.length, matchIndex + firstMatchWord.length + 200)
              let snippet = para.substring(startIdx, endIdx).trim()
              if (startIdx > 0) snippet = '...' + snippet
              if (endIdx < para.length) snippet = snippet + '...'

              const range = lineRanges[pi]
              results.push({
                document_id: doc.id,
                document_name: doc.original_name,
                text: snippet,
                score: contentScore,
                match_type: 'content',
                start_offset: range.startOffset,
                end_offset: range.endOffset,
                start_line: range.startLine,
                end_line: range.endLine
              })
            }
          }
        }

        // 去重并按分数排序
        const seen = new Set<string>()
        const uniqueResults: SearchResult[] = []

        for (const r of results) {
          const key = r.chapter_id
            ? `${r.document_id}-${r.chapter_id}-${r.match_type}`
            : `${r.document_id}-${r.text.substring(0, 100)}-${r.match_type}`
          if (!seen.has(key)) {
            seen.add(key)
            uniqueResults.push(r)
          }
        }

        uniqueResults.sort((a, b) => b.score - a.score)
        const topResults = uniqueResults.slice(0, topK)

        if (topResults.length === 0) {
          return {
            success: true,
            output: `未找到与"${query}"相关的内容。建议：\n1. 尝试使用更通用的关键词\n2. 使用 kb_overview 查看知识库中有哪些文档\n3. 检查文档是否已完成解析和知识处理`
          }
        }

        let output = `## 知识库检索结果: "${query}"\n\n`
        output += `共找到 ${uniqueResults.length} 条相关结果，展示前 ${topResults.length} 条:\n\n`

        for (let i = 0; i < topResults.length; i++) {
          const r = topResults[i]
          const typeLabel = {
            title: '文档标题',
            summary: '文档摘要',
            keywords: '章节摘要',
            content: '原文内容',
            entity: '知识实体'
          }[r.match_type] || '其他'

          output += `[${i + 1}] **${typeLabel}** (相关度: ${r.score})\n`
          output += `来源: ${r.document_name}${r.chapter_title ? ` > ${r.chapter_title}` : ''}\n`
          output += `${r.text}\n`

          // 输出定位信息
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
        output += `- 使用 kb_get_content 获取某个文档或章节的完整内容（支持 chapter_id / start_offset+end_offset / start_line+end_line 精准定位）\n`
        output += `- 使用 kb_entity_detail 查询某个实体的详细信息\n`
        output += `- 使用 query_knowledge_graph 查询某个实体的关系网络\n`
        output += `- 使用 kb_advanced_search 进行更精确的高级检索\n`

        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `知识库检索失败: ${error.message}` }
      }
    },
    source: 'builtin'
  }
}
