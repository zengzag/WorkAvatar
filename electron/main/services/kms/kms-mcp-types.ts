import type { BuiltinToolCategoryId } from '../mcp/builtin-mcp-converter'

/**
 * MCP 服务配置（原 KMS 专用，现扩展为通用内置工具 MCP）。
 * 向后兼容：未设置 tool_categories 时默认仅暴露 KMS 工具，保持与旧版一致的行为。
 */
export interface KMSMCPConfig {
  enabled: boolean
  port: number
  apiKey: string
  /** 开启的内置工具类别 id 列表；未设置时回退为默认（仅 KMS，保持向后兼容）。 */
  tool_categories?: BuiltinToolCategoryId[]
}

export const DEFAULT_CONFIG: KMSMCPConfig = {
  enabled: false,
  port: 3101,
  apiKey: '',
  // 向后兼容默认：仅 KMS MCP 升级后若用户未修改过，默认开启 kms 类别，其他类别手动开启
  tool_categories: ['kms'],
}

/** MCP 工具定义 */
export interface MCPTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

/** JSON-RPC 请求 */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, any>
}

/** JSON-RPC 响应 */
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: any
  error?: {
    code: number
    message: string
    data?: any
  }
}

/**
 * KMS MCP 暴露的工具定义
 *
 * 设计原则：与 Agent 工具（kms-search.tool.ts / kms-collection-tools.ts）保持参数语义统一，
 * 避免维护两套不同的工具抽象。
 *
 * 已合并删除的工具：
 * - kms_agent_search → 合并到 kms_search 的 mode=deep
 * - kms_get_toc / kms_get_paragraphs → 合并到 kms_get_content 的 view 参数
 * - kms_knowledge_card → kms_search 内部已自动附加搜索知识卡片
 *
 * 保留的合集相关工具（kms_list_collections / kms_list_files_in_collection /
 * kms_get_collection_summary）是外部 MCP 客户端浏览合集结构所需，无法被 kms_search 替代。
 */
export const MCP_TOOLS: MCPTool[] = [
  {
    name: 'kms_list_dirs',
    description: 'List all indexed directories in the local search engine with file counts.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'kms_stats',
    description: 'Get overall statistics of the local search engine: indexed files, index entries, embeddings, hot/cold data distribution.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'kms_search',
    description: 'Search local files using keyword or hybrid mode. Supports filtering by directory, collection, file extension, and time range. Returns file paths, match snippets, and precise location (line numbers, offsets). Results automatically append matching knowledge cards (curated topic summaries) and collection summaries. For complex analytical queries, use mode="deep" to invoke the retrieval sub-agent.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query, supports space-separated keywords or natural language questions',
        },
        mode: {
          type: 'string',
          enum: ['simple', 'deep', 'auto'],
          description: 'Search mode: simple single-pass search (fast) / deep sub-agent multi-round search (for complex analysis) / auto system-decided (default)',
          default: 'auto',
        },
        search_mode: {
          type: 'string',
          enum: ['keyword', 'hybrid'],
          description: 'Retrieval method in simple mode: keyword (default) / hybrid (keyword + vector semantic, recommended for conceptual queries)',
          default: 'keyword',
        },
        top_k: {
          type: 'number',
          description: 'Number of results to return in simple mode (1-20, default 5)',
          minimum: 1,
          maximum: 20,
          default: 5,
        },
        max_rounds: {
          type: 'number',
          description: 'Maximum search rounds in deep mode (1-5, default 3)',
          minimum: 1,
          maximum: 5,
          default: 3,
        },
        dir_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit search to specific directory IDs (optional)',
        },
        collection_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit search to files within specified collections (optional). Use kms_list_collections to get available collection IDs.',
        },
        file_extensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by file extensions, e.g. ["pdf", "docx"] (optional)',
        },
        time_range_start: {
          type: 'number',
          description: 'File modification time range start (milliseconds timestamp, optional)',
        },
        time_range_end: {
          type: 'number',
          description: 'File modification time range end (milliseconds timestamp, optional)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'kms_get_content',
    description: 'Get file content by file ID. Use the "view" parameter to switch between views: content (default, file body with precise location by paragraph ID, character offset, or line number), toc (hierarchical table of contents with paragraph IDs), paragraphs (all paragraph summaries of the file). The file_id must be the raw ID returned by kms_search (e.g. "8170964a"), NOT a prefixed format like "f:8170964a".',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'The raw file ID (e.g. "8170964a"), obtained from the "file_id" field in kms_search results. Do NOT include "f:" prefix.',
        },
        view: {
          type: 'string',
          enum: ['content', 'toc', 'paragraphs'],
          description: 'View mode: content file body (default) / toc table of contents / paragraphs all paragraph summaries',
          default: 'content',
        },
        paragraph_id: {
          type: 'string',
          description: 'Paragraph ID for precise paragraph retrieval (view=content, optional). Raw ID without "p:" prefix.',
        },
        paragraph_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of paragraph IDs to fetch summaries in batch (view=content, optional). Raw IDs without "p:" prefix.',
        },
        start_offset: {
          type: 'number',
          description: 'Start character offset (view=content, 0-based, optional)',
        },
        end_offset: {
          type: 'number',
          description: 'End character offset (view=content, optional, used with start_offset)',
        },
        start_line: {
          type: 'number',
          description: 'Start line number (view=content, 1-based, optional)',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return (view=content, default 5000, max 50000)',
          default: 5000,
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'kms_get_summary',
    description: 'Get the summary, keywords, and main topics of a file (available for hot data files). The file_id must be the raw ID returned by kms_search, NOT a prefixed format like "f:8170964a".',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'The raw file ID (e.g. "8170964a"), obtained from the "file_id" field in kms_search results. Do NOT include "f:" prefix.',
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'kms_list_collections',
    description: 'List all manual file collections (curated groups of files, e.g. "Product Spec", "HR Policies"). Each collection has an ID, name, description, and file count. Use collection IDs to filter kms_search.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'kms_list_files_in_collection',
    description: 'List all files within a specific collection, including file name, path, extension, size, index status, and per-file summary.',
    inputSchema: {
      type: 'object',
      properties: {
        collection_id: {
          type: 'string',
          description: 'Collection ID (obtain from kms_list_collections)',
        },
      },
      required: ['collection_id'],
    },
  },
  {
    name: 'kms_get_collection_summary',
    description: 'Get the high-level summary and key topics of a collection (if generated). Useful for understanding what a collection covers before searching within it.',
    inputSchema: {
      type: 'object',
      properties: {
        collection_id: {
          type: 'string',
          description: 'Collection ID (obtain from kms_list_collections)',
        },
      },
      required: ['collection_id'],
    },
  },
]
