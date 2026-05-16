import type { ToolDefinition } from './tools/types'
import { allBuiltinTools } from './tools'

export function createBuiltinTools(): ToolDefinition[] {
  return allBuiltinTools
}

export { allBuiltinTools }

export {
  createKBSearchTool,
  createKBEntitiesTool,
  createKBEntityDetailTool,
  createKBAdvancedSearchTool,
  createKBGetContentTool,
} from './tools'
