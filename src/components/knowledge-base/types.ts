export interface KBDocument {
  id: string
  kb_id: string
  original_name: string
  type: string
  size: number
  hash: string
  parse_status: 'pending' | 'parsing' | 'paused' | 'completed' | 'failed'
  parse_error?: string
  parse_progress?: number
  parse_stage?: string
  parse_detail?: string
  processed_pages?: number
  total_pages?: number
  processed_chunks?: number
  total_chunks?: number
  parse_speed?: number
  parse_eta?: number
  is_reused?: number
  created_at: number
}

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  root_path: string
  doc_count: number
  created_at: number
  updated_at: number
}

export interface ScanTreeNode {
  key: string
  name: string
  ext?: string
  size?: number
  isLeaf: boolean
  children?: ScanTreeNode[]
  fileCount?: number
}
