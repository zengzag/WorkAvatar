import KMSService from '../../kms/kms.service'
import type { ToolDefinition } from './types'
import type { SearchScopeRef } from './kms-search.tool'

export function createKMSCollectionTools(scopeRef: SearchScopeRef): ToolDefinition[] {
  const kmsService = KMSService.getInstance()

  function isAccessible(collectionId: string): boolean {
    const ref = scopeRef.current.collectionIds || []
    if (ref.length === 0) return true
    return ref.includes(collectionId)
  }

  function safeParseJsonArray(raw: any): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }

  const kmsListCollectionsTool: ToolDefinition = {
    id: 'kms_list_collections',
    name: 'kms_list_collections',
    title: '资料库合集列表',
    description: '列出当前可访问的资料库合集（手动组织的文件分组）。每个合集包含若干文档，可用于了解可用资料范围。若会话已选定合集则只显示选定的，否则显示全部。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const allCollections = kmsService.listCollections()
        const ref = scopeRef.current.collectionIds || []
        const visible = ref.length > 0
          ? allCollections.filter((c: any) => ref.includes(c.id))
          : allCollections

        if (visible.length === 0) {
          return { success: true, output: '当前会话未选择任何合集，且系统中暂无合集。' }
        }

        // 批量查询所有可见合集的摘要，避免 N+1
        const summaryMap = kmsService.getCollectionSummariesByIds(visible.map((c: any) => c.id))

        let output = `${visible.length}个合集:\n`
        for (let i = 0; i < visible.length; i++) {
          const c = visible[i]
          output += `${i + 1}. ${c.name} [${c.id}] ${c.file_count || 0}篇`
          const summary = summaryMap.get(c.id)
          if (summary) {
            const keyTopics = safeParseJsonArray(summary.key_topics_json)
            if (keyTopics.length > 0) {
              output += ` | ${keyTopics.join('、')}`
            }
          }
          if (c.description) {
            output += `\n   ${c.description}`
          }
          output += '\n'
        }

        if (ref.length > 0) {
          output += `\n当前会话已选定 ${ref.length} 个合集，检索默认限定在此范围内。`
        } else {
          output += '\n当前会话未选定合集，检索将覆盖全部资料库（含索引目录与所有合集）。'
        }

        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `合集列表获取失败: ${error.message}` }
      }
    },
    source: 'builtin',
  }

  const kmsCollectionOverviewTool: ToolDefinition = {
    id: 'kms_collection_overview',
    name: 'kms_collection_overview',
    title: '合集概览',
    description: '查看合集的全局摘要、核心主题和文件清单（含每篇文件的摘要与主题），帮助确定要深入的目标文档。请先使用 kms_list_collections 获取可用的合集ID。',
    parameters: {
      type: 'object',
      properties: {
        collection_id: {
          type: 'string',
          description: '合集ID（必需）。请先使用 kms_list_collections 查看',
        },
      },
      required: ['collection_id'],
    },
    handler: async (args: any) => {
      try {
        const collectionId = String(args.collection_id || '').trim()
        if (!collectionId) {
          return { success: true, output: '请提供 collection_id。' }
        }
        if (!isAccessible(collectionId)) {
          return { success: true, output: '该合集不在当前会话可访问范围内。' }
        }

        const collection = kmsService.getCollection(collectionId)
        if (!collection) {
          return { success: true, output: '合集不存在。' }
        }

        let output = collection.name
        if (collection.description) {
          output += ` - ${collection.description}`
        }
        output += '\n'

        const summary = kmsService.getCollectionSummary(collectionId)
        if (summary) {
          output += `摘要: ${summary.summary}\n`
          const keyTopics = safeParseJsonArray(summary.key_topics_json)
          if (keyTopics.length > 0) {
            output += `主题: ${keyTopics.join('、')}\n`
          }
        }

        const files = kmsService.listFilesInCollection(collectionId) as any[]
        const completedFiles = files.filter((f: any) => f.index_status === 'completed')

        if (completedFiles.length === 0) {
          output += '暂无已索引文件。'
          return { success: true, output }
        }

        output += `\n${completedFiles.length}篇文件:\n`
        for (const f of completedFiles) {
          output += `- ${f.file_name} [${f.id}]`
          if (f.summary) {
            output += ` ${f.summary}`
          }
          const topics = safeParseJsonArray(f.main_topics_json)
          if (topics.length > 0) {
            output += ` | ${topics.join('、')}`
          }
          output += '\n'
        }

        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `合集概览获取失败: ${error.message}` }
      }
    },
    source: 'builtin',
  }

  const kmsGetTocTool: ToolDefinition = {
    id: 'kms_get_toc',
    name: 'kms_get_toc',
    title: '获取文件目录',
    description: '获取文件的层级目录结构（TOC），包含每个章节的 paragraph_id、标题路径和内容偏移范围。file_id 来自 kms_search 结果，不要带 "f:" 前缀。',
    parameters: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: '文件ID（必需）。来自 kms_search 结果中的 "file_id" 字段，不要带 "f:" 前缀',
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
        const prefixMatch = fileId.match(/^[a-z]+:(.+)$/i)
        if (prefixMatch) {
          fileId = prefixMatch[1].trim()
        }

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
      } catch (error: any) {
        return { success: false, error: `获取文件目录失败: ${error.message}` }
      }
    },
    source: 'builtin',
  }

  const kmsGetParagraphsTool: ToolDefinition = {
    id: 'kms_get_paragraphs',
    name: 'kms_get_paragraphs',
    title: '获取段落摘要',
    description: '批量获取多个段落的详细摘要和元信息（标题路径、内容偏移范围），用于在了解目录结构后深入查看感兴趣章节。paragraph_ids 来自 kms_get_toc 或 kms_search 结果。',
    parameters: {
      type: 'object',
      properties: {
        paragraph_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '段落ID数组（必需）。来自 kms_get_toc 或 kms_search 结果，不要带 "p:" 前缀',
        },
      },
      required: ['paragraph_ids'],
    },
    handler: async (args: any) => {
      try {
        const rawIds: any[] = Array.isArray(args.paragraph_ids) ? args.paragraph_ids : []
        if (rawIds.length === 0) {
          return { success: true, output: '请提供至少一个段落ID。' }
        }

        const ids: string[] = rawIds.map((id: any) => {
          const s = String(id || '').trim()
          const m = s.match(/^[a-z]+:(.+)$/i)
          return m ? m[1].trim() : s
        })

        const paragraphs = kmsService.getParagraphsByIds(ids)

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
          const keywords = safeParseJsonArray(p.keywords_json)
          if (keywords.length > 0) {
            output += ` | 关键词: ${keywords.join('、')}`
          }
          output += `\n    file:${p.file_id} (${p.file_name || ''}) off:${p.start_offset}-${p.end_offset}\n`
        }
        return { success: true, output }
      } catch (error: any) {
        return { success: false, error: `获取段落摘要失败: ${error.message}` }
      }
    },
    source: 'builtin',
  }

  return [
    kmsListCollectionsTool,
    kmsCollectionOverviewTool,
    kmsGetTocTool,
    kmsGetParagraphsTool,
  ]
}
