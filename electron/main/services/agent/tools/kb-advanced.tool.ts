import type { ToolDefinition } from '../tool.types'
import DatabaseService from '../../database.service'

export function createKBAdvancedSearchTool(allowedKbIds: string[]): ToolDefinition {
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
    id: 'kb_advanced_search',
    name: 'kb_advanced_search',
    title: '高级知识库检索',
    description: `对知识库进行高级检索，支持精确短语匹配、排除词、文档类型过滤等语法。`,
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

        // 解析查询语法
        const phrases: string[] = []
        const required: string[] = []
        const excludedWords: string[] = []
        const optional: string[] = []

        // 提取精确短语
        const phraseRegex = /"([^"]+)"/g
        let match
        let queryWithoutPhrases = query
        while ((match = phraseRegex.exec(query)) !== null) {
          phrases.push(match[1].toLowerCase())
          queryWithoutPhrases = queryWithoutPhrases.replace(match[0], ' ')
        }

        // 解析剩余词
        const words = queryWithoutPhrases.toLowerCase().split(/\s+/).filter((w: string) => w.length > 0)
        for (const word of words) {
          if (word.startsWith('+') && word.length > 1) {
            required.push(word.slice(1))
          } else if (word.startsWith('-') && word.length > 1) {
            excludedWords.push(word.slice(1))
          } else if (word.length > 1) {
            optional.push(word)
          }
        }

        if (phrases.length === 0 && required.length === 0 && optional.length === 0) {
          return { success: true, output: '请输入有效的查询条件。' }
        }

        const excluded = excludedWords

        // 构建文档查询
        let docSql = 'SELECT id, original_name, type, content_text FROM kb_documents WHERE kb_id = ? AND parse_status = \'completed\''
        const docParams: any[] = [targetKbId]

        if (args.document_type) {
          docSql += ' AND type = ?'
          docParams.push(args.document_type.toLowerCase())
        }

        const docs = db.getDb().prepare(docSql).all(...docParams) as any[]

        interface AdvancedResult {
          document_id: string
          document_name: string
          document_type: string
          text: string
          score: number
          match_details: string[]
          start_offset: number
          end_offset: number
          start_line: number
          end_line: number
        }

        const results: AdvancedResult[] = []

        for (const doc of docs) {
          const content = (doc.content_text || '').toLowerCase()
          const nameLower = doc.original_name.toLowerCase()
          let score = 0
          const matchDetails: string[] = []

          // 检查排除词
          let isExcluded = false
          for (const exWord of excludedWords) {
            if (content.includes(exWord) || nameLower.includes(exWord)) {
              isExcluded = true
              break
            }
          }
          if (isExcluded) continue

          // 精确短语匹配
          for (const phrase of phrases) {
            const phraseRegex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
            const phraseMatches = (content.match(phraseRegex) || []).length
            if (phraseMatches > 0) {
              score += phraseMatches * 15
              matchDetails.push(`精确短语"${phrase}"匹配${phraseMatches}次`)
            } else if (nameLower.includes(phrase)) {
              score += 12
              matchDetails.push(`标题包含精确短语"${phrase}"`)
            }
          }

          // 必须包含词
          let allRequired = true
          for (const req of required) {
            if (content.includes(req) || nameLower.includes(req)) {
              score += 8
              matchDetails.push(`必须词"${req}"匹配`)
            } else {
              allRequired = false
            }
          }
          if (required.length > 0 && !allRequired) continue

          // 可选词
          for (const opt of optional) {
            const optMatches = (content.match(new RegExp(opt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
            if (optMatches > 0) {
              score += optMatches * 3
              matchDetails.push(`可选词"${opt}"匹配${optMatches}次`)
            } else if (nameLower.includes(opt)) {
              score += 5
              matchDetails.push(`标题包含"${opt}"`)
            }
          }

          if (score > 0) {
            // 提取最佳匹配片段，同时计算行号和偏移量
            const fullContent = doc.content_text || ''
            const lines = fullContent.split('\n')
            const paragraphs = fullContent.split(/\n\n+/).filter((p: string) => p.trim().length > 20)

            let bestSnippet = ''
            let bestStartOffset = 0
            let bestEndOffset = 0
            let bestStartLine = 1
            let bestEndLine = 1

            for (const para of paragraphs) {
              const paraLower = para.toLowerCase()
              let paraScore = 0
              for (const phrase of phrases) {
                if (paraLower.includes(phrase)) paraScore += 10
              }
              for (const req of required) {
                if (paraLower.includes(req)) paraScore += 5
              }
              for (const opt of optional) {
                if (paraLower.includes(opt)) paraScore += 2
              }
              if (paraScore > 0 && para.length > bestSnippet.length) {
                bestSnippet = para.substring(0, 400)
                if (para.length > 400) bestSnippet += '...'

                // 计算偏移量和行号
                bestStartOffset = fullContent.indexOf(para)
                bestEndOffset = bestStartOffset + para.length
                let offset = 0
                for (let i = 0; i < lines.length; i++) {
                  if (offset <= bestStartOffset && bestStartOffset < offset + lines[i].length + 1) {
                    bestStartLine = i + 1
                  }
                  if (offset < bestEndOffset && bestEndOffset <= offset + lines[i].length + 1) {
                    bestEndLine = i + 1
                    break
                  }
                  offset += lines[i].length + 1
                }
              }
            }

            results.push({
              document_id: doc.id,
              document_name: doc.original_name,
              document_type: doc.type,
              text: bestSnippet || doc.original_name,
              score,
              match_details: matchDetails,
              start_offset: bestStartOffset,
              end_offset: bestEndOffset,
              start_line: bestStartLine,
              end_line: bestEndLine
            })
          }
        }

        results.sort((a, b) => b.score - a.score)
        const topResults = results.slice(0, topK)

        if (topResults.length === 0) {
          return {
            success: true,
            output: `未找到符合高级查询条件的内容。\n查询条件: ${query}\n建议放宽条件或减少排除词。`
          }
        }

        let output = `## 高级检索结果\n\n`
        output += `查询: "${query}"\n`
        if (phrases.length > 0) output += `精确短语: ${phrases.map(p => `"${p}"`).join(', ')}\n`
        if (required.length > 0) output += `必须包含: ${required.map(r => `"${r}"`).join(', ')}\n`
        if (excluded.length > 0) output += `排除词: ${excluded.map(e => `"${e}"`).join(', ')}\n`
        if (optional.length > 0) output += `可选词: ${optional.map(o => `"${o}"`).join(', ')}\n`
        output += `\n共找到 ${results.length} 条结果，展示前 ${topResults.length} 条:\n\n`

        for (let i = 0; i < topResults.length; i++) {
          const r = topResults[i]
          output += `[${i + 1}] **${r.document_name}** (${r.document_type}) - 相关度: ${r.score}\n`
          output += `匹配详情: ${r.match_details.join(', ')}\n`
          output += `${r.text}\n`
          output += `[document_id: ${r.document_id}, line: ${r.start_line}-${r.end_line}, offset: ${r.start_offset}-${r.end_offset}]\n\n---\n\n`
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

