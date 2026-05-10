import type { ToolDefinition } from './tool.types'
import { allBuiltinTools } from './tools'

export function createBuiltinTools(): ToolDefinition[] {
  return allBuiltinTools
}

export { allBuiltinTools }
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
} from './tools'