// 关系检查器

import { Button, Popconfirm, Divider, Tag } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { useDataModelStore } from '../data-model.store'
import { hostT } from '../store'
import { deriveRelationshipType, type Relationship } from '../../shared/domain'

const TYPE_LABELS: Record<string, string> = {
  one_to_one: 'relationship.oneToOne',
  one_to_many: 'relationship.oneToMany',
  many_to_one: 'relationship.manyToOne',
  many_to_many: 'relationship.manyToMany'
}

export function RelationshipInspector({ relationship }: { relationship: Relationship }) {
  const model = useDataModelStore((s) => s.model)
  const { removeRelationship } = useDataModelStore.getState()
  if (!model) return null

  const sourceTable = model.tables.find((t) => t.id === relationship.sourceTableId)
  const targetTable = model.tables.find((t) => t.id === relationship.targetTableId)
  const sourceField = sourceTable?.fields.find((f) => f.id === relationship.sourceFieldId)
  const targetField = targetTable?.fields.find((f) => f.id === relationship.targetFieldId)
  const type = deriveRelationshipType(relationship)

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 12, color: 'var(--dm-muted)', marginBottom: 4 }}>{hostT('relationship.type')}</div>
        <Tag color="blue">{hostT(TYPE_LABELS[type])}</Tag>
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'var(--dm-muted)', marginBottom: 4 }}>{hostT('relationship.source')}</div>
        <div style={{ fontSize: 13 }}>
          {sourceTable?.name}.{sourceField?.name}
          <Tag style={{ marginLeft: 6 }}>{relationship.sourceCardinality === 'many' ? 'N' : '1'}</Tag>
        </div>
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'var(--dm-muted)', marginBottom: 4 }}>{hostT('relationship.target')}</div>
        <div style={{ fontSize: 13 }}>
          {targetTable?.name}.{targetField?.name}
          <Tag style={{ marginLeft: 6 }}>{relationship.targetCardinality === 'many' ? 'N' : '1'}</Tag>
        </div>
      </div>
      <Divider style={{ margin: '4px 0' }} />
      <Popconfirm title={hostT('relationship.delete')} onConfirm={() => removeRelationship(relationship.id)}>
        <Button danger block icon={<DeleteOutlined />}>{hostT('relationship.delete')}</Button>
      </Popconfirm>
    </div>
  )
}
