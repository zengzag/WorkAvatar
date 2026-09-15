/** 检索过程步骤（结构化的中间过程，知识卡片与检索流程共用） */
export interface SearchTraceStep {
  phase: string
  action: string
  /** 界面展示用文案键与参数（渲染端按当前语言解析，缺失回退 action） */
  actionKey?: string
  actionParams?: Record<string, string | number>
  detail?: string
  detailKey?: string
  detailParams?: Record<string, string | number>
  durationMs?: number
  /** info/llm/search/read/plan/result */
  type: 'info' | 'llm' | 'search' | 'read' | 'plan' | 'result'
}