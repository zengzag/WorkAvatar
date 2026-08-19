import type { BuiltinToolCategoryId } from '../mcp/builtin-mcp-converter'

/**
 * MCP 服务配置（原 KMS 专用，现扩展为通用内置工具 MCP）。
 * 向后兼容：未设置 tool_categories 时默认仅暴露 KMS 工具，保持与旧版一致的行为。
 */
export interface KMSMCPConfig {
  enabled: boolean
  port: number
  apiKey: string
  /** 开启的内置工具类别 id 列表；未设置时回退为默认（仅 KMS，保持向后兼容）。 */
  tool_categories?: BuiltinToolCategoryId[]
}

export const DEFAULT_CONFIG: KMSMCPConfig = {
  enabled: false,
  port: 3101,
  apiKey: '',
  // 向后兼容默认：仅 KMS MCP 升级后若用户未修改过，默认开启 kms 类别，其他类别手动开启
  tool_categories: ['kms'],
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
