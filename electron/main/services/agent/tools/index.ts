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

// 基础内置工具列表（不包含知识库工具，知识库工具由 EmployeeAgentService 动态创建并带权限控制）
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

// 导出工厂函数（用于 EmployeeAgentService 动态创建带权限控制的知识库工具）
export { createKBSearchTool } from './kb-search.tool'
export { createKBEntitiesTool, createKBEntityDetailTool } from './kb-entities.tool'
export { createKBAdvancedSearchTool, createKBDocumentCompareTool } from './kb-advanced.tool'
export { createKBGetContentTool } from './kb-content.tool'
