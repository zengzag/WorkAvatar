import { Typography, Button, Tag, theme, Tooltip } from 'antd'
import { CloseOutlined, CopyOutlined, RobotOutlined, ColumnWidthOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useTranslation } from 'react-i18next'
import type { MessageWithThought, MessageSegment } from './types'
import { ensureSegments } from './types'
import ThinkingSegment from './ThinkingSegment'
import ToolCallSegment from './ToolCallSegment'
import AnswerSegment from './AnswerSegment'
import CodeBlock from './CodeBlock'

const { Text } = Typography

const PANEL_COLORS = [
  { border: '#1677ff', bg: '#1677ff10', tag: 'blue' },
  { border: '#52c41a', bg: '#52c41a10', tag: 'green' },
  { border: '#722ed1', bg: '#722ed110', tag: 'purple' },
]

const markdownComponents = {
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '')
    const code = String(children).replace(/\n$/, '')
    if (match) {
      return <CodeBlock language={match[1]} code={code} />
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
}

function getModelLabel(msg: MessageWithThought, providers: any[]): string {
  if (!msg.comparisonProviderId || !msg.comparisonModelId) return ''
  const provider = providers.find((p: any) => p.id === msg.comparisonProviderId)
  if (!provider) return msg.comparisonModelId
  let models: any[] = []
  try { models = provider.models_json ? JSON.parse(provider.models_json) : [] } catch { models = [] }
  const model = models.find((m: any) => m.model === msg.comparisonModelId)
  return model?.name || msg.comparisonModelId
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
  const color = PANEL_COLORS[colorIndex % PANEL_COLORS.length]
  const displayMsg = ensureSegments(msg)
  const modelLabel = getModelLabel(msg, providers)
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
          <div style={{ position: 'relative', paddingLeft: 0 }}>
            {displayMsg.segments.map((seg: MessageSegment) => {
              if (seg.type === 'thinking') {
                return (
                  <ThinkingSegment
                    key={seg.id}
                    seg={seg}
                    isStreaming={!!seg.isStreaming}
                    onToggle={() => onToggleSegment(msg.id, seg.id)}
                  />
                )
              }
              if (seg.type === 'tool_call') {
                return (
                  <ToolCallSegment
                    key={seg.id}
                    seg={seg}
                    onToggle={() => onToggleSegment(msg.id, seg.id)}
                    getToolDisplayName={getToolDisplayName}
                  />
                )
              }
              if (seg.type === 'answer') {
                return (
                  <AnswerSegment
                    key={seg.id}
                    seg={seg}
                    isError={!!msg.isError}
                  />
                )
              }
              return null
            })}
          </div>
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
            {msg.tokenUsage && msg.tokenUsage.totalTokens === undefined && msg.tokenUsage.totalChars !== undefined ? (
              <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
                {t('workbench.outputChars')}: {msg.tokenUsage.totalChars}
              </Text>
            ) : null}
            {msg.tokenUsage && msg.tokenUsage.totalTokens !== undefined ? (
              <>
                {msg.tokenUsage.promptTokens !== undefined && (
                  <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
                    {t('workbench.promptTokens')}: {msg.tokenUsage.promptTokens}
                  </Text>
                )}
                {msg.tokenUsage.completionTokens !== undefined && (
                  <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
                    {t('workbench.completionTokens')}: {msg.tokenUsage.completionTokens}
                  </Text>
                )}
                {msg.tokenUsage.totalTokens !== undefined && (
                  <Text style={{ fontSize: 11, color: token.colorTextTertiary }}>
                    {t('workbench.totalTokens')}: {msg.tokenUsage.totalTokens}
                  </Text>
                )}
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

interface MultiChatPanelProps {
  comparisonMessages: MessageWithThought[]
  userMessage: MessageWithThought | null
  providers: any[]
  onClose: () => void
  onToggleSegment: (msgId: string, segId: string) => void
  onCopy: (content: string) => void
  getToolDisplayName: (name: string) => string
}

const MultiChatPanel: React.FC<MultiChatPanelProps> = ({
  comparisonMessages,
  userMessage,
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

      {userMessage && (
        <div style={{
          padding: '10px 16px',
          background: token.colorBgLayout,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          flexShrink: 0,
        }}>
          <div style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            justifyContent: 'flex-end',
          }}>
            <div style={{
              maxWidth: '80%',
              padding: '8px 14px',
              borderRadius: 12,
              background: token.colorPrimary,
              color: '#fff',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.6,
              fontSize: 14,
            }}>
              {userMessage.content}
            </div>
          </div>
        </div>
      )}

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
          <ComparisonColumn
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
