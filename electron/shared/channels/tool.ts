export const TOOL_CHANNELS = {
  TOOL_LIST_BUILTIN: 'tool:list-builtin',
  TOOL_GET_EMPLOYEE_TOOLS: 'tool:get-employee-tools',
  TOOL_ASSIGN_TO_EMPLOYEE: 'tool:assign-to-employee',

  MCP_SERVER_LIST: 'mcp:server-list',
  MCP_SERVER_CREATE: 'mcp:server-create',
  MCP_SERVER_UPDATE: 'mcp:server-update',
  MCP_SERVER_DELETE: 'mcp:server-delete',
  MCP_SERVER_CONNECT: 'mcp:server-connect',
  MCP_SERVER_DISCONNECT: 'mcp:server-disconnect',

  SKILL_REGISTRY_LIST: 'skill-registry:list',
  SKILL_REGISTRY_INSTALL: 'skill-registry:install',
  SKILL_REGISTRY_UNINSTALL: 'skill-registry:uninstall',
  SKILL_REGISTRY_GET_EMPLOYEE_SKILLS: 'skill-registry:get-employee-skills',
  SKILL_REGISTRY_ASSIGN_TO_EMPLOYEE: 'skill-registry:assign-to-employee',
  SKILL_REGISTRY_REMOVE_FROM_EMPLOYEE: 'skill-registry:remove-from-employee',
} as const

export interface ToolAssignParams {
  employee_id: string
  tool_id: string
  is_enabled?: boolean
}

export interface MCPServerCreateParams {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface MCPServerUpdateParams {
  id: string
  name?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  is_enabled?: boolean
}