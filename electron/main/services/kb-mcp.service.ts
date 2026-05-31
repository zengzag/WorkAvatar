import http from 'http'
import KnowledgeBaseService from './kb.service'
import KBDatabaseService from './kb-database.service'
import SearchEngineService from './search-engine.service'
import type { SourceType } from './search-engine.service'
import { generateId } from './common-utils'

export interface KBMCPConfig {
  enabled: boolean
  port: number
  allowedKbIds: string[]
  apiKey: string
}

const DEFAULT_CONFIG: KBMCPConfig = {
  enabled: false,
  port: 3100,
  allowedKbIds: [],
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
    name: 'kb_list',
    description: 'List all accessible knowledge bases with their topics and document counts.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'kb_overview',
    description: 'Get the global summary, core topics, and document summary list of a knowledge base. Helps identify target documents for deeper exploration.',
    inputSchema: {
      type: 'object',
      properties: {
        kb_id: {
          type: 'string',
          description: 'Knowledge base ID (required). Use kb_list first to see available IDs',
        },
      },
      required: ['kb_id'],
    },
  },
  {
    name: 'kb_get_toc',
    description: 'Get the hierarchical table of contents of a document, including paragraph IDs, title paths, and content offset ranges.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'Document ID (required)',
        },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'kb_get_paragraphs',
    description: 'Batch retrieve detailed summaries and content previews for multiple paragraphs. Use after reviewing the TOC to explore sections of interest.',
    inputSchema: {
      type: 'object',
      properties: {
        paragraph_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of paragraph IDs (required). Obtain from kb_get_toc or kb_search results',
        },
      },
      required: ['paragraph_ids'],
    },
  },
  {
    name: 'kb_search',
    description: 'Intelligent knowledge base search supporting keyword and semantic search. Can filter by source type (document titles, summaries, paragraph summaries, content).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query, supports space-separated keywords',
        },
        top_k: {
          type: 'number',
          description: 'Number of results to return (1-20, default 5)',
          minimum: 1,
          maximum: 20,
          default: 5,
        },
        kb_id: {
          type: 'string',
          description: 'Knowledge base ID (optional, uses first available if not provided). Use kb_list first to see available IDs',
        },
        document_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit search to specific document IDs (optional)',
        },
        search_in: {
          type: 'string',
          description: 'Search scope (optional, default "all"). Options: all, document_titles, document_summaries, paragraph_summaries, content',
          enum: ['all', 'document_titles', 'document_summaries', 'paragraph_summaries', 'content'],
          default: 'all',
        },
        use_semantic: {
          type: 'boolean',
          description: 'Enable semantic search (requires Embedding API, default false)',
          default: false,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_get_content',
    description: 'Get document content by paragraph ID, character offset, or line number. Supports batch retrieval via paragraph_ids array.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'Document ID (required when using paragraph_id/offset/line, optional with paragraph_ids)',
        },
        paragraph_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of paragraph IDs (optional, mutually exclusive with paragraph_id/offset/line). Batch retrieve full content of multiple paragraphs',
        },
        paragraph_id: {
          type: 'string',
          description: 'Single paragraph ID (optional, mutually exclusive with paragraph_ids/offset/line)',
        },
        start_offset: {
          type: 'number',
          description: 'Start character offset (0-based, optional, mutually exclusive with paragraph_id/paragraph_ids/line)',
        },
        end_offset: {
          type: 'number',
          description: 'End character offset (optional, used with start_offset)',
        },
        start_line: {
          type: 'number',
          description: 'Start line number (1-based, optional, mutually exclusive with paragraph_id/paragraph_ids/offset)',
        },
        end_line: {
          type: 'number',
          description: 'End line number (optional, used with start_line)',
        },
        context_chars: {
          type: 'number',
          description: 'Context expansion character count (default 200, used with offset or line)',
          default: 200,
        },
      },
      required: [],
    },
  },
]

const SEARCH_IN_OPTIONS = ['all', 'document_titles', 'document_summaries', 'paragraph_summaries', 'content'] as const
type SearchIn = typeof SEARCH_IN_OPTIONS[number]

function parseSearchIn(value: string | undefined): { sourceTypes: SourceType[]; label: string } {
  if (value && SEARCH_IN_OPTIONS.includes(value as SearchIn)) {
    const si = value as SearchIn
    switch (si) {
      case 'document_titles': return { sourceTypes: ['document_title'], label: 'Document Titles' }
      case 'document_summaries': return { sourceTypes: ['document_summary'], label: 'Document Summaries' }
      case 'paragraph_summaries': return { sourceTypes: ['paragraph'], label: 'Paragraph Summaries' }
      case 'content': return { sourceTypes: ['content_paragraph'], label: 'Content' }
      case 'all': return { sourceTypes: ['document_title', 'document_summary', 'paragraph', 'content_paragraph'], label: 'All' }
    }
  }
  return { sourceTypes: ['document_title', 'document_summary', 'paragraph', 'content_paragraph'], label: 'All' }
}

