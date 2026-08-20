// 左侧资源管理器：表与关系列表（可展开/收起）

import { useMemo, useState } from 'react'
import { Input, Button, Tooltip } from 'antd'
import {
  PlusOutlined, SearchOutlined, TableOutlined, EyeOutlined,
  ShareAltOutlined, KeyOutlined, DownOutlined, RightOutlined
} from '@ant-design/icons'
import { useDataModelStore } from './data-model.store'
import { hostT } from './store'
import { createTable } from '../shared/domain'

export function ExplorerPanel() {
  const model = useDataModelStore((s) => s.model)
  const selectedTableId = useDataModelStore((s) => s.selectedTableId)
  const selectedRelationshipId = useDataModelStore((s) => s.selectedRelationshipId)
  const { addTable, focusTable, selectTable, selectRelationship } = useDataModelStore.getState()

  const [search, setSearch] = useState('')
  const [tablesExpanded, setTablesExpanded] = useState(true)
  const [relsExpanded, setRelsExpanded] = useState(true)

  const q = search.trim().toLowerCase()

  const filteredTables = useMemo(() => {
    if (!model) return []
    if (!q) return model.tables
    return model.tables.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.fields ?? []).some((f) => f.name.toLowerCase().includes(q))
    )
  }, [model, q])

  const filteredRelationships = useMemo(() => {
    if (!model) return []
    if (!q) return model.relationships
    return model.relationships.filter((r) => {
      const s = model.tables.find((t) => t.id === r.sourceTableId)
      const t = model.tables.find((t) => t.id === r.targetTableId)
      return (
        s?.name.toLowerCase().includes(q) ||
        t?.name.toLowerCase().includes(q) ||
        r.name?.toLowerCase().includes(q)
      )
    })
  }, [model, q])

  const handleAddTable = () => {
    const table = createTable({ name: `table_${(model?.tables.length ?? 0) + 1}` })
    addTable(table)
    focusTable(table.id)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, borderRight: '1px solid var(--dm-border)', background: 'var(--dm-bg)' }}>
      {/* 搜索 + 新建表（同一行） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderBottom: '1px solid var(--dm-border)' }}>
        <Input
          size="small"
          style={{ flex: 1, minWidth: 0 }}
          prefix={<SearchOutlined style={{ color: 'var(--dm-muted)' }} />}
          placeholder={hostT('explorer.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
        <Tooltip title={hostT('page.newTable')}>
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={handleAddTable} />
        </Tooltip>
      </div>

      {/* 列表 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 6px' }}>
        {/* 表分组 */}
        <SectionHeader
          label={hostT('explorer.tables')}
          count={model?.tables.length ?? 0}
          expanded={tablesExpanded}
          onToggle={() => setTablesExpanded((v) => !v)}
        />
        {tablesExpanded &&
          filteredTables.map((table) => {
            const isActive = table.id === selectedTableId
            const pkCount = (table.fields ?? []).filter((f) => f.primaryKey).length
            return (
              <div
                key={table.id}
                onClick={() => {
                  selectTable(table.id)
                  focusTable(table.id)
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
                  borderRadius: 6, cursor: 'pointer', fontSize: 12,
                  background: isActive ? 'var(--dm-primary-soft)' : 'transparent',
                  color: 'var(--dm-text)'
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--dm-hover)' }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: table.color }} />
                {table.isView ? (
                  <EyeOutlined style={{ fontSize: 12, color: 'var(--dm-muted)' }} />
                ) : (
                  <TableOutlined style={{ fontSize: 12, color: 'var(--dm-muted)' }} />
                )}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--dm-mono)' }}>
                  {table.schema && <span style={{ color: 'var(--dm-muted)' }}>{table.schema}.</span>}
                  {table.name}
                </span>
                {pkCount > 0 && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 10, color: '#d97706' }}>
                    <KeyOutlined style={{ fontSize: 10 }} />
                    {pkCount}
                  </span>
                )}
                <span style={{ fontSize: 10, color: 'var(--dm-muted)' }}>{(table.fields ?? []).length}f</span>
              </div>
            )
          })}

        {/* 关系分组 */}
        <div style={{ marginTop: 8 }}>
          <SectionHeader
            label={hostT('explorer.relationships')}
            count={model?.relationships.length ?? 0}
            expanded={relsExpanded}
            onToggle={() => setRelsExpanded((v) => !v)}
          />
          {relsExpanded &&
            filteredRelationships.map((rel) => {
              const isActive = rel.id === selectedRelationshipId
              const sourceTable = model?.tables.find((t) => t.id === rel.sourceTableId)
              const targetTable = model?.tables.find((t) => t.id === rel.targetTableId)
              return (
                <div
                  key={rel.id}
                  onClick={() => selectRelationship(rel.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
                    borderRadius: 6, cursor: 'pointer', fontSize: 12,
                    background: isActive ? 'var(--dm-primary-soft)' : 'transparent',
                    color: 'var(--dm-text)'
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--dm-hover)' }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
                >
                  <ShareAltOutlined style={{ fontSize: 12, color: 'var(--dm-muted)' }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--dm-mono)' }}>
                    {sourceTable?.name ?? '?'}
                    <span style={{ margin: '0 4px', color: 'var(--dm-muted)' }}>→</span>
                    {targetTable?.name ?? '?'}
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--dm-muted)', background: 'var(--dm-bg-soft)', borderRadius: 8, padding: '0 5px', flexShrink: 0 }}>
                    {rel.sourceCardinality === 'many' ? 'N' : '1'}:{rel.targetCardinality === 'many' ? 'N' : '1'}
                  </span>
                </div>
              )
            })}
        </div>

        {filteredTables.length === 0 && filteredRelationships.length === 0 && (
          <div style={{ padding: '16px 8px', textAlign: 'center', fontSize: 12, color: 'var(--dm-muted)' }}>
            {hostT('explorer.noMatch')}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionHeader({
  label, count, expanded, onToggle
}: {
  label: string
  count: number
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px',
        cursor: 'pointer', fontSize: 11, fontWeight: 600, color: 'var(--dm-muted)',
        textTransform: 'uppercase', letterSpacing: '0.5px', userSelect: 'none'
      }}
    >
      {expanded ? (
        <DownOutlined style={{ fontSize: 10 }} />
      ) : (
        <RightOutlined style={{ fontSize: 10 }} />
      )}
      <span>{label}</span>
      <span style={{ marginLeft: 2, background: 'var(--dm-bg-soft)', borderRadius: 8, padding: '0 6px', fontSize: 10 }}>{count}</span>
    </div>
  )
}
