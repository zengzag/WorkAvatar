import { useState, useMemo, useCallback, useLayoutEffect, useRef, useEffect, Fragment, memo } from 'react'
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
  onDeleteMessage: (msgId: string) => void
  onRegenerate: (msgId: string) => void
  onSwitchModelRegenerate: (msgId: string, providerId: string, modelId: string) => void
  onEditAndResubmit: (msgId: string, newContent: string) => void
  onToggleSegment: (msgId: string, segId: string) => void
  onSwitchBranch: (msgId: string, branchIndex: number) => void
  onOpenComparison: (msgId: string) => void
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
  const needScrollOnLoadRef = useRef(false)

  useLayoutEffect(() => {
    if (activeConversationId !== lastConvIdRef.current) {
      lastConvIdRef.current = activeConversationId
      setVisibleCount(INITIAL_VISIBLE_COUNT)
      prevScrollHeightRef.current = 0
      needScrollOnLoadRef.current = true
    }
  }, [activeConversationId])

  // 消息加载完成后（loading 结束、messages 有内容）再滚动到底部
  // 修复：原来在 activeConversationId 变化时立即滚动，但此时 loading 状态 scrollHeight 不对
  useEffect(() => {
    if (needScrollOnLoadRef.current && messages.length > 0) {
      needScrollOnLoadRef.current = false
      // 双 rAF 确保浏览器完成布局后再滚动
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (chatContainerRef.current) {
            chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight
          }
        })
      })
    }
  }, [messages])

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

// 输入框输入时 inputDraft 变化会触发父组件重新渲染，
// 但回调函数未用 useCallback 稳定化，默认 shallow memo 会失效。
// 这些回调均通过 ref 读取最新值，行为稳定，故只对比数据 props 即可安全跳过渲染。
export default memo(MessageList, (prev, next) => {
  return (
    prev.messages === next.messages &&
    prev.loadingConversationId === next.loadingConversationId &&
    prev.activeConversationId === next.activeConversationId &&
    prev.providers === next.providers
  )
})
