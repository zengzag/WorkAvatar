import http from 'http'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'
import {
  type KMSMCPConfig,
  type JsonRpcRequest,
  type JsonRpcResponse,
  DEFAULT_CONFIG,
} from './kms-mcp-types'
import type {
  KMSMCPToolCategoryInfo,
  KMSMCPExposedTool,
} from '../../../shared/channels/kms'
import {
  BUILTIN_TOOL_CATEGORIES,
  convertToolDefinitionToMcpTool,
  invokeBuiltinTool,
  resolveEnabledToolIds,
  type BuiltinToolCategoryId,
  type McpTool,
} from '../mcp/builtin-mcp-converter'
import { buildAllBuiltinToolDefinitions } from '../mcp/kms-mcp-adapters'
import type { ToolDefinition } from '../agent/tools/types'

const logger = createLogger('Builtin-MCP')

// 向后兼容：重新导出类型
export type { KMSMCPConfig } from './kms-mcp-types'

/** 对外工具类别元信息（不含工具列表，仅用于前端展示类别分组） */
export interface BuiltinToolCategoryInfo {
  id: BuiltinToolCategoryId
  toolIds: string[]
  defaultEnabled: boolean
  toolCount: number
}

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

  /**
   * 缓存：完整 ToolDefinition 列表（name → tool）
   * 懒加载首次用到时构建，避免启动时依赖链过重。
   */
  private toolDefsCache: Map<string, ToolDefinition> | null = null

  private constructor() {}

  static getInstance(): KMSMCPService {
    if (!KMSMCPService.instance) {
      KMSMCPService.instance = new KMSMCPService()
    }
    return KMSMCPService.instance
  }

  // ============================================================
  // 配置与状态
  // ============================================================

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

  /**
   * 返回工具类别元信息（id / 工具数 / 默认是否启用），供 UI 绘制类别开关。
   */
  listCategories(): KMSMCPToolCategoryInfo[] {
    return BUILTIN_TOOL_CATEGORIES.map((c) => ({
      id: c.id,
      toolIds: [...c.toolIds],
      defaultEnabled: c.defaultEnabled,
      toolCount: c.toolIds.length,
    }))
  }

  /** 根据 toolId 或 name 查所属工具类别，无法匹配返回 'unknown'。 */
  private findToolCategory(toolId: string, name: string): BuiltinToolCategoryId | 'unknown' {
    for (const cat of BUILTIN_TOOL_CATEGORIES) {
      for (const id of cat.toolIds) {
        if (id === toolId || id === name) {
          return cat.id
        }
      }
    }
    return 'unknown'
  }

  /**
   * 返回按类别过滤后的对外工具列表（纯 MCP 协议格式），供 MCP tools/list 端点返回。
   * - 不传 enabledCategories 时使用当前 config.tool_categories 过滤
   */
  listExposedTools(enabledCategories?: BuiltinToolCategoryId[]): McpTool[] {
    const allDefs = this.getAllToolDefinitions()
    const enabledIds = resolveEnabledToolIds(
      enabledCategories ?? this.config.tool_categories,
    )
    const result: McpTool[] = []
    for (const [name, def] of allDefs) {
      if (enabledIds.has(def.id) || enabledIds.has(name)) {
        result.push(convertToolDefinitionToMcpTool(def))
      }
    }
    return result
  }

  /**
   * 返回按类别过滤后的对外工具列表（带 category / toolId 元信息），供 UI 展示用。
   */
  listExposedToolsDetailed(enabledCategories?: BuiltinToolCategoryId[]): KMSMCPExposedTool[] {
    const allDefs = this.getAllToolDefinitions()
    const enabledIds = resolveEnabledToolIds(
      enabledCategories ?? this.config.tool_categories,
    )
    const result: KMSMCPExposedTool[] = []
    for (const [name, def] of allDefs) {
      if (enabledIds.has(def.id) || enabledIds.has(name)) {
        const mcp = convertToolDefinitionToMcpTool(def)
        result.push({
          ...mcp,
          category: this.findToolCategory(def.id, name),
          toolId: def.id || name,
        })
      }
    }
    return result
  }

  // ============================================================
  // HTTP 服务启停
  // ============================================================

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
        server.requestTimeout = 60 * 1000
        server.headersTimeout = 65 * 1000
        this.sessionCleanupTimer = setInterval(
          () => this.cleanupExpiredSessions(),
          KMSMCPService.SESSION_CLEANUP_INTERVAL_MS,
        )
        logger.info(`Builtin MCP server started on port ${this.config.port}`)
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

      let resolved = false
      const forceCloseTimer = setTimeout(() => {
        if (resolved) return
        resolved = true
        this.server?.closeAllConnections?.()
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
        logger.info('Builtin MCP server stopped')
        resolve({ success: true })
      })
    })
  }

  // ============================================================
  // 工具定义缓存
  // ============================================================

  private getAllToolDefinitions(): Map<string, ToolDefinition> {
    if (this.toolDefsCache) return this.toolDefsCache
    const defs = buildAllBuiltinToolDefinitions()
    const map = new Map<string, ToolDefinition>()
    for (const t of defs) {
      // name 与 id 都存一份索引，方便匹配（大部分工具 id===name）
      map.set(t.name, t)
      if (t.id !== t.name) map.set(t.id, t)
    }
    this.toolDefsCache = map
    return map
  }

  // ============================================================
  // HTTP 请求处理
  // ============================================================

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

    // 读取 body：带超时与大小限制
    let body = ''
    let bodySize = 0
    let bodyTooLarge = false
    let bodyTimedOut = false
    const bodyTimer = setTimeout(() => {
      bodyTimedOut = true
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

  // ============================================================
  // JSON-RPC 消息处理
  // ============================================================

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
            name: 'WorkAvatar Builtin MCP Server',
            version: '2.0.0',
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
      // 使用配置的 tool_categories 过滤
      const tools = this.listExposedTools(this.config.tool_categories)
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: { tools },
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

  private async handleToolCall(
    id: string | number | null,
    params?: Record<string, any>,
  ): Promise<JsonRpcResponse> {
    if (!params || !params.name) {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32602, message: 'Missing tool name' },
      }
    }
    const toolName: string = String(params.name)

    // 白名单：未启用类别中的工具直接拒绝
    const enabledToolIds = resolveEnabledToolIds(this.config.tool_categories)
    if (!enabledToolIds.has(toolName)) {
      logger.warn(`MCP tool "${toolName}" called but not in enabled categories`)
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: `Error: Tool "${toolName}" is not enabled. Please enable its category in WorkAvatar settings.`,
            },
          ],
          isError: true,
        },
      }
    }

    const allDefs = this.getAllToolDefinitions()
    const tool = allDefs.get(toolName)
    if (!tool) {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [{ type: 'text', text: `Error: Unknown tool: ${toolName}` }],
          isError: true,
        },
      }
    }

    try {
      const result = await invokeBuiltinTool(tool, params.arguments || {})
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result,
      }
    } catch (error: any) {
      logger.error(`MCP tool "${toolName}" execution failed:`, error?.message || error)
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: `Error: ${String(error?.message || error || 'Unknown error')}`,
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
  private sendJsonRpcError(
    res: http.ServerResponse,
    httpStatus: number,
    code: number,
    message: string,
    id: string | number | null,
  ) {
    res.writeHead(httpStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
  }
}

export default KMSMCPService
