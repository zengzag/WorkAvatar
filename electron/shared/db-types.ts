export interface DBEmployee {
  id: string
  workspace_path: string | null
  name: string
  description: string
  avatar_type: string
  status: string
  review_mode: number
  default_skill_id: string | null
  llm_provider_id: string | null
  llm_model: string | null
  profile_json: string
  memory_enabled: number
  arch_version: number
  total_tasks: number
  total_approvals: number
  created_at: number
  updated_at: number
}

export interface DBKBDocument {
  id: string
  kb_id: string
  file_id: string | null
  original_name: string
  type: string
  size: number
  hash: string
  parsed_json_path: string | null
  parse_status: string
  parse_error: string | null
  parse_progress: number
  parse_stage: string
  parse_detail: string
  processed_pages: number
  total_pages: number
  processed_chunks: number
  total_chunks: number
  parse_speed: number
  parse_eta: number
  parse_state_json: string | null
  is_reused: number
  created_at: number
  updated_at: number
}

export interface DBKBParagraph {
  id: string
  kb_id: string
  document_id: string
  title: string
  title_path: string
  level: number
  paragraph_index: number
  start_offset: number
  end_offset: number
  content: string
  summary: string | null
  keywords_json: string
  vector_id: string | null
  created_at: number
  updated_at: number
}

export interface DBKBDocumentSummary {
  id: string
  kb_id: string
  document_id: string
  summary: string
  toc_json: string
  keywords_json: string
  main_topics_json: string
  vector_id: string | null
  created_at: number
  updated_at: number
}

export interface DBKBGlobalSummary {
  id: string
  kb_id: string
  summary: string
  key_topics_json: string
  vector_id: string | null
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

export interface DBKBProcessingJob {
  id: string
  kb_id: string
  document_id: string | null
  job_type: string
  status: string
  progress: number
  total_steps: number
  current_step: string
  error_message: string | null
  started_at: number | null
  completed_at: number | null
  paused_at: number | null
  resume_state_json: string | null
  created_at: number
  updated_at: number
}
