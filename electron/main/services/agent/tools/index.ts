import { calculatorTool } from './calculator.tool'
import { dateTimeTool } from './date-time.tool'
import { stringUtilsTool } from './string-utils.tool'
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
import type { ToolDefinition } from '../tool.types'

export const allBuiltinTools: ToolDefinition[] = [
  calculatorTool,
  dateTimeTool,
  stringUtilsTool,
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
]

export {
  calculatorTool,
  dateTimeTool,
  stringUtilsTool,
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
}