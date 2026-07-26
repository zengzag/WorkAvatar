import { ToolDefinition, OpenAIToolDefinition, ToolInfo, ToolParameter } from './types'

export class ToolRegistry {
  private functionMappings: Map<string, ToolDefinition> = new Map()
  private functionInfo: Map<string, ToolInfo> = new Map()
  private openaiFunctionSchemas: OpenAIToolDefinition[] = []

  registerTool(tool: ToolDefinition, toolInfo?: ToolInfo): boolean {
    if (this.functionMappings.has(tool.name)) {
      return false
    }

    this.functionMappings.set(tool.name, tool)

    if (toolInfo) {
      this.functionInfo.set(tool.name, toolInfo)
    } else {
      this.functionInfo.set(tool.name, {
        tool_name: tool.name,
        tool_title: tool.title,
        tool_description: tool.description,
        tool_params: this.convertToToolParameters(tool.parameters)
      })
    }

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
    return [...this.openaiFunctionSchemas]
  }

  getOpenAISchemasByNames(names: string[]): OpenAIToolDefinition[] {
    const nameSet = new Set(names)
    return this.openaiFunctionSchemas.filter(s => nameSet.has(s.function.name))
  }

  unregisterTool(name: string): boolean {
    if (!this.functionMappings.has(name)) {
      return false
    }

    this.functionMappings.delete(name)
    this.functionInfo.delete(name)
    this.openaiFunctionSchemas = this.openaiFunctionSchemas.filter(
      s => s.function.name !== name
    )
    return true
  }

  private convertToToolParameters(params: Record<string, any>): ToolParameter[] {
    const result: ToolParameter[] = []
    const properties = params.properties || {}
    const required = new Set(params.required || [])

    for (const [name, prop] of Object.entries(properties)) {
      const p = prop as any
      result.push({
        name,
        description: p.description || '',
        type: p.type || 'string',
        required: required.has(name),
        items: p.items,
        properties: p.properties,
        enum: p.enum,
        minimum: p.minimum,
        maximum: p.maximum,
        minLength: p.minLength,
        maxLength: p.maxLength
      })
    }

    return result
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
