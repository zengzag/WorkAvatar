// 表节点渲染

import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { Relationship, Table } from '../../shared/domain'
import { getVisibleFields } from './dagre-layout'

export type TableNodeData = { table: Table; relationships: Relationship[] }
export type TableNodeType = Node<TableNodeData>
export type TableNodeComponentProps = NodeProps<TableNodeType>

const HEADER_HEIGHT = 36
const FIELD_HEIGHT = 24

function FieldRow({ field, color }: { field: Table['fields'][number]; color: string }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', height: FIELD_HEIGHT, padding: '0 8px',
        fontSize: 12, gap: 6, position: 'relative', borderBottom: '1px solid var(--dm-border)'
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        id={`field-${field.id}-left`}
        style={{ width: 8, height: 8, background: color, border: '1px solid var(--dm-border-strong)' }}
      />
      {field.primaryKey && <span style={{ color: '#d97706', fontSize: 11, width: 12 }}>🔑</span>}
      <span
        style={{
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontFamily: 'var(--dm-mono)', fontWeight: field.primaryKey ? 600 : 400
        }}
      >
        {field.name}
      </span>
      {field.comment && <span style={{ color: 'var(--dm-muted)', fontSize: 10 }}>💬</span>}
      <span style={{ color: 'var(--dm-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>
        {field.type}
        {field.typeLength ? `(${field.typeLength})` : ''}
      </span>
      {!field.nullable && <span style={{ color: '#ef4444', fontSize: 11 }}>*</span>}
      <Handle
        type="source"
        position={Position.Right}
        id={`field-${field.id}-right`}
        style={{ width: 8, height: 8, background: color, border: '1px solid var(--dm-border-strong)' }}
      />
    </div>
  )
}

function TableNodeInner({ data, selected }: TableNodeComponentProps) {
  const { table, relationships } = data
  const visibleFields = getVisibleFields(table, relationships)
  const pkCount = table.fields.filter((f) => f.primaryKey).length

  return (
    <div
      style={{
        width: 260, borderRadius: 8, overflow: 'hidden',
        border: selected ? '2px solid var(--dm-primary)' : '1px solid var(--dm-border-strong)',
        boxShadow: selected ? '0 0 0 3px var(--dm-primary-soft)' : '0 1px 3px rgba(0,0,0,0.1)',
        background: 'var(--dm-bg)'
      }}
    >
      <div
        style={{
          height: HEADER_HEIGHT, display: 'flex', alignItems: 'center', padding: '0 10px', gap: 6,
          background: `${table.color}22`, borderBottom: '1px solid var(--dm-border)',
          cursor: 'pointer', userSelect: 'none'
        }}
      >
        <span style={{ fontSize: 13 }}>{table.isView ? '👁' : '▦'}</span>
        <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {table.schema ? `${table.schema}.` : ''}{table.name}
        </span>
        {!table.expanded && <span style={{ color: 'var(--dm-muted)', fontSize: 11 }}>+{table.fields.length - visibleFields.length}</span>}
        {pkCount > 0 && <span style={{ color: 'var(--dm-muted)', fontSize: 11 }}>PK {pkCount}</span>}
        <span style={{ color: 'var(--dm-muted)', fontSize: 11 }}>{table.expanded ? '▾' : '▸'}</span>
      </div>
      {table.expanded && visibleFields.map((f) => <FieldRow key={f.id} field={f} color={table.color} />)}
    </div>
  )
}

export const TableNode = memo(TableNodeInner)
