import type { ToolDefinition, ToolHandlerContext } from './types'
import { ToolRegistry } from './tool-registry'
import { ToolDispatcher } from './tool-dispatcher'
import { buildOfficeGuide } from './office-prompts'

/**
 * 元工具：list_available_tools + invoke_tool
 *
 * 设计目标：
 * - 常驻 LLM tools 数组，保持对话全程 tools 不变（KV cache 友好）
 * - 按需工具（KMS/日历/Office/Shell 等）的 schema 通过 list_available_tools 的返回值
 *   以 tool result 消息形式进入对话历史（append-only，不破坏前缀缓存）
 * - invoke_tool 通用调用入口，复用现有 dispatcher 中间件链（超时/重试/大小限制）
 */

/** 将工具参数 schema 格式化为人类可读的参数说明 */
function formatParameters(params: ToolDefinition['parameters']): string {
  const properties = params.properties || {}
  const requiredSet = new Set(params.required || [])
  const lines: string[] = []

  for (const [name, prop] of Object.entries(properties)) {
    const p = prop as any
    const parts: string[] = []
    parts.push(`  ${name} (${p.type || 'string'}, ${requiredSet.has(name) ? '必填' : '可选'})`)
    if (p.description) parts.push(`: ${p.description}`)
    if (p.enum) parts.push(` [枚举: ${p.enum.join(' / ')}]`)
    if (p.default !== undefined) parts.push(` [默认: ${JSON.stringify(p.default)}]`)
    if (p.minimum !== undefined) parts.push(` [最小: ${p.minimum}]`)
    if (p.maximum !== undefined) parts.push(` [最大: ${p.maximum}]`)
    lines.push(parts.join(''))
  }

  return lines.length > 0 ? lines.join('\n') : '  (无参数)'
}

/** 摘要模式：返回所有按需工具的名称 + 精炼功能与场景描述（summary 优先，回退 title） */
function formatToolsSummary(tools: ToolDefinition[]): string {
  const lines = tools.map(t => `- ${t.name}: ${t.summary || t.title}`)
  return [
    `可用按需工具（共 ${tools.length} 个）：`,
    '',
    lines.join('\n'),
    '',
    '调用 invoke_tool(tool_name="工具名", args={...}) 使用工具。',
    '如需查看工具的详细参数说明，调用 list_available_tools(tool_name="工具名") 或 list_available_tools(tool_name=["工具名1", "工具名2"]) 一次获取多个工具详情。',
  ].join('\n')
}

/** 详情模式：返回指定工具的完整参数说明 */
function formatToolDetail(tool: ToolDefinition, workspacePath?: string): string {
  const parts: string[] = []
  parts.push(`## ${tool.name} — ${tool.title}`)
  parts.push('')
  parts.push(tool.description)
  parts.push('')
  parts.push('参数:')
  parts.push(formatParameters(tool.parameters))
  parts.push('')
  parts.push(`调用方式: invoke_tool(tool_name="${tool.name}", args={...})`)

  // office_exec 追加完整 Office 指南（含代码模板与陷阱清单）
  if (tool.name === 'office_exec') {
    parts.push('')
    parts.push(buildOfficeGuide(workspacePath, ['docx', 'pptx', 'xlsx']))
  }

  return parts.join('\n')
}

/**
 * 创建 list_available_tools 元工具
 *
 * - 无参数：返回所有按需工具的名称 + 一句话描述（摘要模式）
 * - 传入 tool_name（字符串或字符串数组）：返回指定工具的完整参数说明（详情模式），支持一次获取多个工具详情
 */
