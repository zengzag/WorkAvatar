/**
 * 构造对外 MCP 工具集合。
 *
 * 设计原则：MCP 对外暴露的工具与数字员工（Agent）内部使用的工具是**同一套**
 * ToolDefinition，仅做协议格式转换（见 builtin-mcp-converter.ts），不维护两套工具定义。
 * 因此这里不再为 KMS 单独补充适配器工具——kms_search 已自动附加知识卡片/合集摘要，
 * kms_get_content 已合并 TOC/段落视图，与数字员工保持一致。
 */

import type { ToolDefinition } from '../agent/tools/types'

/**
 * 不在 MCP 对外暴露的工具清单：按用户要求移除文件管理、Office 自动化、命令行执行、向用户询问 4 大类。
 * 注意：Agent 内部仍可使用这些工具；这里仅阻止它们被 buildAllBuiltinToolDefinitions()
 * 聚合到对外 MCP 工具清单中，避免通过 MCP 通道泄露能力。
 */
const EXCLUDED_MCP_TOOL_IDS = new Set<string>([
  // files（文件管理）
  'file_read', 'file_write', 'file_edit',
  // scripting（代码执行）
  'javascript_exec',
  // shell（命令行执行）
  'shell_exec',
  // ask_user（向用户询问）
  'ask_user',
])

function isToolIncluded(t: ToolDefinition): boolean {
  const key1 = (t.id || '').trim()
  const key2 = (t.name || '').trim()
  if (key1 && EXCLUDED_MCP_TOOL_IDS.has(key1)) return false
  if (key2 && EXCLUDED_MCP_TOOL_IDS.has(key2)) return false
  return true
}

/**
 * 构造完整的对外 MCP 工具集合：
 * 1. 来自 Agent 的 allBuiltinTools（含通用/网络等，已过滤 files/shell/ask_user/office）
 * 2. KMS 主工具（createKMSTools + createKMSCollectionTools，不带 scope 过滤）
 * 3. 对话工具 search_conversations/list_conversations/get_conversation_detail（需 employeeId，对外场景下为 undefined，仅返回空）
 *
 * 最后按 resolveEnabledToolIds(tool_categories) 过滤。
 *
 * 注意：该函数是"提供全部可选工具清单"，不做类别过滤；过滤由调用方（MCP server 的 tools/list & tools/call）完成。
 */
export function buildAllBuiltinToolDefinitions(): ToolDefinition[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const agentTools = require('../agent/tools')
  const result: ToolDefinition[] = []

  // 1. 常驻 + 按需的通用内置工具（allBuiltinTools）→ 过滤掉 files/office/shell/ask_user
  for (const t of (agentTools.allBuiltinTools || []) as ToolDefinition[]) {
    if (isToolIncluded(t)) result.push(t)
  }

  // 1.1 插件贡献的 agent 工具（如日历插件工具），同样按排除清单过滤
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pluginHost = require('../plugin/plugin-host.service').default
    const pluginTools = (pluginHost.getInstance().getAgentTools() || []) as ToolDefinition[]
    for (const t of pluginTools) {
      if (isToolIncluded(t)) result.push(t)
    }
  } catch {
    // 插件宿主未就绪时忽略
  }

  // 2. KMS 主工具（scope 为空集合，即不过滤合集，等同于"全部"）
  const emptyScope = { current: { collectionIds: [] as string[] } }
  const kmsSearchTools = (agentTools.createKMSTools || (() => []))(emptyScope) as ToolDefinition[]
  for (const t of kmsSearchTools) result.push(t)
  const kmsCollTools = (agentTools.createKMSCollectionTools || (() => []))(emptyScope) as ToolDefinition[]
  for (const t of kmsCollTools) result.push(t)

  // 3. 对话记忆工具（对外场景下无 employeeId，仅空实现兜底，类别关闭时不会出现）
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const convSearch = require('../agent/tools/conversation-search.tool')
    const convList = require('../agent/tools/conversation-list.tool')
    const dummyEmpId = ''
    const searchTools = (convSearch.createConversationSearchTool || (() => []))(dummyEmpId) as ToolDefinition[]
    const listTools = (convList.createConversationListTool || (() => []))(dummyEmpId) as ToolDefinition[]
    for (const t of [...searchTools, ...listTools]) {
      if (isToolIncluded(t)) result.push(t)
    }
  } catch {
    // ignore
  }

  return result
}
