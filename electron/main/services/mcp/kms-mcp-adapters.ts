/**
 * KMS 独有的工具 → ToolDefinition 适配器。
 *
 * 这些工具在 Agent 内部不单独暴露（kms_search 已自动附加知识卡片、合集摘要；
 * kms_get_content 已合并 TOC/段落视图），但作为 MCP 对外暴露时，
 * 第三方 Agent/客户端需要单独调用它们来浏览 KMS 结构，因此需要补一层适配器。
 *
 * 实现复用 kms-mcp-tool-handlers.ts 中已有的 executeTool(name, args)，
 * 不重写业务逻辑，减少代码重复。
 */

import type { ToolDefinition } from '../agent/tools/types'
import { executeTool } from '../kms/kms-mcp-tool-handlers'

function wrapKmsHandler(toolName: string): ToolDefinition['handler'] {
  return async (args: Record<string, any>) => {
    return executeTool(toolName, args || {})
  }
}

const kmsListDirsTool: ToolDefinition = {
  id: 'kms_list_dirs',
  name: 'kms_list_dirs',
  title: '资料库索引目录列表',
  summary: '列出本地搜索引擎所有已索引目录及文件数。',
  description: 'List all indexed directories in the local search engine with file counts.',
  parameters: { type: 'object', properties: {} },
  handler: wrapKmsHandler('kms_list_dirs'),
  source: 'builtin',
  onDemand: true,
}

const kmsStatsTool: ToolDefinition = {
  id: 'kms_stats',
  name: 'kms_stats',
  title: '资料库统计',
  summary: '获取本地搜索引擎的整体统计：索引文件数、条目数、向量数、冷热分布。',
  description: 'Get overall statistics of the local search engine: indexed files, index entries, embeddings, hot/cold data distribution.',
  parameters: { type: 'object', properties: {} },
  handler: wrapKmsHandler('kms_stats'),
  source: 'builtin',
  onDemand: true,
}

const kmsGetSummaryTool: ToolDefinition = {
  id: 'kms_get_summary',
  name: 'kms_get_summary',
  title: '文件摘要',
  summary: '获取文件的摘要、关键词与主题（仅热数据文件可用）。',
  description: 'Get the summary, keywords, and main topics of a file (available for hot data files). The file_id must be the raw ID returned by kms_search.',
  parameters: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        description: 'The raw file ID (e.g. "8170964a"), obtained from kms_search results.',
      },
    },
    required: ['file_id'],
  },
  handler: wrapKmsHandler('kms_get_summary'),
  source: 'builtin',
  onDemand: true,
}

const kmsListFilesInCollectionTool: ToolDefinition = {
  id: 'kms_list_files_in_collection',
  name: 'kms_list_files_in_collection',
  title: '合集内文件列表',
  summary: '列出指定合集中的所有文件及其索引状态、摘要信息。',
  description: 'List all files within a specific collection, including file name, path, extension, size, index status, and per-file summary.',
  parameters: {
    type: 'object',
    properties: {
      collection_id: {
        type: 'string',
        description: 'Collection ID (obtain from kms_list_collections)',
      },
    },
    required: ['collection_id'],
  },
  handler: wrapKmsHandler('kms_list_files_in_collection'),
  source: 'builtin',
  onDemand: true,
}

const kmsGetCollectionSummaryTool: ToolDefinition = {
  id: 'kms_get_collection_summary',
  name: 'kms_get_collection_summary',
  title: '合集摘要',
  summary: '获取合集的高层摘要与关键主题，用于搜索前了解合集覆盖范围。',
  description: 'Get the high-level summary and key topics of a collection (if generated). Useful for understanding what a collection covers before searching within it.',
  parameters: {
    type: 'object',
    properties: {
      collection_id: {
        type: 'string',
        description: 'Collection ID (obtain from kms_list_collections)',
      },
    },
    required: ['collection_id'],
  },
  handler: wrapKmsHandler('kms_get_collection_summary'),
  source: 'builtin',
  onDemand: true,
}

