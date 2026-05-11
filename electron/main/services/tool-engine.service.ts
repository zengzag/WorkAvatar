import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import DatabaseService from './database.service'
import { safeCalculate, formatDate } from './common-utils'

export interface ToolDefinition {
  id: string
  name: string
  description: string
  parameters: Record<string, any>
  handler: (args: Record<string, any>) => Promise<any>
  source: 'builtin' | 'mcp' | 'skill'
  mcpServerId?: string
}

export interface MCPServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
}

export interface ToolCallResult {
  success: boolean
  output?: any
  error?: string
}

class ToolEngineService {
  private db: DatabaseService
  private tools: Map<string, ToolDefinition> = new Map()
  private mcpClients: Map<string, Client> = new Map()
  private mcpTransports: Map<string, StdioClientTransport> = new Map()
  private static instance: ToolEngineService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.registerBuiltinTools()
  }

  static getInstance(): ToolEngineService {
    if (!ToolEngineService.instance) {
      ToolEngineService.instance = new ToolEngineService()
    }
    return ToolEngineService.instance
  }

  private registerBuiltinTools(): void {
    this.tools.set('calculator', {
      id: 'calculator',
      name: 'calculator',
      description: '执行数学计算，支持加减乘除、百分比、幂运算等',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '数学表达式，如 "100 * 1.13 + 50"',
          },
        },
        required: ['expression'],
      },
      handler: async (args) => {
        try {
          const result = safeCalculate(args.expression)
          return { result: String(result) }
        } catch (error: any) {
          return { error: error.message }
        }
      },
      source: 'builtin',
    })

    this.tools.set('file_search', {
      id: 'file_search',
      name: 'file_search',
      description: '在项目文件中搜索包含指定关键词的内容',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: '项目ID',
          },
          keyword: {
            type: 'string',
            description: '搜索关键词',
          },
        },
        required: ['project_id', 'keyword'],
      },
      handler: async (args) => {
        try {
          const files = this.db.getDb().prepare(
            'SELECT id, original_name, parsed_json FROM files WHERE project_id = ? AND status = ?'
          ).all(args.project_id, 'completed') as any[]

          const results: Array<{ file: string; snippets: string[] }> = []
          for (const file of files) {
            if (!file.parsed_json) continue
            try {
              const parsed = JSON.parse(file.parsed_json)
              const text = parsed.fullText || ''
              const lines = text.split('\n')
              const snippets: string[] = []

              for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(args.keyword.toLowerCase())) {
                  const start = Math.max(0, i - 1)
                  const end = Math.min(lines.length, i + 2)
                  snippets.push(lines.slice(start, end).join('\n'))
                }
              }

              if (snippets.length > 0) {
                results.push({ file: file.original_name, snippets: snippets.slice(0, 5) })
              }
            } catch {
              // Skip
            }
          }

          return { results, totalFiles: results.length }
        } catch (error: any) {
          return { error: error.message }
        }
      },
      source: 'builtin',
    })

    this.tools.set('date_time', {
      id: 'date_time',
      name: 'date_time',
      description: '获取当前日期和时间，或进行日期计算',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['now', 'format', 'add_days'],
            description: '操作类型',
          },
          format: {
            type: 'string',
            description: '日期格式，如 "YYYY-MM-DD"',
          },
          days: {
            type: 'number',
            description: '要添加的天数',
          },
        },
        required: ['operation'],
      },
      handler: async (args) => {
        const now = new Date()
        if (args.operation === 'now') {
          return {
            date: now.toISOString().split('T')[0],
            time: now.toTimeString().split(' ')[0],
            datetime: now.toISOString(),
            timestamp: now.getTime(),
          }
        }
        if (args.operation === 'format') {
          const fmt = args.format || 'YYYY-MM-DD HH:mm:ss'
          return { formatted: formatDate(now, fmt) }
        }
        if (args.operation === 'add_days' && typeof args.days === 'number') {
          const target = new Date(now.getTime() + args.days * 24 * 60 * 60 * 1000)
          return { result: target.toISOString().split('T')[0] }
        }
        return { error: 'Unknown operation' }
      },
      source: 'builtin',
    })

    this.tools.set('string_utils', {
      id: 'string_utils',
      name: 'string_utils',
      description: '字符串处理工具：截取、替换、统计、格式化等',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['length', 'substring', 'replace', 'split', 'trim', 'uppercase', 'lowercase'],
            description: '操作类型',
          },
          text: { type: 'string', description: '输入文本' },
          start: { type: 'number', description: '起始位置' },
          end: { type: 'number', description: '结束位置' },
          search: { type: 'string', description: '搜索字符串' },
          replacement: { type: 'string', description: '替换字符串' },
          delimiter: { type: 'string', description: '分隔符' },
        },
        required: ['operation', 'text'],
      },
      handler: async (args) => {
        const { operation, text } = args
        switch (operation) {
          case 'length':
            return { result: text.length }
          case 'substring':
            return { result: text.substring(args.start || 0, args.end || text.length) }
          case 'replace':
            return { result: text.replaceAll(args.search || '', args.replacement || '') }
          case 'split':
            return { result: text.split(args.delimiter || ',') }
          case 'trim':
            return { result: text.trim() }
          case 'uppercase':
            return { result: text.toUpperCase() }
          case 'lowercase':
            return { result: text.toLowerCase() }
          default:
            return { error: 'Unknown operation' }
        }
      },
      source: 'builtin',
    })
  }

  getBuiltinTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).filter((t) => t.source === 'builtin')
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  getToolsForEmployee(employeeId: string): ToolDefinition[] {
    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as any
    if (!employee) return []

    const enabledToolIds = this.db.getDb().prepare(
      'SELECT tool_id FROM employee_tools WHERE employee_id = ? AND is_enabled = 1'
    ).all(employeeId) as any[]

    const toolIds = enabledToolIds.map((r) => r.tool_id)
    return this.getAllTools().filter((t) => toolIds.includes(t.id))
  }

  async executeTool(toolId: string, args: Record<string, any>): Promise<ToolCallResult> {
    const tool = this.tools.get(toolId)
    if (!tool) {
      return { success: false, error: `Tool ${toolId} not found` }
    }

    try {
      const output = await tool.handler(args)
      if (output && output.error) {
        return { success: false, error: output.error }
      }
      return { success: true, output }
    } catch (error: any) {
      return { success: false, error: error.message || 'Tool execution failed' }
    }
  }

  async connectMCPServer(config: MCPServerConfig): Promise<{ success: boolean; error?: string; tools?: any[] }> {
    try {
      if (this.mcpClients.has(config.id)) {
        await this.disconnectMCPServer(config.id)
      }

      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env as Record<string, string>,
      })

      const client = new Client(
        { name: 'workavatar-mcp-client', version: '1.0.0' },
        { capabilities: {} }
      )

      await client.connect(transport)

      this.mcpClients.set(config.id, client)
      this.mcpTransports.set(config.id, transport)

      const toolsResponse = await client.listTools()
      const mcpTools = (toolsResponse.tools || []).map((t: any) => ({
        id: `${config.id}_${t.name}`,
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || {},
      }))

      for (const tool of mcpTools) {
        this.tools.set(tool.id, {
          ...tool,
          handler: async (args) => {
            const c = this.mcpClients.get(config.id)
            if (!c) throw new Error('MCP client disconnected')
            const result = await c.callTool({ name: tool.name, arguments: args })
            return result
          },
          source: 'mcp',
          mcpServerId: config.id,
        })
      }

      return { success: true, tools: mcpTools }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  async disconnectMCPServer(serverId: string): Promise<void> {
    const client = this.mcpClients.get(serverId)
    if (client) {
      try {
        await client.close()
      } catch {
        // Ignore
      }
      this.mcpClients.delete(serverId)
    }

    const transport = this.mcpTransports.get(serverId)
    if (transport) {
      try {
        await transport.close()
      } catch {
        // Ignore
      }
      this.mcpTransports.delete(serverId)
    }

    for (const [toolId, tool] of this.tools.entries()) {
      if (tool.mcpServerId === serverId) {
        this.tools.delete(toolId)
      }
    }
  }
}

export default ToolEngineService
