// 画布自动布局（dagre）

import dagre from '@dagrejs/dagre'
import type { DataModel, Table, Relationship } from '../../shared/domain'

export const NODE_WIDTH = 260
export const NODE_HEIGHT_COLLAPSED = 40
export const FIELD_HEIGHT = 24
export const HEADER_HEIGHT = 36

export function getVisibleFields(table: Table, relationships: Relationship[]): Table['fields'] {
  if (table.expanded) return table.fields
  const relFieldIds = new Set<string>()
  for (const r of relationships) {
    if (r.sourceTableId === table.id) relFieldIds.add(r.sourceFieldId)
    if (r.targetTableId === table.id) relFieldIds.add(r.targetFieldId)
  }
  return table.fields.filter((f) => f.primaryKey || relFieldIds.has(f.id))
}

export function computeNodeHeight(table: Table, relationships: Relationship[]): number {
  if (!table.expanded) return NODE_HEIGHT_COLLAPSED
  return HEADER_HEIGHT + getVisibleFields(table, relationships).length * FIELD_HEIGHT
}

export interface LayoutResult {
  nodes: Array<{ id: string; position: { x: number; y: number } }>
  edges: Array<{ id: string; source: string; target: string }>
}

export function layoutTables(model: DataModel, width: number): LayoutResult {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 80 })

  for (const t of model.tables) {
    g.setNode(t.id, { width: NODE_WIDTH, height: computeNodeHeight(t, model.relationships) })
  }
  for (const r of model.relationships) {
    g.setEdge(r.sourceTableId, r.targetTableId)
  }

  dagre.layout(g)

  const nodes = model.tables.map((t) => {
    const pos = g.node(t.id)
    return {
      id: t.id,
      position: { x: (pos.x - NODE_WIDTH / 2) + (width / 2 - 400), y: pos.y - computeNodeHeight(t, model.relationships) / 2 }
    }
  })
  const edges = model.relationships.map((r) => ({ id: r.id, source: r.sourceTableId, target: r.targetTableId }))
  return { nodes, edges }
}
