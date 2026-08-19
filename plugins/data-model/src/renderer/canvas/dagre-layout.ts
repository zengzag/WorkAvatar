// 画布自动布局（dagre）

import dagre from '@dagrejs/dagre'
import type { DataModel, Table, Relationship } from '../../shared/domain'

export const NODE_WIDTH = 260
export const NODE_HEIGHT_COLLAPSED = 40
export const FIELD_HEIGHT = 24
export const HEADER_HEIGHT = 36

/**
 * 计算指定表在画布上应渲染的字段列表。
 * - 展开时：返回全部字段
 * - 折叠时：返回主键字段 + 在任意关系中作为端点的字段（保持原顺序去重）
 * 这样折叠后连线仍能定位到对应字段的 Handle，画布上的关系边不会消失。
 */
export function getVisibleFields(table: Table, relationships: Relationship[]): Table['fields'] {
  if (table.expanded) return table.fields
  const visibleIds = new Set<string>()
  for (const f of table.fields) {
    if (f.primaryKey) visibleIds.add(f.id)
  }
  for (const r of relationships) {
    if (r.sourceTableId === table.id) visibleIds.add(r.sourceFieldId)
    if (r.targetTableId === table.id) visibleIds.add(r.targetFieldId)
  }
  return table.fields.filter((f) => visibleIds.has(f.id))
}

export function computeNodeHeight(table: Table, relationships: Relationship[]): number {
  if (!table.expanded) {
    const visibleCount = getVisibleFields(table, relationships).length
    if (visibleCount === 0) return NODE_HEIGHT_COLLAPSED
    return HEADER_HEIGHT + visibleCount * FIELD_HEIGHT + 8
  }
  const fieldCount = table.fields.length
  return HEADER_HEIGHT + Math.max(fieldCount * FIELD_HEIGHT, 40) + 8
}

export interface LayoutResult {
  nodes: Array<{ id: string; position: { x: number; y: number } }>
  edges: Array<{ id: string; source: string; target: string }>
}

export function layoutTables(model: DataModel, width: number): LayoutResult {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 80, marginx: 40, marginy: 40 })

  const nodeMap = new Map<string, Table>()
  for (const t of model.tables) {
    nodeMap.set(t.id, t)
    g.setNode(t.id, { width: NODE_WIDTH, height: computeNodeHeight(t, model.relationships) })
  }
  for (const r of model.relationships) {
    if (nodeMap.has(r.sourceTableId) && nodeMap.has(r.targetTableId)) {
      g.setEdge(r.sourceTableId, r.targetTableId)
    }
  }

  dagre.layout(g)

  const nodes = model.tables.map((t) => {
    const pos = g.node(t.id)
    return {
      id: t.id,
      position: { x: pos.x - NODE_WIDTH / 2 + (width / 2 - 400), y: pos.y - computeNodeHeight(t, model.relationships) / 2 }
    }
  })
  const edges = model.relationships.map((r) => ({ id: r.id, source: r.sourceTableId, target: r.targetTableId }))
  return { nodes, edges }
}
