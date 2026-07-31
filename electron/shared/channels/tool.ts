export const TOOL_CHANNELS = {
  TOOL_LIST_BUILTIN: 'tool:list-builtin',
  TOOL_GET_EMPLOYEE_TOOLS: 'tool:get-employee-tools',
  TOOL_ASSIGN_TO_EMPLOYEE: 'tool:assign-to-employee',
  TOOL_GET_EMPLOYEE_TOOL_CATEGORIES: 'tool:get-employee-tool-categories',
  TOOL_ASSIGN_CATEGORY_TO_EMPLOYEE: 'tool:assign-category-to-employee',

  SEARCH_GET_ENGINES: 'tool:search-get-engines',
  SEARCH_OPEN_WINDOW: 'tool:search-open-window',
  SEARCH_CLOSE_WINDOW: 'tool:search-close-window',

  SKILL_REGISTRY_LIST: 'skill-registry:list',
  SKILL_REGISTRY_INSTALL: 'skill-registry:install',
  SKILL_REGISTRY_UNINSTALL: 'skill-registry:uninstall',
  SKILL_REGISTRY_GET_EMPLOYEE_SKILLS: 'skill-registry:get-employee-skills',
  SKILL_REGISTRY_ASSIGN_TO_EMPLOYEE: 'skill-registry:assign-to-employee',
  SKILL_REGISTRY_REMOVE_FROM_EMPLOYEE: 'skill-registry:remove-from-employee',
  SKILL_REGISTRY_TOGGLE_FOR_EMPLOYEE: 'skill-registry:toggle-for-employee',
} as const

export interface ToolAssignParams {
  employee_id: string
  tool_id: string
  is_enabled?: boolean
}

export interface ToolCategoryAssignParams {
  employee_id: string
  category_id: string
  is_enabled?: boolean
}

export interface ToolCategoryInfo {
  id: string
  name: string
  title: string
  description: string
  icon: string
  tool_ids: string[]
  tools: Array<{
    id: string
    name: string
    title: string
    description: string
  }>
  is_enabled: boolean
  enabled_count: number
  total_count: number
}

export interface SearchOpenWindowParams {
  engine: string
}

export interface SearchCloseWindowParams {
  engine: string
}
