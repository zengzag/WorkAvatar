import { dateTimeTool } from './date-time.tool'
import { shellExecTool } from './shell-exec.tool'
import { residentFileTools } from './fs-tools'
import { webSearchTool } from './web-search.tool'
import { webFetchTool } from './web-fetch.tool'
import { askUserTool } from './ask-user.tool'
import { ocrImageTool } from './ocr.tool'
import { delegateTool } from './delegate.tool'
import { listEmployeesTool, listProvidersTool } from './collaboration.tool'
import type { ToolDefinition } from './types'

export const allBuiltinTools: ToolDefinition[] = [
  dateTimeTool,
  shellExecTool,
  ...residentFileTools,
  webSearchTool,
  webFetchTool,
  askUserTool,
  ocrImageTool,
  delegateTool,
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
