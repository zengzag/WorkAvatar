import { useTranslation } from 'react-i18next'
import {
  Card, Typography, Space, Table, Tag, Button,
  Modal, Select, Empty,
} from 'antd'
import {
  NodeIndexOutlined, ApartmentOutlined,
  EyeOutlined, ReloadOutlined,
} from '@ant-design/icons'

const { Text } = Typography

interface KBEntityGraphProps {
  entities: any[]
  entityFilter: string
  selectedEntity: any
  entityRelations: any[]
  entityModalOpen: boolean
  onEntityFilterChange: (v: string) => void
  onLoadEntities: (kbId: string, type?: string) => void
  onViewEntity: (entity: any) => void
  onCloseEntityModal: () => void
  selectedKBId: string
}

const KBEntityGraph: React.FC<KBEntityGraphProps> = ({
  entities, entityFilter, selectedEntity, entityRelations,
  entityModalOpen, onEntityFilterChange, onLoadEntities,
  onViewEntity, onCloseEntityModal, selectedKBId,
}) => {
  const { t } = useTranslation()

  return (
    <div>
      <Card
        title={<Space><NodeIndexOutlined />{t('knowledgeBase.entityList', { count: entities.length })}</Space>}
        extra={
          <Space>
            <Select placeholder={t('knowledgeBase.filterByType')} allowClear style={{ width: 140 }} value={entityFilter || undefined}
              onChange={(v: string) => { onEntityFilterChange(v || ''); onLoadEntities(selectedKBId, v || undefined) }}
              options={[
                { label: t('knowledgeBase.entityTypePerson'), value: 'person' },
                { label: t('knowledgeBase.entityTypeOrg'), value: 'organization' },
                { label: t('knowledgeBase.entityTypeLocation'), value: 'location' },
                { label: t('knowledgeBase.entityTypeEvent'), value: 'event' },
                { label: t('knowledgeBase.entityTypeConcept'), value: 'concept' },
                { label: t('knowledgeBase.entityTypeTool'), value: 'tool' },
              ]}
            />
            <Button icon={<ReloadOutlined />} size="small"
              onClick={() => { onLoadEntities(selectedKBId, entityFilter || undefined) }}>{t('common.refresh')}</Button>
          </Space>
        }
      >
        {entities.length === 0 ? (
          <Empty description={t('knowledgeBase.noEntities')} />
        ) : (
          <Table dataSource={entities} rowKey="id" size="small" pagination={{ pageSize: 20 }}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: t('common.name'), dataIndex: 'name', key: 'name', ellipsis: true, width: 160,
                render: (name: string, record: any) => (
                  <Button type="link" size="small" onClick={() => onViewEntity(record)}>
                    <NodeIndexOutlined /> {name}
                  </Button>
                ),
              },
              { title: t('common.type'), dataIndex: 'type', key: 'type', width: 80,
                render: (type: string) => {
                  const colors: Record<string, string> = { person: 'blue', organization: 'green', location: 'orange', event: 'red', concept: 'purple', tool: 'cyan' }
                  return <Tag color={colors[type] || 'default'}>{type}</Tag>
                },
              },
              { title: t('common.description'), dataIndex: 'description', key: 'description', ellipsis: true,
              },
              { title: t('knowledgeBase.mentions'), dataIndex: 'mention_count', key: 'mention_count', width: 90,
                render: (count: number) => <Tag>{count}</Tag>,
              },
              { title: t('knowledgeBase.aliases'), dataIndex: 'aliases_json', key: 'aliases', width: 150,
                render: (json: string) => {
                  const aliases: string[] = JSON.parse(json || '[]')
                  return <Space size={2} wrap>{aliases.slice(0, 3).map(a => <Tag key={a} style={{ fontSize: 11 }}>{a}</Tag>)}</Space>
                },
              },
              { title: t('common.action'), key: 'action', width: 60,
                render: (_: any, record: any) => (
                  <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => onViewEntity(record)}>{t('knowledgeBase.details')}</Button>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Modal
        title={<Space><NodeIndexOutlined />{selectedEntity?.name}</Space>}
        open={entityModalOpen}
        onCancel={onCloseEntityModal}
        footer={null}
        width={700}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        {selectedEntity && (
          <div>
            <Space wrap style={{ marginBottom: 16 }}>
              <Tag color={(() => { const c: Record<string, string> = { person: 'blue', organization: 'green', location: 'orange', event: 'red', concept: 'purple' }; return c[selectedEntity.type] || 'default' })()}>
                {selectedEntity.type}
              </Tag>
              <Tag>{t('knowledgeBase.mentionCount', { count: selectedEntity.mention_count })}</Tag>
              {JSON.parse(selectedEntity.aliases_json || '[]').map((a: string) => (
                <Tag key={a} style={{ fontSize: 11 }}>{t('knowledgeBase.aliasLabel')} {a}</Tag>
              ))}
            </Space>
            {selectedEntity.description && (
              <Card size="small" title={t('knowledgeBase.descCard')} style={{ marginBottom: 16 }}>
                <Text>{selectedEntity.description}</Text>
              </Card>
            )}
            {entityRelations.length > 0 && (
              <Card size="small" title={<Space><ApartmentOutlined />{t('knowledgeBase.relationNetworkCard')}</Space>}>
                <Table dataSource={entityRelations} rowKey="id" size="small" pagination={false}
                  columns={[
                    { title: t('knowledgeBase.direction'), key: 'direction', width: 50,
                      render: (_: any, record: any) => record.source_entity_id === selectedEntity.id ? '→' : '←',
                    },
                    { title: t('knowledgeBase.relatedEntity'), key: 'related', width: 150,
                      render: (_: any, record: any) => {
                        const isSource = record.source_entity_id === selectedEntity.id
                        return <Button type="link" size="small" onClick={() => {
                          const relatedId = isSource ? record.target_entity_id : record.source_entity_id
                          const relatedEntity = entities.find((e: any) => e.id === relatedId)
                          if (relatedEntity) {
                            onCloseEntityModal()
                            setTimeout(() => onViewEntity(relatedEntity), 100)
                          }
                        }}>{isSource ? record.target_name : record.source_name}</Button>
                      },
                    },
                    { title: t('common.type'), key: 'related_type', width: 80,
                      render: (_: any, record: any) => {
                        const isSource = record.source_entity_id === selectedEntity.id
                        const type = isSource ? record.target_type : record.source_type
                        return <Tag>{type}</Tag>
                      },
                    },
                    { title: t('knowledgeBase.relation'), dataIndex: 'relation_type', key: 'relation_type', width: 120 },
                    { title: t('common.description'), dataIndex: 'description', key: 'description',
                      render: (desc: string) => <Text type="secondary">{desc}</Text>,
                    },
                  ]}
                />
              </Card>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

export default KBEntityGraph
