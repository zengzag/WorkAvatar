// 表节点渲染

import { memo, useCallback, useMemo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { Relationship, Table } from '../../shared/domain'
import { getVisibleFields, FIELD_HEIGHT, HEADER_HEIGHT, NODE_WIDTH } from './dagre-layout'
import { useDataModelStore } from '../data-model.store'

export type TableNodeData = { table: Table; relationships: Relationship[] }
export type TableNodeType = Node<TableNodeData>
export type TableNodeComponentProps = NodeProps<TableNodeType>

function FieldRow({ field, color }: { field: Table['fields'][number]; color: string }) {
  const title = field.comment
    ? `${field.name}: ${field.type}${field.typeLength ? `(${field.typeLength})` : ''}\n${field.comment}`
    : `${field.name}: ${field.type}${field.typeLength ? `(${field.typeLength})` : ''}`
  return (
    <div
      title={title}
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
  const updateTable = useDataModelStore((s) => s.updateTable)
  const visibleFields = useMemo(
    () => getVisibleFields(table, relationships),
    [table, relationships]
  )
  const fields = table.fields ?? []
  const pkCount = fields.filter((f) => f.primaryKey).length

  const toggleExpanded = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      updateTable(table.id, { expanded: !table.expanded })
    },
    [table.id, table.expanded, updateTable]
  )

  // 折叠时若无可显示字段（既无主键也无连线），则不渲染字段列表区
  const showFieldsWhenCollapsed = !table.expanded && visibleFields.length > 0

  return (
    <div
      style={{
        width: NODE_WIDTH, borderRadius: 8, overflow: 'hidden',
        border: selected ? '2px solid var(--dm-primary)' : '1px solid var(--dm-border-strong)',
        boxShadow: selected ? '0 0 0 3px var(--dm-primary-soft)' : '0 1px 3px rgba(0,0,0,0.1)',
        background: 'var(--dm-bg)'
      }}
    >
      <div
        onClick={toggleExpanded}
        title={table.expanded ? '点击折叠' : '点击展开'}
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
        {!table.expanded && fields.length > visibleFields.length && (
          <span style={{ color: 'var(--dm-muted)', fontSize: 11 }}>+{fields.length - visibleFields.length}</span>
        )}
        {pkCount > 0 && <span style={{ color: 'var(--dm-muted)', fontSize: 11 }}>PK {pkCount}</span>}
        <span style={{ color: 'var(--dm-muted)', fontSize: 11 }}>{table.expanded ? '▾' : '▸'}</span>
      </div>
      {(table.expanded || showFieldsWhenCollapsed) && (
        <div>
          {visibleFields.length === 0 ? (
            <div style={{ padding: '4px 10px', fontSize: 11, color: 'var(--dm-muted)', fontStyle: 'italic' }}>无字段</div>
          ) : (
            visibleFields.map((f) => <FieldRow key={f.id} field={f} color={table.color} />)
          )}
        </div>
      )}
    </div>
  )
}

export const TableNode = memo(TableNodeInner)