class KBMCPService {
  private server: http.Server | null = null
  private config: KBMCPConfig = { ...DEFAULT_CONFIG }
  private sessions: Map<string, { initialized: boolean; createdAt: number }> = new Map()
  private static instance: KBMCPService

  private constructor() {}

  static getInstance(): KBMCPService {
    if (!KBMCPService.instance) {
      KBMCPService.instance = new KBMCPService()
    }
    return KBMCPService.instance
  }

  getConfig(): KBMCPConfig {
    return { ...this.config }
  }

  updateConfig(config: Partial<KBMCPConfig>): void {
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
            name: 'WorkAvatar Knowledge Base MCP Server',
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
    const kbService = KnowledgeBaseService.getInstance()
    const kbDb = KBDatabaseService.getInstance()
    const searchEngine = SearchEngineService.getInstance()

    const allowedKbIds = this.config.allowedKbIds.length > 0 ? this.config.allowedKbIds : this.getAllKbIds()

    const validateKbId = (kbId: string | undefined): string | null => {
      if (!kbId) return allowedKbIds.length > 0 ? allowedKbIds[0] : null
      if (!allowedKbIds.includes(kbId)) return null
      return kbId
    }

    switch (name) {
      case 'kb_list': {
        if (allowedKbIds.length === 0) {
          return 'No knowledge bases available.'
        }

        const placeholders = allowedKbIds.map(() => '?').join(',')
        const allKBs = kbDb.getDb().prepare(`
          SELECT kb.*, (SELECT COUNT(*) FROM kb_documents WHERE kb_id = kb.id) as doc_count
          FROM knowledge_bases kb
          WHERE kb.id IN (${placeholders})
          ORDER BY kb.name
        `).all(...allowedKbIds) as any[]

        if (allKBs.length === 0) {
          return 'No knowledge bases available.'
        }

        let output = `${allKBs.length} knowledge base(s):\n`
        for (let i = 0; i < allKBs.length; i++) {
          const kb = allKBs[i]
          output += `${i + 1}. ${kb.name} [${kb.id}] ${kb.doc_count || 0} docs`
          const globalSummary = kbService.getGlobalSummary(kb.id)
          if (globalSummary) {
            const keyTopics: string[] = JSON.parse(globalSummary.key_topics_json || '[]')
            if (keyTopics.length > 0) {
              output += ` | ${keyTopics.join(', ')}`
            }
          }
          if (kb.description) {
            output += `\n   ${kb.description}`
          }
          output += '\n'
        }
        return output
      }

      case 'kb_overview': {
        const targetKbId = validateKbId(args.kb_id)
        if (!targetKbId) {
          return 'Knowledge base not accessible. Use kb_list to see available IDs.'
        }

        const kb = kbService.getKB(targetKbId)
        if (!kb) {
          return 'Knowledge base not found.'
        }

        let output = kb.name
        if (kb.description) {
          output += ` - ${kb.description}`
        }
        output += '\n'

        const globalSummary = kbService.getGlobalSummary(targetKbId)
        if (globalSummary) {
          output += `Summary: ${globalSummary.summary}\n`
          const keyTopics: string[] = JSON.parse(globalSummary.key_topics_json || '[]')
          if (keyTopics.length > 0) {
            output += `Topics: ${keyTopics.join(', ')}\n`
          }
        }

        const docs = kbService.getDocumentList(targetKbId) as any[]
        const completedDocs = docs.filter((d: any) => d.parse_status === 'completed')

        if (completedDocs.length === 0) {
          output += 'No parsed documents yet.'
          return output
        }

        output += `\n${completedDocs.length} document(s):\n`
        for (const doc of completedDocs) {
          output += `- ${doc.original_name} [${doc.id}]`
          const docSummary = kbService.getDocumentSummary(doc.id)
          if (docSummary) {
            if (docSummary.summary) output += ` ${docSummary.summary}`
            const topics: string[] = JSON.parse(docSummary.main_topics_json || '[]')
            if (topics.length > 0) {
              output += ` | ${topics.join(', ')}`
            }
          }
          output += '\n'
        }
        return output
      }

      case 'kb_get_toc': {
        const doc = kbDb.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(args.document_id) as any
        if (!doc) {
          return 'Document not found.'
        }

        if (!allowedKbIds.includes(doc.kb_id)) {
          return 'Access denied: document not in allowed knowledge bases.'
        }

        if (doc.parse_status !== 'completed') {
          return 'Document has not been parsed yet.'
        }

        const paragraphs = kbDb.getDb().prepare(
          'SELECT id, title, level FROM kb_paragraphs WHERE document_id = ? ORDER BY paragraph_index'
        ).all(args.document_id) as any[]

        if (paragraphs.length === 0) {
          return 'No paragraphs found for this document.'
        }

        let output = `${doc.original_name} (${paragraphs.length} paragraphs, # followed by paragraph ID):\n`
        for (const p of paragraphs) {
          const indent = '  '.repeat(Math.max(0, p.level - 1))
          output += `${indent}${p.title} #${p.id}\n`
        }
        return output
      }

      case 'kb_get_paragraphs': {
        const ids: string[] = args.paragraph_ids || []
        if (ids.length === 0) {
          return 'Please provide at least one paragraph ID.'
        }

        const placeholders = ids.map(() => '?').join(',')
        const paragraphs = kbDb.getDb().prepare(
          `SELECT p.*, d.original_name as document_name, d.kb_id
           FROM kb_paragraphs p
           LEFT JOIN kb_documents d ON d.id = p.document_id
           WHERE p.id IN (${placeholders})
           ORDER BY p.document_id, p.paragraph_index`
        ).all(...ids) as any[]

        if (paragraphs.length === 0) {
          return 'No matching paragraphs found. Check paragraph IDs.'
        }

        const inaccessible = paragraphs.find((p: any) => !allowedKbIds.includes(p.kb_id))
        if (inaccessible) {
          return 'Access denied: paragraph belongs to a knowledge base not in allowed list.'
        }

        let output = `${paragraphs.length} paragraph(s):\n`
        for (let i = 0; i < paragraphs.length; i++) {
          const p = paragraphs[i]
          output += `[${i + 1}] ${p.title_path || p.title} [${p.id}]`
          if (p.summary) {
            output += ` ${p.summary}`
          }
          const preview = p.content ? p.content.substring(0, 200) : ''
          if (preview) {
            output += `\n    ${preview}${p.content.length > 200 ? '...' : ''}`
          }
          output += `\n    doc:${p.document_id} off:${p.start_offset}-${p.end_offset}\n`
        }
        return output
      }

      case 'kb_search': {
        const targetKbId = validateKbId(args.kb_id)
        if (!targetKbId) {
          return 'No accessible knowledge base for search. Use kb_list to see available IDs.'
        }

        const query = String(args.query || '').trim()
        if (!query || query.length < 2) {
          return 'Please enter at least 2 characters for the query.'
        }

        const topK = Math.min(Math.max(args.top_k || 5, 1), 20)
        const documentIds = args.document_ids
        const { sourceTypes, label } = parseSearchIn(args.search_in)

        let results: any[]

        if (args.use_semantic) {
          results = await kbService.searchWithEmbedding(targetKbId, query, topK, documentIds) as any[]
          results = results.slice(0, topK)
        } else {
          results = searchEngine.ftsSearch(targetKbId, query, topK, {
            documentIds,
            sourceTypes,
          }) as any[]
        }

        if (results.length === 0) {
          const searchScope = args.search_in && !args.use_semantic ? `(${label})` : ''
          return `No results for "${query}" ${searchScope}. Suggestions: expand search scope (search_in:"all") or enable semantic search (use_semantic:true)`
        }

        let output = `${results.length} result(s)`
        if (!args.use_semantic) {
          output += ` (${label})`
        }
        output += ':\n'

        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const typeLabelMap: Record<string, string> = {
            document_title: 'Title',
            document_summary: 'Doc Summary',
            paragraph: 'Paragraph',
            content_paragraph: 'Content',
            hybrid: 'Hybrid',
          }
          const typeLabel = typeLabelMap[r.match_type] || r.match_type

          output += `[${i + 1}] ${typeLabel} | ${r.document_name}${r.paragraph_title ? ` > ${r.paragraph_title}` : ''}\n`
          output += `${r.text}\n`

          const locParts: string[] = []
          if (r.document_id) locParts.push(`d:${r.document_id}`)
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

        return output
      }

      case 'kb_get_content': {
        if (args.paragraph_ids && Array.isArray(args.paragraph_ids) && args.paragraph_ids.length > 0) {
          const ids: string[] = args.paragraph_ids
          const placeholders = ids.map(() => '?').join(',')
          const paragraphs = kbDb.getDb().prepare(
            `SELECT p.*, d.original_name as document_name, d.kb_id, d.parse_status
             FROM kb_paragraphs p
             LEFT JOIN kb_documents d ON d.id = p.document_id
             WHERE p.id IN (${placeholders})
             ORDER BY p.document_id, p.paragraph_index`
          ).all(...ids) as any[]

          if (paragraphs.length === 0) {
            return 'No matching paragraphs found.'
          }

          const inaccessible = paragraphs.find((p: any) => !allowedKbIds.includes(p.kb_id))
          if (inaccessible) {
            return 'Access denied: paragraph belongs to a knowledge base not in allowed list.'
          }

          const notParsed = paragraphs.find((p: any) => p.parse_status !== 'completed')
          if (notParsed) {
            return 'Document has not been parsed yet.'
          }

          let output = `${paragraphs.length} paragraph(s) content:\n`
          for (let i = 0; i < paragraphs.length; i++) {
            const p = paragraphs[i]
            output += `\n--- [${i + 1}] ${p.title_path || p.title} [${p.id}] ---\n`
            output += p.content || ''
            output += `\ndoc:${p.document_id} off:${p.start_offset}-${p.end_offset}\n`
          }
          return output
        }

        if (!args.document_id) {
          return 'Please provide document_id or paragraph_ids.'
        }

        const doc = kbDb.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(args.document_id) as any
        if (!doc) {
          return 'Document not found.'
        }

        if (!allowedKbIds.includes(doc.kb_id)) {
          return 'Access denied: document not in allowed knowledge bases.'
        }

        if (doc.parse_status !== 'completed') {
          return 'Document has not been parsed yet.'
        }

        const content = kbService.getDocumentContent(args.document_id) || ''
        if (!content) {
          return 'Document content is empty.'
        }

        if (args.paragraph_id) {
          const paragraphs = kbService.getParagraphs(args.document_id)
          const paragraph = paragraphs.find((p: any) => p.id === args.paragraph_id)
          if (!paragraph) {
            return 'Paragraph not found.'
          }

          let output = `${paragraph.title_path || paragraph.title}\n\n${paragraph.content}`
          const paragraphIndex = paragraphs.findIndex((p: any) => p.id === args.paragraph_id)
          if (paragraphIndex > 0) {
            const prev = paragraphs[paragraphIndex - 1]
            output += `\n<- ${prev.title_path || prev.title} [${prev.id}]`
          }
          if (paragraphIndex < paragraphs.length - 1) {
            const next = paragraphs[paragraphIndex + 1]
            output += `\n-> ${next.title_path || next.title} [${next.id}]`
          }
          return output
        }

        if (args.start_line !== undefined) {
          const lines = content.split('\n')
          const startLine = Math.max(1, args.start_line)
          const endLine = args.end_line !== undefined ? Math.min(args.end_line, lines.length) : startLine + 49
          const contextChars = args.context_chars || 200

          let startOffset = 0
          for (let i = 0; i < startLine - 1; i++) {
            startOffset += lines[i].length + 1
          }
          let endOffset = startOffset
          for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
            endOffset += lines[i].length + 1
          }

          const actualStart = Math.max(0, startOffset - contextChars)
          const actualEnd = Math.min(content.length, endOffset + contextChars)

          let output = content.substring(actualStart, actualEnd)
          if (actualStart > 0) output = '...' + output
          if (actualEnd < content.length) output = output + '...'

          return `${doc.original_name} L${startLine}-${endLine} off:${actualStart}-${actualEnd}\n\n${output}\n\nd:${args.document_id}`
        }

        if (args.start_offset !== undefined) {
          const startOffset = Math.max(0, args.start_offset)
          const endOffset = args.end_offset !== undefined ? Math.min(args.end_offset, content.length) : Math.min(startOffset + 2000, content.length)
          const contextChars = args.context_chars || 200

          const actualStart = Math.max(0, startOffset - contextChars)
          const actualEnd = Math.min(content.length, endOffset + contextChars)

          let output = content.substring(actualStart, actualEnd)
          if (actualStart > 0) output = '...' + output
          if (actualEnd < content.length) output = output + '...'

          return `${doc.original_name} off:${startOffset}-${endOffset}(show:${actualStart}-${actualEnd})\n\n${output}\n\nd:${args.document_id}`
        }

        let output = content.substring(0, 10000)
        if (content.length > 10000) {
          output += '\n\n...(truncated to first 10000 chars, use paragraph_id/paragraph_ids/start_offset/start_line to locate)'
        }

        const paragraphs = kbService.getParagraphs(args.document_id)
        if (paragraphs.length > 0) {
          output += `\n\nParagraphs: ${paragraphs.map((p: any) => `${p.title_path || p.title} [${p.id} off:${p.start_offset}-${p.end_offset}]`).join(' | ')}`
        }

        return `${doc.original_name}\n\n${output}\n\nd:${args.document_id}`
      }

      default:
        return `Unknown tool: ${name}`
    }
  }

  private getAllKbIds(): string[] {
    try {
      const kbDb = KBDatabaseService.getInstance()
      const rows = kbDb.getDb().prepare('SELECT id FROM knowledge_bases').all() as any[]
      return rows.map((r: any) => r.id)
    } catch {
      return []
    }
  }

  private setCORSHeaders(res: http.ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id')
  }
}

export default KBMCPService
