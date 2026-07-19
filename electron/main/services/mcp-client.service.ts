/**
 * 基于 @modelcontextprotocol/sdk 的 MCP (Model Context Protocol) 客户端封装。
 *
 * 设计目标：
 *  1. 使用官方 SDK（@modelcontextprotocol/sdk）作为底层实现，避免手写 JSON-RPC 协议
 *     带来的兼容性与稳定性问题，享受协议演进的生态红利
 *  2. 支持三种主流传输方式：
 *     - stdio：spawn 子进程，通过 stdin/stdout 收发消息
 *     - streamableHttp：HTTP POST + 可选 SSE 流（2025-03-26 协议主流方式）
 *     - sse：旧版 SSE 长连接（兼容旧 server）
 *  3. 对外暴露统一接口：initialize / listTools / callTool / close，
 *     供 McpRegistryService 按需连接、复用、释放
 *
 * 协议参考：https://modelcontextprotocol.io/specification/2025-03-26
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { createLogger } from './logger'
import type {
  McpServerConfig,
  McpToolInfo,
  McpTestResult,
} from '../../shared/ipc-channels'

const logger = createLogger('MCP-Client')

const CLIENT_NAME = 'workavatar-employee-agent'
const CLIENT_VERSION = '1.0.0'

/**
 * MCP 客户端：基于官方 SDK 的 Client + Transport 封装。
 *
 * 内部维护 SDK Client 与 Transport 实例，对外提供简化的
 * initialize / listTools / callTool / close 接口。
 * 三种传输方式通过 factory 函数 createMcpClient 创建。
 */
export class McpClient {
  private client: Client | null = null
  private transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport | null = null
  private initialized = false
  private serverInfo: { name?: string; version?: string } = {}
  private protocolVersion: string = ''

  constructor(private config: McpServerConfig) {}

  /** 建立连接并发送 initialize 握手 */
  async initialize(): Promise<void> {
    if (this.initialized) return
    this.transport = this.createTransport()
    this.client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      { capabilities: {} }
    )
    // connect() 内部完成 initialize 握手与 notifications/initialized 通知
    await this.client.connect(this.transport)
    // 读取 server 信息（SDK 内部已存储）
    try {
      const ver = this.client.getServerVersion()
      if (ver) {
        this.serverInfo = { name: ver.name, version: ver.version }
      }
      const caps = this.client.getServerCapabilities()
      if (caps) {
        // SDK 不直接暴露协商后的协议版本，用固定值占位（兼容旧调用方）
        this.protocolVersion = '2025-03-26'
      }
    } catch {
      // ignore
    }
    this.initialized = true
    logger.info(`[MCP ${this.config.name}] connected (server=${this.serverInfo.name || 'unknown'} v${this.serverInfo.version || '?'})`)
  }

  /** 拉取工具列表 */
  async listTools(): Promise<McpToolInfo[]> {
    await this.initialize()
    const result = await this.client!.listTools()
    const tools: any[] = result?.tools || []
    return tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object' as const, properties: {} },
    }))
  }

  /** 调用工具 */
  async callTool(name: string, args: Record<string, any>): Promise<{
    content: any[]
    isError?: boolean
    raw: any
  }> {
    await this.initialize()
    const result = await this.client!.callTool({ name, arguments: args })
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      isError: result?.isError === true,
      raw: result,
    }
  }

  /** 关闭连接、清理资源 */
  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close()
      } catch (err: any) {
        logger.debug(`[MCP ${this.config.name}] client close error: ${err.message}`)
      }
      this.client = null
    }
    // StdioClientTransport 需要显式关闭子进程
    if (this.transport && typeof (this.transport as any).close === 'function') {
      try {
        await (this.transport as any).close()
      } catch { /* ignore */ }
    }
    this.transport = null
    this.initialized = false
  }

  getServerInfo() { return this.serverInfo }
  getProtocolVersion() { return this.protocolVersion }

  /** 根据 config.transport_type 构造对应的 SDK Transport */
  private createTransport(): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
    switch (this.config.transport_type) {
      case 'stdio': {
        if (!this.config.command) {
          throw new Error('stdio 模式缺少 command 参数')
        }
        // StdioClientTransport 要求 env 为 Record<string, string>，
        // 而 process.env 中可能存在 undefined 值，需过滤
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(process.env)) {
          if (typeof v === 'string') env[k] = v
        }
        Object.assign(env, this.config.env || {})
        return new StdioClientTransport({
          command: this.config.command,
          args: this.config.args || [],
          env,
          stderr: 'pipe' as const,
        })
      }
      case 'streamableHttp': {
        if (!this.config.url) {
          throw new Error('streamableHttp 模式缺少 url 参数')
        }
        const headers = this.config.headers || {}
        return new StreamableHTTPClientTransport(new URL(this.config.url), {
          requestInit: { headers },
        })
      }
      case 'sse': {
        if (!this.config.url) {
          throw new Error('sse 模式缺少 url 参数')
        }
        const headers = this.config.headers || {}
        return new SSEClientTransport(new URL(this.config.url), {
          requestInit: { headers },
        })
      }
      default:
        throw new Error(`不支持的 MCP 传输方式: ${(this.config as any).transport_type}`)
    }
  }
}

/**
 * 工厂方法：根据 config.transport_type 创建合适的 MCP 客户端
 */
export function createMcpClient(config: McpServerConfig): McpClient {
  return new McpClient(config)
}

/**
 * 测试 MCP server 连接：建立客户端 → initialize → listTools → close。
 *
 * 用于"测试连接"按钮和首次添加 server 时主动拉取工具列表缓存。
 * 失败时返回 { success: false, error }，成功时返回工具清单与 serverInfo。
 */
export async function testMcpServer(config: McpServerConfig): Promise<McpTestResult> {
  let client: McpClient | null = null
  try {
    client = createMcpClient(config)
    await client.initialize()
    const tools = await client.listTools()
    return {
      success: true,
      tools,
      serverInfo: client.getServerInfo(),
      protocolVersion: client.getProtocolVersion(),
    }
  } catch (err: any) {
    return {
      success: false,
      error: String(err?.message || err),
    }
  } finally {
    if (client) {
      try { await client.close() } catch { /* ignore */ }
    }
  }
}
