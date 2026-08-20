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
    onDemand: false,
    handler: (args) => {
      const { result } = modelSession.applyTool(tool.name, args)
      if (result.ok) {
        // 将结构化 data 序列化进 output，确保 LLM 能读到完整内容（如 get_model_json 的 JSON）
        let output = result.message ?? ''
        if (result.data !== undefined) {
          try {
            const dataStr = JSON.stringify(result.data, null, 2)
            if (dataStr && dataStr !== '{}') output = output ? `${output}\n\n${dataStr}` : dataStr
          } catch { /* 忽略序列化失败，保留 message */ }
        }
        return {
          success: true,
          output,
          ...(result.data !== undefined ? { data: result.data } : {})
        }
      }
      return { success: false, error: result.error ?? '执行失败' }
    }
  }))
}
