/**
 * 插件贡献的 agent 工具定义。
 * 与宿主内部 ToolDefinition 结构兼容，但：
 * - 无 source 字段（宿主固定标记为插件来源）
 * - handler 上下文收窄为 onProgress
 * - id 不得与已注册工具冲突（含内核内置工具），冲突则整组拒绝注册
 */

export interface PluginToolContext {
  /** 工具执行进度回调（用于 UI 展示，不进入 LLM 上下文） */
  onProgress?: (progress: unknown) => void
}

export interface PluginToolDefinition {
  id: string
  name: string
  title: string
  /** 详情模式描述：参数说明、调用方式、陷阱 */
  description: string
  /** 摘要模式一句话描述，缺省回退 title */
  summary?: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  handler: (args: Record<string, unknown>, context: PluginToolContext) => Promise<unknown> | unknown
  permission?: 'safe' | 'requires_confirmation' | 'dangerous'
  /** 执行超时毫秒数 */
  timeoutMs?: number
  /** 禁用 retry 中间件（交互类工具） */
  noRetry?: boolean
  /** 按需工具：不进入 LLM tools 数组，经 list_available_tools 发现 */
  onDemand?: boolean
  metadata?: Record<string, unknown>
}
