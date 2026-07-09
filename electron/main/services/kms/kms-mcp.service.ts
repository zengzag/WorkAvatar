import http from 'http'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'
import {
  type KMSMCPConfig,
  type JsonRpcRequest,
  type JsonRpcResponse,
  DEFAULT_CONFIG,
  MCP_TOOLS,
} from './kms-mcp-types'
import { executeTool } from './kms-mcp-tool-handlers'

const logger = createLogger('KMS-MCP')

// 向后兼容：重新导出类型
export type { KMSMCPConfig } from './kms-mcp-types'

class KMSMCPService {
  private server: http.Server | null = null
  private config: KMSMCPConfig = { ...DEFAULT_CONFIG }
  private sessions: Map<string, { initialized: boolean; createdAt: number; lastActivityAt: number }> = new Map()
  private sessionCleanupTimer: NodeJS.Timeout | null = null
  private static readonly SESSION_IDLE_TTL_MS = 60 * 60 * 1000
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
      return { success: false, error: 'Server is already running' }
    }

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          logger.error('Failed to handle MCP request:', err)
          this.sendJsonRpcError(res, 500, -32603, 'Internal error', null)
        })
      })

      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          resolve({ success: false, error: `Port ${this.config.port} is already in use` })
        } else {
          resolve({ success: false, error: err.message })
        }
      })

      server.listen(this.config.port, () => {
        this.server = server
        this.sessionCleanupTimer = setInterval(
          () => this.cleanupExpiredSessions(),
          KMSMCPService.SESSION_CLEANUP_INTERVAL_MS,
        )
        logger.info(`MCP server started on port ${this.config.port}`)
        resolve({ success: true })
      })
    })
  }

  async stop(): Promise<{ success: boolean }> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve({ success: true })
        return
      }

      if (this.sessionCleanupTimer) {
        clearInterval(this.sessionCleanupTimer)
        this.sessionCleanupTimer = null
      }

      this.server.close(() => {
        this.server = null
        this.sessions.clear()
        logger.info('MCP server stopped')
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
      this.sendJsonRpcError(res, 405, -32600, 'Method not allowed', null)
      return
    }

    if (req.url !== '/mcp') {
      this.sendJsonRpcError(res, 404, -32600, 'Not found. Use POST /mcp', null)
      return
    }

    if (this.config.apiKey) {
      const authHeader = req.headers['authorization'] || ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
      if (token !== this.config.apiKey) {
        this.sendJsonRpcError(res, 401, -32001, 'Unauthorized: invalid API key', null)
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
      this.sendJsonRpcError(res, 400, -32700, 'Parse error', null)
      return
    }

    const response = await this.handleMessage(message, sessionId)
    const newSessionId = sessionId || this.getOrCreateSessionId(message)
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

    try {
      const result = await executeTool(params.name, params.arguments || {})
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
      logger.error(`MCP tool "${params.name}" execution failed:`, error?.message || error)
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

  private setCORSHeaders(res: http.ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id')
  }

  /** 发送 JSON-RPC 错误响应 */
  private sendJsonRpcError(res: http.ServerResponse, httpStatus: number, code: number, message: string, id: string | number | null) {
    res.writeHead(httpStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
  }
}

export default KMSMCPService
