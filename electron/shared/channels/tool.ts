/** 工具启用模式：on=常驻（直接进入 LLM tools 数组）/ on_demand=按需（list_available_tools+invoke_tool）/ off=关闭 */
export type ToolMode = 'on' | 'on_demand' | 'off'

export const TOOL_CHANNELS = {
  TOOL_LIST_BUILTIN: 'tool:list-builtin',
  TOOL_ASSIGN_TO_EMPLOYEE: 'tool:assign-to-employee',
  TOOL_GET_EMPLOYEE_TOOL_CATEGORIES: 'tool:get-employee-tool-categories',
  TOOL_ASSIGN_CATEGORY_TO_EMPLOYEE: 'tool:assign-category-to-employee',
  /** 获取完整工具分类定义（含插件分类），供创建向导等按分类渲染 */
  TOOL_GET_CATEGORIES: 'tool:get-categories',

  SEARCH_GET_ENGINES: 'tool:search-get-engines',
  SEARCH_OPEN_WINDOW: 'tool:search-open-window',
  SEARCH_CLOSE_WINDOW: 'tool:search-close-window',

  // 搜索 API（DeepSeek / Tavily / Brave）：查询配置状态、加密保存/清除密钥
  SEARCH_API_GET_STATUS: 'tool:search-api-get-status',
  SEARCH_API_SET_KEY: 'tool:search-api-set-key',
  SEARCH_API_CLEAR_KEY: 'tool:search-api-clear-key',

  SKILL_REGISTRY_LIST: 'skill-registry:list',
  SKILL_REGISTRY_INSTALL: 'skill-registry:install',
  SKILL_REGISTRY_UNINSTALL: 'skill-registry:uninstall',
  SKILL_REGISTRY_GET_EMPLOYEE_SKILLS: 'skill-registry:get-employee-skills',
  SKILL_REGISTRY_ASSIGN_TO_EMPLOYEE: 'skill-registry:assign-to-employee',
  SKILL_REGISTRY_REMOVE_FROM_EMPLOYEE: 'skill-registry:remove-from-employee',
  SKILL_REGISTRY_TOGGLE_FOR_EMPLOYEE: 'skill-registry:toggle-for-employee',
  /** 技能安装/卸载/员工技能启停变更广播（主进程 → 渲染进程） */
  SKILL_REGISTRY_CHANGED: 'skill-registry:changed',
} as const

export interface ToolAssignParams {
  employee_id: string
  tool_id: string
  mode: ToolMode
}

export interface ToolCategoryAssignParams {
  employee_id: string
  category_id: string
  /** 分类下所有工具的模式 */
  mode: ToolMode
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
    /** 该工具的启用模式 */
    mode: ToolMode
  }>
  /** 分类聚合模式：按分类内所有工具的最高状态（on > on_demand > off） */
  mode: ToolMode
  enabled_count: number
  total_count: number
}

export interface SearchOpenWindowParams {
  engine: string
}

export interface SearchCloseWindowParams {
  engine: string
}

/** 网络搜索后端：browser=本地浏览器抓取，api=第三方搜索 API */
export type WebSearchMode = 'browser' | 'api'

/** 支持的搜索 API 服务商 */
export type SearchApiProviderId = 'deepseek' | 'tavily' | 'brave'

export interface SearchApiProviderInfo {
  id: SearchApiProviderId
  name: string
  /** 是否已保存可用的 API Key */
  hasKey: boolean
}

export interface SearchApiStatus {
  mode: WebSearchMode
  provider: SearchApiProviderId
  providers: SearchApiProviderInfo[]
}

export interface SearchApiSetKeyParams {
  provider: SearchApiProviderId
  apiKey: string
}

export interface SearchApiProviderParams {
  provider: SearchApiProviderId
}
