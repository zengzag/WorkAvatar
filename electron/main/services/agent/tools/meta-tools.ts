import type { ToolDefinition, ToolHandlerContext } from './types'
import { ToolRegistry } from './tool-registry'
import { ToolDispatcher } from './tool-dispatcher'

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
function formatToolDetail(tool: ToolDefinition, _workspacePath?: string): string {
  const parts: string[] = []
  parts.push(`## ${tool.name} — ${tool.title}`)
  parts.push('')
  parts.push(tool.description)
  parts.push('')
  parts.push('参数:')
  parts.push(formatParameters(tool.parameters))
  parts.push('')
  parts.push(`调用方式: invoke_tool(tool_name="${tool.name}", args={...})`)

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

/** 截断过长的参数值，避免错误信息爆掉 LLM 上下文 */
function summarizeArgs(args: Record<string, any>, maxLen = 200): string {
  try {
    const parts: string[] = []
    for (const [k, v] of Object.entries(args || {})) {
      let val: string
      if (typeof v === 'string') val = v
      else if (v === undefined) val = 'undefined'
      else if (v === null) val = 'null'
      else {
        try { val = JSON.stringify(v) } catch { val = String(v) }
      }
      if (val.length > maxLen) val = val.slice(0, maxLen) + `…(${val.length}字符)`
      parts.push(`${k}=${val}`)
    }
    return parts.length > 0 ? parts.join(', ') : '(空)'
  } catch {
    return '(序列化失败)'
  }
}

/** 根据错误信息文本特征识别错误类型并给出修复建议 */
function diagnoseError(errorMessage: string): { type: string; hint: string } {
  const msg = errorMessage || ''
  if (/不存在|not found|找不到|未找到|无此/i.test(msg)) {
    return { type: 'not_found', hint: '检查参数是否正确（如 ID、路径、工具名），或调用 list_available_tools 重新确认可用工具与参数说明。' }
  }
  if (/超时|timeout|timed out/i.test(msg)) {
    return { type: 'timeout', hint: '工具执行超时，可尝试增大 timeout 参数（秒），或拆分任务、简化输入。' }
  }
  if (/权限|permission|denied|拒绝|取消|未授权/i.test(msg)) {
    return { type: 'permission_denied', hint: '权限被拒绝或用户取消。需用户在弹窗中授权后重试；后台任务无法弹窗时请改用工作区内路径。' }
  }
  if (/必填|required|缺少|不能为空|需要\s*\w+|invalid/i.test(msg)) {
    return { type: 'param_error', hint: '参数错误。调用 list_available_tools(tool_name=["工具名"]) 查看完整参数说明后修正参数。' }
  }
  if (/syntax|parse|json|unexpected token/i.test(msg)) {
    return { type: 'parse_error', hint: '解析失败。检查传入参数格式（如 JSON 字符串、数组、对象是否符合 schema）。' }
  }
  return { type: 'internal', hint: '工具内部异常。可检查参数是否符合规范后重试；若持续失败，调用 list_available_tools(tool_name=["工具名"]) 复查参数说明。' }
}

/** 拼装失败时返回给 LLM 的结构化上下文 */
function buildFailureContext(
  toolName: string,
  toolArgs: Record<string, any>,
  result: { error?: string; output?: any; generatedFiles?: any[] },
): string {
  const lines: string[] = []
  lines.push(`# 工具调用失败`)
  lines.push(`工具: ${toolName}`)
  lines.push(`参数: ${summarizeArgs(toolArgs)}`)
  lines.push('')

  const errorMsg = result.error || '(无错误信息)'
  const diag = diagnoseError(errorMsg)
  lines.push(`错误类型: ${diag.type}`)
  lines.push(`错误信息: ${errorMsg}`)
  lines.push(`修复建议: ${diag.hint}`)
  lines.push('')

  // 保留工具内部产出的调试上下文（console 日志、已写入文件列表等）
  if (result.output !== undefined && result.output !== null && result.output !== '') {
    const outputStr = typeof result.output === 'string' ? result.output : (() => { try { return JSON.stringify(result.output, null, 2) } catch { return String(result.output) } })()
    if (outputStr.trim()) {
      lines.push('--- 工具输出（调试上下文）---')
      lines.push(outputStr)
      lines.push('')
    }
  }

  if (result.generatedFiles && result.generatedFiles.length > 0) {
    lines.push(`--- 错误前已生成文件（共 ${result.generatedFiles.length} 个，可能需要清理）---`)
    for (const f of result.generatedFiles) {
      lines.push(`  - ${(f as any).path || (f as any).name || JSON.stringify(f)}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 创建 invoke_tool 元工具
 *
 * 通用按需工具调用入口，通过 dispatcher 分发到实际工具 handler，
 * 复用中间件链（超时/重试/大小限制）。
 *
 * 失败时返回结构化错误上下文（参数摘要、错误类型、修复建议、工具输出、已生成文件），
 * 便于 LLM 判断具体原因并修正参数或代码后重试。
 */
export function createInvokeToolTool(
  dispatcher: ToolDispatcher,
  registry: ToolRegistry
): ToolDefinition {
  return {
    id: 'invoke_tool',
    name: 'invoke_tool',
    title: '调用按需工具',
    description: '调用按需工具。先用 list_available_tools 获取工具名和参数说明，再将参数组装为 args 对象传入。args 的结构由对应工具的参数说明决定。失败时返回结构化错误上下文（错误类型、修复建议、工具输出、已生成文件），请据此修正参数或代码后重试。',
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
        return {
          success: false,
          error: '参数错误：缺少 tool_name。',
          output: buildFailureContext('invoke_tool', args || {}, {
            error: 'invoke_tool 必填参数 tool_name 缺失。args 结构应为 { tool_name: string, args: object }。',
          }),
        }
      }

      const toolArgs = (args?.args && typeof args.args === 'object') ? args.args : {}
      const tool = registry.getTool(toolName)

      if (!tool) {
        const available = registry.getOnDemandTools().map(t => t.name).join(', ')
        const error = `工具 "${toolName}" 不存在。可用工具: ${available || '(无)'}`
        return {
          success: false,
          error,
          output: buildFailureContext(toolName, toolArgs, {
            error,
          }),
        }
      }

      // 通过 dispatcher 调用，复用中间件链
      const result = await dispatcher.dispatch(toolName, toolArgs, context)

      if (result.success) {
        return {
          success: true,
          output: result.output,
          generatedFiles: result.generatedFiles,
        }
      }

      // 失败时保留 error 作为简短摘要，output 返回完整结构化上下文供 LLM 诊断
      return {
        success: false,
        error: result.error || `工具 "${toolName}" 执行失败`,
        output: buildFailureContext(toolName, toolArgs, {
          error: result.error,
          output: result.output,
          generatedFiles: result.generatedFiles,
        }),
        generatedFiles: result.generatedFiles,
      }
    },
    source: 'builtin',
    permission: 'safe',
  }
}
