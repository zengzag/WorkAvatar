export const KB_MCP_CHANNELS = {
  KB_MCP_START: 'kb-mcp:start',
  KB_MCP_STOP: 'kb-mcp:stop',
  KB_MCP_GET_STATUS: 'kb-mcp:get-status',
  KB_MCP_GET_CONFIG: 'kb-mcp:get-config',
  KB_MCP_SET_CONFIG: 'kb-mcp:set-config',
} as const

export interface KBMCPSetConfigParams {
  enabled?: boolean
  port?: number
  allowedKbIds?: string[]
  apiKey?: string
}
