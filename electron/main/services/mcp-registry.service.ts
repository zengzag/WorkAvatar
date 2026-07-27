/**
 * 数字员工 MCP server 注册中心。
 *
 * 负责 employee_mcp_servers 表的 CRUD、状态维护、工具缓存刷新，
 * 以及为 EmployeeAgentService 提供"按 employee_id 拉取启用的 MCP server
 * 并构造 ToolDefinition 数组"的接口。
 *
 * 工具命名约定：
 *   注入到 agent 的 tool name = `mcp_<serverId短前缀>_<原始工具名>`
 *   避免与内置工具 / KMS 工具 / skill 工具命名冲突。
 */

import DatabaseService from './database.service'
import { generateId } from './common-utils'
import { createLogger } from './logger'
import { createMcpClient, McpClient, testMcpServer } from './mcp-client.service'
import type { ToolDefinition } from './agent/tools/types'
import type {
  McpServerConfig,
  McpServerInfo,
  McpToolInfo,
  McpTestResult,
  McpSaveParams,
} from '../../shared/ipc-channels'

const logger = createLogger('MCP-Registry')

/** 数据库行结构 */
interface DBMcpServerRow {
  id: string
  employee_id: string
  name: string
  transport_type: string
  command: string | null
  args_json: string
  env_json: string
  url: string | null
  headers_json: string
  is_enabled: number
  status: string
  last_error: string | null
  tools_json: string
  created_at: number
  updated_at: number
}

/** serverId → 活跃 client 实例缓存（agent 创建时复用，避免每次都重新 spawn / connect） */
interface ActiveClientEntry {
  client: McpClient
  /** 引用计数：每次 agent 注册引用 +1，agent 销毁时 -1，归零时关闭 client */
  refCount: number
  /** 守护 timer：长时间未引用则自动关闭，防止泄漏 */
  idleTimer: NodeJS.Timeout | null
  /** 该 client 对应的 server 配置快照（用于日志） */
  serverName: string
}

const IDLE_CLOSE_MS = 10 * 60 * 1000 // 10 分钟未引用自动关闭

class McpRegistryService {
  private db: DatabaseService
  private static instance: McpRegistryService
  /** serverId → 活跃 client */
  private activeClients: Map<string, ActiveClientEntry> = new Map()

  private constructor() {
    this.db = DatabaseService.getInstance()
  }

  static getInstance(): McpRegistryService {
    if (!McpRegistryService.instance) {
      McpRegistryService.instance = new McpRegistryService()
    }
    return McpRegistryService.instance
  }

  // ============================================================
  // CRUD
  // ============================================================

  /** 列出指定员工的所有 MCP server */
  listByEmployee(employeeId: string): McpServerInfo[] {
    const rows = this.db.getDb().prepare(
      `SELECT * FROM employee_mcp_servers WHERE employee_id = ? ORDER BY created_at ASC`
    ).all(employeeId) as DBMcpServerRow[]
    return rows.map((r) => this.rowToInfo(r))
  }

  /** 新增 MCP server */
  add(params: McpSaveParams): McpServerInfo {
    const { employee_id, config } = params
    this.validateConfig(config)
    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    this.db.getDb().prepare(`
      INSERT INTO employee_mcp_servers
        (id, employee_id, name, transport_type, command, args_json, env_json, url, headers_json,
         is_enabled, status, last_error, tools_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', NULL, '[]', ?, ?)
    `).run(
      id,
      employee_id,
      config.name.trim(),
      config.transport_type,
      config.command || null,
      JSON.stringify(config.args || []),
      JSON.stringify(config.env || {}),
      config.url || null,
      JSON.stringify(config.headers || {}),
      config.is_enabled === false ? 0 : 1,
      now,
      now,
    )
    logger.info(`Added MCP server "${config.name}" (id=${id}) for employee ${employee_id}`)
    return this.getById(id)!
  }

