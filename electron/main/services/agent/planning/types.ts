export interface PlanStep {
  id: string
  description: string
  toolName?: string
  toolArgs?: Record<string, any>
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  result?: any
}

export interface Plan {
  goal: string
  steps: PlanStep[]
  selectedToolNames?: string[]
  reasoning?: string
}

export interface IPlanner {
  plan(
    query: string,
    availableTools: any[],
    context?: PlanningContext
  ): Promise<Plan>
}

export interface PlanningContext {
  historySummary?: string
  previousPlanResult?: string
  additionalInstructions?: string
}

export type PlanningStrategy = 'react' | 'plan_execute' | 'tool_filter'
