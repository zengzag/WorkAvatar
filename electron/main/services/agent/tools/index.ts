import { calculatorTool } from './calculator.tool'
import { dateTimeTool } from './date-time.tool'
import { shellExecTool } from './shell-exec.tool'
import { readFileTool } from './read-file.tool'
import { writeFileTool } from './write-file.tool'
import { listDirTool } from './list-dir.tool'
import { systemInfoTool } from './system-info.tool'
import { webSearchTool } from './web-search.tool'
import { webFetchTool } from './web-fetch.tool'
import { jsonUtilsTool } from './json-utils.tool'
import { randomUtilsTool } from './random-utils.tool'
import { envVarsTool } from './env-vars.tool'
import { askUserTool } from './ask-user.tool'
import type { ToolDefinition } from '../tool.types'

export const allBuiltinTools: ToolDefinition[] = [
  calculatorTool,
  dateTimeTool,
  shellExecTool,
  readFileTool,
  writeFileTool,
  listDirTool,
  systemInfoTool,
  webSearchTool,
  webFetchTool,
  jsonUtilsTool,
  randomUtilsTool,
  envVarsTool,
  askUserTool,
]

export { createKBSearchTool } from './kb-search.tool'
export { createKBEntitiesTool, createKBEntityDetailTool } from './kb-entities.tool'
export { createKBAdvancedSearchTool } from './kb-advanced.tool'
export { createKBGetContentTool } from './kb-content.tool'
export { createKBAgentTools } from './kb-agent-tools'
export { createWorkspaceTools, getWorkspacePrompt } from './workspace-tools'
