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

// 导出工厂函数（用于 EmployeeAgentService 动态创建带权限控制的知识库工具）
export {
  createKBSearchTool,
  createKBEntitiesTool,
  createKBEntityDetailTool,
  createKBAdvancedSearchTool,
  createKBDocumentCompareTool,
  createKBGetContentTool,
} from './tools'
