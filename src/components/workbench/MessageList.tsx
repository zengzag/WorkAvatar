import { useState, useMemo, useCallback, useLayoutEffect, useRef, useEffect, Fragment } from 'react'
import { Button, Spin, Typography } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { theme } from 'antd'
import { MessageBubble } from './index'
import type { MessageWithThought } from './types'
import { formatMessageTime, shouldShowTimeSeparator } from '../../utils/format'

const { Text, Paragraph } = Typography

const INITIAL_VISIBLE_COUNT = 30
const VISIBLE_INCREMENT = 30

interface MessageListProps {
  messages: MessageWithThought[]
  loadingConversationId: string | null
  activeConversationId: string | null
  chatContainerRef: React.RefObject<HTMLDivElement | null>
  onCopy: (content: string) => Promise<void>
  onDeleteMessage: (msgId: string, timestamp: number) => Promise<void>
  onRegenerate: (msg: MessageWithThought) => void
  onSwitchModelRegenerate: (msg: MessageWithThought) => void
  onEditAndResubmit: (msg: MessageWithThought, newContent: string) => void
  onToggleSegment: (msgId: string, segId: string) => void
  onSwitchBranch: (msgId: string, branchIndex: number) => void
  onOpenComparison: (msg: MessageWithThought) => void
  getToolDisplayName: (name: string) => string
  providers: any[]
}

const MessageList: React.FC<MessageListProps> = ({
  messages,
  loadingConversationId,
  activeConversationId,
  chatContainerRef,
  onCopy,
  onDeleteMessage,
  onRegenerate,
  onSwitchModelRegenerate,
  onEditAndResubmit,
  onToggleSegment,
  onSwitchBranch,
  onOpenComparison,
  getToolDisplayName,
  providers,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const prevScrollHeightRef = useRef(0)
  const lastConvIdRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (activeConversationId !== lastConvIdRef.current) {
      lastConvIdRef.current = activeConversationId
      setVisibleCount(INITIAL_VISIBLE_COUNT)
      prevScrollHeightRef.current = 0
      requestAnimationFrame(() => {
        if (chatContainerRef.current) {
          chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight
        }
      })
    }
  }, [activeConversationId])

  useEffect(() => {
    if (prevScrollHeightRef.current > 0 && chatContainerRef.current) {
      const newScrollHeight = chatContainerRef.current.scrollHeight
      const scrollDiff = newScrollHeight - prevScrollHeightRef.current
      chatContainerRef.current.scrollTop += scrollDiff
      prevScrollHeightRef.current = 0
    }
  }, [visibleCount])

  const visibleStartIndex = useMemo(
    () => Math.max(0, messages.length - visibleCount),
    [messages.length, visibleCount]
  )
  const visibleMessages = useMemo(
    () => messages.slice(visibleStartIndex),
    [messages, visibleStartIndex]
  )

  const handleLoadMoreOlder = useCallback(() => {
    if (!chatContainerRef.current) return
    prevScrollHeightRef.current = chatContainerRef.current.scrollHeight
    setVisibleCount(prev => Math.min(prev + VISIBLE_INCREMENT, messages.length))
  }, [messages.length])

  const isLoading = loadingConversationId && loadingConversationId === activeConversationId

  if (isLoading) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          minHeight: 240,
        }}
      >
        <Spin size="large" />
        <Text type="secondary" style={{ fontSize: 13 }}>
          {t('workbench.loadingMessages')}
        </Text>
      </div>
    )
  }

  return (
    <>
      {messages.length === 0 && activeConversationId && (
        <div style={{ textAlign: 'center', paddingTop: '20vh' }}>
          <RobotOutlined style={{ fontSize: 48, color: token.colorTextQuaternary, marginBottom: 16 }} />
          <Paragraph type="secondary" style={{ fontSize: 14 }}>{t('workbench.startConvHint')}</Paragraph>
        </div>
      )}

      {visibleStartIndex > 0 && (
        <div style={{ textAlign: 'center', padding: '4px 0 8px' }}>
          <Button
            type="link"
            size="small"
            onClick={handleLoadMoreOlder}
            style={{ fontSize: 13, color: token.colorTextSecondary }}
          >
            {t('workbench.loadOlderMessages', { count: visibleStartIndex })}
          </Button>
        </div>
      )}

      {visibleMessages.map((msg, visibleIndex) => {
        const fullIndex = visibleStartIndex + visibleIndex
        const prevMsg = fullIndex > 0 ? messages[fullIndex - 1] : null
        const showTime = fullIndex === 0 || (prevMsg && shouldShowTimeSeparator(prevMsg.timestamp, msg.timestamp))

        return (
          <Fragment key={msg.id}>
            {showTime && (
              <div style={{
                textAlign: 'center',
                padding: '4px 0',
                color: token.colorTextQuaternary,
                fontSize: 12,
                userSelect: 'none',
              }}>
                {formatMessageTime(msg.timestamp, t)}
              </div>
            )}
            <MessageBubble
              msg={msg}
              onCopy={onCopy}
              onDeleteMessage={onDeleteMessage}
              onRegenerate={onRegenerate}
              onSwitchModelRegenerate={onSwitchModelRegenerate}
              onEditAndResubmit={onEditAndResubmit}
              onToggleSegment={onToggleSegment}
              onSwitchBranch={onSwitchBranch}
              onOpenComparison={onOpenComparison}
              getToolDisplayName={getToolDisplayName}
              providers={providers}
            />
          </Fragment>
        )
      })}
    </>
  )
}

export default MessageList
