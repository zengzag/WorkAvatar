// 表检查器

import { useState } from 'react'
import { Button, Input, Select, Switch, Popconfirm, Divider, Space, Collapse, Tooltip } from 'antd'
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
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 表属性（默认展开） */}
      <Collapse
        size="small"
        defaultActiveKey={['table']}
        bordered={false}
        ghost
        items={[
          {
            key: 'table',
            label: <span style={{ fontWeight: 600, fontSize: 13 }}>{hostT('table.name')}</span>,
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
              </div>
            )
          }
        ]}
      />

      <Divider style={{ margin: '4px 0' }} />

      {/* 字段列表（重点） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{hostT('table.addField')}（{table.fields.length}）</span>
        <Tooltip title={hostT('table.addField')}>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={addNewField} />
        </Tooltip>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Input
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

      <Divider style={{ margin: '4px 0' }} />
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
      {/* 重点：名称 + 类型 + 主键标识 */}
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

      {/* 重点：字段注释 */}
      <Input
        size="small"
        prefix={<CommentOutlined style={{ color: 'var(--dm-muted)' }} />}
        placeholder={hostT('field.comment')}
        value={field.comment ?? ''}
        onChange={(e) => onChange({ comment: e.target.value || null })}
      />

      {/* 次要属性：默认收起 */}
      <Collapse
        size="small"
        ghost
        bordered={false}
        items={[
          {
            key: 'attrs',
            label: <span style={{ fontSize: 12, color: 'var(--dm-muted)' }}>{hostT('field.attrs')}</span>,
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <Space size={4}>
                    <Switch size="small" checked={field.primaryKey} onChange={(v) => onChange({ primaryKey: v })} />
                    <span style={{ fontSize: 11, color: 'var(--dm-muted)' }}>{hostT('field.primaryKey')}</span>
                  </Space>
                  <Space size={4}>
                    <Switch size="small" checked={field.unique} onChange={(v) => onChange({ unique: v })} />
                    <span style={{ fontSize: 11, color: 'var(--dm-muted)' }}>{hostT('field.unique')}</span>
                  </Space>
                  <Space size={4}>
                    <Switch size="small" checked={field.nullable} onChange={(v) => onChange({ nullable: v })} />
                    <span style={{ fontSize: 11, color: 'var(--dm-muted)' }}>{hostT('field.nullable')}</span>
                  </Space>
                  <Space size={4}>
                    <Switch size="small" checked={field.autoIncrement} onChange={(v) => onChange({ autoIncrement: v })} />
                    <span style={{ fontSize: 11, color: 'var(--dm-muted)' }}>{hostT('field.autoIncrement')}</span>
                  </Space>
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
        ]}
      />
    </div>
  )
}
