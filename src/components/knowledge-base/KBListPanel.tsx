import { useTranslation } from 'react-i18next'
import { Card, Typography, Space, Button, Popconfirm, Empty, Tooltip, theme } from 'antd'
import { DatabaseOutlined, FileTextOutlined, DeleteOutlined } from '@ant-design/icons'

const { Text } = Typography

interface KnowledgeBase {
  id: string
  name: string
  description: string
  root_path: string
  doc_count: number
  created_at: number
  updated_at: number
}

interface KBListPanelProps {
  kbs: KnowledgeBase[]
  selectedKB: KnowledgeBase | null
  onSelectKB: (kb: KnowledgeBase) => void
  onDeleteKB: (kbId: string) => void
}

const KBListPanel: React.FC<KBListPanelProps> = ({ kbs, selectedKB, onSelectKB, onDeleteKB }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
    <Card size="small" title={<Space><DatabaseOutlined />{t('knowledgeBase.kbList')}</Space>}
      style={{ width: 280, flexShrink: 0 }}
      styles={{ body: { padding: 0, overflow: 'auto' } }}
    >
      {kbs.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: token.colorTextSecondary }}>
          <Empty description={t('knowledgeBase.noKb')} />
        </div>
      ) : (
        kbs.map(kb => (
          <div key={kb.id} onClick={() => onSelectKB(kb)}
            style={{
              padding: '12px 16px', cursor: 'pointer',
              borderLeft: selectedKB?.id === kb.id ? `3px solid ${token.colorPrimary}` : '3px solid transparent',
              background: selectedKB?.id === kb.id ? token.colorPrimaryBg : 'transparent',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <Tooltip title={kb.name} placement="topLeft">
                <Text strong style={{ fontSize: 14, display: 'block' }} ellipsis>{kb.name}</Text>
              </Tooltip>
              <Popconfirm title={t('knowledgeBase.confirmDelete')} onConfirm={(e) => { e?.stopPropagation(); onDeleteKB(kb.id) }}>
                <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }} />
              </Popconfirm>
            </div>
            <div style={{ marginTop: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}><FileTextOutlined /> {t('common.documents', { count: kb.doc_count || 0 })}</Text>
            </div>
          </div>
        ))
      )}
    </Card>
  )
}

export default KBListPanel
