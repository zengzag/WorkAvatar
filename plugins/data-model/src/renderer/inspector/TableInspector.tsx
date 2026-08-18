// 表检查器

import { useState } from 'react'
import { Button, Input, Select, Switch, Popconfirm, Divider, Space } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { useDataModelStore } from '../data-model.store'
import { hostT } from '../store'
import { createField, type FieldType, type Table } from '../../shared/domain'

const FIELD_TYPES: FieldType[] = [
  'integer', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'real', 'double', 'float',
  'varchar', 'char', 'text', 'string', 'json', 'jsonb', 'xml',
  'boolean', 'bool', 'bit', 'date', 'time', 'timestamp', 'timestamptz', 'datetime', 'interval',
  'uuid', 'bytea', 'blob', 'binary', 'enum', 'array', 'custom'
]

const PRESET_COLORS = ['#71717a', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#06b6d4']

export function TableInspector({ table }: { table: Table }) {
  const { updateTable, removeTable, addField, updateField, removeField } = useDataModelStore.getState()
  const [newFieldName, setNewFieldName] = useState('')

  const addNewField = () => {
    if (!newFieldName.trim()) return
    addField(table.id, createField({ name: newFieldName.trim(), type: 'varchar' }))
    setNewFieldName('')
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 12, color: 'var(--dm-muted)', marginBottom: 4 }}>{hostT('table.name')}</div>
        <Input value={table.name} onChange={(e) => updateTable(table.id, { name: e.target.value })} />
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'var(--dm-muted)', marginBottom: 4 }}>{hostT('table.schema')}</div>
        <Input value={table.schema ?? ''} placeholder="public" onChange={(e) => updateTable(table.id, { schema: e.target.value || null })} />
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'var(--dm-muted)', marginBottom: 4 }}>{hostT('table.comment')}</div>
        <Input value={table.comment ?? ''} onChange={(e) => updateTable(table.id, { comment: e.target.value || null })} />
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'var(--dm-muted)', marginBottom: 4 }}>{hostT('table.color')}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PRESET_COLORS.map((c) => (
            <div
              key={c}
              onClick={() => updateTable(table.id, { color: c })}
              style={{
                width: 20, height: 20, borderRadius: 4, background: c, cursor: 'pointer',
                border: table.color === c ? '2px solid var(--dm-primary)' : '1px solid var(--dm-border-strong)'
              }}
            />
          ))}
        </div>
      </div>
      <div>
        <Space>
          <span style={{ fontSize: 12, color: 'var(--dm-muted)' }}>{hostT('table.isView')}</span>
          <Switch size="small" checked={table.isView} onChange={(v) => updateTable(table.id, { isView: v })} />
        </Space>
      </div>

      <Divider style={{ margin: '4px 0' }} />

      <div style={{ fontSize: 13, fontWeight: 600 }}>{hostT('table.addField')}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Input
          placeholder={hostT('field.name')}
          value={newFieldName}
          onChange={(e) => setNewFieldName(e.target.value)}
          onPressEnter={addNewField}
        />
        <Button icon={<PlusOutlined />} onClick={addNewField} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {table.fields.map((f) => (
          <div key={f.id} style={{ border: '1px solid var(--dm-border)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Input size="small" value={f.name} style={{ flex: 1 }} onChange={(e) => updateField(table.id, f.id, { name: e.target.value })} />
              <Select
                size="small"
                value={f.type}
                style={{ width: 110 }}
                options={FIELD_TYPES.map((t) => ({ value: t, label: t }))}
                onChange={(v) => updateField(table.id, f.id, { type: v })}
              />
              <Popconfirm title={hostT('field.delete')} onConfirm={() => removeField(table.id, f.id)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Space size={4}>
                <Switch size="small" checked={f.primaryKey} onChange={(v) => updateField(table.id, f.id, { primaryKey: v })} />
                <span style={{ fontSize: 11, color: 'var(--dm-muted)' }}>{hostT('field.primaryKey')}</span>
              </Space>
              <Space size={4}>
                <Switch size="small" checked={f.unique} onChange={(v) => updateField(table.id, f.id, { unique: v })} />
                <span style={{ fontSize: 11, color: 'var(--dm-muted)' }}>{hostT('field.unique')}</span>
              </Space>
              <Space size={4}>
                <Switch size="small" checked={f.nullable} onChange={(v) => updateField(table.id, f.id, { nullable: v })} />
                <span style={{ fontSize: 11, color: 'var(--dm-muted)' }}>{hostT('field.nullable')}</span>
              </Space>
              <Space size={4}>
                <Switch size="small" checked={f.autoIncrement} onChange={(v) => updateField(table.id, f.id, { autoIncrement: v })} />
                <span style={{ fontSize: 11, color: 'var(--dm-muted)' }}>{hostT('field.autoIncrement')}</span>
              </Space>
            </div>
            <Input size="small" placeholder={hostT('field.comment')} value={f.comment ?? ''} onChange={(e) => updateField(table.id, f.id, { comment: e.target.value || null })} />
          </div>
        ))}
      </div>

      <Divider style={{ margin: '4px 0' }} />
      <Popconfirm title={hostT('table.delete')} onConfirm={() => removeTable(table.id)}>
        <Button danger block icon={<DeleteOutlined />}>{hostT('table.delete')}</Button>
      </Popconfirm>
    </div>
  )
}
