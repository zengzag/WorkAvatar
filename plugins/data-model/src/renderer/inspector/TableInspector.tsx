// 表检查器

import { useState } from 'react'
import { Button, Input, Select, Checkbox, Popconfirm, Divider, Tooltip } from 'antd'
import { DeleteOutlined, PlusOutlined, KeyOutlined, CommentOutlined } from '@ant-design/icons'
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
    <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 表属性（直接平铺，不折叠） */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 56, flexShrink: 0, fontSize: 12, color: 'var(--dm-muted)' }}>{hostT('table.name')}</span>
          <Input size="small" value={table.name} onChange={(e) => updateTable(table.id, { name: e.target.value })} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 56, flexShrink: 0, fontSize: 12, color: 'var(--dm-muted)' }}>{hostT('table.schema')}</span>
          <Input size="small" value={table.schema ?? ''} placeholder="public" onChange={(e) => updateTable(table.id, { schema: e.target.value || null })} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 56, flexShrink: 0, fontSize: 12, color: 'var(--dm-muted)' }}>{hostT('table.comment')}</span>
          <Input size="small" value={table.comment ?? ''} onChange={(e) => updateTable(table.id, { comment: e.target.value || null })} />
        </div>
        {/* 颜色：label 与色块单行显示 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 56, flexShrink: 0, fontSize: 12, color: 'var(--dm-muted)' }}>{hostT('table.color')}</span>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {PRESET_COLORS.map((c) => (
              <div
                key={c}
                onClick={() => updateTable(table.id, { color: c })}
                style={{
                  width: 18, height: 18, borderRadius: 4, background: c, cursor: 'pointer',
                  border: table.color === c ? '2px solid var(--dm-primary)' : '1px solid var(--dm-border-strong)'
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <Divider style={{ margin: '2px 0' }} />

      {/* 字段列表（重点） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{hostT('table.addField')}（{table.fields.length}）</span>
        <Tooltip title={hostT('table.addField')}>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={addNewField} />
        </Tooltip>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Input
          size="small"
          placeholder={hostT('field.name')}
          value={newFieldName}
          onChange={(e) => setNewFieldName(e.target.value)}
          onPressEnter={addNewField}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {table.fields.map((f) => (
          <FieldEditor key={f.id} tableId={table.id} field={f} onRemove={() => removeField(table.id, f.id)} />
        ))}
      </div>

      <Divider style={{ margin: '2px 0' }} />
      <Popconfirm title={hostT('table.delete')} onConfirm={() => removeTable(table.id)}>
        <Button danger block icon={<DeleteOutlined />}>{hostT('table.delete')}</Button>
      </Popconfirm>
    </div>
  )
}

function FieldEditor({ tableId, field, onRemove }: { tableId: string; field: Table['fields'][number]; onRemove: () => void }) {
  const { updateField } = useDataModelStore.getState()
  const onChange = (patch: Partial<Table['fields'][number]>) => updateField(tableId, field.id, patch)

  return (
    <div style={{ border: '1px solid var(--dm-border)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* 名称 + 类型 + 主键标识 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {field.primaryKey && <KeyOutlined style={{ color: '#d97706', fontSize: 12 }} />}
        <Input size="small" value={field.name} style={{ flex: 1, fontFamily: 'var(--dm-mono)' }} onChange={(e) => onChange({ name: e.target.value })} />
        <Select
          size="small"
          value={field.type}
          style={{ width: 110 }}
          options={FIELD_TYPES.map((t) => ({ value: t, label: t }))}
          onChange={(v) => onChange({ type: v })}
        />
        <Popconfirm title={hostT('field.delete')} onConfirm={onRemove}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </div>

      {/* 字段注释 */}
      <Input
        size="small"
        prefix={<CommentOutlined style={{ color: 'var(--dm-muted)' }} />}
        placeholder={hostT('field.comment')}
        value={field.comment ?? ''}
        onChange={(e) => onChange({ comment: e.target.value || null })}
      />

      {/* 字段属性：平铺显示（不折叠） */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Checkbox checked={field.primaryKey} onChange={(e) => onChange({ primaryKey: e.target.checked })}>
          <span style={{ fontSize: 11, color: 'var(--dm-muted)' }}>{hostT('field.primaryKey')}</span>
        </Checkbox>
        <Checkbox checked={field.unique} onChange={(e) => onChange({ unique: e.target.checked })}>
          <span style={{ fontSize: 11, color: 'var(--dm-muted)' }}>{hostT('field.unique')}</span>
        </Checkbox>
        <Checkbox checked={field.nullable} onChange={(e) => onChange({ nullable: e.target.checked })}>
          <span style={{ fontSize: 11, color: 'var(--dm-muted)' }}>{hostT('field.nullable')}</span>
        </Checkbox>
        <Checkbox checked={field.autoIncrement} onChange={(e) => onChange({ autoIncrement: e.target.checked })}>
          <span style={{ fontSize: 11, color: 'var(--dm-muted)' }}>{hostT('field.autoIncrement')}</span>
        </Checkbox>
      </div>
      <Input
        size="small"
        placeholder={hostT('field.defaultValue')}
        value={field.defaultValue ?? ''}
        onChange={(e) => onChange({ defaultValue: e.target.value || null })}
      />
    </div>
  )
}
