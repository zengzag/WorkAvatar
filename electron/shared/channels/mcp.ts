/**
 * 数字员工 MCP (Model Context Protocol) 接入相关 IPC 通道。
 *
 * 用于在员工设置页导入外部 MCP server（stdio / streamableHttp / sse 三种传输方式），
 * 并将 server 暴露的工具注入到员工 agent 的工具列表。
 * Skill 执行环境设置（uv/python/node/pip 检测与安装）也归入 MCP 设置页统一管理。
 */
export const MCP_CHANNELS = {
  // 列出指定员工的所有 MCP server（含状态与缓存工具列表）
  MCP_LIST: 'mcp:list',
  // 新增 MCP server
  MCP_ADD: 'mcp:add',
  // 更新 MCP server 配置
  MCP_UPDATE: 'mcp:update',
  // 删除 MCP server
  MCP_DELETE: 'mcp:delete',
  // 启用 / 禁用 MCP server
  MCP_TOGGLE: 'mcp:toggle',
  // 测试连接：拉取一次工具列表，返回连接结果与工具清单
  MCP_TEST: 'mcp:test',
  // 刷新指定 server 的工具缓存（主动重新连接并 listTools）
  MCP_REFRESH_TOOLS: 'mcp:refresh-tools',
} as const

/** MCP 传输方式 */
export type McpTransportType = 'stdio' | 'streamableHttp' | 'sse'

/** MCP server 配置（持久化结构） */
export interface McpServerConfig {
  id?: string
  /** 用户起的友好名称，同一员工下唯一即可 */
  name: string
  transport_type: McpTransportType
  /** stdio 模式：可执行文件名或绝对路径 */
  command?: string
  /** stdio 模式：命令行参数 */
  args?: string[]
  /** stdio 模式：环境变量 */
  env?: Record<string, string>
  /** HTTP / SSE 模式：MCP 端点 URL */
  url?: string
  /** HTTP / SSE 模式：自定义请求头 */
  headers?: Record<string, string>
  /** 是否启用（禁用的 server 不会注入到 agent） */
  is_enabled?: boolean
}

/** MCP 工具信息（listTools 返回的元素） */
export interface McpToolInfo {
  /** 工具名（注入到 ToolDefinition.name 时会加前缀 mcp_<serverId>_） */
  name: string
  description: string
  /** JSON Schema 形式的入参定义 */
  inputSchema: {
    type: 'object'
    properties?: Record<string, any>
    required?: string[]
  }
}

/** MCP server 完整信息（前端展示用） */
export interface McpServerInfo extends McpServerConfig {
  id: string
  employee_id: string
  /** 连接状态：unknown / connected / disconnected / error */
  status: 'unknown' | 'connected' | 'disconnected' | 'error'
  last_error?: string
  /** 最近一次缓存的工具列表 */
  tools: McpToolInfo[]
  created_at: number
  updated_at: number
}

/** 新增 / 更新 MCP server 的请求参数 */
export interface McpSaveParams {
  employee_id: string
  config: McpServerConfig
}

/** 测试连接参数 */
export interface McpTestParams {
  config: McpServerConfig
}

/** 测试连接返回 */
export interface McpTestResult {
  success: boolean
  error?: string
  tools?: McpToolInfo[]
  /** serverInfo 字段（协议 initialize 阶段返回） */
  serverInfo?: { name?: string; version?: string }
  protocolVersion?: string
}