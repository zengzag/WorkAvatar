// 关系边渲染

import { memo } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import type { Relationship } from '../../shared/domain'

export type RelationshipEdgeData = { relationship: Relationship }
export type RelationshipEdgeType = Edge<RelationshipEdgeData>
export type RelationshipEdgeComponentProps = EdgeProps<RelationshipEdgeType>

function RelationshipEdgeInner({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: RelationshipEdgeComponentProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition
  })
  const rel = data?.relationship
  const srcCard = rel?.sourceCardinality === 'many' ? 'N' : '1'
  const tgtCard = rel?.targetCardinality === 'many' ? 'N' : '1'

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? 'var(--dm-primary)' : 'var(--dm-edge)',
          strokeWidth: selected ? 2 : 1.5
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute', transform: `translate(-50%, -50%) translate(${sourceX}px, ${sourceY}px)`,
            background: 'var(--dm-bg)', border: '1px solid var(--dm-border-strong)', borderRadius: 4,
            fontSize: 10, padding: '0 4px', color: 'var(--dm-muted)', pointerEvents: 'all'
          }}
        >
          {srcCard}
        </div>
        <div
          style={{
            position: 'absolute', transform: `translate(-50%, -50%) translate(${targetX}px, ${targetY}px)`,
            background: 'var(--dm-bg)', border: '1px solid var(--dm-border-strong)', borderRadius: 4,
            fontSize: 10, padding: '0 4px', color: 'var(--dm-muted)', pointerEvents: 'all'
          }}
        >
          {tgtCard}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const RelationshipEdge = memo(RelationshipEdgeInner)