export function createListAvailableToolsTool(
  registry: ToolRegistry,
  workspacePath?: string
): ToolDefinition {
  return {
    id: 'list_available_tools',
    name: 'list_available_tools',
    title: '列出可用工具',
    description: '列出当前可用的按需工具。无参数时返回所有工具的名称和一句话功能描述（摘要模式）；传入 tool_name 时返回指定工具的完整参数说明（详情模式），tool_name 支持字符串或字符串数组，可一次获取多个工具详情。当常用工具无法满足需求时（如需检索资料库、管理日程、生成文档等），先调用本工具浏览可用工具，再按需获取详细参数说明，最后用 invoke_tool 调用。',
    parameters: {
      type: 'object',
      properties: {
        tool_name: {
          description: '工具名（字符串）或工具名列表（字符串数组）。传入时返回这些工具的完整参数说明（详情模式）；不传则返回所有工具摘要（摘要模式）',
        },
      },
    },
    handler: (args: any) => {
      const onDemandTools = registry.getOnDemandTools()

      if (onDemandTools.length === 0) {
        return { success: true, output: '当前没有可用的按需工具。' }
      }

      // 详情模式：tool_name 支持单个字符串或字符串数组
      const rawName = args?.tool_name
      if (rawName !== undefined && rawName !== null) {
        const requestedNames: string[] = Array.isArray(rawName)
          ? rawName.map(n => String(n).trim()).filter(Boolean)
          : [String(rawName).trim()]

        if (requestedNames.length === 0) {
          return { success: false, error: 'tool_name 不能为空。' }
        }

        const found: ToolDefinition[] = []
        const missing: string[] = []
        for (const name of requestedNames) {
          const tool = onDemandTools.find(t => t.name === name)
          if (tool) {
            found.push(tool)
          } else {
            missing.push(name)
          }
        }

        const sections: string[] = []
        if (found.length > 0) {
          sections.push(found.map(t => formatToolDetail(t, workspacePath)).join('\n\n---\n\n'))
        }
        if (missing.length > 0) {
          const available = onDemandTools.map(t => t.name).join(', ')
          sections.push(`未找到工具: ${missing.join(', ')}。可用工具: ${available}`)
        }

        return {
          success: found.length > 0,
          output: sections.join('\n\n'),
        }
      }

      // 摘要模式
      return { success: true, output: formatToolsSummary(onDemandTools) }
    },
    source: 'builtin',
    permission: 'safe',
  }
}

/**
 * 创建 invoke_tool 元工具
 *
 * 通用按需工具调用入口，通过 dispatcher 分发到实际工具 handler，
 * 复用中间件链（超时/重试/大小限制）。
 */
export function createInvokeToolTool(
  dispatcher: ToolDispatcher,
  registry: ToolRegistry
): ToolDefinition {
  return {
    id: 'invoke_tool',
    name: 'invoke_tool',
    title: '调用按需工具',
    description: '调用按需工具。先用 list_available_tools 获取工具名和参数说明，再将参数组装为 args 对象传入。args 的结构由对应工具的参数说明决定。',
    parameters: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          description: '要调用的工具名（来自 list_available_tools 返回）',
        },
        args: {
          type: 'object',
          description: '工具参数对象，结构由 list_available_tools 返回的参数说明决定',
          additionalProperties: true,
        },
      },
      required: ['tool_name', 'args'],
    },
    handler: async (args: any, context?: ToolHandlerContext) => {
      const toolName = String(args?.tool_name || '').trim()
      if (!toolName) {
        return { success: false, error: '请提供 tool_name 参数。' }
      }

      const toolArgs = (args?.args && typeof args.args === 'object') ? args.args : {}
      const tool = registry.getTool(toolName)

      if (!tool) {
        return {
          success: false,
          error: `工具 "${toolName}" 不存在。请先调用 list_available_tools 查看可用工具。`,
        }
      }

      // 通过 dispatcher 调用，复用中间件链
      const result = await dispatcher.dispatch(toolName, toolArgs, context)
      return {
        success: result.success,
        output: result.success ? result.output : result.error,
        generatedFiles: result.generatedFiles,
      }
    },
    source: 'builtin',
    permission: 'safe',
  }
}
