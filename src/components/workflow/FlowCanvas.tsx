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
  type ReactFlowInstance,
  applyNodeChanges,
  applyEdgeChanges,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button, Dropdown, Modal, Table, App, theme } from 'antd'
import {
  PlusOutlined,
  ApartmentOutlined,
  EnterOutlined,
  ExportOutlined,
  DeleteOutlined,
  CopyOutlined,
  ScissorOutlined,
  ForkOutlined,
  MergeCellsOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { generateId } from '../../utils/format'
import { useWorkflowStore } from '../../stores/workflow.store'
import { useAppearanceStore, getEffectiveTheme } from '../../stores/appearance.store'
import { nodeTypes } from './nodes'

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  type: 'pane' | 'node' | 'edge'
  targetId?: string
}

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
  const setSelectedNodeId = useWorkflowStore((s) => s.setSelectedNodeId)

  const [nodes, setNodes] = useNodesState(storeNodes)
  const [edges, setEdges] = useEdgesState(storeEdges)
  const [employeeModalOpen, setEmployeeModalOpen] = useState(false)
  const [employees, setEmployees] = useState<any[]>([])
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, type: 'pane' })
  const reactFlowInstance = useRef<ReactFlowInstance<Node, Edge> | null>(null)

  useEffect(() => {
    setNodes(storeNodes)
  }, [])

  useEffect(() => {
    setEdges(storeEdges)
  }, [])

  const skipStoreSyncRef = useRef(false)
  const skipEdgeStoreSyncRef = useRef(false)

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const updated = applyNodeChanges(changes, nodes)
      setNodes(updated)
      skipStoreSyncRef.current = true
      setStoreNodes(updated)
    },
    [nodes, setNodes, setStoreNodes]
  )

  useEffect(() => {
    if (skipStoreSyncRef.current) {
      skipStoreSyncRef.current = false
      return
    }
    setNodes(storeNodes)
  }, [storeNodes])

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const updated = applyEdgeChanges(changes, edges)
      setEdges(updated)
      skipEdgeStoreSyncRef.current = true
      setStoreEdges(updated)
    },
    [edges, setEdges, setStoreEdges]
  )

  useEffect(() => {
    if (skipEdgeStoreSyncRef.current) {
      skipEdgeStoreSyncRef.current = false
      return
    }
    setEdges(storeEdges)
  }, [storeEdges])

  const handleConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      if (connection.source === connection.target) return
      if (hasCycle(nodes, edges, connection.source, connection.target)) {
        message.warning(t('workflow.cycleDetected'))
        return
      }
      const newEdge: Edge = {
        id: `e-${generateId()}`,
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle || undefined,
        markerEnd: { type: MarkerType.ArrowClosed },
      }
      const updated = addEdge(newEdge, edges)
      setEdges(updated)
      setStoreEdges(updated)
    },
    [nodes, edges, setEdges, setStoreEdges, message, t]
  )

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNodeId(node.id)
    },
    [setSelectedNodeId]
  )

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null)
    setContextMenu((prev) => ({ ...prev, visible: false }))
  }, [setSelectedNodeId])

  const handlePaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault()
      setContextMenu({
        visible: true,
        x: (event as React.MouseEvent).clientX,
        y: (event as React.MouseEvent).clientY,
        type: 'pane',
      })
    },
    []
  )

  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault()
      setContextMenu({
        visible: true,
        x: event.clientX,
        y: event.clientY,
        type: 'node',
        targetId: node.id,
      })
    },
    []
  )

  const handleEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.preventDefault()
      setContextMenu({
        visible: true,
        x: event.clientX,
        y: event.clientY,
        type: 'edge',
        targetId: edge.id,
      })
    },
    []
  )

  const addNodeByType = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      if (type === 'employee') {
        loadEmployees()
        setEmployeeModalOpen(true)
        return
      }
      const id = `node-${generateId()}`
      const labelMap: Record<string, string> = {
        input: t('workflow.inputNode'),
        output: t('workflow.outputNode'),
        branch: t('workflow.branchNode'),
        merge: t('workflow.mergeNode'),
        extract: t('workflow.extractNode'),
      }
      const dataMap: Record<string, any> = {
        input: { label: labelMap.input, inputType: 'fixed' },
        output: { label: labelMap.output },
        branch: { label: labelMap.branch, rules: [] },
        merge: { label: labelMap.merge, selectedUpstreamIds: [], upstreamOrder: [], mergeMode: 'concat' },
        extract: { label: labelMap.extract, fields: [] },
      }
      const newNode: Node = {
        id,
        type,
        position: position || { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
        data: dataMap[type] || { label: labelMap[type] || type },
      }
      setNodes((nds) => [...nds, newNode])
      addStoreNode(newNode)
      setContextMenu((prev) => ({ ...prev, visible: false }))
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

  const handleDeleteNodeById = useCallback(
    (nodeId: string) => {
      const remaining = nodes.filter((n) => n.id !== nodeId)
      const remainingEdges = edges.filter((e) => e.source !== nodeId && e.target !== nodeId)
      setNodes(remaining)
      setEdges(remainingEdges)
      setStoreNodes(remaining)
      setStoreEdges(remainingEdges)
      setSelectedNodeId(null)
      setContextMenu((prev) => ({ ...prev, visible: false }))
    },
    [nodes, edges, setNodes, setEdges, setStoreNodes, setStoreEdges, setSelectedNodeId]
  )

  const handleCopyNode = useCallback(
    (nodeId: string) => {
      const sourceNode = nodes.find((n) => n.id === nodeId)
      if (!sourceNode) return
      const id = `node-${generateId()}`
      const newNode: Node = {
        id,
        type: sourceNode.type,
        position: { x: sourceNode.position.x + 40, y: sourceNode.position.y + 40 },
        data: { ...sourceNode.data, label: `${(sourceNode.data as any).label} ${t('workflow.copySuffix')}` },
      }
      setNodes((nds) => [...nds, newNode])
      addStoreNode(newNode)
      setContextMenu((prev) => ({ ...prev, visible: false }))
    },
    [nodes, setNodes, addStoreNode, t]
  )

  const handleDeleteEdgeById = useCallback(
    (edgeId: string) => {
      const remaining = edges.filter((e) => e.id !== edgeId)
      setEdges(remaining)
      setStoreEdges(remaining)
      setContextMenu((prev) => ({ ...prev, visible: false }))
    },
    [edges, setEdges, setStoreEdges]
  )

  const handleAutoLayout = useCallback(() => {
    const layouted = topologicalLayout(nodes, edges)
    setNodes(layouted)
    setStoreNodes(layouted)
  }, [nodes, edges, setNodes, setStoreNodes])

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
        icon: <EnterOutlined />,
        onClick: () => addNodeByType('input'),
      },
      {
        key: 'output',
        label: t('workflow.addOutputNode'),
        icon: <ExportOutlined />,
        onClick: () => addNodeByType('output'),
      },
      {
        key: 'employee',
        label: t('workflow.addEmployeeNode'),
        icon: <PlusOutlined />,
        onClick: () => addNodeByType('employee'),
      },
      {
        key: 'branch',
        label: t('workflow.addBranchNode'),
        icon: <ForkOutlined />,
        onClick: () => addNodeByType('branch'),
      },
      {
        key: 'merge',
        label: t('workflow.addMergeNode'),
        icon: <MergeCellsOutlined />,
        onClick: () => addNodeByType('merge'),
      },
      {
        key: 'extract',
        label: t('workflow.addExtractNode'),
        icon: <ScissorOutlined />,
        onClick: () => addNodeByType('extract'),
      },
    ],
    [addNodeByType, t]
  )

  const paneContextMenuItems = useMemo(() => {
    const flowPos = reactFlowInstance.current?.screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y }) || { x: 100, y: 100 }
    return [
      {
        key: 'input',
        label: t('workflow.addInputNode'),
        icon: <EnterOutlined />,
        onClick: () => addNodeByType('input', flowPos),
      },
      {
        key: 'output',
        label: t('workflow.addOutputNode'),
        icon: <ExportOutlined />,
        onClick: () => addNodeByType('output', flowPos),
      },
      {
        key: 'employee',
        label: t('workflow.addEmployeeNode'),
        icon: <PlusOutlined />,
        onClick: () => addNodeByType('employee', flowPos),
      },
      {
        key: 'branch',
        label: t('workflow.addBranchNode'),
        icon: <ForkOutlined />,
        onClick: () => addNodeByType('branch', flowPos),
      },
      {
        key: 'merge',
        label: t('workflow.addMergeNode'),
        icon: <MergeCellsOutlined />,
        onClick: () => addNodeByType('merge', flowPos),
      },
      {
        key: 'extract',
        label: t('workflow.addExtractNode'),
        icon: <ScissorOutlined />,
        onClick: () => addNodeByType('extract', flowPos),
      },
    ]
  }, [addNodeByType, t, contextMenu.x, contextMenu.y])

  const nodeContextMenuItems = useMemo(() => {
    if (!contextMenu.targetId) return []
    return [
      {
        key: 'copy',
        label: t('workflow.copyNode'),
        icon: <CopyOutlined />,
        onClick: () => handleCopyNode(contextMenu.targetId!),
      },
      {
        key: 'delete',
        label: t('workflow.deleteNode'),
        icon: <DeleteOutlined />,
        danger: true,
        onClick: () => handleDeleteNodeById(contextMenu.targetId!),
      },
    ]
  }, [contextMenu.targetId, handleCopyNode, handleDeleteNodeById, t])

  const edgeContextMenuItems = useMemo(() => {
    if (!contextMenu.targetId) return []
    return [
      {
        key: 'delete',
        label: t('workflow.deleteEdge'),
        icon: <ScissorOutlined />,
        danger: true,
        onClick: () => handleDeleteEdgeById(contextMenu.targetId!),
      },
    ]
  }, [contextMenu.targetId, handleDeleteEdgeById, t])

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

  const edgeColor = effectiveTheme === 'dark' ? '#555' : '#b1b1b7'

  const styledEdges = useMemo(() =>
    edges.map((edge) => {
      let strokeColor = edgeColor
      let label: string | undefined
      if (edge.sourceHandle === 'yes') {
        strokeColor = '#52c41a'
        label = t('workflow.branchYes')
      } else if (edge.sourceHandle === 'no') {
        strokeColor = '#ff4d4f'
        label = t('workflow.branchNo')
      }
      return {
        ...edge,
        style: { stroke: strokeColor, strokeWidth: 2 },
        label,
        labelStyle: { fill: strokeColor, fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: effectiveTheme === 'dark' ? '#1a1a2e' : '#fff', fillOpacity: 0.8 },
        labelBgPadding: [4, 6] as [number, number],
        labelBgBorderRadius: 4,
      }
    }),
    [edges, edgeColor, effectiveTheme, t]
  )

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
        <Button icon={<ApartmentOutlined />} onClick={handleAutoLayout}>
          {t('workflow.autoLayout')}
        </Button>
      </div>

      <div style={{ flex: 1 }}>
        <ReactFlow
          onInit={(instance) => { reactFlowInstance.current = instance as any }}
          nodes={nodes}
          edges={styledEdges}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          onPaneContextMenu={handlePaneContextMenu}
          onNodeContextMenu={handleNodeContextMenu}
          onEdgeContextMenu={handleEdgeContextMenu}
          nodeTypes={nodeTypes}
          fitView
          style={{ background: bgColor }}
          deleteKeyCode={null}
          minZoom={0.2}
          maxZoom={2}
          colorMode={effectiveTheme}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color={effectiveTheme === 'dark' ? '#333' : '#ddd'} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(node) => {
              if (node.type === 'input') return '#52c41a'
              if (node.type === 'output') return '#1677ff'
              if (node.type === 'employee') return '#722ed1'
              if (node.type === 'branch') return '#fa8c16'
              if (node.type === 'merge') return '#13c2c2'
              if (node.type === 'extract') return '#eb2f96'
              return '#999'
            }}
          />
        </ReactFlow>

        {contextMenu.visible && (
          <div
            style={{
              position: 'fixed',
              top: contextMenu.y,
              left: contextMenu.x,
              zIndex: 1000,
            }}
          >
            <Dropdown
              menu={{
                items:
                  contextMenu.type === 'pane'
                    ? paneContextMenuItems
                    : contextMenu.type === 'node'
                      ? nodeContextMenuItems
                      : edgeContextMenuItems,
              }}
              open={contextMenu.visible}
              onOpenChange={(open) => {
                if (!open) setContextMenu((prev) => ({ ...prev, visible: false }))
              }}
            >
              <div />
            </Dropdown>
          </div>
        )}
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
