export interface DBEmployee {
  id: string
  workspace_path: string | null
  name: string
  description: string
  avatar_type: string
  status: string
  default_skill_id: string | null
  profile_json: string
  memory_enabled: number
  arch_version: number
  total_tasks: number
  total_approvals: number
  created_at: number
  updated_at: number
}

export interface DBEmployeeTool {
  id: string
  employee_id: string
  tool_id: string
  is_enabled: number
  config_json: string
  created_at: number
}
