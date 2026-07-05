import { ToolRegistry } from './tool-registry'
import { ToolCallResult, ToolHandlerContext } from './types'
import { ToolMiddlewareChain } from './tool-middleware'

export class ToolDispatcher {
  private registry: ToolRegistry
  private middlewareChain: ToolMiddlewareChain

  constructor(registry?: ToolRegistry) {
    this.registry = registry || new ToolRegistry()
    this.middlewareChain = new ToolMiddlewareChain()
  }

  getMiddlewareChain(): ToolMiddlewareChain {
    return this.middlewareChain
  }

  async dispatch(toolName: string, toolParams: Record<string, any>, context?: ToolHandlerContext): Promise<ToolCallResult> {
    const tool = this.registry.getTool(toolName)

    if (!tool) {
      return {
        success: false,
        error: `Tool "${toolName}" not found`,
        toolName
      }
    }

    const startTime = Date.now()

    try {
      // 如果工具定义指定了 timeoutMs，注入到中间件参数中供超时中间件使用
      const middlewareParams = { ...toolParams }
      if (tool.timeoutMs) {
        middlewareParams._timeoutMs = tool.timeoutMs
      }

      const result = await this.middlewareChain.execute(toolName, middlewareParams, async () => {
        const result = await tool.handler(toolParams, context)

        // 尊重工具自身的 success 字段；未显式声明时默认为 true
        const success = result?.success !== false
        // 优先使用工具返回的 output 字段；否则序列化整个结果（排除元字段）
        const output = result?.output !== undefined
          ? result.output
          : this.serializeResult(result, ['success', 'error', 'toolName', 'rawOutput', 'output'])
        const error = result?.error

        return {
          success,
          output,
          error,
          toolName,
          rawOutput: result
        }
      })

      return {
        ...result,
        latencyMs: Date.now() - startTime,
      }
    } catch (error: any) {
      return {
        success: false,
        error: `Tool execution failed: ${error.message || error}`,
        toolName,
        latencyMs: Date.now() - startTime,
      }
    }
  }

  /**
   * 将工具返回值序列化为字符串
   * @param result 工具返回值
   * @param excludeKeys 需要排除的元字段（避免把 success/error 等元数据也喂给 LLM）
   */
  private serializeResult(result: any, excludeKeys: string[] = []): any {
    if (result === null || result === undefined) {
      return 'Tool executed successfully (no output)'
    }

    if (typeof result === 'string') {
      return result
    }

    if (typeof result === 'number' || typeof result === 'boolean') {
      return String(result)
    }

    if (typeof result === 'object') {
      try {
        if (excludeKeys.length > 0) {
          const filtered: Record<string, any> = {}
          for (const [k, v] of Object.entries(result)) {
            if (!excludeKeys.includes(k)) {
              filtered[k] = v
            }
          }
          // 如果过滤后只剩空对象，返回成功提示
          if (Object.keys(filtered).length === 0) {
            return 'Tool executed successfully'
          }
          return JSON.stringify(filtered, null, 2)
        }
        return JSON.stringify(result, null, 2)
      } catch {
        return String(result)
      }
    }

    return String(result)
  }
}
