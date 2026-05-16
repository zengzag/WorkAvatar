export interface DBEmployee {
  id: string
  project_id: string
  name: string
  description: string
  avatar_type: string
  status: string
  review_mode: number
  default_skill_id: string | null
  llm_provider_id: string | null
  llm_model: string | null
  profile_json: string
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

export interface DBKBChapter {
  id: string
  kb_id: string
  document_id: string
  title: string
  chapter_index: number
  start_offset: number
  end_offset: number
  content: string
  summary: string | null
  keywords_json: string
  entities_json: string
  vector_id: string | null
  created_at: number
  updated_at: number
}

export interface DBKBDocumentSummary {
  id: string
  kb_id: string
  document_id: string
  summary: string
  key_entities_json: string
  timeline_json: string
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
  key_entities_json: string
  global_timeline_json: string
  vector_id: string | null
  created_at: number
  updated_at: number
}

export interface DBKBEntity {
  id: string
  kb_id: string
  name: string
  type: string
  description: string
  aliases_json: string
  attributes_json: string
  mention_count: number
  first_seen_doc_id: string | null
  created_at: number
  updated_at: number
}

export interface DBKBEntityRelation {
  id: string
  kb_id: string
  source_entity_id: string
  target_entity_id: string
  relation_type: string
  description: string
  source_document_id: string | null
  confidence: number
  created_at: number
  source_name: string
  source_type: string
  target_name: string
  target_type: string
}

export interface DBKBEntityMention {
  id: string
  entity_id: string
  document_id: string
  chapter_id: string | null
  context_text: string
  start_offset: number
  end_offset: number
  created_at: number
  document_name: string
  chapter_title: string | null
}

export interface DBKnowledgeBase {
  id: string
  name: string
  description: string
  root_path: string
  created_at: number
  updated_at: number
}

export interface DBLLMProvider {
  id: string
  name: string
  provider_type: string
  base_url: string | null
  model: string
  embedding_model: string
  temperature: number
  max_tokens: number
  timeout_ms: number
  extra_headers_json: string | null
  extra_body_json: string | null
  is_default: number
  models_json: string
  created_at: number
}

export interface DBProject {
  id: string
  name: string
  description: string
  root_path: string
  llm_provider_id: string | null
  created_at: number
  updated_at: number
}

export interface DBConversation {
  id: string
  employee_id: string
  skill_id: string | null
  title: string
  messages_json: string
  message_count: number
  status: string
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
