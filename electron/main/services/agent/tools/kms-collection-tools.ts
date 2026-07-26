import KMSService from '../../kms/kms.service'
import type { ToolDefinition } from './types'
import type { SearchScopeRef } from './kms-search.tool'

/**
 * 合集相关工具集
 *
 * 设计原则：让智能体能使用的工具保持相对简单，避免太多工具混淆概念。
 * - kms_search 工具内部已自动附加搜索合集摘要，无需单独的 kms_collection_overview
 * - kms_get_content 工具已合并原 kms_get_toc / kms_get_paragraphs 的功能（通过 view 参数）
 * - 这里仅保留 kms_list_collections，用于让 LLM 了解可用合集范围
 */
export function createKMSCollectionTools(scopeRef: SearchScopeRef): ToolDefinition[] {
  const kmsService = KMSService.getInstance()

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
    summary: '列出资料库合集（手动组织的文件分组）。了解可用资料范围时使用。',
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
    onDemand: true,
  }

  return [kmsListCollectionsTool]
}
