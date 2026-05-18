import DatabaseService from './database.service'
import EmployeeAgentService from './employee-agent.service'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { generateId } from './common-utils'
import type { DBEmployee } from '../../shared/db-types'

interface Workflow {
  id: string
  name: string
  description: string
  nodes_json: string
  edges_json: string
  status: string
  created_at: number
  updated_at: number
}

interface WorkflowExecution {
  id: string
  workflow_id: string
  status: string
  node_executions_json: string
  started_at: number | null
  completed_at: number | null
  error_message: string | null
  created_at: number
}

interface NodeExecutionState {
  status: 'pending' | 'running' | 'completed' | 'failed'
  input: string
  output: string
  started_at: number | null
  completed_at: number | null
  error: string | null
  segments?: any[]
}

interface WorkflowNode {
  id: string
  type: string
  data?: any
  config_json?: { prompt?: string; employee_id?: string }
}

interface WorkflowEdge {
  source: string
  target: string
}

class WorkflowService {
  private db: DatabaseService
  private static instance: WorkflowService
  private activeExecutions: Map<string, AbortController> = new Map()

  private constructor() {
    this.db = DatabaseService.getInstance()
  }

  static getInstance(): WorkflowService {
    if (!WorkflowService.instance) {
      WorkflowService.instance = new WorkflowService()
    }
    return WorkflowService.instance
  }

  listWorkflows(): Workflow[] {
    return this.db.getDb().prepare(
      'SELECT * FROM workflows ORDER BY updated_at DESC'
    ).all() as Workflow[]
  }

  getWorkflow(id: string): Workflow | null {
    return this.db.getDb().prepare(
      'SELECT * FROM workflows WHERE id = ?'
    ).get(id) as Workflow | null
  }

