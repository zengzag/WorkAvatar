import { ToolRegistry } from './tool-registry'
import { ToolCallResult } from './types'
import { ToolMiddlewareChain } from './tool-middleware'

export class ToolDispatcher {
  private registry: ToolRegistry
  private middlewareChain: ToolMiddlewareChain

  constructor(registry?: ToolRegistry) {
    this.registry = registry || new ToolRegistry()
    this.middlewareChain = new ToolMiddlewareChain()
  }

  setRegistry(registry: ToolRegistry): void {
    this.registry = registry
  }

  getMiddlewareChain(): ToolMiddlewareChain {
    return this.middlewareChain
  }

  async dispatch(toolName: string, toolParams: Record<string, any>): Promise<ToolCallResult> {
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
      const result = await this.middlewareChain.execute(toolName, toolParams, async () => {
        let result
        if (tool.handler.constructor.name === 'AsyncFunction') {
          result = await tool.handler(toolParams)
        } else {
          result = tool.handler(toolParams)
        }

        const output = this.serializeResult(result)

        return {
          success: true,
          output,
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

  async dispatchMultiple(calls: Array<{ name: string; params: Record<string, any> }>): Promise<ToolCallResult[]> {
    const results: ToolCallResult[] = []

    for (const call of calls) {
      results.push(await this.dispatch(call.name, call.params))
    }

    return results
  }

  async dispatchParallel(calls: Array<{ name: string; params: Record<string, any> }>): Promise<ToolCallResult[]> {
    return Promise.all(calls.map(call => this.dispatch(call.name, call.params)))
  }

  private serializeResult(result: any): any {
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
        return JSON.stringify(result, null, 2)
      } catch {
        return String(result)
      }
    }

    return String(result)
  }
}
