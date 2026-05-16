import { ToolDefinition, OpenAIToolDefinition, ToolInfo, ToolParameter, ToolPermission } from './types'

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

    this.openaiFunctionSchemas.push(this.toOpenAISchema(tool))
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

  getToolsBySource(source: ToolDefinition['source']): ToolDefinition[] {
    return this.getTools().filter(t => t.source === source)
  }

  getToolsByPermission(permission: ToolPermission): ToolDefinition[] {
    return this.getTools().filter(t => (t.permission || 'safe') === permission)
  }

  getOpenAISchemas(): OpenAIToolDefinition[] {
    return [...this.openaiFunctionSchemas]
  }

  getOpenAISchemasByNames(names: string[]): OpenAIToolDefinition[] {
    const nameSet = new Set(names)
    return this.openaiFunctionSchemas.filter(s => nameSet.has(s.function.name))
  }

  getToolsString(): string {
    return JSON.stringify(this.openaiFunctionSchemas, null, 2)
  }

  filterTools(toolReflectionResult: string): OpenAIToolDefinition[] {
    try {
      let refinedContent = toolReflectionResult.trim()
      if (refinedContent.startsWith('```json')) {
        refinedContent = refinedContent.substring(7)
      }
      if (refinedContent.endsWith('```')) {
        refinedContent = refinedContent.substring(0, refinedContent.length - 3)
      }
      refinedContent = refinedContent.trim()

      const parsedData = JSON.parse(refinedContent)
      const validTools = new Set(
        (parsedData.tools || []).map((t: any) => (t.name || '').toLowerCase().trim())
      )

      return this.openaiFunctionSchemas.filter(schema => {
        const name = schema.function.name.toLowerCase().trim()
        return validTools.has(name)
      })
    } catch (error) {
      throw new Error(`Tool filtering failed: ${error}`)
    }
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

  hasTool(name: string): boolean {
    return this.functionMappings.has(name)
  }

  getToolNames(): string[] {
    return Array.from(this.functionMappings.keys())
  }

  getToolCount(): number {
    return this.functionMappings.size
  }

  clear(): void {
    this.functionMappings.clear()
    this.functionInfo.clear()
    this.openaiFunctionSchemas = []
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
