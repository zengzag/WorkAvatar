/** 员工画像（LLM 分析或启发式生成的角色配置） */
export interface EmployeeProfile {
  roleName: string
  roleDescription: string
  suggestedTools: string[]
}

/** 分析过程中的流式阶段标识 */
export type AnalyzeStage =
  | 'preparing'
  | 'llm_calling'
  | 'thinking'
  | 'streaming'
  | 'parsing'
  | 'done'
  | 'error'
  | ''

/** 阶段对应的进度百分比 */
export const STAGE_PROGRESS_MAP: Record<string, number> = {
  preparing: 10,
  llm_calling: 30,
  thinking: 45,
  streaming: 60,
  parsing: 90,
  done: 100,
  error: 100,
}

/** 默认选中的内置工具名 */
export const DEFAULT_TOOL_NAMES = ['kms_search', 'kms_agent_search', 'read_file', 'write_file']

/**
 * 将 LLM 建议的工具名匹配到内置工具 ID
 */
export function matchSuggestedToolIds(
  suggestedTools: string[],
  builtinTools: any[],
): string[] {
  if (!suggestedTools.length || !builtinTools.length) return []
  const suggestedSet = new Set(suggestedTools.map((s) => s.toLowerCase()))
  return builtinTools
    .filter((tool: any) => suggestedSet.has((tool.name || '').toLowerCase()))
    .map((tool: any) => tool.id)
}

/**
 * 合并工具 ID（去重）
 */
export function mergeToolIds(existing: string[], newIds: string[]): string[] {
  if (newIds.length === 0) return existing
  return Array.from(new Set([...existing, ...newIds]))
}
