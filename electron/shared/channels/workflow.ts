export const WORKFLOW_CHANNELS = {
  WORKFLOW_LIST: 'workflow:list',
  WORKFLOW_GET: 'workflow:get',
  WORKFLOW_CREATE: 'workflow:create',
  WORKFLOW_UPDATE: 'workflow:update',
  WORKFLOW_DELETE: 'workflow:delete',
  WORKFLOW_EXECUTE: 'workflow:execute',
  WORKFLOW_ABORT_EXECUTION: 'workflow:abort-execution',
  WORKFLOW_EXECUTION_PROGRESS: 'workflow:execution-progress',
  WORKFLOW_NODE_EXECUTION_UPDATE: 'workflow:node-execution-update',
} as const

export interface WorkflowCreateParams {
  name: string
  description?: string
  nodes?: any[]
  edges?: any[]
}

export interface WorkflowUpdateParams {
  id: string
  name?: string
  description?: string
  nodes?: any[]
  edges?: any[]
  status?: string
}
