import { dateTimeTool } from './date-time.tool'
import { shellExecTool } from './shell-exec.tool'
import { fileTools } from './fs-tools'
import { webSearchTool } from './web-search.tool'
import { webFetchTool } from './web-fetch.tool'
import { askUserTool } from './ask-user.tool'
import { calendarTools } from './calendar.tool'
import { automationTools } from './automation.tool'
import { ocrImageTool } from './ocr.tool'
import type { ToolDefinition } from './types'

export const allBuiltinTools: ToolDefinition[] = [
  dateTimeTool,
  shellExecTool,
  ...fileTools,
  webSearchTool,
  webFetchTool,
  askUserTool,
  ...calendarTools,
  ...automationTools,
  ocrImageTool,
]

export * from './javascript-exec.tool'

export { shellExecTool } from './shell-exec.tool'
export { createKMSTools, type SearchScopeRef } from './kms-search.tool'
export { createKMSCollectionTools } from './kms-collection-tools'
export { calendarTools } from './calendar.tool'
export { automationTools } from './automation.tool'
export { createListAvailableToolsTool, createInvokeToolTool } from './meta-tools'
export { buildOfficeGuide } from './office-prompts'
export { runSkillScriptTool } from './run-skill-script.tool'
