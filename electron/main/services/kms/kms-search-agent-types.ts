/** 检索过程步骤（结构化的中间过程，知识卡片与检索流程共用） */
export interface SearchTraceStep {
  phase: string
  action: string
  detail?: string
  durationMs?: number
  /** info/llm/search/read/plan/result */
  type: 'info' | 'llm' | 'search' | 'read' | 'plan' | 'result'
}