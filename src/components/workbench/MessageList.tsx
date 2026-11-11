import { useState, useMemo, useCallback, useLayoutEffect, useRef, useEffect, Fragment, memo } from 'react'
import { Button, Spin, Typography } from 'antd'
import { RobotOutlined, CompressOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { theme } from 'antd'
import { MessageBubble } from './index'
import type { MessageWithThought } from './types'
import type { Employee } from '../../types'
import { formatMessageTime, shouldShowTimeSeparator } from '../../utils/format'
import { setActiveWorkbenchConversation } from './active-conversation'

const { Text, Paragraph } = Typography

const INITIAL_VISIBLE_COUNT = 8
const VISIBLE_INCREMENT = 20

interface MessageListProps {
  messages: MessageWithThought[]
  loadingConversationId: string | null
  activeConversationId: string | null
  chatContainerRef: React.RefObject<HTMLDivElement | null>
  onCopy: (content: string) => Promise<void>
  onDeleteMessage: (msgId: string) => void
  onRegenerate: (msgId: string) => void
  /** 出错重试：原地从失败处继续生成 */
  onRetry?: (msgId: string) => void
  onSwitchModelRegenerate: (msgId: string, providerId: string, modelId: string) => void
  onEditAndResubmit: (msgId: string, newContent: string) => void
  onToggleSegment: (msgId: string, segId: string) => void
  onSwitchBranch: (msgId: string, branchIndex: number) => void
  onBranch?: (msgId: string) => void
  onOpenComparison: (msgId: string) => void
  getToolDisplayName: (name: string) => string
  providers: any[]
  contextStats?: any
  isCompacting?: boolean
  onCompact?: () => void
  /** 隐藏消息操作按钮（重生成/切换模型/删除/编辑等），用于不支持这些能力的轻量对话视图 */
  hideMessageActions?: boolean
  /** 当前数字员工，用于助手消息展示其真实头像 */
  assistantEmployee?: Employee | null
  /** 是否还有更早的历史消息（行存储分页） */
  hasOlderMessages?: boolean
  /** 正在补载更早消息 */
  loadingOlderMessages?: boolean
  /** 补载更早消息 */
  onLoadOlderMessages?: () => void
  /** 会话消息总条数（用于"加载更早消息"数量提示） */
  totalMessageCount?: number
}

const MessageList: React.FC<MessageListProps> = ({
  messages,
  loadingConversationId,
  activeConversationId,
  chatContainerRef,
  onCopy,
  onDeleteMessage,
  onRegenerate,
  onRetry,
  onSwitchModelRegenerate,
  onEditAndResubmit,
  onToggleSegment,
  onSwitchBranch,
  onBranch,
  onOpenComparison,
  getToolDisplayName,
  providers,
  contextStats,
  isCompacting,
  onCompact,
  hideMessageActions,
  assistantEmployee,
  hasOlderMessages,
  loadingOlderMessages,
  onLoadOlderMessages,
  totalMessageCount,
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

  // 委托卡片按需拉取子过程时依赖当前会话（轻量对话视图同样适用）
  useEffect(() => {
    setActiveWorkbenchConversation(activeConversationId)
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

  // 当前对话平均输出速度：仅统计带计时数据的主对话助手消息（子任务用量单独展示）
  const conversationTokensPerSec = useMemo(() => {
    let completionTokens = 0
    let generationMs = 0
    for (const m of messages) {
      if (m.role !== 'assistant' || m.isCompactSummary) continue
      const branch = m.branches && (m.activeBranchIndex ?? m.branches.length) < m.branches.length
        ? m.branches[m.activeBranchIndex ?? 0]
        : undefined
      const usage = branch ? branch.tokenUsage : m.tokenUsage
      if (!usage?.completionTokens || !usage.generationMs) continue
      completionTokens += usage.completionTokens
      generationMs += usage.generationMs
    }
    return generationMs > 0 ? completionTokens / (generationMs / 1000) : undefined
  }, [messages])

  const handleLoadMoreOlder = useCallback(() => {
    if (!chatContainerRef.current) return
    // 还有更早的历史：交给分页接口补载；否则扩大本地可视窗口
    if (hasOlderMessages) {
      if (!loadingOlderMessages) onLoadOlderMessages?.()
      return
    }
    prevScrollHeightRef.current = chatContainerRef.current.scrollHeight
    setVisibleCount(prev => Math.min(prev + VISIBLE_INCREMENT, messages.length))
  }, [messages.length, hasOlderMessages, loadingOlderMessages, onLoadOlderMessages])

  // 更早一页消息被前置插入：保留当前滚动位置并同步扩大可视窗口
  // prevCount > 0 用来排除首屏加载（0 → N），否则窗口会被一次性撑满整页，失去窗口化收益
  const prevCountRef = useRef(messages.length)
  const prevFirstIdRef = useRef(messages[0]?.id)
  useLayoutEffect(() => {
    const prevCount = prevCountRef.current
    const prevFirstId = prevFirstIdRef.current
    const firstId = messages[0]?.id
    prevCountRef.current = messages.length
    prevFirstIdRef.current = firstId
    if (prevCount > 0 && messages.length > prevCount && firstId !== prevFirstId) {
      const delta = messages.length - prevCount
      prevScrollHeightRef.current = chatContainerRef.current?.scrollHeight || 0
      // 只扩大"原有窗口 + 新增条数"，避免把整页消息全部渲染出来
      setVisibleCount(prev => Math.min(prev + delta, messages.length))
    }
  }, [messages, chatContainerRef])

  // 滚动到接近顶部时自动补载更早的消息，保持"向上翻阅历史"的连续体验
  useEffect(() => {
    const container = chatContainerRef.current
    if (!container) return
    let scheduled = false
    const onScroll = () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        const el = chatContainerRef.current
        if (!el) return
        const aboveBottom = el.scrollHeight - el.scrollTop > el.clientHeight + 120
        if (aboveBottom && el.scrollTop < 80) handleLoadMoreOlder()
      })
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [chatContainerRef, handleLoadMoreOlder])

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
        <div style={{ textAlign: 'center', paddingTop: '18vh' }}>
          <div className="wa-msg-avatar" style={{ width: 52, height: 52, borderRadius: 16, margin: '0 auto 14px' }}>
            <RobotOutlined style={{ fontSize: 22, color: token.colorTextTertiary }} />
          </div>
          <Paragraph type="secondary" style={{ fontSize: 13.5 }}>{t('workbench.startConvHint')}</Paragraph>
        </div>
      )}

      {(visibleStartIndex > 0 || hasOlderMessages) && (
        <div style={{ textAlign: 'center', padding: '4px 0 8px' }}>
          <Button
            type="link"
            size="small"
            loading={!!loadingOlderMessages}
            onClick={handleLoadMoreOlder}
            style={{ fontSize: 12.5, color: token.colorTextTertiary }}
          >
            {t('workbench.loadOlderMessages', {
              count: Math.max(
                1,
                visibleStartIndex + Math.max(0, (totalMessageCount ?? messages.length) - messages.length),
              ),
            })}
          </Button>
        </div>
      )}

      {visibleMessages.map((msg, visibleIndex) => {
        const fullIndex = visibleStartIndex + visibleIndex
        const prevMsg = fullIndex > 0 ? messages[fullIndex - 1] : null
        const showTime = fullIndex === 0 || (prevMsg && shouldShowTimeSeparator(prevMsg.timestamp, msg.timestamp))

        return (
          <Fragment key={msg.id}>
            {msg.isCompactSummary && (
              <div className="wa-time-sep">
                <CompressOutlined style={{ fontSize: 11, flexShrink: 0 }} />
                <span style={{ flexShrink: 0 }}>{t('workbench.compressed', { defaultValue: '已压缩' })}</span>
              </div>
            )}
            {showTime && (
              <div className="wa-time-sep">
                <span style={{ flexShrink: 0 }}>{formatMessageTime(msg.timestamp, t)}</span>
              </div>
            )}
            {(() => {
              let nextAssistantIdx = -1
              for (let j = fullIndex + 1; j < messages.length; j++) {
                if (!messages[j].isCompactSummary && messages[j].role === 'assistant') {
                  nextAssistantIdx = j
                  break
                }
              }
              const isLastAssistantMsg = !msg.isCompactSummary && msg.role === 'assistant' && nextAssistantIdx === -1
              return !msg.isCompactSummary && (
                <MessageBubble
                  msg={msg}
                  onCopy={onCopy}
                  onDeleteMessage={onDeleteMessage}
                  onRegenerate={onRegenerate}
                  onRetry={onRetry}
                  onSwitchModelRegenerate={onSwitchModelRegenerate}
                  onEditAndResubmit={onEditAndResubmit}
                  onToggleSegment={onToggleSegment}
                  onSwitchBranch={onSwitchBranch}
                  onBranch={onBranch}
                  onOpenComparison={onOpenComparison}
                  getToolDisplayName={getToolDisplayName}
                  providers={providers}
                  isLastAssistantMessage={isLastAssistantMsg}
                  isLastMessage={fullIndex === messages.length - 1}
                  contextStats={isLastAssistantMsg ? contextStats : undefined}
                  isCompacting={isLastAssistantMsg ? isCompacting : false}
                  onCompact={isLastAssistantMsg ? onCompact : undefined}
                  hideMessageActions={hideMessageActions}
                  assistantEmployee={assistantEmployee}
                  conversationTokensPerSec={conversationTokensPerSec}
                />
              )
            })()}
          </Fragment>
        )
      })}
    </>
  )
}

// 输入框已下沉为内部 state，输入时不再触发父组件重渲染，
// 但回调函数未用 useCallback 稳定化，默认 shallow memo 仍可能失效。
// 这些回调均通过 ref 读取最新值，行为稳定，故只对比数据 props 即可安全跳过渲染。
export default memo(MessageList, (prev, next) => {
  return (
    prev.messages === next.messages &&
    prev.loadingConversationId === next.loadingConversationId &&
    prev.activeConversationId === next.activeConversationId &&
    prev.providers === next.providers &&
    prev.contextStats === next.contextStats &&
    prev.isCompacting === next.isCompacting &&
    prev.assistantEmployee === next.assistantEmployee &&
    prev.hasOlderMessages === next.hasOlderMessages &&
    prev.loadingOlderMessages === next.loadingOlderMessages &&
    prev.totalMessageCount === next.totalMessageCount
  )
})
