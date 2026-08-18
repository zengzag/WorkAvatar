// 将数模操作工具包装为宿主 agent 工具（registerAgentTools）

import type { PluginToolDefinition } from '../../../plugin-sdk/src'
import { MODEL_TOOLS } from '../shared/model-tools'
import { modelSession } from './model-session'

/**
 * 生成数据模型 agent 工具。handler 统一调用 modelSession.applyTool，
 * 返回 { success, output, ...data } 供 LLM 消费。
 */
export function createDataModelAgentTools(): PluginToolDefinition[] {
  return MODEL_TOOLS.map((tool) => ({
    id: tool.name,
    name: tool.name,
    title: tool.name,
    description: tool.description,
    summary: tool.description.split('。')[0],
    parameters: tool.parameters as PluginToolDefinition['parameters'],
    onDemand: true,
    handler: (args) => {
      const { result } = modelSession.applyTool(tool.name, args)
      if (result.ok) {
        return {
          success: true,
          output: result.message ?? '',
          ...(result.data !== undefined ? { data: result.data } : {})
        }
      }
      return { success: false, error: result.error ?? '执行失败' }
    }
  }))
}
