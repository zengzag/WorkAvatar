import { ToolDefinition, OpenAIToolDefinition } from './types'

export class ToolRegistry {
  private functionMappings: Map<string, ToolDefinition> = new Map()
  private openaiFunctionSchemas: OpenAIToolDefinition[] = []

  registerTool(tool: ToolDefinition): boolean {
    if (this.functionMappings.has(tool.name)) {
      return false
    }

    this.functionMappings.set(tool.name, tool)

    // 按需工具不加入 LLM API 的 tools 数组，通过 list_available_tools + invoke_tool 发现和调用
    if (!tool.onDemand) {
      this.openaiFunctionSchemas.push(this.toOpenAISchema(tool))
    }
    return true
  }

  registerTools(tools: ToolDefinition[]): boolean {
    let success = true
    for (const tool of tools) {
      if (!this.registerTool(tool)) {
        success = false
      }
    }
    return success
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.functionMappings.get(name)
  }

  getTools(): ToolDefinition[] {
    return Array.from(this.functionMappings.values())
  }

  /** 返回所有按需工具（不在 LLM tools 数组中，通过 invoke_tool 调用） */
  getOnDemandTools(): ToolDefinition[] {
    return Array.from(this.functionMappings.values()).filter(t => t.onDemand)
  }

  getOpenAISchemas(): OpenAIToolDefinition[] {
    // 连 function 一层一起浅拷贝：调用方就地改 function.name 不会污染注册表内部 schema；
    // parameters 保持引用共享，避免每次调用深拷贝整个 schema 的开销
    return this.openaiFunctionSchemas.map(s => ({ ...s, function: { ...s.function } }))
  }

  getOpenAISchemasByNames(names: string[]): OpenAIToolDefinition[] {
    const nameSet = new Set(names)
    // 与 getOpenAISchemas 一致：返回副本，避免调用方就地修改污染注册表内部 schema
    return this.openaiFunctionSchemas
      .filter(s => nameSet.has(s.function.name))
      .map(s => ({ ...s, function: { ...s.function } }))
  }

  unregisterTool(name: string): boolean {
    if (!this.functionMappings.has(name)) {
      return false
    }

    this.functionMappings.delete(name)
    this.openaiFunctionSchemas = this.openaiFunctionSchemas.filter(
      s => s.function.name !== name
    )
    return true
  }

  private toOpenAISchema(tool: ToolDefinition): OpenAIToolDefinition {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }
  }
}
