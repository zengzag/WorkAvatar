import KMSService from '../../kms/kms.service'
import type { ToolDefinition } from './types'

/**
 * 创建 KMS 本地搜索工具集
 *
 * 暴露本地知识库搜索引擎的能力给数字员工，支持：
 * - kms_search: 关键词/语义/混合检索本地文件
 * - kms_agent_search: AI 智能检索（子智能体内部闭环，输出结论+溯源）
 * - kms_get_content: 获取文件内容（支持段落/偏移/行号定位）
 */
export function createKMSTools(): ToolDefinition[] {
  const kmsService = KMSService.getInstance()

  // kms_search: 本地文件检索
  const kmsSearchTool: ToolDefinition = {
    id: 'kms_search',
    name: 'kms_search',
    title: '本地文件检索',
    description: '对本地索引目录中的文件进行关键词、语义或混合检索。支持 PDF、Word、Excel、PPT、Markdown、TXT 等格式。返回文件名、路径、匹配片段和定位信息。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索查询语句，支持空格分隔多个关键词',
        },
        top_k: {
          type: 'number',
          description: '返回结果数量（1-20，默认5）',
          minimum: 1,
          maximum: 20,
          default: 5,
        },
        use_semantic: {
          type: 'boolean',
          description: '是否启用语义搜索（需要Embedding模型支持，默认false，使用关键词检索）。对于概念性查询建议启用',
          default: false,
        },
        use_hybrid: {
          type: 'boolean',
          description: '是否启用混合搜索（关键词+语义，默认false）。混合搜索能兼顾精确匹配和语义相似',
          default: false,
        },
        file_extensions: {
          type: 'array',
          items: { type: 'string' },
          description: '限定文件扩展名（可选，如 ["pdf", "docx", "md"]）',
        },
      },
      required: ['query'],
    },
    handler: async (args: any) => {
      try {
        const query = String(args.query || '').trim()
        if (!query || query.length < 1) {
          return { success: true, output: '请输入查询内容。' }
        }

        const topK = Math.min(Math.max(args.top_k || 5, 1), 20)
        const useSemantic = Boolean(args.use_semantic)
        const useHybrid = Boolean(args.use_hybrid)

        const results = await kmsService.search(query, {
          topK,
          useSemantic: useSemantic || useHybrid,
          fileExtensions: args.file_extensions,
        })

        if (results.length === 0) {
          let msg = `本地搜索无结果："${query}"。`
          if (!useSemantic && !useHybrid) {
            msg += ' 建议：尝试启用语义搜索(use_semantic:true)或混合搜索(use_hybrid:true)'
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

        let output = `${results.length} 条结果${useHybrid ? '(混合)' : useSemantic ? '(语义)' : '(关键词)'}:\n\n`
        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const typeLabel = typeLabels[r.match_type] || r.match_type

          output += `[${i + 1}] ${typeLabel} | ${r.file_name}`
          if (r.paragraph_title) output += ` > ${r.paragraph_title}`
          output += '\n'
          output += `路径: ${r.file_path}\n`
          output += `${r.text}\n`

          const locParts: string[] = []
          if (r.file_id) locParts.push(`f:${r.file_id}`)
          if (r.paragraph_id) locParts.push(`p:${r.paragraph_id}`)
          if (r.start_line !== undefined && r.end_line !== undefined) {
            locParts.push(`L${r.start_line}-${r.end_line}`)
          }
          if (r.start_offset !== undefined && r.end_offset !== undefined) {
            locParts.push(`off:${r.start_offset}-${r.end_offset}`)
          }
          if (locParts.length > 0) {
            output += `[${locParts.join(' ')}]\n`
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

  // kms_agent_search: AI 智能检索
  const kmsAgentSearchTool: ToolDefinition = {
    id: 'kms_agent_search',
    name: 'kms_agent_search',
    title: '本地AI智能检索',
    description: '使用独立检索子智能体对本地文件进行深度检索。自动识别查询意图（定位/概念/趋势/分析），多轮检索后输出核心结论和精准溯源信息。适合需要综合分析、趋势梳理、概念解释的复杂查询。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索需求描述，可以是自然语言问题',
        },
        max_rounds: {
          type: 'number',
          description: '最大检索轮次（1-5，默认3）',
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
        if (!query || query.length < 1) {
          return { success: true, output: '请输入查询内容。' }
        }

        const maxRounds = Math.min(Math.max(args.max_rounds || 3, 1), 5)

        const result = await kmsService.agentSearch(query, { maxRounds })

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
            const locParts: string[] = []
            if (s.fileId) locParts.push(`f:${s.fileId}`)
            if (s.paragraphId) locParts.push(`p:${s.paragraphId}`)
            if (s.startLine !== undefined && s.endLine !== undefined) {
              locParts.push(`L${s.startLine}-${s.endLine}`)
            }
            if (s.startOffset !== undefined && s.endOffset !== undefined) {
              locParts.push(`off:${s.startOffset}-${s.endOffset}`)
            }
            if (locParts.length > 0) {
              output += `[${locParts.join(' ')}]\n`
            }
            output += '\n'
          }
        }

        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `AI智能检索失败: ${error.message}` }
      }
    },
    source: 'builtin',
  }

  // kms_get_content: 获取文件内容
  const kmsGetContentTool: ToolDefinition = {
    id: 'kms_get_content',
    name: 'kms_get_content',
    title: '获取本地文件内容',
    description: '获取本地索引文件的完整内容或指定片段。支持按段落ID、字符偏移、行号定位读取。需先通过 kms_search 或 kms_agent_search 获取文件ID。',
    parameters: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: '文件ID（通过 kms_search 结果中的 f: 获取）',
        },
        paragraph_id: {
          type: 'string',
          description: '段落ID（可选，指定后返回该段落内容）',
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
        const fileId = String(args.file_id || '').trim()
        if (!fileId) {
          return { success: true, output: '请提供 file_id。' }
        }

        const content = await kmsService.getFileContent(fileId, {
          paragraphId: args.paragraph_id,
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

  return [kmsSearchTool, kmsAgentSearchTool, kmsGetContentTool]
}
