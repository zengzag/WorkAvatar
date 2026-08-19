// 数据模型画布

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  useNodesState, useEdgesState, useReactFlow,
  type Connection, type Node, type Edge, type OnNodeDrag, type NodeMouseHandler
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useDataModelStore } from '../data-model.store'
import { useAppearance, hostT } from '../store'
import { createTable, createRelationship } from '../../shared/domain'
import { TableNode, type TableNodeData } from './TableNode'
import { RelationshipEdge, type RelationshipEdgeData } from './RelationshipEdge'
import { layoutTables, NODE_WIDTH, HEADER_HEIGHT, FIELD_HEIGHT, NODE_HEIGHT_COLLAPSED, getVisibleFields } from './dagre-layout'
import { CanvasContextMenu, type ContextMenuState } from './CanvasContextMenu'

const nodeTypes = { table: TableNode }
const edgeTypes = { relationship: RelationshipEdge }

function CanvasInner() {
  const model = useDataModelStore((s) => s.model)
  const selectedTableId = useDataModelStore((s) => s.selectedTableId)
  const selectedRelationshipId = useDataModelStore((s) => s.selectedRelationshipId)
  const focusRequest = useDataModelStore((s) => s.focusRequest)
  const layoutRequest = useDataModelStore((s) => s.layoutRequest)
  const { selectTable, selectRelationship, updateTable, removeTable, addTable, addRelationship, removeRelationship, requestLayout } = useDataModelStore.getState()

  const { isDark } = useAppearance()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TableNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<RelationshipEdgeData>>([])
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { setCenter, getNode, fitView } = useReactFlow()

  // 用于检测 model 是否切换（新项目加载）
  const prevModelId = useRef<string | undefined>(model?.id)

  // 当 model 切换（新项目加载）时，重新自动布局
  useEffect(() => {
    if (!model) {
      setNodes([])
      setEdges([])
      prevModelId.current = undefined
      return
    }
    if (prevModelId.current !== model.id) {
      prevModelId.current = model.id
      const width = containerRef.current?.clientWidth ?? 800
      const { nodes: laidOut } = layoutTables(model, width)
      setNodes(laidOut.map((l) => ({
        id: l.id,
        type: 'table',
        position: l.position,
        data: { table: model.tables.find((t) => t.id === l.id)!, relationships: model.relationships }
      })))
      setEdges(model.relationships.map((r) => ({
        id: r.id,
        type: 'relationship',
        source: r.sourceTableId,
        target: r.targetTableId,
        sourceHandle: `field-${r.sourceFieldId}-right`,
        targetHandle: `field-${r.targetFieldId}-left`,
        data: { relationship: r }
      })))
    }
  }, [model, setNodes, setEdges])

  // 当 model 内的 tables/relationships 变化时，同步节点数据（不重布局）
  // - 已有节点：更新 data（保留用户拖拽的 position）
  // - 新增表：使用默认位置
  // - 删除表：移除对应节点
  useEffect(() => {
    if (!model) return
    if (prevModelId.current !== model.id) return // 已由上面的 effect 处理

    const tableMap = new Map(model.tables.map((t) => [t.id, t]))

    setNodes((nds) => {
      const existing = nds.filter((n) => tableMap.has(n.id))
      const updated = existing.map((n) => {
        const table = tableMap.get(n.id)!
        return { ...n, data: { table, relationships: model.relationships } }
      })
      const existingIds = new Set(nds.map((n) => n.id))
      const newTables = model.tables.filter((t) => !existingIds.has(t.id))
      const newNodes = newTables.map((table) => ({
        id: table.id,
        type: 'table' as const,
        position: { x: table.x || 200, y: table.y || 200 },
        data: { table, relationships: model.relationships }
      }))
      return [...updated, ...newNodes]
    })

    const relEdges: Edge<RelationshipEdgeData>[] = model.relationships.map((r) => ({
      id: r.id,
      type: 'relationship',
      source: r.sourceTableId,
      target: r.targetTableId,
      sourceHandle: `field-${r.sourceFieldId}-right`,
      targetHandle: `field-${r.targetFieldId}-left`,
      data: { relationship: r },
      selected: r.id === selectedRelationshipId
    }))
    setEdges(relEdges)
  }, [model, setNodes, setEdges, selectedRelationshipId])

  // 选中态同步到节点
  useEffect(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === selectedTableId })))
  }, [selectedTableId, setNodes])

  // 响应自动排版请求（用户点击按钮 / AI 工具增删表后）
  useEffect(() => {
    if (!layoutRequest) return
    const currentModel = useDataModelStore.getState().model
    if (!currentModel || currentModel.tables.length === 0) return
    const width = containerRef.current?.clientWidth ?? 800
    const { nodes: laidOut } = layoutTables(currentModel, width)
    setNodes(laidOut.map((l) => ({
      id: l.id,
      type: 'table',
      position: l.position,
      data: { table: currentModel.tables.find((t) => t.id === l.id)!, relationships: currentModel.relationships }
    })))
    setEdges(currentModel.relationships.map((r) => ({
      id: r.id,
      type: 'relationship',
      source: r.sourceTableId,
      target: r.targetTableId,
      sourceHandle: `field-${r.sourceFieldId}-right`,
      targetHandle: `field-${r.targetFieldId}-left`,
      data: { relationship: r }
    })))
    const raf = requestAnimationFrame(() => {
      try { fitView({ padding: 0.2, duration: 300 }) } catch { /* 节点未挂载时忽略 */ }
    })
    return () => cancelAnimationFrame(raf)
  }, [layoutRequest, setNodes, setEdges, fitView])

  // 聚焦
  useEffect(() => {
    if (!focusRequest) return
    const node = getNode(focusRequest.tableId)
    if (!node) return
    const table = (node.data as TableNodeData)?.table
    if (!table) return
    const relationships = model?.relationships ?? []
    const visibleCount = getVisibleFields(table, relationships).length
    const h = table.expanded
      ? HEADER_HEIGHT + Math.max(table.fields.length * FIELD_HEIGHT, 40) + 8
      : visibleCount > 0
        ? HEADER_HEIGHT + visibleCount * FIELD_HEIGHT + 8
        : NODE_HEIGHT_COLLAPSED
    const cx = node.position.x + NODE_WIDTH / 2
    const cy = node.position.y + h / 2
    setCenter(cx, cy, { zoom: 1, duration: 400 })
  }, [focusRequest, getNode, setCenter, model])

  const onConnect = useCallback((conn: Connection) => {
    const sourceFieldId = conn.sourceHandle?.replace(/^field-/, '').replace(/-right$/, '')
    const targetFieldId = conn.targetHandle?.replace(/^field-/, '').replace(/-left$/, '')
    if (!sourceFieldId || !targetFieldId || !conn.source || !conn.target) return
    const rel = createRelationship({
      sourceTableId: conn.source,
      sourceFieldId,
      targetTableId: conn.target,
      targetFieldId,
      sourceCardinality: 'one',
      targetCardinality: 'many'
    })
    addRelationship(rel)
  }, [addRelationship])

  const onNodeDragStop: OnNodeDrag<Node<TableNodeData>> = useCallback((_: any, node: Node) => {
    updateTable(node.id, { x: node.position.x, y: node.position.y })
  }, [updateTable])

  const onNodeClick: NodeMouseHandler<Node<TableNodeData>> = useCallback((_: any, node: Node) => {
    selectTable(node.id)
  }, [selectTable])

  const onEdgeClick = useCallback((_: any, edge: Edge) => {
    selectRelationship(edge.id)
  }, [selectRelationship])

  const onPaneClick = useCallback(() => {
    selectTable(null)
    selectRelationship(null)
  }, [selectTable, selectRelationship])

  const onPaneContextMenu = useCallback((e: React.MouseEvent<Element, MouseEvent> | MouseEvent) => {
    e.preventDefault()
    setMenu({ type: 'pane', x: e.clientX, y: e.clientY })
  }, [])

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault()
    setMenu({ type: 'node', x: e.clientX, y: e.clientY, nodeId: node.id })
  }, [])

  const onEdgeContextMenu = useCallback((e: React.MouseEvent, edge: Edge) => {
    e.preventDefault()
    setMenu({ type: 'edge', x: e.clientX, y: e.clientY, edgeId: edge.id })
  }, [])

  const handleNewTable = useCallback(() => {
    const table = createTable({ name: `table_${model?.tables.length ?? 0 + 1}` })
    addTable(table)
  }, [model, addTable])

  const menuItems = useMemo(() => {
    if (!menu) return []
    if (menu.type === 'pane') {
      return [
        { key: 'new-table', label: hostT('page.newTable'), onClick: handleNewTable },
        { key: 'layout', label: hostT('page.autoLayout'), onClick: requestLayout }
      ]
    }
    if (menu.type === 'node') {
      const table = model?.tables.find((t) => t.id === menu.nodeId)
      return [
        { key: 'edit', label: hostT('table.edit'), onClick: () => selectTable(menu.nodeId) },
        {
          key: 'toggle', label: table?.expanded ? hostT('table.collapse') : hostT('table.expand'),
          onClick: () => table && updateTable(table.id, { expanded: !table.expanded })
        },
        { key: 'add-field', label: hostT('table.addField'), onClick: () => selectTable(menu.nodeId) },
        { key: 'delete', label: hostT('table.delete'), danger: true, onClick: () => removeTable(menu.nodeId) }
      ]
    }
    return [
      { key: 'delete', label: hostT('relationship.delete'), danger: true, onClick: () => removeRelationship(menu.edgeId) }
    ]
  }, [menu, model, handleNewTable, requestLayout, selectTable, updateTable, removeTable, removeRelationship])

  if (!model) return null

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={isDark ? 'dark' : 'light'}
        fitView
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls />
        <MiniMap
          nodeColor={(n) => (n.data as TableNodeData)?.table?.color ?? '#71717a'}
          pannable
          zoomable
        />
      </ReactFlow>
      <CanvasContextMenu state={menu} items={menuItems} onClose={() => setMenu(null)} />
    </div>
  )
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}
