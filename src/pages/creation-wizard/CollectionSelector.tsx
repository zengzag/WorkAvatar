import { useTranslation } from 'react-i18next'
import { Checkbox, Tag, Typography, Space, Button, Empty, theme } from 'antd'
import { DatabaseOutlined } from '@ant-design/icons'

interface CollectionSelectorProps {
  collections: any[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
}

/** 知识库合集选择器（带全选/清空） */
const CollectionSelector: React.FC<CollectionSelectorProps> = ({
  collections,
  selectedIds,
  onChange,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Typography.Text strong>{t('creationWizard.linkedKbLabel')}</Typography.Text>
        <Space>
          <Button size="small" onClick={() => onChange(collections.map((c: any) => c.id))}>
            {t('common.selectAll')}
          </Button>
          <Button size="small" onClick={() => onChange([])}>
            {t('common.clearAll')}
          </Button>
        </Space>
      </div>
      {collections.length > 0 ? (
        <div style={{ border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadius }}>
          {collections.map((c: any) => {
            const isSelected = selectedIds.includes(c.id)
            return (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '10px 16px',
                  background: isSelected ? token.colorPrimaryBg : 'transparent',
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <Checkbox
                  checked={isSelected}
                  onChange={(e) => {
                    if (e.target.checked) {
                      onChange([...selectedIds, c.id])
                    } else {
                      onChange(selectedIds.filter((i) => i !== c.id))
                    }
                  }}
                  style={{ marginRight: 12 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ marginBottom: 2 }}>
                    <Space>
                      <DatabaseOutlined style={{ color: token.colorPrimary }} />
                      <Typography.Text strong>{c.name}</Typography.Text>
                      <Tag>{t('common.documents', { count: c.file_count || 0 })}</Tag>
                    </Space>
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {c.description || t('common.noDescription')}
                  </Typography.Text>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <Empty description={t('creationWizard.noKbAvailable')} />
      )}
    </div>
  )
}

export default CollectionSelector
