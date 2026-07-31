import { calculatorTool } from './calculator.tool'
import { dateTimeTool } from './date-time.tool'
import { shellExecTool } from './shell-exec.tool'
import { fileTools } from './fs-tools'
import { systemInfoTool } from './system-info.tool'
import { webSearchTool } from './web-search.tool'
import { webFetchTool } from './web-fetch.tool'
import { envVarsTool } from './env-vars.tool'
import { askUserTool } from './ask-user.tool'
import { calendarTools } from './calendar.tool'
import { automationTools } from './automation.tool'
import type { ToolDefinition } from './types'

export const allBuiltinTools: ToolDefinition[] = [
  calculatorTool,
  dateTimeTool,
  shellExecTool,
  ...fileTools,
  systemInfoTool,
  webSearchTool,
  webFetchTool,
  envVarsTool,
  askUserTool,
  ...calendarTools,
  ...automationTools,
]

export { officeExecTool } from './office-exec.tool'
export { createKMSTools, type SearchScopeRef } from './kms-search.tool'
export { createKMSCollectionTools } from './kms-collection-tools'
export { calendarTools } from './calendar.tool'
export { automationTools } from './automation.tool'
export { createListAvailableToolsTool, createInvokeToolTool } from './meta-tools'
export { buildOfficeGuide } from './office-prompts'
export { runSkillScriptTool } from './run-skill-script.tool'
