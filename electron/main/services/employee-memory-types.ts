import type {
  EmployeeMemoryCreateParams,
  EmployeeMemoryUpdateParams,
} from '../../shared/channels/employee'

export type { EmployeeMemoryCreateParams }

/** 更新记忆时传入的字段（不含 id，id 作为独立参数传递） */
export type EmployeeMemoryUpdateData = Omit<EmployeeMemoryUpdateParams, 'id'>

export interface EmployeeMemory {
  id: string
  employee_id: string
  key: string
  topic: string
  content: string
  is_pinned: number
  source: 'auto' | 'manual'
  importance: 'critical' | 'normal' | 'low'
  created_at: number
  updated_at: number
  last_referenced_at: number | null
  deleted_at: number | null
}

export interface ExtractedMemory {
  key: string
  topic: string
  content: string
}

export interface ExtractionResult {
  memories: ExtractedMemory[]
  delete_keys: string[]
  update_memories: Array<{ key: string; content: string; topic?: string }>
  summary: string
}

export interface ConsolidationResult {
  delete_keys: string[]
  merge_groups: Array<{ keys: string[]; merged: ExtractedMemory }>
  simplify_updates: Array<{ key: string; content: string }>
  importance_updates: Array<{ key: string; importance: 'critical' | 'normal' | 'low' }>
}

export interface MemoryStats {
  count: number
  totalChars: number
  pinnedCount: number
  autoCount: number
  manualCount: number
  oldestTimestamp: number | null
  staleCount: number
}

/** 跨任务记忆注入 prompt 的总字符上限（含分隔符与主题标签），与 Hermes MEMORY.md 上限对齐 */
export const MEMORY_MAX_CHARS = 3000
/** 记忆条数上限，假设单条精炼后约 60 字符，约 50 条可达上限 */
export const MEMORY_MAX_COUNT = 30
/** 单条 content 字符上限（LLM 偶尔会写长句，需在服务层兜底截断） */
export const MEMORY_CONTENT_MAX_CHARS = 160
/** 整理触发阈值：总字符达到上限的 60% 即触发，更早整理以保留缓冲 */
export const MEMORY_CONSOLIDATION_THRESHOLD = 0.6
export const STALE_MEMORY_DAYS = 90
export const CONSOLIDATION_COOLDOWN_SECONDS = 3600
/** 现有记忆减少，提示 LLM 更聚焦精炼而非穷举 */
export const EXTRACTION_MAX_EXISTING_MEMORIES = 12
export const CONSOLIDATION_CANDIDATE_MAX = 15
