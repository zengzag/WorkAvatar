import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type OnConnect,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  applyNodeChanges,
  applyEdgeChanges,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button, Dropdown, Modal, Table, App, theme } from 'antd'
import {
  PlusOutlined,
  PlayCircleOutlined,
  StopOutlined,
  ApartmentOutlined,
  ExpandOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { generateId } from '../../utils/format'
import { useWorkflowStore } from '../../stores/workflow.store'
import { useAppearanceStore, getEffectiveTheme } from '../../stores/appearance.store'
import { nodeTypes } from './nodes'

function hasCycle(nodes: Node[], edges: Edge[], source: string, target: string): boolean {
  const adj = new Map<string, string[]>()
  for (const node of nodes) {
    adj.set(node.id, [])
  }
  for (const edge of edges) {
    adj.get(edge.source)?.push(edge.target)
  }
  adj.get(source)?.push(target)

  const visited = new Set<string>()
  const stack = new Set<string>()

  function dfs(nodeId: string): boolean {
    if (stack.has(nodeId)) return true
    if (visited.has(nodeId)) return false
    visited.add(nodeId)
    stack.add(nodeId)
    for (const neighbor of adj.get(nodeId) || []) {
      if (dfs(neighbor)) return true
    }
    stack.delete(nodeId)
    return false
  }

  for (const node of nodes) {
    if (dfs(node.id)) return true
  }
  return false
}

function topologicalLayout(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes

  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()

  for (const node of nodes) {
    inDegree.set(node.id, 0)
    adj.set(node.id, [])
  }
  for (const edge of edges) {
    adj.get(edge.source)?.push(edge.target)
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1)
  }

  const layers: string[][] = []
  const queue: string[] = []
  const remainingInDegree = new Map(inDegree)

  for (const [nodeId, deg] of remainingInDegree) {
    if (deg === 0) queue.push(nodeId)
  }

  while (queue.length > 0) {
    const layer = [...queue]
    layers.push(layer)
    const nextQueue: string[] = []
    for (const nodeId of layer) {
      for (const neighbor of adj.get(nodeId) || []) {
        remainingInDegree.set(neighbor, (remainingInDegree.get(neighbor) || 0) - 1)
        if (remainingInDegree.get(neighbor) === 0) {
          nextQueue.push(neighbor)
        }
      }
    }
    queue.length = 0
    queue.push(...nextQueue)
  }

  const LAYER_GAP_X = 280
  const NODE_GAP_Y = 120
  const START_X = 80
  const START_Y = 80

  return nodes.map((node) => {
    let layerIndex = 0
    let posInLayer = 0
    for (let i = 0; i < layers.length; i++) {
      const idx = layers[i].indexOf(node.id)
      if (idx !== -1) {
        layerIndex = i
        posInLayer = idx
        break
      }
    }
    return {
      ...node,
      position: {
        x: START_X + layerIndex * LAYER_GAP_X,
        y: START_Y + posInLayer * NODE_GAP_Y,
      },
    }
  })
}

