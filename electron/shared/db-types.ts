export interface DBEmployee {
  id: string
  workspace_path: string | null
  name: string
  description: string
  rules: string
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
  /** 工具启用模式：on / on_demand / off（旧数据可能缺失） */
  tool_mode?: string
  config_json: string
  created_at: number
}