  createWorkflow(params: { name: string; description?: string; nodes?: any[]; edges?: any[] }): Workflow {
    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    this.db.getDb().prepare(
      `INSERT INTO workflows (id, name, description, nodes_json, edges_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).run(id, params.name, params.description || '', JSON.stringify(params.nodes || []), JSON.stringify(params.edges || []), now, now)
    return this.getWorkflow(id)!
  }

  updateWorkflow(id: string, params: { name?: string; description?: string; nodes?: any[]; edges?: any[]; status?: string }): Workflow | null {
    const workflow = this.getWorkflow(id)
    if (!workflow) return null
    const updates: string[] = []
    const values: any[] = []
    if (params.name !== undefined) { updates.push('name = ?'); values.push(params.name) }
    if (params.description !== undefined) { updates.push('description = ?'); values.push(params.description) }
    if (params.nodes !== undefined) { updates.push('nodes_json = ?'); values.push(JSON.stringify(params.nodes)) }
    if (params.edges !== undefined) { updates.push('edges_json = ?'); values.push(JSON.stringify(params.edges)) }
    if (params.status !== undefined) { updates.push('status = ?'); values.push(params.status) }
    if (updates.length === 0) return workflow
    updates.push('updated_at = ?')
    values.push(Math.floor(Date.now() / 1000))
    values.push(id)
    this.db.getDb().prepare(`UPDATE workflows SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    return this.getWorkflow(id)
  }

  deleteWorkflow(id: string): boolean {
    const result = this.db.getDb().prepare('DELETE FROM workflows WHERE id = ?').run(id)
    return result.changes > 0
  }

  async executeWorkflow(workflowId: string, mainWindow: Electron.BrowserWindow): Promise<string> {
    const workflow = this.getWorkflow(workflowId)
    if (!workflow) throw new Error(`Workflow ${workflowId} not found`)

    const nodes: WorkflowNode[] = JSON.parse(workflow.nodes_json)
    const edges: WorkflowEdge[] = JSON.parse(workflow.edges_json)

    this.validateDAG(nodes, edges)

    const executionId = generateId()
    const now = Math.floor(Date.now() / 1000)
    const nodeExecutions: Record<string, NodeExecutionState> = {}
    for (const node of nodes) {
      nodeExecutions[node.id] = {
        status: 'pending',
        input: '',
        output: '',
        started_at: null,
        completed_at: null,
        error: null,
      }
    }

    this.db.getDb().prepare(
      `INSERT INTO workflow_executions (id, workflow_id, status, node_executions_json, started_at, created_at)
       VALUES (?, ?, 'running', ?, ?, ?)`
    ).run(executionId, workflowId, JSON.stringify(nodeExecutions), now, now)

    this.sendProgress(mainWindow, executionId, 'running', nodeExecutions)

    this.executeWorkflowAsync(executionId, workflowId, nodes, edges, nodeExecutions, mainWindow)

    return executionId
  }

  private async executeWorkflowAsync(
    executionId: string,
    _workflowId: string,
    nodes: WorkflowNode[],
    edges: WorkflowEdge[],
    nodeExecutions: Record<string, NodeExecutionState>,
    mainWindow: Electron.BrowserWindow
  ): Promise<void> {
    const abortController = new AbortController()
    this.activeExecutions.set(executionId, abortController)

    try {
      const adjacency = this.buildAdjacency(nodes, edges)
      const nodeMap = new Map(nodes.map(n => [n.id, n]))

      const queue: string[] = []
      for (const node of nodes) {
        if (node.type === 'input') {
          queue.push(node.id)
        }
      }

      const completedNodes = new Set<string>()
      const predecessors = this.buildPredecessorMap(edges)

      while (queue.length > 0) {
        if (abortController.signal.aborted) {
          throw new Error('Execution aborted')
        }

        const nodeId = queue.shift()!
        const node = nodeMap.get(nodeId)!
        const nodeExec = nodeExecutions[nodeId]

        nodeExec.status = 'running'
        nodeExec.started_at = Math.floor(Date.now() / 1000)
        this.updateNodeExecution(executionId, nodeExecutions)
        this.sendNodeUpdate(mainWindow, executionId, nodeId, nodeExec)
        this.sendProgress(mainWindow, executionId, 'running', nodeExecutions)

        try {
          if (node.type === 'input') {
            const prompt = node.data?.prompt || node.data?.config_json?.prompt || ''
            nodeExec.input = prompt
            nodeExec.output = prompt
          } else if (node.type === 'employee') {
            const employeeId = node.data?.employee_id || node.data?.config_json?.employee_id
            if (!employeeId) throw new Error(`Employee node ${nodeId} has no employee_id configured`)

            const nodeModelId = node.data?.model_id || node.data?.config_json?.model_id
            const nodeProviderId = node.data?.provider_id || node.data?.config_json?.provider_id

            const inputParts: string[] = []
            for (const predId of predecessors.get(nodeId) || []) {
              const predExec = nodeExecutions[predId]
              if (predExec && predExec.output) {
                inputParts.push(predExec.output)
              }
            }
            const combinedInput = inputParts.join('\n\n')
            nodeExec.input = combinedInput

            const result = await this.executeEmployeeNode(employeeId, nodeProviderId, nodeModelId, combinedInput, abortController.signal, (segments) => {
              nodeExec.segments = segments
              this.sendNodeUpdate(mainWindow, executionId, nodeId, { ...nodeExec })
            })
            nodeExec.output = result
          } else if (node.type === 'output') {
            const inputParts: string[] = []
            for (const predId of predecessors.get(nodeId) || []) {
              const predExec = nodeExecutions[predId]
              if (predExec && predExec.output) {
                inputParts.push(predExec.output)
              }
            }
            nodeExec.input = inputParts.join('\n\n')
            nodeExec.output = nodeExec.input
          }

          nodeExec.status = 'completed'
          nodeExec.completed_at = Math.floor(Date.now() / 1000)
        } catch (error: any) {
          nodeExec.status = 'failed'
          nodeExec.error = error.message || String(error)
          nodeExec.completed_at = Math.floor(Date.now() / 1000)
          this.updateNodeExecution(executionId, nodeExecutions)
          this.sendNodeUpdate(mainWindow, executionId, nodeId, nodeExec)
          throw error
        }

        completedNodes.add(nodeId)
        this.updateNodeExecution(executionId, nodeExecutions)
        this.sendNodeUpdate(mainWindow, executionId, nodeId, nodeExec)
        this.sendProgress(mainWindow, executionId, 'running', nodeExecutions)

        for (const successor of adjacency.get(nodeId) || []) {
          const allPredsComplete = (predecessors.get(successor) || []).every(pred => completedNodes.has(pred))
          if (allPredsComplete) {
            queue.push(successor)
          }
        }
      }

      const completedAt = Math.floor(Date.now() / 1000)
      this.db.getDb().prepare(
        `UPDATE workflow_executions SET status = 'completed', node_executions_json = ?, completed_at = ? WHERE id = ?`
      ).run(JSON.stringify(nodeExecutions), completedAt, executionId)
      this.sendProgress(mainWindow, executionId, 'completed', nodeExecutions)
    } catch (error: any) {
      const completedAt = Math.floor(Date.now() / 1000)
      const status = abortController.signal.aborted ? 'aborted' : 'failed'
      this.db.getDb().prepare(
        `UPDATE workflow_executions SET status = ?, node_executions_json = ?, completed_at = ?, error_message = ? WHERE id = ?`
      ).run(status, JSON.stringify(nodeExecutions), completedAt, error.message || String(error), executionId)
      this.sendProgress(mainWindow, executionId, status, nodeExecutions)
    } finally {
      this.activeExecutions.delete(executionId)
    }
  }

  private async executeEmployeeNode(
    employeeId: string,
    overrideProviderId: string | undefined,
    modelId: string | undefined,
    input: string,
    signal: AbortSignal,
    onSegments: (segments: any[]) => void
  ): Promise<string> {
    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as DBEmployee | undefined
    if (!employee) throw new Error(`Employee ${employeeId} not found`)

    const providerId = overrideProviderId || employee.llm_provider_id
    if (!providerId) throw new Error(`Employee ${employeeId} has no LLM provider configured`)

    const resolvedModelId = modelId || employee.llm_model || undefined

    const agentService = EmployeeAgentService.getInstance()

    let resultText = ''
    const segments: any[] = []
    let lastSentTime = 0
    const SEGMENT_SEND_INTERVAL = 200

    const throttledSendSegments = () => {
      const now = Date.now()
      if (now - lastSentTime >= SEGMENT_SEND_INTERVAL) {
        lastSentTime = now
        onSegments([...segments])
      }
    }

    resultText = await new Promise<string>((resolve, reject) => {
      let accumulated = ''
      let currentSegment: any = null

      agentService.chatStream(
        {
          employee_id: employeeId,
          provider_id: providerId,
          model_id: resolvedModelId,
          messages: [{ role: 'user', content: input }],
          use_skills: true,
          enable_thinking: false,
        },
        {
          onChunk: (chunk: string) => {
            accumulated += chunk
            if (currentSegment && currentSegment.type === 'answer') {
              currentSegment.content = (currentSegment.content || '') + chunk
            } else {
              if (currentSegment) {
                currentSegment.isStreaming = false
              }
              currentSegment = {
                type: 'answer',
                id: generateId(),
                content: chunk,
                isStreaming: true,
              }
              segments.push(currentSegment)
            }
            throttledSendSegments()
          },
          onThought: (thought: string) => {
            if (currentSegment && currentSegment.type === 'thinking') {
              currentSegment.content = (currentSegment.content || '') + thought
            } else {
              if (currentSegment) {
                currentSegment.isStreaming = false
              }
              currentSegment = {
                type: 'thinking',
                id: generateId(),
                content: thought,
                isStreaming: true,
                collapsed: false,
              }
              segments.push(currentSegment)
            }
            throttledSendSegments()
          },
          onToolCall: (toolCall: any) => {
            if (currentSegment) {
              currentSegment.isStreaming = false
            }
            currentSegment = {
              type: 'tool_call',
              id: generateId(),
              toolName: toolCall.name || toolCall.function?.name,
              toolArgs: toolCall.arguments || toolCall.function?.arguments,
              isToolComplete: false,
              isStreaming: true,
            }
            segments.push(currentSegment)
            throttledSendSegments()
          },
          onToolResult: (result: any) => {
            if (currentSegment && currentSegment.type === 'tool_call') {
              currentSegment.toolResult = typeof result === 'string' ? result : JSON.stringify(result)
              currentSegment.isToolComplete = true
              currentSegment.isStreaming = false
            }
            currentSegment = null
            throttledSendSegments()
          },
          onDone: () => {
            if (currentSegment) {
              currentSegment.isStreaming = false
            }
            for (const seg of segments) {
              if (seg.type === 'thinking') {
                seg.collapsed = true
              }
            }
            onSegments([...segments])
            resolve(accumulated)
          },
          onError: (error: string) => {
            if (currentSegment) {
              currentSegment.isStreaming = false
            }
            onSegments([...segments])
            reject(new Error(error))
          },
        },
        signal
      )
    })

    return resultText
  }

  abortExecution(executionId: string): boolean {
    const controller = this.activeExecutions.get(executionId)
    if (controller) {
      controller.abort()
      return true
    }
    return false
  }

  getExecution(executionId: string): WorkflowExecution | null {
    return this.db.getDb().prepare(
      'SELECT * FROM workflow_executions WHERE id = ?'
    ).get(executionId) as WorkflowExecution | null
  }

  listExecutions(workflowId: string, limit: number = 50): WorkflowExecution[] {
    return this.db.getDb().prepare(
      'SELECT * FROM workflow_executions WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(workflowId, limit) as WorkflowExecution[]
  }

  private validateDAG(nodes: WorkflowNode[], edges: WorkflowEdge[]): void {
    const nodeIds = new Set(nodes.map(n => n.id))
    const visited = new Set<string>()
    const recursionStack = new Set<string>()

    const adjacency = new Map<string, string[]>()
    for (const node of nodes) {
      adjacency.set(node.id, [])
    }
    for (const edge of edges) {
      if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
        adjacency.get(edge.source)!.push(edge.target)
      }
    }

    const hasCycle = (nodeId: string): boolean => {
      visited.add(nodeId)
      recursionStack.add(nodeId)
      for (const neighbor of adjacency.get(nodeId) || []) {
        if (!visited.has(neighbor)) {
          if (hasCycle(neighbor)) return true
        } else if (recursionStack.has(neighbor)) {
          return true
        }
      }
      recursionStack.delete(nodeId)
      return false
    }

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        if (hasCycle(node.id)) {
          throw new Error('Workflow contains a cycle and is not a valid DAG')
        }
      }
    }
  }

  private buildAdjacency(nodes: WorkflowNode[], edges: WorkflowEdge[]): Map<string, string[]> {
    const adjacency = new Map<string, string[]>()
    const nodeIds = new Set(nodes.map(n => n.id))
    for (const node of nodes) {
      adjacency.set(node.id, [])
    }
    for (const edge of edges) {
      if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
        adjacency.get(edge.source)!.push(edge.target)
      }
    }
    return adjacency
  }

  private buildPredecessorMap(edges: WorkflowEdge[]): Map<string, string[]> {
    const predecessors = new Map<string, string[]>()
    for (const edge of edges) {
      if (!predecessors.has(edge.target)) {
        predecessors.set(edge.target, [])
      }
      predecessors.get(edge.target)!.push(edge.source)
    }
    return predecessors
  }

  private updateNodeExecution(executionId: string, nodeExecutions: Record<string, NodeExecutionState>): void {
    this.db.getDb().prepare(
      'UPDATE workflow_executions SET node_executions_json = ? WHERE id = ?'
    ).run(JSON.stringify(nodeExecutions), executionId)
  }

  private sendProgress(mainWindow: Electron.BrowserWindow, executionId: string, status: string, nodeExecutions: Record<string, NodeExecutionState>): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.WORKFLOW_EXECUTION_PROGRESS, {
        executionId,
        status,
        nodeExecutions,
      })
    }
  }

  private sendNodeUpdate(mainWindow: Electron.BrowserWindow, executionId: string, nodeId: string, nodeExecution: NodeExecutionState): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.WORKFLOW_NODE_EXECUTION_UPDATE, {
        executionId,
        nodeId,
        nodeExecution,
      })
    }
  }
}

export default WorkflowService
export type { Workflow, WorkflowExecution, NodeExecutionState }