  /** 更新 MCP server 配置 */
  update(params: McpSaveParams): McpServerInfo {
    const { employee_id, config } = params
    if (!config.id) throw new Error('更新 MCP server 缺少 id')
    this.validateConfig(config)
    const existing = this.getById(config.id)
    if (!existing || existing.employee_id !== employee_id) {
      throw new Error('MCP server 不存在或不属于该员工')
    }
    const now = Math.floor(Date.now() / 1000)
    this.db.getDb().prepare(`
      UPDATE employee_mcp_servers
      SET name = ?, transport_type = ?, command = ?, args_json = ?, env_json = ?,
          url = ?, headers_json = ?, status = 'unknown', last_error = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(
      config.name.trim(),
      config.transport_type,
      config.command || null,
      JSON.stringify(config.args || []),
      JSON.stringify(config.env || {}),
      config.url || null,
      JSON.stringify(config.headers || {}),
      now,
      config.id,
    )
    // 配置变更后，关闭旧 client 强制下次重新连接
    this.closeActiveClient(config.id).catch(() => { /* ignore */ })
    logger.info(`Updated MCP server "${config.name}" (id=${config.id})`)
    return this.getById(config.id)!
  }

  /** 删除 MCP server */
  delete(id: string): { success: boolean } {
    this.db.getDb().prepare('DELETE FROM employee_mcp_servers WHERE id = ?').run(id)
    this.closeActiveClient(id).catch(() => { /* ignore */ })
    logger.info(`Deleted MCP server id=${id}`)
    return { success: true }
  }

  /** 启用 / 禁用 MCP server */
  toggle(id: string, enabled: boolean): McpServerInfo {
    const now = Math.floor(Date.now() / 1000)
    this.db.getDb().prepare(
      `UPDATE employee_mcp_servers SET is_enabled = ?, updated_at = ? WHERE id = ?`
    ).run(enabled ? 1 : 0, now, id)
    // 禁用时关闭活跃 client；启用时不主动连接，下次 agent 创建时按需拉起
    if (!enabled) {
      this.closeActiveClient(id).catch(() => { /* ignore */ })
    }
    return this.getById(id)!
  }

  getById(id: string): McpServerInfo | null {
    const row = this.db.getDb().prepare(
      'SELECT * FROM employee_mcp_servers WHERE id = ?'
    ).get(id) as DBMcpServerRow | undefined
    return row ? this.rowToInfo(row) : null
  }

  // ============================================================
  // 连接测试与工具刷新
  // ============================================================

  /** 测试连接（不依赖已缓存的 client，每次新建一个临时 client） */
  async testConnection(config: McpServerConfig): Promise<McpTestResult> {
    return testMcpServer(config)
  }

  /** 刷新指定 server 的工具缓存（主动连接 + listTools + 落库） */
  async refreshTools(id: string): Promise<McpTestResult> {
    const server = this.getById(id)
    if (!server) return { success: false, error: 'MCP server 不存在' }
    // 先关闭旧 client，确保用最新配置连接
    await this.closeActiveClient(id)
    const result = await testMcpServer(server)
    const now = Math.floor(Date.now() / 1000)
    if (result.success) {
      this.db.getDb().prepare(`
        UPDATE employee_mcp_servers
        SET status = 'connected', last_error = NULL, tools_json = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(result.tools || []), now, id)
    } else {
      this.db.getDb().prepare(`
        UPDATE employee_mcp_servers
        SET status = 'error', last_error = ?, updated_at = ?
        WHERE id = ?
      `).run((result.error || '').substring(0, 1000), now, id)
    }
    return result
  }

  // ============================================================
  // Agent 工具注入
  // ============================================================

  /**
   * 为指定员工构造启用的 MCP server 对应的 ToolDefinition 列表。
   *
   * 调用时机：EmployeeAgentService.getOrCreateAgent() 中，紧接内置工具注册之后。
   * 行为：
   *   1. 拉取该员工 is_enabled=1 的所有 server
   *   2. 对每个 server，获取或创建活跃 client（复用缓存避免重复 spawn）
   *   3. 调用 listTools() 拉取工具清单（失败则跳过该 server 并记录错误状态）
   *   4. 为每个工具构造 ToolDefinition，handler 内部调用 client.callTool
   *   5. 引用计数 +1，agent 销毁时调用 releaseAgentTools 释放
   *
   * 失败容忍：单个 server 失败不影响其他 server 与 agent 整体创建。
   */
  async buildAgentTools(employeeId: string): Promise<{
    tools: ToolDefinition[]
    release: () => Promise<void>
  }> {
    const rows = this.db.getDb().prepare(
      `SELECT * FROM employee_mcp_servers WHERE employee_id = ? AND is_enabled = 1`
    ).all(employeeId) as DBMcpServerRow[]

    const tools: ToolDefinition[] = []
    const acquiredServerIds: string[] = []

    for (const row of rows) {
      try {
        const client = await this.getOrCreateClient(row)
        let toolList: McpToolInfo[]
        try {
          toolList = await client.listTools()
        } catch (err: any) {
          // listTools 失败：标记 server 状态为 error，跳过该 server 的工具注入
          logger.warn(`MCP server "${row.name}" listTools 失败: ${err.message}`)
          this.markServerError(row.id, err.message).catch(() => { /* ignore */ })
          // 释放刚才获取的引用（仅 releaseClient，不加入 acquiredServerIds，
          // 避免 release() 再次 releaseClient 造成 double-release）
          this.releaseClient(row.id).catch(() => { /* ignore */ })
          continue
        }
        // listTools 成功后才登记到 acquiredServerIds，确保 release() 只释放成功的引用
        acquiredServerIds.push(row.id)
        // 更新工具缓存与状态
        this.markServerConnected(row.id, toolList).catch(() => { /* ignore */ })

        for (const tool of toolList) {
          const toolName = this.buildToolName(row.id, tool.name)
          const toolDef: ToolDefinition = {
            id: toolName,
            name: toolName,
            title: `[${row.name}] ${tool.name}`,
            description: this.buildToolDescription(row.name, tool),
            parameters: this.normalizeSchema(tool.inputSchema),
            source: 'dynamic',
            permission: 'safe',
            timeoutMs: 120000, // MCP 工具可能执行较久，2 分钟超时
            metadata: {
              mcpServerId: row.id,
              mcpServerName: row.name,
              mcpToolName: tool.name,
            },
            handler: async (args) => {
              return this.invokeMcpTool(row.id, row.name, tool.name, args || {})
            },
          }
          tools.push(toolDef)
        }
      } catch (err: any) {
        logger.warn(`Failed to attach MCP server "${row.name}" to agent: ${err.message}`)
        this.markServerError(row.id, err.message).catch(() => { /* ignore */ })
      }
    }

    return {
      tools,
      release: async () => {
        for (const sid of acquiredServerIds) {
          await this.releaseClient(sid).catch(() => { /* ignore */ })
        }
      },
    }
  }

  /** 主动调用 MCP 工具（agent handler 调用） */
  private async invokeMcpTool(serverId: string, serverName: string, toolName: string, args: Record<string, any>): Promise<any> {
    const client = await this.getActiveClient(serverId)
    if (!client) {
      throw new Error(`MCP server "${serverName}" 未连接，无法调用工具 ${toolName}`)
    }
    const result = await client.callTool(toolName, args)
    if (result.isError) {
      // MCP 协议规定 isError=true 时 content 中包含错误信息
      const errText = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
      throw new Error(errText || `MCP 工具 ${toolName} 调用失败`)
    }
    // 标准化为 agent 可读的字符串/对象
    return this.formatToolResult(result.content, result.raw)
  }

  /**
   * 将 MCP content 数组（可能含 text/image/resource 等类型）格式化为 agent 友好输出。
   * 优先返回纯文本拼接；若只有单个 text 项则直接返回字符串，否则返回结构化对象。
   */
  private formatToolResult(content: any[], raw: any): any {
    if (!Array.isArray(content) || content.length === 0) {
      return typeof raw === 'string' ? raw : JSON.stringify(raw)
    }
    const textParts: string[] = []
    const otherParts: any[] = []
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') {
        textParts.push(c.text)
      } else {
        otherParts.push(c)
      }
    }
    if (otherParts.length === 0) {
      // 仅文本：返回拼接字符串
      return textParts.join('\n')
    }
    // 含非文本内容：返回结构化对象
    return {
      text: textParts.join('\n'),
      other: otherParts,
      raw,
    }
  }

  // ============================================================
  // 活跃 client 管理（引用计数 + 空闲自动关闭）
  // ============================================================

  private async getOrCreateClient(row: DBMcpServerRow): Promise<McpClient> {
    const existing = this.activeClients.get(row.id)
    if (existing) {
      existing.refCount++
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer)
        existing.idleTimer = null
      }
      return existing.client
    }
    const config: McpServerConfig = {
      id: row.id,
      name: row.name,
      transport_type: row.transport_type as any,
      command: row.command || undefined,
      args: this.safeParse(row.args_json, []),
      env: this.safeParse(row.env_json, {}),
      url: row.url || undefined,
      headers: this.safeParse(row.headers_json, {}),
    }
    const client = createMcpClient(config)
    await client.initialize()
    const entry: ActiveClientEntry = {
      client,
      refCount: 1,
      idleTimer: null,
      serverName: row.name,
    }
    this.activeClients.set(row.id, entry)
    logger.info(`MCP client created for server "${row.name}" (id=${row.id})`)
    return client
  }

  private async getActiveClient(serverId: string): Promise<McpClient | null> {
    const entry = this.activeClients.get(serverId)
    return entry?.client || null
  }

  /** 释放一次引用；引用归零时启动空闲 timer */
  private async releaseClient(serverId: string): Promise<void> {
    const entry = this.activeClients.get(serverId)
    if (!entry) return
    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount === 0) {
      // 启动空闲 timer，超时后真正关闭
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
      entry.idleTimer = setTimeout(() => {
        this.closeActiveClient(serverId).catch(() => { /* ignore */ })
      }, IDLE_CLOSE_MS)
    }
  }

  /** 强制关闭并移除活跃 client（配置变更 / 删除 / 禁用时调用） */
  private async closeActiveClient(serverId: string): Promise<void> {
    const entry = this.activeClients.get(serverId)
    if (!entry) return
    this.activeClients.delete(serverId)
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    try {
      await entry.client.close()
      logger.info(`MCP client closed for server "${entry.serverName}" (id=${serverId})`)
    } catch (err: any) {
      logger.debug(`MCP client close error for "${entry.serverName}": ${err.message}`)
    }
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  private validateConfig(config: McpServerConfig): void {
    if (!config.name || !config.name.trim()) {
      throw new Error('MCP server 名称不能为空')
    }
    if (!config.transport_type) {
      throw new Error('MCP server 传输方式不能为空')
    }
    if (config.transport_type === 'stdio') {
      if (!config.command || !config.command.trim()) {
        throw new Error('stdio 模式必须指定 command')
      }
    } else if (config.transport_type === 'streamableHttp' || config.transport_type === 'sse') {
      if (!config.url || !config.url.trim()) {
        throw new Error('HTTP/SSE 模式必须指定 URL')
      }
      try {
        // eslint-disable-next-line no-new
        new URL(config.url)
      } catch {
        throw new Error('URL 格式不合法')
      }
    } else {
      throw new Error(`不支持的传输方式: ${config.transport_type}`)
    }
  }

  private rowToInfo(row: DBMcpServerRow): McpServerInfo {
    return {
      id: row.id,
      employee_id: row.employee_id,
      name: row.name,
      transport_type: row.transport_type as any,
      command: row.command || undefined,
      args: this.safeParse(row.args_json, []),
      env: this.safeParse(row.env_json, {}),
      url: row.url || undefined,
      headers: this.safeParse(row.headers_json, {}),
      is_enabled: row.is_enabled === 1,
      status: row.status as any,
      last_error: row.last_error || undefined,
      tools: this.safeParse(row.tools_json, []),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  private safeParse<T>(json: string, fallback: T): T {
    try {
      return JSON.parse(json) as T
    } catch {
      return fallback
    }
  }

  /** 注入 agent 的工具名：mcp_<serverId前8位>_<原始工具名>，避免命名冲突 */
  private buildToolName(serverId: string, originalName: string): string {
    const prefix = serverId.substring(0, 8)
    // 清理原始工具名中的非法字符（保留字母数字下划线连字符）
    const safe = originalName.replace(/[^a-zA-Z0-9_-]/g, '_')
    return `mcp_${prefix}_${safe}`
  }

  private buildToolDescription(serverName: string, tool: McpToolInfo): string {
    const desc = tool.description || ''
    const suffix = `（MCP 来源：${serverName}）`
    if (!desc) return suffix.slice(1, -1) // 仅保留来源
    return `${desc}\n${suffix}`.trim()
  }

  /** 规范化 MCP 工具的 inputSchema 为 OpenAI function schema 格式 */
  private normalizeSchema(schema: any): { type: 'object'; properties: Record<string, any>; required?: string[] } {
    if (!schema || typeof schema !== 'object') {
      return { type: 'object', properties: {} }
    }
    return {
      type: 'object',
      properties: schema.properties || {},
      required: Array.isArray(schema.required) ? schema.required : undefined,
    }
  }

  private async markServerError(serverId: string, errorMessage: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    try {
      this.db.getDb().prepare(`
        UPDATE employee_mcp_servers
        SET status = 'error', last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(errorMessage.substring(0, 1000), now, serverId)
    } catch { /* ignore */ }
  }

  private async markServerConnected(serverId: string, tools: McpToolInfo[]): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    try {
      this.db.getDb().prepare(`
        UPDATE employee_mcp_servers
        SET status = 'connected', last_error = NULL, tools_json = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(tools), now, serverId)
    } catch { /* ignore */ }
  }

  /** 关闭所有活跃 client（应用退出时调用） */
  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.activeClients.keys())
    await Promise.all(ids.map((id) => this.closeActiveClient(id)))
  }
}

export default McpRegistryService
