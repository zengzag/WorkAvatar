// 数据模型画布

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge, type Connection, type Node, type Edge
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useDataModelStore } from '../data-model.store'
import { useAppearance, hostT } from '../store'
import { createTable, createRelationship, type Table, type Relationship } from '../../shared/domain'
import { TableNode, type TableNodeData } from './TableNode'
import { RelationshipEdge, type RelationshipEdgeData } from './RelationshipEdge'
import { layoutTables } from './dagre-layout'
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

  // 同步节点/边
  useEffect(() => {
    if (!model) { setNodes([]); setEdges([]); return }
    const tableNodes: Node<TableNodeData>[] = model.tables.map((t) => ({
      id: t.id,
      type: 'table',
      position: { x: t.x, y: t.y },
      data: { table: t, relationships: model.relationships },
      selected: t.id === selectedTableId
    }))
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
    setNodes(tableNodes)
    setEdges(relEdges)
  }, [model, selectedTableId, selectedRelationshipId])

  // 自动布局
  useEffect(() => {
    if (!model || model.tables.length === 0) return
    const width = containerRef.current?.clientWidth ?? 800
    const { nodes: laidOut } = layoutTables(model, width)
    setNodes((nds) => nds.map((n) => {
      const pos = laidOut.find((l) => l.id === n.id)
      return pos ? { ...n, position: pos.position } : n
    }))
  }, [layoutRequest])

  // 聚焦
  useEffect(() => {
    if (!focusRequest) return
    const el = document.querySelector(`[data-id="${focusRequest.tableId}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focusRequest])

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

  const onNodeDragStop = useCallback((_: any, node: Node) => {
    updateTable(node.id, { x: node.position.x, y: node.position.y })
  }, [updateTable])

  const onNodeClick = useCallback((_: any, node: Node) => {
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
        { key: 'new-table', label: hostT('page.newProject'), onClick: handleNewTable },
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
