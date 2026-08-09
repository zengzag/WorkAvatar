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
      const middlewareParams = { ...toolParams }
      if (tool.timeoutMs) {
        middlewareParams._timeoutMs = tool.timeoutMs
      }
      if (tool.noRetry) {
        middlewareParams._noRetry = true
      }

      const result = await this.middlewareChain.execute(toolName, middlewareParams, async () => {
        const result = await tool.handler(toolParams, context)

        const success = result?.success !== false
        const output = result?.output !== undefined
          ? result.output
          : this.serializeResult(result, ['success', 'error', 'toolName', 'rawOutput', 'output'])
        const error = result?.error

        return {
          success,
          output,
          error,
          toolName,
          rawOutput: result,
          generatedFiles: result?.generatedFiles,
        }
      })

      return {
        ...result,
        latencyMs: Date.now() - startTime,
      }
    } catch (error: any) {
      return {
        success: false,
        error: this.formatUncaughtError(toolName, toolParams, error),
        toolName,
        latencyMs: Date.now() - startTime,
      }
    }
  }

  /** 格式化工具未捕获异常：包含工具名、参数摘要、错误信息与堆栈首行 */
  private formatUncaughtError(toolName: string, params: Record<string, any>, error: any): string {
    const msg = error?.message || String(error)
    const parts: string[] = [`工具 "${toolName}" 抛出未捕获异常: ${msg}`]

    // 参数摘要（截断长值，避免错误信息爆掉 LLM 上下文）
    try {
      const argParts: string[] = []
      for (const [k, v] of Object.entries(params || {})) {
        if (k.startsWith('_')) continue
        let val: string
        if (typeof v === 'string') val = v
        else if (v === undefined) val = 'undefined'
        else if (v === null) val = 'null'
        else { try { val = JSON.stringify(v) } catch { val = String(v) } }
        if (val.length > 200) val = val.slice(0, 200) + `…(${val.length}字符)`
        argParts.push(`${k}=${val}`)
      }
      if (argParts.length > 0) parts.push(`参数: ${argParts.join(', ')}`)
    } catch { /* 忽略参数摘要失败 */ }

    // 错误类型与堆栈首行（帮助定位代码位置）
    if (error?.constructor?.name && error.constructor.name !== 'Error') {
      parts.push(`错误类型: ${error.constructor.name}`)
    }
    if (error?.stack) {
      const stackLines = error.stack.split('\n')
      // 取堆栈中第一处工具相关位置（含 .tool.ts 或工具名），最多 3 行
      const relevant = stackLines
        .slice(1, 6)
        .map((l: string) => l.trim())
        .filter((l: string) => l && !l.includes('node:internal'))
        .slice(0, 3)
      if (relevant.length > 0) {
        parts.push(`堆栈:\n  ${relevant.join('\n  ')}`)
      }
    }

    parts.push('建议：检查参数是否符合工具 schema；若代码执行类工具（如 office_exec），检查生成的代码语法与运行时逻辑。')
    return parts.join('\n')
  }

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
