import { Typography, Button, Space, Popconfirm, theme } from 'antd'
import {
  RobotOutlined,
  UserOutlined,
  CopyOutlined,
  DislikeOutlined,
  LikeOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import type { MessageWithThought } from './types'
import { ensureSegments } from './types'
import ThinkingSegment from './ThinkingSegment'
import ToolCallSegment from './ToolCallSegment'
import AnswerSegment from './AnswerSegment'

const { Text } = Typography

const MessageBubble: React.FC<{
  msg: MessageWithThought
  onCopy: (content: string) => void
  onDeleteMessage: (msgId: string) => void
  onToggleSegment: (msgId: string, segId: string) => void
  getToolDisplayName: (name: string) => string
}> = ({ msg, onCopy, onDeleteMessage, onToggleSegment, getToolDisplayName }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const displayMsg = msg.role === 'assistant' ? ensureSegments(msg) : msg

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
        alignItems: 'flex-start',
      }}
    >
      <div style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        background: msg.role === 'assistant' ? token.colorPrimaryBg : token.colorInfoBg,
      }}>
        {msg.role === 'assistant'
          ? <RobotOutlined style={{ color: '#1677ff', fontSize: 18 }} />
          : <UserOutlined style={{ color: '#1677ff', fontSize: 18 }} />}
      </div>

      <div style={{ maxWidth: '80%', minWidth: 0 }}>
        {msg.role === 'user' && (
          <div>
            <div style={{
              padding: '10px 16px',
              borderRadius: 12,
              background: token.colorPrimary,
              color: '#fff',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.7,
            }}>
              <Text style={{ color: '#fff', fontSize: 14 }}>{msg.content}</Text>
            </div>
            {!msg.isStreaming && (
              <Space size={4} style={{ marginTop: 2, marginLeft: 2, justifyContent: 'flex-end', display: 'flex' }}>
                <Popconfirm title={t('workbench.confirmDeleteMsg')} onConfirm={() => onDeleteMessage(msg.id)}
                  okText={t('common.confirm')} cancelText={t('common.cancel')}>
                  <Button type="text" size="small" danger icon={<DeleteOutlined style={{ fontSize: 12 }} />} />
                </Popconfirm>
              </Space>
            )}
          </div>
        )}

        {msg.role === 'assistant' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
              <>
                <div style={{ position: 'relative', paddingLeft: 0 }}>
                  {displayMsg.segments.map((seg) => {
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
              </>
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
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </div>
            )}

            {!msg.isStreaming && !msg.isError && msg.content && (
              <Space size={4} style={{ marginTop: 2, marginLeft: 2 }}>
                <Button type="text" size="small" icon={<CopyOutlined style={{ fontSize: 12 }} />}
                  onClick={() => onCopy(msg.content)} />
                <Button type="text" size="small" icon={<LikeOutlined style={{ fontSize: 12 }} />} />
                <Button type="text" size="small" icon={<DislikeOutlined style={{ fontSize: 12 }} />} />
                <Popconfirm title={t('workbench.confirmDeleteMsg')} onConfirm={() => onDeleteMessage(msg.id)}
                  okText={t('common.confirm')} cancelText={t('common.cancel')}>
                  <Button type="text" size="small" danger icon={<DeleteOutlined style={{ fontSize: 12 }} />} />
                </Popconfirm>
              </Space>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default MessageBubble
