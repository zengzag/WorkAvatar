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

  /** 插入链首（先于已有中间件执行，适用于 gate/守卫语义） */
  useFront(middleware: ToolMiddleware): ToolMiddlewareChain {
    this.middlewares.unshift(middleware)
    return this
  }

  async execute(
    toolName: string,
    args: Record<string, any>,
    handler: () => Promise<ToolCallResult>
  ): Promise<ToolCallResult> {
    // 按位置递归组合：每个中间件拿到的 next 只负责「其后」的中间件，
    // 重复调用 next()（如 retry 的第二次尝试）会从该位置重新完整走一遍下游链，
    // 保证每次尝试都经过 timeout / result_size。若用单一 index 游标推进，
    // 重试时游标已到链尾会直接命中 handler，导致超时保护与结果截断被跳过。
    const middlewares = this.middlewares
    const dispatch = (index: number): Promise<ToolCallResult> => {
      if (index >= middlewares.length) return handler()
      const middleware = middlewares[index]
      return middleware.fn(toolName, args, () => dispatch(index + 1))
    }

    return dispatch(0)
  }
}

export function createTimeoutMiddleware(defaultTimeoutMs: number = 30000): ToolMiddleware {
  return {
    name: 'timeout',
    fn: async (toolName, _args, next) => {
      // 不删除 _timeoutMs：retry 的后续尝试会重新进入本中间件，
      // 删除会导致自定义超时（如交互工具 305s）在第二次尝试时丢失、回退到默认 30s。
      // 该字段仅存在于派发给中间件的参数副本上，不会传给工具 handler。
      const timeoutMs = _args._timeoutMs ?? defaultTimeoutMs

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
      // 交互类工具（ask_user/fs 确认）标记 noRetry，超时或取消不重试
      if (_args._noRetry) {
        try {
          return await next()
        } catch (error: any) {
          return { success: false, error: error?.message || String(error), toolName }
        }
      }

      let lastResult: ToolCallResult | undefined
      let lastError: Error | null = null

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await next()
          if (result.success) return result
          lastResult = result
          // 仅对瞬时故障继续重试；参数错误/权限拒绝/文件不存在等直接返回原始结果，
          // 避免重复执行造成副作用，同时保留 output/generatedFiles 等诊断字段
          if (!isRetryableToolError(new Error(result.error || ''))) return result
        } catch (error: any) {
          lastError = error
          if (!isRetryableToolError(error)) {
            return { success: false, error: error?.message || String(error), toolName }
          }
        }

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.pow(2, attempt)))
        }
      }

      // 重试耗尽：优先返回最后一次的工具结果（保留结构化字段），否则回退错误信息
      if (lastResult) return lastResult
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
        let outputStr: string
        try {
          outputStr = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
        } catch {
          // 循环引用/BigInt 等无法序列化：回退 String()，避免丢掉本应成功的结果
          outputStr = String(result.output)
        }
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
