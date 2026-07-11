import type { SearchResult } from './kms-search-engine.service'

/** 查询类型：定位查找 / 概念解释 / 趋势梳理 / 综合分析 */
export type QueryType = 'locate' | 'concept' | 'trend' | 'analysis'

/** 检索过程步骤（结构化中间过程） */
export interface SearchTraceStep {
  phase: string
  action: string
  detail?: string
  durationMs?: number
  /** info/llm/search/read/plan/result */
  type: 'info' | 'llm' | 'search' | 'read' | 'plan' | 'result'
}

/** 检索子智能体输出结果 */
export interface AgentSearchResult {
  queryType: QueryType
  queryTypeLabel: string
  /** 核心结论（已整理的干净内容，无冗余原文） */
  conclusion: string
  sources: AgentSearchSource[]
  searchRounds: number
  /** 检索过程摘要（兼容旧格式，简单字符串列表） */
  searchTrace: string[]
  /** 结构化检索过程（详细中间步骤） */
  searchSteps: SearchTraceStep[]
}

export interface AgentSearchSource {
  fileId: string
  fileName: string
  filePath: string
  paragraphId?: string
  paragraphTitle?: string
  snippet: string
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
  score?: number
}

export interface AgentSearchOptions {
  dirIds?: string[]
  collectionIds?: string[]
  fileExtensions?: string[]
  timeRangeStart?: number
  timeRangeEnd?: number
  maxRounds?: number
  topK?: number
  signal?: AbortSignal
  providerId?: string
  onProgress?: (step: SearchTraceStep) => void
}

export const QUERY_TYPE_LABELS: Record<QueryType, string> = {
  locate: '定位查找',
  concept: '概念解释',
  trend: '趋势梳理',
  analysis: '综合分析',
}

/** 单次读取文件片段的最大字符数 */
export const READ_CHUNK_SIZE = 2000

/** 文件清单条目（用于 LLM 判断哪些文件可能相关） */
export interface FileInventoryItem {
  fileId: string
  fileName: string
  filePath: string
  fileExt: string
  lightSummary: string
}

/** 作用域摘要条目（目录摘要或合集摘要） */
export interface ScopeSummaryItem {
  dirPath: string
  summary: string
  fileCount: number
}

/** LLM 规划输出 */
export interface SearchPlan {
  queries: string[]
  useSemanticForAll: boolean
  candidateFileIds: string[]
}

/** 默认 LLM 配置 */
export interface AgentLLMConfig {
  providerId: string
  modelId: string | undefined
  enableThinking: boolean
}

/** 待读取文件信息 */
export interface FileToRead {
  fileId: string
  fileName: string
}

/** distillResults 输出 */
export interface DistilledResult {
  conclusion: string
  sources: AgentSearchSource[]
}

export type { SearchResult }
