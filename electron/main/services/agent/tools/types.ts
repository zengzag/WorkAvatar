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

export type ToolPermission = 'safe' | 'requires_confirmation' | 'dangerous'

/**
 * 工具执行上下文，传递给工具 handler 的运行时上下文
 */
export interface ToolHandlerContext {
  /** 工具执行的中间进度回调（用于UI展示，不进入LLM上下文） */
  onProgress?: (progress: any) => void
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
  handler: (args: Record<string, any>, context?: ToolHandlerContext) => Promise<any> | any
  source: 'builtin' | 'skill' | 'dynamic'
  permission?: ToolPermission
  timeoutMs?: number
  metadata?: Record<string, any>
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
  latencyMs?: number
}
