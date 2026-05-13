export interface ToolParameter {
  name: string
  description: string
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  required?: boolean
  items?: any
  properties?: any
  enum?: string[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}

export interface ToolInfo {
  tool_name: string
  tool_title: string
  tool_description: string
  tool_params: ToolParameter[]
}

export interface ToolDefinition {
  id: string
  name: string
  title: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
  handler: (args: Record<string, any>) => Promise<any> | any
  source: 'builtin' | 'mcp' | 'skill' | 'dynamic' | 'workspace'
  mcpServerId?: string
}

export interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, any>
      required?: string[]
    }
  }
}

export interface ToolCallResult {
  success: boolean
  output?: any
  error?: string
  toolName?: string
  rawOutput?: any
}
