import { dateTimeTool } from './date-time.tool'
import { shellExecTool } from './shell-exec.tool'
import { residentFileTools } from './fs-tools'
import { webSearchTool } from './web-search.tool'
import { webFetchTool } from './web-fetch.tool'
import { askUserTool } from './ask-user.tool'
import { ocrImageTool } from './ocr.tool'
import { sendMessageTool, readMessagesTool } from './collab-messages.tool'
import { listEmployeesTool, listProvidersTool } from './collaboration.tool'
import type { ToolDefinition } from './types'

// 委托类工具（delegateTool / launchAgentsTool / awaitAgentsTool）不在此列：
// 它们由员工「委托能力设置」（employees.delegation_json）驱动注册，不再是员工可配置工具
export const allBuiltinTools: ToolDefinition[] = [
  dateTimeTool,
  shellExecTool,
  ...residentFileTools,
  webSearchTool,
  webFetchTool,
  askUserTool,
  ocrImageTool,
  sendMessageTool,
  readMessagesTool,
  listEmployeesTool,
  listProvidersTool,
]

export * from './javascript-exec.tool'

export { shellExecTool } from './shell-exec.tool'
export { createKMSTools, type SearchScopeRef } from './kms-search.tool'
export { createKMSCollectionTools } from './kms-collection-tools'
export { createListAvailableToolsTool, createInvokeToolTool } from './meta-tools'
export { buildOfficeGuide } from './office-prompts'
export { runSkillScriptTool } from './run-skill-script.tool'
export { delegateTool } from './delegate.tool'
export { followupTool } from './followup.tool'
export { launchAgentsTool, awaitAgentsTool } from './launch-agents.tool'
export { sendMessageTool, readMessagesTool } from './collab-messages.tool'