const kmsKnowledgeCardTool: ToolDefinition = {
  id: 'kms_knowledge_card',
  name: 'kms_knowledge_card',
  title: '搜索知识卡片',
  summary: '根据关键词搜索已沉淀的知识卡片（高频主题摘要 + 关键要点 + 溯源）。',
  description: 'Search curated knowledge cards for a keyword. Each card contains a summary of a frequently searched topic, key points, and citations to source files. Useful for quickly retrieving already-concluded topic conclusions without re-searching raw documents.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (topic keyword or question)',
      },
      top_k: {
        type: 'number',
        description: 'Number of cards to return (1-5, default 2)',
        minimum: 1,
        maximum: 5,
        default: 2,
      },
    },
    required: ['query'],
  },
  handler: async (args: Record<string, any>) => {
    // 复用 kms-search.tool.ts 中已有的 appendKnowledgeCards 逻辑
    const query = String(args.query || '').trim()
    if (!query) return 'Please provide a query.'
    // 从 kms service 直接获取知识卡片
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const KMSService = require('../kms/kms.service').default
    const kmsService = KMSService.getInstance()
    const topK = Math.min(Math.max(args.top_k || 2, 1), 5)
    const cards = await kmsService.searchKnowledgeCards(query, topK) as any[]
    if (cards.length === 0) return `No knowledge cards for "${query}".`
    let output = `${cards.length} knowledge card(s):\n\n`
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i]
      output += `[${i + 1}] ${c.displayKeyword} (searched ${c.searchCount} times, ${c.status === 'stale' ? 'needs refresh' : 'active'})\n`
      output += `${c.summary}\n`
      if (c.keyPoints && c.keyPoints.length > 0) {
        output += 'Key points:\n'
        for (const kp of c.keyPoints) {
          const citation = c.citations?.[kp.sourceIndex]
          const source = citation ? ` (source: ${citation.fileName})` : ''
          output += `- ${kp.point}${source}\n`
        }
      }
      output += '\n'
    }
    return output
  },
  source: 'builtin',
  onDemand: true,
}

const kmsCollectionOverviewTool: ToolDefinition = {
  id: 'kms_collection_overview',
  name: 'kms_collection_overview',
  title: '相关合集摘要搜索',
  summary: '根据关键词搜索相关的合集摘要，快速了解可用合集覆盖的主题范围。',
  description: 'Search collection summaries for a query, returning high-level overviews of related collections so you can understand which collections are relevant before searching within them.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (topic keyword)',
      },
      top_k: {
        type: 'number',
        description: 'Number of collections to return (1-5, default 2)',
        minimum: 1,
        maximum: 5,
        default: 2,
      },
    },
    required: ['query'],
  },
  handler: async (args: Record<string, any>) => {
    const query = String(args.query || '').trim()
    if (!query) return 'Please provide a query.'
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const KMSService = require('../kms/kms.service').default
    const kmsService = KMSService.getInstance()
    const topK = Math.min(Math.max(args.top_k || 2, 1), 5)
    const hits = kmsService.searchCollectionSummaries(query, topK) as any[]
    if (hits.length === 0) return `No related collections for "${query}".`
    let output = `${hits.length} related collection(s):\n\n`
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i]
      output += `[${i + 1}] ${h.collectionName} [${h.collectionId}] ${h.fileCount} files`
      if (h.keyTopics?.length > 0) output += ` | ${h.keyTopics.join(', ')}`
      output += '\n'
      output += `${h.summary}\n\n`
    }
    return output
  },
  source: 'builtin',
  onDemand: true,
}

const kmsGetTocTool: ToolDefinition = {
  id: 'kms_get_toc',
  name: 'kms_get_toc',
  title: '文件目录结构',
  summary: '获取文件的层级目录结构（TOC），用于快速了解文件大纲（仅热数据文件可用）。可通过 kms_get_content 的 view=toc 参数等价获得。',
  description: 'Get the hierarchical table of contents of a file with paragraph IDs. Only available for hot-indexed files. Equivalent to kms_get_content with view=toc.',
  parameters: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        description: 'Raw file ID from kms_search',
      },
    },
    required: ['file_id'],
  },
  handler: wrapKmsHandler('kms_get_content'),
  source: 'builtin',
  onDemand: true,
}

const kmsGetParagraphsTool: ToolDefinition = {
  id: 'kms_get_paragraphs',
  name: 'kms_get_paragraphs',
  title: '文件段落摘要列表',
  summary: '获取文件所有段落的摘要列表，用于快速了解文件分节（仅热数据可用）。可通过 kms_get_content 的 view=paragraphs 参数等价获得。',
  description: 'Get all paragraph summaries of a file (with paragraph IDs). Only available for hot-indexed files. Equivalent to kms_get_content with view=paragraphs.',
  parameters: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        description: 'Raw file ID from kms_search',
      },
    },
    required: ['file_id'],
  },
  // 转发到 kms_get_content(view=paragraphs)
  handler: async (args: Record<string, any>) => {
    return executeTool('kms_get_content', { ...(args || {}), view: 'paragraphs' })
  },
  source: 'builtin',
  onDemand: true,
}

