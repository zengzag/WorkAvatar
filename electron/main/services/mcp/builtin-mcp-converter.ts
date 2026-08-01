/**
 * 通用内置工具 → MCP 工具转换器。
 *
 * 核心目的：消除 KMS MCP 与 Agent 工具之间的两套工具定义/两套 handler 的重复代码。
 * 对外暴露的 MCP 工具与智能体内部使用的工具函数是**同一套** ToolDefinition，
 * 仅通过本文件做一层「协议格式转换」。
 *
 * 转换流程：
 *   ToolDefinition (Agent 内部工具定义)
 *     ↓ convertToolDefinitionToMcpTool()
 *   McpTool (MCP 协议 tools/list 返回的格式)
 *     ↓ 客户端发起 tools/call
 *   invokeBuiltinTool()  → 直接调用原 ToolDefinition.handler
 *     ↓
 *   MCP 响应 content / isError
 *
 * 工具类别（ToolCategory）：
 *   用于设置界面中按类别开关对外暴露哪些工具。
 */

import type { ToolDefinition } from '../agent/tools/types'

/**
 * MCP 对外工具类别枚举。
 * 注意：类别 id 使用英文、稳定，存入 settings 表；中文展示名由 i18n 提供。
 */
export const BUILTIN_TOOL_CATEGORIES = [
  {
    id: 'kms',
    defaultEnabled: true,
    toolIds: [
      'kms_search', 'kms_get_content',
      'kms_list_collections', 'kms_collection_overview',
      'kms_get_toc', 'kms_get_paragraphs',
      'kms_knowledge_card',
      // KMS MCP 原独有、但 Agent 工具也能支撑的：列目录 / 统计
      'kms_list_dirs', 'kms_stats',
      'kms_get_summary', 'kms_list_files_in_collection',
      'kms_get_collection_summary',
    ],
  },
  {
    id: 'calendar',
    defaultEnabled: false,
    toolIds: [
      'calendar_event_list', 'calendar_event_create',
      'calendar_event_update', 'calendar_event_delete',
      'calendar_todo_list', 'calendar_todo_create',
      'calendar_todo_update', 'calendar_todo_delete',
      'calendar_todo_complete', 'calendar_todo_stats',
    ],
  },
  {
    id: 'automation',
    defaultEnabled: false,
    toolIds: [
      'automation_list_employees', 'automation_list_providers',
      'automation_task_list', 'automation_task_create',
      'automation_task_update', 'automation_task_delete',
      'automation_task_toggle', 'automation_task_run_now',
      'automation_task_preview', 'automation_run_list',
    ],
  },
  {
    id: 'general',
    defaultEnabled: true,
    toolIds: [
      'date_time',
    ],
  },
  {
    id: 'web',
    defaultEnabled: false,
    toolIds: [
      'web_search', 'web_fetch',
    ],
  },
  {
    id: 'conversation',
    defaultEnabled: false,
    toolIds: [
      'search_conversations', 'list_conversations', 'get_conversation_detail',
    ],
  },
] as const

export type BuiltinToolCategoryId = typeof BUILTIN_TOOL_CATEGORIES[number]['id']

/** MCP 工具格式（与 kms-mcp-types.ts 中的 MCPTool 保持语义一致，避免耦合旧文件） */
export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

/**
 * 将 Agent 内部 ToolDefinition 转换为 MCP 协议 tools/list 返回的格式。
 *
 * 说明：
 *  - 原 ToolDefinition.parameters 的类型结构已经是 { type, properties, required }，
 *    与 MCP inputSchema 的 JSON Schema 子集合一致，可以直接透传。
 *  - MCP 协议要求的 name/description 也直接使用 ToolDefinition 的 name/description。
 */
export function convertToolDefinitionToMcpTool(tool: ToolDefinition): McpTool {
  return {
    name: tool.name,
    description: tool.description || tool.title || tool.name,
    inputSchema: {
      type: 'object',
      properties: tool.parameters?.properties ?? {},
      required: Array.isArray(tool.parameters?.required)
        ? tool.parameters.required
        : undefined,
    },
  }
}

/**
 * 调用一个内置 ToolDefinition 的 handler，并把返回值/异常包装为 MCP 协议
 * tools/call 的响应结构：{ content, isError? }。
 *
 * 设计目标：
 *   对外 MCP 与对内 Agent 共用同一套 handler，不做重复的业务逻辑实现。
 *   MCP 侧仅做一层：
 *     1. 入参透传（args → args，无上下文时 context 传 undefined）
 *     2. 返回值标准化为字符串（agent 友好输出通常已是字符串/可序列化对象）
 *     3. 异常 → isError=true + 错误文本 content
 */
export async function invokeBuiltinTool(
  tool: ToolDefinition,
  args: Record<string, any>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const raw = await tool.handler(args || {}, undefined)
    let text: string
    if (raw === null || raw === undefined) {
      text = ''
    } else if (typeof raw === 'string') {
      text = raw
    } else {
      // 对象/数组：尝试 JSON 字符串化；失败则 toString 兜底
      try {
        text = JSON.stringify(raw, null, 2)
      } catch {
        text = String(raw)
      }
    }
    return {
      content: [{ type: 'text', text }],
    }
  } catch (err: any) {
    const errMsg = String(err?.message || err || 'Unknown error')
    return {
      content: [{ type: 'text', text: `Error: ${errMsg}` }],
      isError: true,
    }
  }
}

/**
 * 给定启用的类别列表，返回所有应被暴露的 toolId 集合（用于过滤 tools/list 输出 & tools/call 白名单）。
 * 若 enabledCategories 为 undefined，则按默认是否启用取类别。
 */
export function resolveEnabledToolIds(
  enabledCategories?: BuiltinToolCategoryId[],
): Set<string> {
  const ids = new Set<string>()
  for (const cat of BUILTIN_TOOL_CATEGORIES) {
    const catEnabled = enabledCategories
      ? enabledCategories.includes(cat.id)
      : cat.defaultEnabled
    if (catEnabled) {
      for (const tid of cat.toolIds) {
        ids.add(tid)
      }
    }
  }
  return ids
}
