import { Typography, theme } from 'antd'
import { BulbOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { MessageSegment } from './types'

const { Text, Paragraph } = Typography

const ThinkingSegment: React.FC<{
  seg: MessageSegment
  isStreaming: boolean
  onToggle: () => void
}> = ({ seg, isStreaming, onToggle }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  return (
    <div style={{ marginBottom: 0 }}>
      <div
        onClick={() => {
          if (!isStreaming) {
            onToggle()
          }
        }}
        style={{
          padding: '8px 14px',
          borderRadius: 8,
          background: token.colorPrimaryBg,
          border: `1px solid ${token.colorPrimaryBorder}`,
          borderLeft: `3px solid ${token.colorPrimary}`,
          cursor: isStreaming ? 'default' : 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BulbOutlined style={{ color: token.colorPrimary, fontSize: 13 }} />
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 500 }}>{t('workbench.thinkingProcess')}</Text>
          {isStreaming && <span className="cursor-blink" style={{ color: token.colorPrimary }}>▊</span>}
          {!isStreaming && (
            <Text style={{ fontSize: 11, color: token.colorPrimary, marginLeft: 'auto' }}>
              {seg.collapsed ? t('workbench.expand') : t('workbench.collapse')}
            </Text>
          )}
        </div>
        {!seg.collapsed && seg.content && (
          <Paragraph style={{
            fontSize: 12,
            margin: '8px 0 0',
            color: token.colorTextSecondary,
            whiteSpace: 'pre-wrap',
          }}>
            {seg.content}
          </Paragraph>
        )}
      </div>
    </div>
  )
}

export default ThinkingSegment
