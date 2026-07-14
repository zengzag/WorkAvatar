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
  /** 请求 body 最大字节数（10MB），防止恶意大 body 导致 OOM */
  private static readonly MAX_BODY_BYTES = 10 * 1024 * 1024
  /** 请求 body 读取超时（30秒），防止慢客户端挂起服务器 */
  private static readonly BODY_TIMEOUT_MS = 30 * 1000
  /** server.close() 超时（5秒），超时后强制销毁所有连接 */
  private static readonly CLOSE_TIMEOUT_MS = 5 * 1000
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
        // 服务器级别超时：防止慢速攻击（慢头发送、慢 body 读取）
        // requestTimeout：整个请求处理超时（含 body），Node 默认 300s → 收紧到 60s
        server.requestTimeout = 60 * 1000
        // headersTimeout： headers 接收超时，必须略大于 requestTimeout 的 keep-alive 超时
        server.headersTimeout = 65 * 1000
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

      // 超时兜底：如果 server.close() 在 CLOSE_TIMEOUT_MS 内未完成（有连接未关闭），
      // 强制销毁所有连接并完成 stop，避免永久挂起
      let resolved = false
      const forceCloseTimer = setTimeout(() => {
        if (resolved) return
        resolved = true
        this.server?.closeAllConnections?.()
        // closeAllConnections 在 Node 18.2+ 可用；兜底再 close 一次
        this.server = null
        this.sessions.clear()
        logger.warn('MCP server stop timed out, forced close all connections')
        resolve({ success: true })
      }, KMSMCPService.CLOSE_TIMEOUT_MS)

      this.server.close(() => {
        if (resolved) return
        resolved = true
        clearTimeout(forceCloseTimer)
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

    // 读取请求 body，带超时和大小限制：
    // - 超时：慢客户端在 BODY_TIMEOUT_MS 内未发送完 body 则中止，防止挂起
    // - 大小限制：超过 MAX_BODY_BYTES 立即返回 413，防止 OOM
    let body = ''
    let bodySize = 0
    let bodyTooLarge = false
    let bodyTimedOut = false
    const bodyTimer = setTimeout(() => {
      bodyTimedOut = true
      // 超时后销毁 socket，中止 for-await 循环
      req.destroy(new Error('Request body timeout'))
    }, KMSMCPService.BODY_TIMEOUT_MS)

    try {
      for await (const chunk of req) {
        bodySize += chunk.length
        if (bodySize > KMSMCPService.MAX_BODY_BYTES) {
          bodyTooLarge = true
          break
        }
        body += chunk
      }
    } catch {
      // 超时导致的 destroy 会抛异常，bodyTimedOut 标记已在下方处理
    } finally {
      clearTimeout(bodyTimer)
    }

    // 超时后 socket 已销毁，无法再写响应，直接返回
    if (bodyTimedOut) {
      logger.warn('MCP request body read timed out, connection destroyed')
      return
    }

    if (bodyTooLarge) {
      this.sendJsonRpcError(res, 413, -32603, 'Request body too large', null)
      return
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
