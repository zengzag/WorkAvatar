/**
 * 插件工具中间件 → 宿主 ToolMiddleware 适配层。
 * 插件中间件以链首守卫挂到数字员工上：可观察/改写参数、短路阻断、改写结果。
 * 异常收敛为错误结果而非裸 throw，避免不可信代码逃逸宿主工具执行链。
 */
import type { ToolMiddleware } from '../agent/tools/tool-middleware'
import type { ToolCallResult } from '../agent/tools/types'
import type { GeneratedFileInfo } from '../../../shared/types'
import type { PluginToolMiddleware, PluginToolResult } from '../../../../plugin-sdk/src'

/** 还原透传宿主结果（插件直接返回 next() 的情形，含 rawOutput/latencyMs 等调试字段） */
function normalizeResult(result: PluginToolResult | undefined, fallbackToolName: string): ToolCallResult {
  if (!result) return { success: true, output: '', toolName: fallbackToolName }
  const asHost = result as Partial<ToolCallResult>
  return {
    success: result.success ?? asHost.success ?? true,
    output: result.output ?? asHost.output ?? '',
    error: result.error ?? asHost.error,
    toolName: result.toolName ?? asHost.toolName ?? fallbackToolName,
    rawOutput: asHost.rawOutput,
    latencyMs: asHost.latencyMs,
    generatedFiles: (result.generatedFiles ?? asHost.generatedFiles) as GeneratedFileInfo[] | undefined,
  }
}

/** 把插件中间件包装为主进程 ToolMiddleware（name 带 pluginId 便于识别/去重） */
export function toToolMiddleware(pluginMiddle: PluginToolMiddleware, pluginId: string): ToolMiddleware {
  return {
    name: `plugin:${pluginId}:${pluginMiddle.name}`,
    fn: async (toolName, args, next) => {
      try {
        const result = await pluginMiddle.fn(toolName, args, next as unknown as () => Promise<PluginToolResult>)
        return normalizeResult(result, toolName)
      } catch (err: any) {
        return { success: false, error: err?.message || String(err), toolName }
      }
    },
  }
}