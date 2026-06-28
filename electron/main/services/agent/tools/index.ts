import { calculatorTool } from './calculator.tool'
import { dateTimeTool } from './date-time.tool'
import { shellExecTool } from './shell-exec.tool'
import {
  readFileTool,
  writeFileTool,
  listDirTool,
  createFolderTool,
  deleteItemTool,
  renameItemTool,
  moveItemTool,
  copyItemTool,
  getFileInfoTool,
  searchFilesTool,
} from './fs-tools'
import { systemInfoTool } from './system-info.tool'
import { webSearchTool } from './web-search.tool'
import { webFetchTool } from './web-fetch.tool'
import { jsonUtilsTool } from './json-utils.tool'
import { randomUtilsTool } from './random-utils.tool'
import { envVarsTool } from './env-vars.tool'
import { askUserTool } from './ask-user.tool'
import type { ToolDefinition } from './types'

export const allBuiltinTools: ToolDefinition[] = [
  calculatorTool,
  dateTimeTool,
  shellExecTool,
  readFileTool,
  writeFileTool,
  listDirTool,
  createFolderTool,
  deleteItemTool,
  renameItemTool,
  moveItemTool,
  copyItemTool,
  getFileInfoTool,
  searchFilesTool,
  systemInfoTool,
  webSearchTool,
  webFetchTool,
  jsonUtilsTool,
  randomUtilsTool,
  envVarsTool,
  askUserTool,
]

export { officeExecTool } from './office-exec.tool'
export { createOfficeGuideTool } from './office-prompts'
export { createKMSTools, type CollectionIdsRef } from './kms-search.tool'
export { createKMSCollectionTools } from './kms-collection-tools'
