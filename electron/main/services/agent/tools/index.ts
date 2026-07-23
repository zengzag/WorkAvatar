import { calculatorTool } from './calculator.tool'
import { dateTimeTool } from './date-time.tool'
import { shellExecTool } from './shell-exec.tool'
import { fileTool } from './fs-tools'
import { systemInfoTool } from './system-info.tool'
import { webSearchTool } from './web-search.tool'
import { webFetchTool } from './web-fetch.tool'
import { envVarsTool } from './env-vars.tool'
import { askUserTool } from './ask-user.tool'
import { calendarTools } from './calendar.tool'
import { notesTools } from './notes.tool'
import type { ToolDefinition } from './types'

export const allBuiltinTools: ToolDefinition[] = [
  calculatorTool,
  dateTimeTool,
  shellExecTool,
  fileTool,
  systemInfoTool,
  webSearchTool,
  webFetchTool,
  envVarsTool,
  askUserTool,
  ...calendarTools,
  ...notesTools,
]

export { officeExecTool } from './office-exec.tool'
export { createOfficeGuideTool } from './office-prompts'
export { createKMSTools, type SearchScopeRef } from './kms-search.tool'
export { createKMSCollectionTools } from './kms-collection-tools'
export { calendarTools } from './calendar.tool'
export { notesTools } from './notes.tool'