export const kmsAdapterTools: ToolDefinition[] = [
  kmsListDirsTool,
  kmsStatsTool,
  kmsGetSummaryTool,
  kmsListFilesInCollectionTool,
  kmsGetCollectionSummaryTool,
  kmsKnowledgeCardTool,
  kmsCollectionOverviewTool,
  kmsGetTocTool,
  kmsGetParagraphsTool,
]

/**
 * 不在 MCP 对外暴露的工具清单：按用户要求移除文件管理、Office 自动化、命令行执行、向用户询问 4 大类。
 * 注意：Agent 内部仍可使用这些工具；这里仅阻止它们被 buildAllBuiltinToolDefinitions()
 * 聚合到对外 MCP 工具清单中，避免通过 MCP 通道泄露能力。
 */
const EXCLUDED_MCP_TOOL_IDS = new Set<string>([
  // files（文件管理）
  'file_read', 'file_write', 'file_edit',
  'file_mkdir', 'file_list', 'file_search',
  'file_delete', 'file_move', 'file_copy',
  'file_rename', 'file_stat',
  // office（Office 自动化）
  'office_exec',
  // shell（命令行执行）
  'shell_exec',
  // ask_user（向用户询问）
  'ask_user',
])

function isToolIncluded(t: ToolDefinition): boolean {
  const key1 = (t.id || '').trim()
  const key2 = (t.name || '').trim()
  if (key1 && EXCLUDED_MCP_TOOL_IDS.has(key1)) return false
  if (key2 && EXCLUDED_MCP_TOOL_IDS.has(key2)) return false
  return true
}

/**
 * 构造完整的对外 MCP 工具集合：
 * 1. 来自 Agent 的 allBuiltinTools（含日历/自动化/通用/网络/对话等，已过滤 files/shell/ask_user/office）
 * 2. KMS 主工具（createKMSTools + createKMSCollectionTools，不带 scope 过滤）
 * 3. 对话工具 search_conversations/list_conversations/get_conversation_detail（需 employeeId，对外场景下为 undefined，仅返回空）
 * 4. KMS 适配器（补充对外浏览结构的小工具）
 *
 * 最后按 resolveEnabledToolIds(tool_categories) 过滤。
 *
 * 注意：该函数是"提供全部可选工具清单"，不做类别过滤；过滤由调用方（MCP server 的 tools/list & tools/call）完成。
 */
export function buildAllBuiltinToolDefinitions(): ToolDefinition[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const agentTools = require('../agent/tools')
  const result: ToolDefinition[] = []

  // 1. 常驻 + 按需的通用内置工具（allBuiltinTools）→ 过滤掉 files/office/shell/ask_user
  for (const t of (agentTools.allBuiltinTools || []) as ToolDefinition[]) {
    if (isToolIncluded(t)) result.push(t)
  }

  // 2. KMS 主工具（scope 为空集合，即不过滤合集，等同于"全部"）
  const emptyScope = { current: { collectionIds: [] as string[] } }
  const kmsSearchTools = (agentTools.createKMSTools || (() => []))(emptyScope) as ToolDefinition[]
  for (const t of kmsSearchTools) result.push(t)
  const kmsCollTools = (agentTools.createKMSCollectionTools || (() => []))(emptyScope) as ToolDefinition[]
  for (const t of kmsCollTools) result.push(t)

  // 3. 对话记忆工具（对外场景下无 employeeId，仅空实现兜底，类别关闭时不会出现）
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const convSearch = require('../agent/tools/conversation-search.tool')
    const convList = require('../agent/tools/conversation-list.tool')
    const dummyEmpId = ''
    const searchTools = (convSearch.createConversationSearchTool || (() => []))(dummyEmpId) as ToolDefinition[]
    const listTools = (convList.createConversationListTool || (() => []))(dummyEmpId) as ToolDefinition[]
    for (const t of [...searchTools, ...listTools]) {
      if (isToolIncluded(t)) result.push(t)
    }
  } catch {
    // ignore
  }

  // 4. KMS 适配器
  for (const t of kmsAdapterTools) {
    if (isToolIncluded(t)) result.push(t)
  }

  return result
}
