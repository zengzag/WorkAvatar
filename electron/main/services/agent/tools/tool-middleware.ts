import { ToolCallResult } from './types'

export type ToolMiddlewareFn = (
  toolName: string,
  args: Record<string, any>,
  next: () => Promise<ToolCallResult>
) => Promise<ToolCallResult>

export interface ToolMiddleware {
  name: string
  fn: ToolMiddlewareFn
}

export class ToolMiddlewareChain {
  private middlewares: ToolMiddleware[] = []

  use(middleware: ToolMiddleware): ToolMiddlewareChain {
    this.middlewares.push(middleware)
    return this
  }

  async execute(
    toolName: string,
    args: Record<string, any>,
    handler: () => Promise<ToolCallResult>
  ): Promise<ToolCallResult> {
    let index = 0

    const next = async (): Promise<ToolCallResult> => {
      if (index >= this.middlewares.length) {
        return handler()
      }

      const middleware = this.middlewares[index]
      index++

      return middleware.fn(toolName, args, next)
    }

    return next()
  }
}

export function createTimeoutMiddleware(defaultTimeoutMs: number = 30000): ToolMiddleware {
  return {
    name: 'timeout',
    fn: async (toolName, _args, next) => {
      const timeoutMs = _args._timeoutMs ?? defaultTimeoutMs
      delete _args._timeoutMs

      let timer: NodeJS.Timeout | undefined
      try {
        const result = await Promise.race([
          next(),
          new Promise<ToolCallResult>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${timeoutMs}ms`)), timeoutMs)
          }),
        ])
        return result
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}

/** 判断错误是否可重试：仅对瞬时错误重试，避免对不可恢复错误浪费重试配额 */
export function isRetryableToolError(error: any): boolean {
  if (!error) return false
  const msg = String(error.message || error).toLowerCase()
  // 超时、网络、速率限制、服务端错误可重试
  if (msg.includes('timeout') || msg.includes('timed out')) return true
  if (msg.includes('econnreset') || msg.includes('enetunreach') || msg.includes('econnrefused')) return true
  if (msg.includes('rate limit') || msg.includes('429')) return true
  if (msg.includes('socket hang up')) return true
  // 5xx 服务端错误
  if (error?.status >= 500 || error?.statusCode >= 500) return true
  return false
}

export function createRetryMiddleware(maxRetries: number = 2, baseDelayMs: number = 1000): ToolMiddleware {
  return {
    name: 'retry',
    fn: async (toolName, _args, next) => {
      let lastError: Error | null = null

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await next()
          if (result.success) return result

          // 仅对可重试的错误（瞬时故障）进行重试，参数错误/权限拒绝等不重试
          if (attempt < maxRetries && isRetryableToolError(new Error(result.error || ''))) {
            const delay = baseDelayMs * Math.pow(2, attempt)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
          lastError = new Error(result.error || 'Tool execution failed')
        } catch (error: any) {
          lastError = error
          if (attempt < maxRetries && isRetryableToolError(error)) {
            const delay = baseDelayMs * Math.pow(2, attempt)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }
      }

      return {
        success: false,
        error: lastError?.message || 'Max retries reached',
        toolName,
      }
    },
  }
}

export function createLoggingMiddleware(logger: (level: string, action: string, data: any) => void): ToolMiddleware {
  return {
    name: 'logging',
    fn: async (toolName, args, next) => {
      const startTime = Date.now()
      logger('info', 'tool_call_start', { tool: toolName, args })

      try {
        const result = await next()
        const latencyMs = Date.now() - startTime
        logger('info', 'tool_call_end', { tool: toolName, latencyMs, success: result.success })
        return result
      } catch (error: any) {
        const latencyMs = Date.now() - startTime
        logger('error', 'tool_call_error', { tool: toolName, latencyMs, error: error.message })
        throw error
      }
    },
  }
}

export function createPermissionMiddleware(
  isAllowed: (toolName: string) => boolean,
  onDenied?: (toolName: string) => void
): ToolMiddleware {
  return {
    name: 'permission',
    fn: async (toolName, _args, next) => {
      if (!isAllowed(toolName)) {
        onDenied?.(toolName)
        return {
          success: false,
          error: `Tool "${toolName}" is not allowed`,
          toolName,
        }
      }
      return next()
    },
  }
}

export function createResultSizeMiddleware(maxResultSize: number = 50000): ToolMiddleware {
  return {
    name: 'result_size',
    fn: async (_toolName, _args, next) => {
      const result = await next()

      if (result.success && result.output) {
        const outputStr = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
        if (outputStr.length > maxResultSize) {
          const truncated = outputStr.substring(0, maxResultSize)
          return {
            ...result,
            output: truncated + `\n\n[结果已截断，原始大小: ${outputStr.length} 字符]`,
          }
        }
      }

      return result
    },
  }
}
