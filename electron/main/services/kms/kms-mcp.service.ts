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
    description: 'Search local files using keyword, semantic, or hybrid mode. Supports filtering by directory, file extension, and time range. Returns file paths, match snippets, and precise location (line numbers, offsets).',
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
    description: 'Get file content by file ID, with precise location by paragraph ID, character offset, or line number. Supports context expansion.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'File ID (required)',
        },
        paragraph_id: {
          type: 'string',
          description: 'Paragraph ID for precise paragraph retrieval (optional)',
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
    description: 'Get the summary, keywords, and main topics of a file (available for hot data files).',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'File ID (required)',
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
 * 工具列表：
 * - kms_list_dirs: 列出索引目录
 * - kms_stats: 获取统计信息
 * - kms_search: 普通检索（关键词/语义/混合）
 * - kms_agent_search: 智能检索（子智能体自主规划+提纯）
 * - kms_get_content: 获取文件内容（精确定位）
 * - kms_get_summary: 获取文件摘要
 */
class KMSMCPService {
  private server: http.Server | null = null
  private config: KMSMCPConfig = { ...DEFAULT_CONFIG }
  private sessions: Map<string, { initialized: boolean; createdAt: number }> = new Map()
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
      this.sessions.set(sessionId, { initialized: false, createdAt: Date.now() })
      return sessionId
    }
    return null
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

  private async executeTool(name: string, args: Record<string, any>): Promise<string> {
    const kmsService = KMSService.getInstance()

    switch (name) {
      case 'kms_list_dirs': {
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
      }

      case 'kms_stats': {
        const stats = kmsService.getStats()
        let output = 'KMS Statistics:\n'
        output += `Directories: ${stats.dirs.total} (enabled: ${stats.dirs.enabled})\n`
        output += `Files: ${stats.files.total}\n`
        output += `  Status: ${JSON.stringify(stats.files.byStatus)}\n`
        output += `  Tier: ${JSON.stringify(stats.files.byTier)}\n`
        output += `  Extensions: ${JSON.stringify(stats.files.byExt)}\n`
        output += `Index entries: ${stats.index.totalEntries}\n`
        output += `  By type: ${JSON.stringify(stats.index.byType)}\n`
        output += `Embeddings: ${stats.index.embeddingCount}\n`
        return output
      }

      case 'kms_search': {
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

          const locParts: string[] = []
          locParts.push(`f:${r.file_id}`)
          if (r.paragraph_id) locParts.push(`p:${r.paragraph_id}`)
          if (r.start_line !== undefined && r.end_line !== undefined) {
            locParts.push(`L${r.start_line}-${r.end_line}`)
          }
          if (r.start_offset !== undefined && r.end_offset !== undefined) {
            locParts.push(`off:${r.start_offset}-${r.end_offset}`)
          }
          output += `[${locParts.join(' ')}]\n`
          output += `path: ${r.file_path}\n\n`
        }

        return output
      }

      case 'kms_agent_search': {
        const query = String(args.query || '').trim()
        if (!query || query.length < 2) {
          return 'Please enter at least 2 characters for the query.'
        }

        const result = await kmsService.agentSearch(query, {
          maxRounds: args.max_rounds,
          topK: args.top_k,
          dirIds: args.dir_ids,
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
            const locParts: string[] = []
            locParts.push(`f:${s.fileId}`)
            if (s.paragraphId) locParts.push(`p:${s.paragraphId}`)
            if (s.startLine !== undefined && s.endLine !== undefined) {
              locParts.push(`L${s.startLine}-${s.endLine}`)
            }
            if (s.startOffset !== undefined && s.endOffset !== undefined) {
              locParts.push(`off:${s.startOffset}-${s.endOffset}`)
            }
            output += `[${locParts.join(' ')}]\n`
            output += `path: ${s.filePath}\n`
            if (s.snippet) output += `snippet: ${s.snippet.substring(0, 150)}...\n`
            output += '\n'
          }
        }

        return output
      }

      case 'kms_get_content': {
        const fileId = String(args.file_id || '').trim()
        if (!fileId) {
          return 'Please provide file_id.'
        }

        const content = await kmsService.getFileContent(fileId, {
          paragraphId: args.paragraph_id,
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
        const locParts: string[] = [`f:${fileId}`]
        if (args.paragraph_id) locParts.push(`p:${args.paragraph_id}`)
        if (args.start_offset !== undefined && args.end_offset !== undefined) {
          locParts.push(`off:${args.start_offset}-${args.end_offset}`)
        }
        if (args.start_line !== undefined) {
          locParts.push(`L${args.start_line}`)
        }
        output += `[${locParts.join(' ')}]\n`
        output += `path: ${file.file_path}\n\n`
        output += content
        return output
      }

      case 'kms_get_summary': {
        const fileId = String(args.file_id || '').trim()
        if (!fileId) {
          return 'Please provide file_id.'
        }

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
      }

      default:
        return `Unknown tool: ${name}`
    }
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

  private setCORSHeaders(res: http.ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id')
  }
}

export default KMSMCPService
