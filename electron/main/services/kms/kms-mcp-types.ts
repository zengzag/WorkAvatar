/** MCP 服务配置 */
export interface KMSMCPConfig {
  enabled: boolean
  port: number
  apiKey: string
}

export const DEFAULT_CONFIG: KMSMCPConfig = {
  enabled: false,
  port: 3101,
  apiKey: '',
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

/** KMS MCP 暴露的八个工具定义 */
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
    description: 'Search local files using keyword, semantic, or hybrid mode. Supports filtering by directory, collection, file extension, and time range. Returns file paths, match snippets, and precise location (line numbers, offsets).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query, supports space-separated keywords',
        },
        top_k: {
          type: 'number',
          description: 'Number of results to return (1-50, default 10)',
          minimum: 1,
          maximum: 50,
          default: 10,
        },
        use_semantic: {
          type: 'boolean',
          description: 'Enable semantic search (requires Embedding API, default false)',
          default: false,
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
    name: 'kms_agent_search',
    description: 'Intelligent search powered by a retrieval sub-agent. Autonomously plans search paths, performs multi-round searches, identifies query type (locate/concept/trend/analysis), and distills results into clean conclusions with precise source references. Ideal for complex queries that require synthesis across multiple documents. Output is concise and does not include redundant original text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query describing what information is needed',
        },
        max_rounds: {
          type: 'number',
          description: 'Maximum search rounds (1-5, default 3)',
          minimum: 1,
          maximum: 5,
          default: 3,
        },
        top_k: {
          type: 'number',
          description: 'Results per round (3-30, default 10)',
          minimum: 3,
          maximum: 30,
          default: 10,
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
          description: 'Filter by file extensions (optional)',
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
    description: 'Get file content by file ID, with precise location by paragraph ID, character offset, or line number. Supports context expansion. The file_id must be the raw ID returned by kms_search or kms_agent_search (e.g. "8170964a"), NOT a prefixed format like "f:8170964a".',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'The raw file ID (e.g. "8170964a"), obtained from the "file_id" field in kms_search/kms_agent_search results. Do NOT include "f:" prefix.',
        },
        paragraph_id: {
          type: 'string',
          description: 'Paragraph ID for precise paragraph retrieval (optional). Raw ID without "p:" prefix.',
        },
        start_offset: {
          type: 'number',
          description: 'Start character offset (0-based, optional)',
        },
        end_offset: {
          type: 'number',
          description: 'End character offset (optional, used with start_offset)',
        },
        start_line: {
          type: 'number',
          description: 'Start line number (1-based, optional)',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return (default 5000)',
          default: 5000,
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'kms_get_summary',
    description: 'Get the summary, keywords, and main topics of a file (available for hot data files). The file_id must be the raw ID returned by kms_search or kms_agent_search, NOT a prefixed format like "f:8170964a".',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'The raw file ID (e.g. "8170964a"), obtained from the "file_id" field in kms_search/kms_agent_search results. Do NOT include "f:" prefix.',
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'kms_list_collections',
    description: 'List all manual file collections (curated groups of files, e.g. "Product Spec", "HR Policies"). Each collection has an ID, name, description, and file count. Use collection IDs to filter kms_search and kms_agent_search.',
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
  {
    name: 'kms_get_toc',
    description: 'Get the table of contents (TOC) of a file - the hierarchical structure of its paragraphs/headings. Useful for understanding document structure before reading specific sections. The file_id must be the raw ID without "f:" prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'The raw file ID (e.g. "8170964a"). Do NOT include "f:" prefix.',
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'kms_get_paragraphs',
    description: 'Get all paragraphs of a file with their titles, hierarchy, and offsets. Useful for browsing document structure and locating specific sections. The file_id must be the raw ID without "f:" prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'The raw file ID (e.g. "8170964a"). Do NOT include "f:" prefix.',
        },
      },
      required: ['file_id'],
    },
  },
]
