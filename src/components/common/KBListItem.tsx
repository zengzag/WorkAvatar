import React from 'react'
import { Tag, Typography, Tooltip, Space, theme } from 'antd'
import { DatabaseOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

interface KBListItemProps {
  kb: {
    id: string
    name: string
    description?: string
    doc_count?: number
  }
  actions?: React.ReactNode
  iconSize?: number
}

const KBListItem: React.FC<KBListItemProps> = ({ kb, actions, iconSize = 40 }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const iconFontSize = iconSize * 0.5

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 0',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
        <div
          style={{
            width: iconSize,
            height: iconSize,
            borderRadius: 8,
            background: token.colorPrimaryBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <DatabaseOutlined style={{ fontSize: iconFontSize, color: '#722ed1' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <Tooltip title={kb.name}>
            <Text strong ellipsis style={{ display: 'block' }}>{kb.name}</Text>
          </Tooltip>
          <Tooltip title={kb.description || t('common.noDescription')}>
            <Text type="secondary" ellipsis style={{ display: 'block' }}>{kb.description || t('common.noDescription')}</Text>
          </Tooltip>
          <Tag style={{ marginTop: 4 }}>{t('common.documents', { count: kb.doc_count || 0 })}</Tag>
        </div>
      </div>
      {actions && <Space>{actions}</Space>}
    </div>
  )
}

export default KBListItem
