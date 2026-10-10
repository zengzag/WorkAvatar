import type {
  EmployeeMemoryCreateParams,
  EmployeeMemoryUpdateParams,
  MemoryScope,
} from '../../shared/channels/employee'

export type { EmployeeMemoryCreateParams }
export type { MemoryScope }

/** 更新记忆时传入的字段（不含 id，id 作为独立参数传递） */
export type EmployeeMemoryUpdateData = Omit<EmployeeMemoryUpdateParams, 'id'>

export const MEMORY_SCOPE_EMPLOYEE: MemoryScope = 'employee'
export const MEMORY_SCOPE_GLOBAL: MemoryScope = 'global'

export interface EmployeeMemory {
  id: string
  /** 归属员工；全局记忆为 null */
  employee_id: string | null
  scope: MemoryScope
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
  /** 提取器判定的作用域；缺省按 employee 处理 */
  scope?: MemoryScope
}

export interface ExtractionResult {
  memories: ExtractedMemory[]
  delete_keys: string[]
  update_memories: Array<{ key: string; content: string; topic?: string; scope?: MemoryScope }>
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

/** 记忆桶：标识一次读写操作的目标作用域 */
export interface MemoryBucket {
  scope: MemoryScope
  /** employee 作用域必填；global 作用域忽略 */
  employeeId?: string
}

/** 记忆库总字符上限：仅用于触发整理（不再约束注入，注入上限见 MEMORY_ALWAYS_ON_MAX_CHARS） */
export const MEMORY_MAX_CHARS = 8000
/** 记忆库条数上限：仅用于触发整理；常驻注入另有 MEMORY_ALWAYS_ON_MAX_COUNT */
export const MEMORY_MAX_COUNT = 100
/** 单条 content 字符上限（LLM 偶尔会写长句，需在服务层兜底截断） */
export const MEMORY_CONTENT_MAX_CHARS = 160
/** 整理触发阈值：总字符达到上限的 60% 即触发，更早整理以保留缓冲 */
export const MEMORY_CONSOLIDATION_THRESHOLD = 0.6
export const STALE_MEMORY_DAYS = 90
export const CONSOLIDATION_COOLDOWN_SECONDS = 3600
/** 现有记忆减少，提示 LLM 更聚焦精炼而非穷举 */
export const EXTRACTION_MAX_EXISTING_MEMORIES = 12
export const CONSOLIDATION_CANDIDATE_MAX = 15
/** 单次提取连续失败多少次后放弃并推进指针，避免永久重试同一对话 */
export const EXTRACTION_MAX_ATTEMPTS = 3

/** 常驻注入的记忆条数上限（pinned + critical） */
export const MEMORY_ALWAYS_ON_MAX_COUNT = 12
/** 常驻注入的记忆字符上限（pinned 不受该上限约束） */
export const MEMORY_ALWAYS_ON_MAX_CHARS = 1500

/** 每轮按语义相关度召回的条数上限 */
export const MEMORY_RECALL_TOP_N = 5
/** 召回余弦相似度下限：低于该值视为不相关，不注入（避免噪声） */
export const MEMORY_RECALL_MIN_SCORE = 0.3
/** 召回块的字符上限 */
export const MEMORY_RECALL_MAX_CHARS = 1200
/** 查询向量化的超时（毫秒）：超时即降级到 FTS5 关键词召回，不阻塞对话 */
export const MEMORY_QUERY_EMBED_TIMEOUT_MS = 3000
/** 单次向量回填最多处理的记忆条数 */
export const MEMORY_EMBED_BACKFILL_BATCH = 50
/** 向量输入文本的字符上限（与单条 content 上限同量级，避免超长输入拖慢 embedding） */
export const MEMORY_EMBED_TEXT_LIMIT = 600

/** 记忆向量行（存于 employee_memory_vectors，与主表 1:1） */
export interface MemoryVectorRow {
  memory_id: string
  /** 生成该向量的 embedding 模型标识；模型切换后需重新生成 */
  model: string
  /** 记忆 key|topic|content 的哈希；内容变更后可据此检测失效 */
  content_hash: string
  embedding: Float32Array
}

/** 记忆检索工具默认返回条数 */
export const MEMORY_SEARCH_DEFAULT_LIMIT = 5
/** 记忆检索工具最大返回条数 */
export const MEMORY_SEARCH_MAX_LIMIT = 20
/** 检索相对分数下限：保留得分 ≥ top*floor 的结果（0 表示不过滤） */
export const MEMORY_SEARCH_SCORE_FLOOR = 0.15
/** MATCH 表达式最多使用的词元数，避免超长查询拖慢 FTS */
export const MEMORY_SEARCH_MAX_TERMS = 12

/**
 * 与「跨任务记忆」开关绑定的工具 id（即「对话记忆」分类的 4 个工具）。
 * 开关关闭时：工具列表整类不可见，运行时也强制 off（不注册）。
 */
export const MEMORY_BOUND_TOOL_IDS: readonly string[] = [
  'search_conversations',
  'list_conversations',
  'get_conversation_detail',
  'search_memories',
]

export function isGlobalScope(scope: MemoryScope | undefined): boolean {
  return scope === MEMORY_SCOPE_GLOBAL
}