const FlowCanvas: React.FC = () => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { message } = App.useApp()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const effectiveTheme = getEffectiveTheme(themeMode)

  const storeNodes = useWorkflowStore((s) => s.nodes)
  const storeEdges = useWorkflowStore((s) => s.edges)
  const setStoreNodes = useWorkflowStore((s) => s.setNodes)
  const setStoreEdges = useWorkflowStore((s) => s.setEdges)
  const addStoreNode = useWorkflowStore((s) => s.addNode)
  const addStoreEdge = useWorkflowStore((s) => s.addEdge)
  const setSelectedNodeId = useWorkflowStore((s) => s.setSelectedNodeId)
  const execution = useWorkflowStore((s) => s.execution)
  const setExecution = useWorkflowStore((s) => s.setExecution)
  const resetExecution = useWorkflowStore((s) => s.resetExecution)

  const [nodes, setNodes] = useNodesState(storeNodes)
  const [edges, setEdges] = useEdgesState(storeEdges)
  const [employeeModalOpen, setEmployeeModalOpen] = useState(false)
  const [employees, setEmployees] = useState<any[]>([])
  const reactFlowRef = useRef<any>(null)

  useEffect(() => {
    setNodes(storeNodes)
  }, [])

  useEffect(() => {
    setEdges(storeEdges)
  }, [])

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const updated = applyNodeChanges(changes, nodes)
      setNodes(updated)
      setStoreNodes(updated)
    },
    [nodes, setNodes, setStoreNodes]
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const updated = applyEdgeChanges(changes, edges)
      setEdges(updated)
      setStoreEdges(updated)
    },
    [edges, setEdges, setStoreEdges]
  )

  const handleConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      if (connection.source === connection.target) return
      if (hasCycle(nodes, edges, connection.source, connection.target)) {
        message.warning(t('workflow.cycleDetected'))
        return
      }
      const newEdge: Edge = {
        id: `e-${connection.source}-${connection.target}`,
        source: connection.source,
        target: connection.target,
        markerEnd: { type: MarkerType.ArrowClosed },
      }
      const updated = addEdge(newEdge, edges)
      setEdges(updated)
      setStoreEdges(updated)
      addStoreEdge(newEdge)
    },
    [nodes, edges, setEdges, setStoreEdges, addStoreEdge, message, t]
  )

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNodeId(node.id)
    },
    [setSelectedNodeId]
  )

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null)
  }, [setSelectedNodeId])

  const addNodeByType = useCallback(
    (type: string) => {
      if (type === 'employee') {
        loadEmployees()
        setEmployeeModalOpen(true)
        return
      }
      const id = `node-${generateId()}`
      const label = type === 'input' ? t('workflow.inputNode') : t('workflow.outputNode')
      const newNode: Node = {
        id,
        type,
        position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
        data: { label },
      }
      setNodes((nds) => [...nds, newNode])
      addStoreNode(newNode)
    },
    [setNodes, addStoreNode, t]
  )

  const loadEmployees = async () => {
    try {
      const result = await window.electronAPI.employee.list()
      setEmployees(result || [])
    } catch {
      message.error(t('workflow.loadEmployeesFailed'))
    }
  }

  const handleSelectEmployee = (emp: any) => {
    const id = `node-${generateId()}`
    const newNode: Node = {
      id,
      type: 'employee',
      position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
      data: {
        label: emp.name,
        employee_id: emp.id,
        employee_name: emp.name,
        description: emp.description || '',
      },
    }
    setNodes((nds) => [...nds, newNode])
    addStoreNode(newNode)
    setEmployeeModalOpen(false)
  }

  const handleAutoLayout = useCallback(() => {
    const layouted = topologicalLayout(nodes, edges)
    setNodes(layouted)
    setStoreNodes(layouted)
  }, [nodes, edges, setNodes, setStoreNodes])

  const handleRun = useCallback(() => {
    if (execution?.status === 'running') {
      resetExecution()
      return
    }
    setExecution({
      id: `exec-${generateId()}`,
      status: 'running',
      nodeExecutions: {},
      startedAt: new Date().toISOString(),
    })
  }, [execution, setExecution, resetExecution])

  const handleDelete = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const target = event.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return

        const selectedNodes = nodes.filter((n) => (n as any).selected)
        const selectedEdges = edges.filter((e) => (e as any).selected)

        if (selectedNodes.length > 0) {
          const selectedIds = new Set(selectedNodes.map((n) => n.id))
          const remaining = nodes.filter((n) => !selectedIds.has(n.id))
          const remainingEdges = edges.filter((e) => !selectedIds.has(e.source) && !selectedIds.has(e.target))
          setNodes(remaining)
          setEdges(remainingEdges)
          setStoreNodes(remaining)
          setStoreEdges(remainingEdges)
          setSelectedNodeId(null)
        } else if (selectedEdges.length > 0) {
          const selectedEdgeIds = new Set(selectedEdges.map((e) => e.id))
          const remaining = edges.filter((e) => !selectedEdgeIds.has(e.id))
          setEdges(remaining)
          setStoreEdges(remaining)
        }
      }
    },
    [nodes, edges, setNodes, setEdges, setStoreNodes, setStoreEdges, setSelectedNodeId]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleDelete)
    return () => window.removeEventListener('keydown', handleDelete)
  }, [handleDelete])

  const addMenuItems = useMemo(
    () => [
      {
        key: 'input',
        label: t('workflow.addInputNode'),
        icon: <PlayCircleOutlined />,
        onClick: () => addNodeByType('input'),
      },
      {
        key: 'output',
        label: t('workflow.addOutputNode'),
        icon: <ExpandOutlined />,
        onClick: () => addNodeByType('output'),
      },
      {
        key: 'employee',
        label: t('workflow.addEmployeeNode'),
        icon: <PlusOutlined />,
        onClick: () => addNodeByType('employee'),
      },
    ],
    [addNodeByType, t]
  )

  const employeeColumns = useMemo(
    () => [
      {
        title: t('workflow.employeeLabel'),
        dataIndex: 'name',
        key: 'name',
      },
      {
        title: t('common.description'),
        dataIndex: 'description',
        key: 'description',
        render: (text: string) => text || t('common.noDescription'),
      },
      {
        title: t('common.action'),
        key: 'action',
        render: (_: any, record: any) => (
          <Button type="link" size="small" onClick={() => handleSelectEmployee(record)}>
            {t('common.add')}
          </Button>
        ),
      },
    ],
    [t]
  )

  const bgColor = effectiveTheme === 'dark' ? '#1a1a2e' : '#f5f5f5'
  const isRunning = execution?.status === 'running'

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '8px 12px',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        <Dropdown menu={{ items: addMenuItems }} trigger={['click']}>
          <Button icon={<PlusOutlined />} type="primary">
            {t('workflow.addNode')}
          </Button>
        </Dropdown>
        <Button
          icon={isRunning ? <StopOutlined /> : <PlayCircleOutlined />}
          danger={isRunning}
          type={isRunning ? 'primary' : 'default'}
          onClick={handleRun}
        >
          {isRunning ? t('workflow.stop') : t('workflow.run')}
        </Button>
        <Button icon={<ApartmentOutlined />} onClick={handleAutoLayout}>
          {t('workflow.autoLayout')}
        </Button>
      </div>

      <div style={{ flex: 1 }}>
        <ReactFlow
          ref={reactFlowRef}
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          nodeTypes={nodeTypes}
          fitView
          style={{ background: bgColor }}
          deleteKeyCode={null}
          minZoom={0.2}
          maxZoom={2}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color={effectiveTheme === 'dark' ? '#333' : '#ddd'} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(node) => {
              if (node.type === 'input') return '#52c41a'
              if (node.type === 'output') return '#1677ff'
              if (node.type === 'employee') return '#722ed1'
              return '#999'
            }}
            style={{ background: effectiveTheme === 'dark' ? '#1a1a2e' : '#fff' }}
          />
        </ReactFlow>
      </div>

      <Modal
        title={t('workflow.selectEmployee')}
        open={employeeModalOpen}
        onCancel={() => setEmployeeModalOpen(false)}
        footer={null}
        width={600}
      >
        <Table
          dataSource={employees}
          columns={employeeColumns}
          rowKey="id"
          size="small"
          pagination={false}
          scroll={{ y: 300 }}
          locale={{ emptyText: t('workflow.noEmployees') }}
        />
      </Modal>
    </div>
  )
}

export default FlowCanvas
