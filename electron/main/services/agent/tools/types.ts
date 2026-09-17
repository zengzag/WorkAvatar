import type { GeneratedFileInfo } from '../../../../shared/types'

export type ToolPermission = 'safe' | 'requires_confirmation' | 'dangerous'

/**
 * 工具执行上下文，传递给工具 handler 的运行时上下文
 */
export interface ToolHandlerContext {
  /** 工具执行的中间进度回调（用于UI展示，不进入LLM上下文） */
  onProgress?: (progress: any) => void
  /** 当前模型是否支持图片（视觉）输入；未设置视为支持（保守输出中性文案） */
  imageSupport?: boolean
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
  source: 'builtin' | 'skill' | 'dynamic' | 'plugin'
  permission?: ToolPermission
  timeoutMs?: number
  /** 禁用 retry 中间件：适用于交互类工具（ask_user/fs 确认），超时或取消不应重试 */
  noRetry?: boolean
  metadata?: Record<string, any>
  /** 按需工具：不加入 LLM API 的 tools 数组，通过 list_available_tools + invoke_tool 发现和调用 */
  onDemand?: boolean
  /**
   * 摘要：list_available_tools 无参调用（摘要模式）时显示的精炼描述。
   * 一句话说明工具大致功能与使用场景；不传则回退到 title。
   * 详细参数说明、调用方式、陷阱等放在 description（详情模式展示）。
   */
  summary?: string
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
  generatedFiles?: GeneratedFileInfo[]
  /** 工具产出的图片（data URL），仅用于视觉注入与 UI 展示，不作为文本进 LLM 上下文 */
  images?: string[]
}
