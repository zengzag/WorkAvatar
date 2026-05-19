import { useTranslation } from 'react-i18next'
import { Typography, Space, Button, Popconfirm, Empty, Tooltip, theme } from 'antd'
import { DatabaseOutlined, FileTextOutlined, DeleteOutlined, RightOutlined, LeftOutlined } from '@ant-design/icons'

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
  collapsed: boolean
  onToggleCollapse: () => void
}

const KBListPanel: React.FC<KBListPanelProps> = ({ kbs, selectedKB, onSelectKB, onDeleteKB, collapsed, onToggleCollapse }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  if (collapsed) {
    return (
      <div style={{
        width: 48,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        background: token.colorBgContainer,
        borderRadius: 8,
        border: `1px solid ${token.colorBorderSecondary}`,
        overflow: 'hidden',
        paddingTop: 8,
        gap: 4,
      }}>
        <Tooltip title={t('knowledgeBase.showListPanel')} placement="right">
          <Button type="text" size="small" icon={<RightOutlined />} onClick={onToggleCollapse} style={{ marginBottom: 4 }} />
        </Tooltip>
        {kbs.map(kb => (
          <Tooltip key={kb.id} title={`${kb.name} (${kb.doc_count || 0} ${t('common.documents', { count: kb.doc_count || 0 })})`} placement="right">
            <div
              onClick={() => onSelectKB(kb)}
              style={{
                width: 36,
                height: 36,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 6,
                cursor: 'pointer',
                background: selectedKB?.id === kb.id ? token.colorPrimaryBg : 'transparent',
                border: selectedKB?.id === kb.id ? `1px solid ${token.colorPrimary}` : '1px solid transparent',
                transition: 'all 0.2s',
              }}
            >
              <DatabaseOutlined style={{
                fontSize: 16,
                color: selectedKB?.id === kb.id ? token.colorPrimary : token.colorTextSecondary,
              }} />
            </div>
          </Tooltip>
        ))}
      </div>
    )
  }

  return (
    <div style={{
      width: 240,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      background: token.colorBgContainer,
      borderRadius: 8,
      border: `1px solid ${token.colorBorderSecondary}`,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '8px 12px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <Space size={4}>
          <DatabaseOutlined style={{ color: token.colorPrimary }} />
          <Text strong style={{ fontSize: 13 }}>{t('knowledgeBase.kbList')}</Text>
        </Space>
        <Tooltip title={t('knowledgeBase.hideListPanel')} placement="right">
          <Button type="text" size="small" icon={<LeftOutlined />} onClick={onToggleCollapse} />
        </Tooltip>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {kbs.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: token.colorTextSecondary }}>
            <Empty description={t('knowledgeBase.noKb')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </div>
        ) : (
          kbs.map(kb => (
            <div key={kb.id} onClick={() => onSelectKB(kb)}
              style={{
                padding: '8px 12px', cursor: 'pointer',
                borderLeft: selectedKB?.id === kb.id ? `3px solid ${token.colorPrimary}` : '3px solid transparent',
                background: selectedKB?.id === kb.id ? token.colorPrimaryBg : 'transparent',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                transition: 'background 0.2s',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                <Tooltip title={kb.name} placement="topLeft">
                  <Text strong style={{ fontSize: 13, display: 'block' }} ellipsis>{kb.name}</Text>
                </Tooltip>
                <Popconfirm title={t('knowledgeBase.confirmDelete')} onConfirm={(e) => { e?.stopPropagation(); onDeleteKB(kb.id) }}>
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, minWidth: 0 }} />
                </Popconfirm>
              </div>
              <Text type="secondary" style={{ fontSize: 11 }}><FileTextOutlined /> {kb.doc_count || 0} {t('knowledgeBase.parsed')}</Text>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default KBListPanel
