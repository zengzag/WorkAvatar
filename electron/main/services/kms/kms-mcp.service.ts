import http from 'http'
import KMSService from './kms.service'
import KMSDatabaseService from './kms-database.service'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'

const logger = createLogger('KMS-MCP')

export interface KMSMCPConfig {
  enabled: boolean
  port: number
  apiKey: string
}

const DEFAULT_CONFIG: KMSMCPConfig = {
  enabled: false,
  port: 3101,
  apiKey: '',
}

interface MCPTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, any>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: any
  error?: {
    code: number
    message: string
    data?: any
  }
}

const MCP_TOOLS: MCPTool[] = [
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

/**
 * KMS MCP 服务
 * 将本地搜索引擎能力暴露为 MCP 工具，供第三方智能体（Claude Code、Cursor 等）调用
 *
 * 工具列表（11 个）：
 * - kms_list_dirs: 列出索引目录
 * - kms_stats: 获取统计信息（含合集数）
 * - kms_search: 普通检索（关键词/语义/混合，支持目录/合集过滤）
 * - kms_agent_search: 智能检索（子智能体自主规划+提纯，支持目录/合集过滤）
 * - kms_get_content: 获取文件内容（精确定位）
 * - kms_get_summary: 获取文件摘要
 * - kms_list_collections: 列出所有合集
 * - kms_list_files_in_collection: 列出合集内文件
 * - kms_get_collection_summary: 获取合集摘要与关键主题
 * - kms_get_toc: 获取文件目录结构（TOC）
 * - kms_get_paragraphs: 获取文件段落列表
 */
class KMSMCPService {
  private server: http.Server | null = null
  private config: KMSMCPConfig = { ...DEFAULT_CONFIG }
  private sessions: Map<string, { initialized: boolean; createdAt: number; lastActivityAt: number }> = new Map()
  /** 会话清理定时器：定期移除长时间未活动的 session，避免内存泄漏 */
  private sessionCleanupTimer: NodeJS.Timeout | null = null
  /** 会话过期阈值：1 小时无活动则清理 */
  private static readonly SESSION_IDLE_TTL_MS = 60 * 60 * 1000
  /** 清理检查间隔：30 分钟 */
  private static readonly SESSION_CLEANUP_INTERVAL_MS = 30 * 60 * 1000
  private static instance: KMSMCPService

  private constructor() {}

  static getInstance(): KMSMCPService {
    if (!KMSMCPService.instance) {
      KMSMCPService.instance = new KMSMCPService()
    }
    return KMSMCPService.instance
  }

  getConfig(): KMSMCPConfig {
    return { ...this.config }
  }

  updateConfig(config: Partial<KMSMCPConfig>): void {
    this.config = { ...this.config, ...config }
  }

  getStatus(): { running: boolean; port: number; url: string } {
    const running = this.server !== null
    return {
      running,
      port: this.config.port,
      url: running ? `http://localhost:${this.config.port}/mcp` : '',
    }
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    if (this.server) {
      return { success: true }
    }

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res)
      })

      this.server.on('error', (err: any) => {
        this.server = null
        if (err.code === 'EADDRINUSE') {
          resolve({ success: false, error: `Port ${this.config.port} is already in use` })
        } else {
          resolve({ success: false, error: err.message })
        }
      })

      this.server.listen(this.config.port, '127.0.0.1', () => {
        logger.info(`KMS MCP server started on port ${this.config.port}`)
        // 启动会话清理定时器，定期移除长时间未活动的 session
        this.sessionCleanupTimer = setInterval(
          () => this.cleanupExpiredSessions(),
          KMSMCPService.SESSION_CLEANUP_INTERVAL_MS
        )
        // 防止定时器阻止进程退出
        this.sessionCleanupTimer.unref?.()
        resolve({ success: true })
      })
    })
  }

  async stop(): Promise<{ success: boolean }> {
    if (!this.server) {
      return { success: true }
    }

    return new Promise((resolve) => {
      if (!this.server) {
        resolve({ success: true })
        return
      }

      // 停止会话清理定时器
      if (this.sessionCleanupTimer) {
        clearInterval(this.sessionCleanupTimer)
        this.sessionCleanupTimer = null
      }
      this.sessions.clear()
      this.server.close(() => {
        this.server = null
        logger.info('KMS MCP server stopped')
        resolve({ success: true })
      })
    })
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method === 'OPTIONS') {
      this.setCORSHeaders(res)
      res.writeHead(204)
      res.end()
      return
    }

    this.setCORSHeaders(res)

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } }))
      return
    }

    if (req.url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Not found. Use POST /mcp' } }))
      return
    }

    if (this.config.apiKey) {
      const authHeader = req.headers['authorization'] || ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
      if (token !== this.config.apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: invalid API key' } }))
        return
      }
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined

    let body = ''
    for await (const chunk of req) {
      body += chunk
    }

    let message: JsonRpcRequest
    try {
      message = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }

    const response = await this.handleMessage(message, sessionId)
    const newSessionId = sessionId || this.getOrCreateSessionId(message)
    // 更新当前 session 的最后活动时间（用于过期清理）
    this.touchSession(sessionId ?? newSessionId ?? undefined)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (newSessionId) {
      headers['Mcp-Session-Id'] = newSessionId
    }

    res.writeHead(200, headers)
    res.end(JSON.stringify(response))
  }

  private getOrCreateSessionId(message: JsonRpcRequest): string | null {
    if (message.method === 'initialize') {
      const sessionId = generateId()
      const now = Date.now()
      this.sessions.set(sessionId, { initialized: false, createdAt: now, lastActivityAt: now })
      return sessionId
    }
    return null
  }

  /** 更新 session 的最后活动时间（每次收到请求时调用） */
  private touchSession(sessionId: string | undefined): void {
    if (!sessionId) return
    const session = this.sessions.get(sessionId)
    if (session) {
      session.lastActivityAt = Date.now()
    }
  }

  /** 清理过期 session：移除超过 SESSION_IDLE_TTL_MS 未活动的条目 */
  private cleanupExpiredSessions(): void {
    if (this.sessions.size === 0) return
    const now = Date.now()
    let removed = 0
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > KMSMCPService.SESSION_IDLE_TTL_MS) {
        this.sessions.delete(id)
        removed++
      }
    }
    if (removed > 0) {
      logger.info(`MCP: cleaned up ${removed} expired session(s)`)
    }
  }

  private async handleMessage(message: JsonRpcRequest, sessionId?: string): Promise<JsonRpcResponse> {
    const { id, method, params } = message

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'WorkAvatar KMS MCP Server',
            version: '1.0.0',
          },
        },
      }
    }

    if (method === 'notifications/initialized') {
      if (sessionId && this.sessions.has(sessionId)) {
        const session = this.sessions.get(sessionId)!
        session.initialized = true
      }
      return { jsonrpc: '2.0', id: id ?? null, result: {} }
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id: id ?? null, result: {} }
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          tools: MCP_TOOLS,
        },
      }
    }

    if (method === 'tools/call') {
      return await this.handleToolCall(id ?? null, params)
    }

    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32601, message: `Method not found: ${method}` },
    }
  }

  private async handleToolCall(id: string | number | null, params?: Record<string, any>): Promise<JsonRpcResponse> {
    if (!params || !params.name) {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32602, message: 'Missing tool name' },
      }
    }

    const toolName = params.name
    const toolArgs = params.arguments || {}

    try {
      const result = await this.executeTool(toolName, toolArgs)
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: result,
            },
          ],
        },
      }
    } catch (error: any) {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        },
      }
    }
  }

  /**
   * 工具处理字典：将工具名映射到对应的处理函数
   * - 使用箭头函数形式，自动绑定 this 上下文，便于访问 getFileCountByDir/getFileById/stripIdPrefix 等私有方法
   * - 每个处理函数接收 (args, kmsService) 参数，返回 Promise<string>
   */
  private toolHandlers: Record<string, (args: Record<string, any>, kmsService: KMSService) => Promise<string>> = {
    'kms_list_dirs': async (_args, kmsService) => {
      const dirs = kmsService.listIndexDirs() as any[]
      if (dirs.length === 0) {
        return 'No index directories configured.'
      }

      let output = `${dirs.length} index directory(ies):\n`
      for (let i = 0; i < dirs.length; i++) {
        const dir = dirs[i]
        const fileCount = this.getFileCountByDir(dir.id)
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
        timeRangeStart: args.time_range_start ? Math.floor(args.time_range_start / 1000) : undefined,
        timeRangeEnd: args.time_range_end ? Math.floor(args.time_range_end / 1000) : undefined,
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
      // 防御性剥离前缀（AI 可能误传 f:xxx 格式）
      fileId = this.stripIdPrefix(fileId)

      const content = await kmsService.getFileContent(fileId, {
        paragraphId: this.stripIdPrefix(String(args.paragraph_id || '')) || undefined,
        startOffset: args.start_offset,
        endOffset: args.end_offset,
        startLine: args.start_line,
        maxChars: args.max_chars || 5000,
      })

      const file = this.getFileById(fileId)
      if (!file) {
        return 'File not found.'
      }

      let output = `${file.file_name}\n`
      output += `file_id: ${fileId}\n`
      if (args.paragraph_id) output += `paragraph_id: ${this.stripIdPrefix(String(args.paragraph_id))}\n`
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
      // 防御性剥离前缀（AI 可能误传 f:xxx 格式）
      fileId = this.stripIdPrefix(fileId)

      const summary = kmsService.getFileSummary(fileId) as any
      if (!summary) {
        return 'No summary available. Summary is only generated for hot data files.'
      }

      let output = `File Summary:\n`
      output += `${summary.summary || '(empty)'}\n`
      try {
        const keywords = JSON.parse(summary.keywords_json || '[]')
        if (keywords.length > 0) {
          output += `\nKeywords: ${keywords.join(', ')}\n`
        }
        const topics = JSON.parse(summary.main_topics_json || '[]')
        if (topics.length > 0) {
          output += `Main Topics: ${topics.join(', ')}\n`
        }
      } catch {}

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
      try {
        const topics = JSON.parse(summary.key_topics_json || '[]')
        if (topics.length > 0) {
          output += `\nKey Topics: ${topics.join(', ')}\n`
        }
      } catch {}
      return output
    },

    'kms_get_toc': async (args, kmsService) => {
      let fileId = String(args.file_id || '').trim()
      if (!fileId) {
        return 'Please provide file_id.'
      }
      fileId = this.stripIdPrefix(fileId)

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
      fileId = this.stripIdPrefix(fileId)

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
        try {
          const keywords = JSON.parse(p.keywords_json || '[]')
          if (Array.isArray(keywords) && keywords.length > 0) {
            output += `  keywords: ${keywords.join(', ')}\n`
          }
        } catch {}
        output += '\n'
      }
      return output
    },
  }

  private async executeTool(name: string, args: Record<string, any>): Promise<string> {
    const kmsService = KMSService.getInstance()
    const handler = this.toolHandlers[name]
    if (!handler) {
      return `Unknown tool: ${name}`
    }
    return handler(args, kmsService)
  }

  private getFileCountByDir(dirId: string): number {
    const db = KMSDatabaseService.getInstance().getDb()
    const row = db.prepare('SELECT COUNT(*) as count FROM kms_files WHERE dir_id = ?').get(dirId) as any
    return row?.count || 0
  }

  private getFileById(fileId: string): any {
    const db = KMSDatabaseService.getInstance().getDb()
    return db.prepare('SELECT file_name, file_path FROM kms_files WHERE id = ?').get(fileId)
  }

  /**
   * 防御性剥离 ID 前缀
   * AI 可能误传 f:xxx / p:xxx 等带前缀格式（来源于旧版输出格式的歧义）
   */
  private stripIdPrefix(id: string): string {
    const trimmed = id.trim()
    // 匹配 f: / p: / off: 等单字母前缀 + 冒号
    const match = trimmed.match(/^[a-z]+:(.+)$/i)
    if (match) {
      return match[1].trim()
    }
    return trimmed
  }

  private setCORSHeaders(res: http.ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id')
  }
}

export default KMSMCPService
