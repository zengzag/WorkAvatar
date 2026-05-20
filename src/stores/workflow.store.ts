import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { Node, Edge } from '@xyflow/react'

export type WorkflowNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface InputNodeData {
  label: string
  prompt?: string
  inputType: 'fixed' | 'runtime' | 'file'
  filePath?: string
  [key: string]: unknown
}

export interface OutputNodeData {
  label: string
  [key: string]: unknown
}

export interface EmployeeNodeData {
  label: string
  employee_id?: string
  employee_name?: string
  description?: string
  provider_id?: string
  model_id?: string
  [key: string]: unknown
}

export interface BranchRule {
  type: 'json_key' | 'keyword'
  jsonKey?: string
  jsonValue?: string
  keywords?: string
}

export interface BranchNodeData {
  label: string
  sourceNodeId?: string
  rules: BranchRule[]
  [key: string]: unknown
}

export interface MergeNodeData {
  label: string
  selectedUpstreamIds: string[]
  upstreamOrder: string[]
  mergeMode: 'concat'
  separator?: string
  prefix?: string
  suffix?: string
  [key: string]: unknown
}

export interface ExtractField {
  name: string
  path: string
  defaultValue?: string
}

export interface ExtractNodeData {
  label: string
  sourceNodeId?: string
  fields: ExtractField[]
  [key: string]: unknown
}

export interface NodeExecutionRecord {
  nodeId: string
  status: WorkflowNodeStatus
  input: string
  output: string
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

interface WorkflowExecution {
  id: string
  status: WorkflowNodeStatus
  nodeExecutions: Record<string, NodeExecutionRecord>
  startedAt: string | null
}

interface DebugState {
  enabled: boolean
  currentNodeId: string | null
  paused: boolean
}

interface WorkflowState {
  nodes: Node[]
  edges: Edge[]
  selectedNodeId: string | null
  execution: WorkflowExecution | null
  debug: DebugState

  setNodes: (nodes: Node[]) => void
  setEdges: (edges: Edge[]) => void
  addNode: (node: Node) => void
  addEdge: (edge: Edge) => void
  setSelectedNodeId: (id: string | null) => void
  updateNodeData: (nodeId: string, data: Partial<InputNodeData | OutputNodeData | EmployeeNodeData | BranchNodeData | MergeNodeData | ExtractNodeData>) => void

  setExecution: (execution: WorkflowExecution | null) => void
  resetExecution: () => void
  updateNodeExecution: (nodeId: string, data: Partial<NodeExecutionRecord>) => void

  setDebugEnabled: (enabled: boolean) => void
  setDebugCurrentNode: (nodeId: string | null) => void
  setDebugPaused: (paused: boolean) => void

  loadFromWorkflow: (workflow: { nodes_json: string; edges_json: string }) => void
}

export const useWorkflowStore = create<WorkflowState>()(
  immer((set) => ({
    nodes: [],
    edges: [],
    selectedNodeId: null,
    execution: null,
    debug: {
      enabled: false,
      currentNodeId: null,
      paused: false,
    },

    setNodes: (nodes) =>
      set((state) => {
        state.nodes = nodes
      }),

    setEdges: (edges) =>
      set((state) => {
        state.edges = edges
      }),

    addNode: (node) =>
      set((state) => {
        state.nodes.push(node)
      }),

    addEdge: (edge) =>
      set((state) => {
        state.edges.push(edge)
      }),

    setSelectedNodeId: (id) =>
      set((state) => {
        state.selectedNodeId = id
      }),

    updateNodeData: (nodeId, data) =>
      set((state) => {
        const node = state.nodes.find((n) => n.id === nodeId)
        if (node) {
          node.data = { ...node.data, ...data }
        }
      }),

    setExecution: (execution) =>
      set((state) => {
        state.execution = execution
      }),

    resetExecution: () =>
      set((state) => {
        state.execution = null
        state.debug.currentNodeId = null
        state.debug.paused = false
      }),

    updateNodeExecution: (nodeId, data) =>
      set((state) => {
        if (state.execution) {
          if (!state.execution.nodeExecutions[nodeId]) {
            state.execution.nodeExecutions[nodeId] = {
              nodeId,
              status: 'pending',
              input: '',
              output: '',
              error: null,
              startedAt: null,
              completedAt: null,
            }
          }
          Object.assign(state.execution.nodeExecutions[nodeId], data)
        }
      }),

    setDebugEnabled: (enabled) =>
      set((state) => {
        state.debug.enabled = enabled
        if (!enabled) {
          state.debug.currentNodeId = null
          state.debug.paused = false
        }
      }),

    setDebugCurrentNode: (nodeId) =>
      set((state) => {
        state.debug.currentNodeId = nodeId
      }),

    setDebugPaused: (paused) =>
      set((state) => {
        state.debug.paused = paused
      }),

    loadFromWorkflow: (workflow) =>
      set((state) => {
        try {
          state.nodes = JSON.parse(workflow.nodes_json || '[]')
        } catch {
          state.nodes = []
        }
        try {
          state.edges = JSON.parse(workflow.edges_json || '[]')
        } catch {
          state.edges = []
        }
        state.selectedNodeId = null
        state.execution = null
        state.debug.currentNodeId = null
        state.debug.paused = false
      }),
  }))
)
