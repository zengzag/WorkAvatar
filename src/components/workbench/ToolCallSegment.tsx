import { Typography, Tag, theme } from 'antd'
import {
  DownOutlined,
  RightOutlined,
  CodeOutlined,
  LoadingOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { MessageSegment } from './types'

const { Text } = Typography

const ToolCallSegment: React.FC<{
  seg: MessageSegment
  onToggle: () => void
  getToolDisplayName: (name: string) => string
}> = ({ seg, onToggle, getToolDisplayName }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const isToolPending = !seg.isToolComplete
  const isExpanded = !seg.collapsed
  const resultStr = seg.toolResult !== undefined
    ? (typeof seg.toolResult === 'string' ? seg.toolResult : JSON.stringify(seg.toolResult, null, 2))
    : ''
  const argsStr = seg.toolArgs !== undefined
    ? (typeof seg.toolArgs === 'string' ? seg.toolArgs : JSON.stringify(seg.toolArgs, null, 2))
    : ''

  return (
    <div style={{ marginBottom: 0 }}>
      <div
        style={{
          borderRadius: 8,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderLeft: `3px solid ${isToolPending ? token.colorPrimary : token.colorSuccess}`,
          background: token.colorBgLayout,
          overflow: 'hidden',
          opacity: 0.9,
        }}
      >
        <div
          onClick={onToggle}
          style={{
            padding: '6px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          {isExpanded ? <DownOutlined style={{ fontSize: 10, color: token.colorTextSecondary }} /> : <RightOutlined style={{ fontSize: 10, color: token.colorTextSecondary }} />}
          <CodeOutlined style={{ fontSize: 13, color: isToolPending ? token.colorPrimary : token.colorSuccess }} />
          <Text strong style={{ fontSize: 13, color: token.colorText }}>
            {seg.toolName ? getToolDisplayName(seg.toolName) : t('workbench.toolCall')}
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>({seg.toolName})</Text>
          {isToolPending ? (
            <Tag color="processing" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', marginLeft: 'auto' }}>
              <LoadingOutlined spin /> {t('workbench.executing')}
            </Tag>
          ) : (
            <Tag color="success" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', marginLeft: 'auto' }}>
              <CheckCircleOutlined /> {t('workbench.completed')}
            </Tag>
          )}
        </div>
        {isExpanded && (
          <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: '8px 12px' }}>
            {argsStr && (
              <div style={{ marginBottom: seg.toolResult !== undefined ? 8 : 0 }}>
                <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>{t('workbench.inputParams')}</Text>
                <pre style={{
                  margin: 0,
                  padding: '6px 10px',
                  background: token.colorBgContainer,
                  borderRadius: 6,
                  fontSize: 12,
                  lineHeight: 1.5,
                  maxHeight: 200,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  border: `1px solid ${token.colorBorderSecondary}`,
                }}>
                  {argsStr}
                </pre>
              </div>
            )}
            {seg.toolResult !== undefined && (
              <div>
                <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>{t('workbench.outputResult')}</Text>
                <pre style={{
                  margin: 0,
                  padding: '6px 10px',
                  background: token.colorSuccessBg,
                  borderRadius: 6,
                  fontSize: 12,
                  lineHeight: 1.5,
                  maxHeight: 300,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  border: `1px solid ${token.colorSuccessBorder}`,
                }}>
                  {resultStr.length > 2000 ? resultStr.slice(0, 2000) + '\n' + t('workbench.resultTruncated') : resultStr}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default ToolCallSegment
