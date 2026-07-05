import { Typography, Button, Tag, theme, Tooltip } from 'antd'
import { CloseOutlined, CopyOutlined, RobotOutlined, ColumnWidthOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useTranslation } from 'react-i18next'
import { memo } from 'react'
import type { MessageWithThought } from './types'
import { ensureSegments } from './types'
import { markdownComponents } from './markdown-components'
import { resolveModelLabel, TokenUsageDisplay, SegmentList } from './message-shared'

const { Text } = Typography

const PANEL_COLOR_KEYS: Array<{ borderKey: keyof typeof import('antd/es/theme/internal').DerivativeToken; bgKey: keyof typeof import('antd/es/theme/internal').DerivativeToken; tag: string }> = [
  { borderKey: 'colorPrimary' as any, bgKey: 'colorPrimaryBg' as any, tag: 'blue' },
  { borderKey: 'colorSuccess' as any, bgKey: 'colorSuccessBg' as any, tag: 'green' },
  { borderKey: 'colorInfo' as any, bgKey: 'colorInfoBg' as any, tag: 'purple' },
]

function getPanelColor(index: number, token: any) {
  const k = PANEL_COLOR_KEYS[index % PANEL_COLOR_KEYS.length]
  return { border: token[k.borderKey], bg: token[k.bgKey], tag: k.tag }
}

function getProviderName(msg: MessageWithThought, providers: any[]): string {
  if (!msg.comparisonProviderId) return ''
  const provider = providers.find((p: any) => p.id === msg.comparisonProviderId)
  return provider?.name || ''
}

interface ComparisonColumnProps {
  msg: MessageWithThought
  colorIndex: number
  providers: any[]
  onToggleSegment: (msgId: string, segId: string) => void
  onCopy: (content: string) => void
  getToolDisplayName: (name: string) => string
}

const ComparisonColumn: React.FC<ComparisonColumnProps> = ({
  msg,
  colorIndex,
  providers,
  onToggleSegment,
  onCopy,
  getToolDisplayName,
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const color = getPanelColor(colorIndex, token)
  const displayMsg = ensureSegments(msg)
  const modelLabel = resolveModelLabel(msg, providers)
  const providerName = getProviderName(msg, providers)

  return (
    <div style={{
      flex: 1,
      minWidth: 320,
      display: 'flex',
      flexDirection: 'column',
      border: `2px solid ${color.border}`,
      borderRadius: 12,
      overflow: 'hidden',
      background: token.colorBgContainer,
    }}>
      <div style={{
        padding: '8px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: color.bg,
        borderBottom: `1px solid ${color.border}30`,
        flexShrink: 0,
      }}>
        <div style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          background: `${color.border}20`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <RobotOutlined style={{ fontSize: 13, color: color.border }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13, color: color.border }}>{modelLabel}</Text>
          {providerName && (
            <Text style={{ fontSize: 11, color: token.colorTextTertiary, marginLeft: 6 }}>{providerName}</Text>
          )}
        </div>
        {!msg.isStreaming && msg.content && (
          <Tooltip title={t('common.copied')}>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined style={{ fontSize: 12 }} />}
              onClick={() => onCopy(msg.content)}
              style={{ color: token.colorTextQuaternary }}
            />
          </Tooltip>
        )}
        {msg.isStreaming && (
          <Tag color={color.tag} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>
            {t('workbench.thinking')}
          </Tag>
        )}
      </div>

      <div style={{
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}>
        {displayMsg.isStreaming && (!displayMsg.segments || displayMsg.segments.length === 0) && (
          <div style={{
            padding: '10px 16px',
            borderRadius: 12,
            background: token.colorBgLayout,
            lineHeight: 1.7,
          }}>
            <Text style={{ color: token.colorTextQuaternary, fontSize: 14 }}>{t('workbench.thinking')}</Text>
          </div>
        )}

        {displayMsg.segments && displayMsg.segments.length > 0 && (
          <SegmentList
            segments={displayMsg.segments}
            msgId={msg.id}
            isError={!!msg.isError}
            onToggleSegment={onToggleSegment}
            getToolDisplayName={getToolDisplayName}
          />
        )}

        {(!displayMsg.segments || displayMsg.segments.length === 0) && msg.content && !msg.isStreaming && (
          <div style={{
            padding: '10px 16px',
            borderRadius: 12,
            background: token.colorBgLayout,
            lineHeight: 1.7,
            wordBreak: 'break-word',
            border: msg.isError ? '1px solid #ff4d4f' : 'none',
          }}>
            <div className="markdown-content" style={{ fontSize: 14, color: token.colorText }}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={markdownComponents}
              >
                {msg.content}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {!msg.isStreaming && (
          <div style={{
            marginTop: 4,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}>
            <TokenUsageDisplay tokenUsage={msg.tokenUsage} />
          </div>
        )}
      </div>
    </div>
  )
}

// 用 memo 包裹，避免 MultiChatPanel 父级状态变化时所有对比列整体重渲染（M3 修复）
const MemoizedComparisonColumn = memo(ComparisonColumn)

interface MultiChatPanelProps {
  comparisonMessages: MessageWithThought[]
  providers: any[]
  onClose: () => void
  onToggleSegment: (msgId: string, segId: string) => void
  onCopy: (content: string) => void
  getToolDisplayName: (name: string) => string
}

const MultiChatPanel: React.FC<MultiChatPanelProps> = ({
  comparisonMessages,
  providers,
  onClose,
  onToggleSegment,
  onCopy,
  getToolDisplayName,
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        flexShrink: 0,
      }}>
        <ColumnWidthOutlined style={{ fontSize: 14, color: token.colorPrimary }} />
        <Text strong style={{ fontSize: 13 }}>{t('workbench.multiModelComparison')}</Text>
        <Tag color="blue" style={{ fontSize: 11, lineHeight: '16px', padding: '0 6px', margin: 0 }}>
          {comparisonMessages.length} {t('workbench.models')}
        </Tag>
        <div style={{ flex: 1 }} />
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined style={{ fontSize: 12 }} />}
          onClick={onClose}
          style={{ color: token.colorTextSecondary }}
        >
          {t('workbench.closeComparison')}
        </Button>
      </div>

      <div style={{
        flex: 1,
        display: 'flex',
        gap: 12,
        padding: '12px 16px',
        overflowX: 'auto',
        overflowY: 'hidden',
        minHeight: 0,
      }}>
        {comparisonMessages.map((msg, index) => (
          <MemoizedComparisonColumn
            key={msg.id}
            msg={msg}
            colorIndex={index}
            providers={providers}
            onToggleSegment={onToggleSegment}
            onCopy={onCopy}
            getToolDisplayName={getToolDisplayName}
          />
        ))}
      </div>
    </div>
  )
}

export default MultiChatPanel
