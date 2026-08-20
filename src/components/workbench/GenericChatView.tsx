// 通用对话视图：复用任务对话 UI 样式（MessageList + ChatInput）的受控组件。
// 调用方维护消息与回调（messages/isStreaming/onSend/onStop...），宿主负责渲染。
// 暴露给插件（hostCapabilities.GenericChatView），插件页面内可直接调用 LLM 实现自定义对话。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { theme, Button, Tooltip } from 'antd'
import { CloseOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { GenericChatViewProps } from '../../../plugins/plugin-sdk/src/renderer'
import { MessageList, ChatInput } from './index'
import type { MessageWithThought } from './types'
import type { AttachedImage } from './ChatInput'
import { ensureSegments } from './types'
import { useChatScroll } from '../../hooks/useChatScroll'

const GenericChatView: React.FC<GenericChatViewProps> = ({
  messages,
  isStreaming,
  chatError,
  conversationId,
  placeholder,
  title,
  providers = [],
  header,
  onSend,
  onStop,
  onNewChat,
  onClose,
  onToggleSegment,
  loading,
  contextStats,
  style,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])

  // 归一化为宿主 MessageWithThought（无 segments 时按 content/thought 派生）
  const normalizedMessages = useMemo<MessageWithThought[]>(
    () => messages.map((m) => ensureSegments(m as MessageWithThought)),
    [messages]
  )

  // 流式自动滚动：仅当用户位于底部时跟随，用户上滚浏览历史时不打扰
  const { messagesEndRef, chatContainerRef, handleScroll, forceScrollToBottom } = useChatScroll(normalizedMessages)

  // 切换会话（加载历史）时重置滚动到底部，避免沿用上一会话的上滚位置导致新历史不显示最新消息
  const forceScrollRef = useRef(forceScrollToBottom)
  forceScrollRef.current = forceScrollToBottom
  useEffect(() => {
    forceScrollRef.current()
  }, [conversationId])

  const handleCopy = useCallback(async (content: string) => {
    try { await navigator.clipboard.writeText(content) } catch { /* ignore */ }
  }, [])

  const handleSend = useCallback((content: string, images: string[]) => {
    forceScrollToBottom()
    onSend(content, images)
    if (images.length > 0) setAttachedImages([])
  }, [onSend, forceScrollToBottom])

  // 通用对话不提供重生成/对比/分支等高级能力，保持受控组件的零负担
  const noop = useCallback(() => {}, [])
  const getToolDisplayName = useCallback((name: string) => name, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, ...style }}>
      {(title || onNewChat || onClose || header) && (
        <div style={{ padding: '8px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}`, display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
          {(title || onNewChat || onClose) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {title && (
                <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {title}
                </span>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                {onNewChat && (
                  <Tooltip title={t('workbench.newChat')}>
                    <Button size="small" type="text" icon={<PlusOutlined />} onClick={onNewChat} />
                  </Tooltip>
                )}
                {onClose && (
                  <Tooltip title={t('common.close')}>
                    <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} />
                  </Tooltip>
                )}
              </div>
            </div>
          )}
          {header}
        </div>
      )}

      <div ref={chatContainerRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {!loading && normalizedMessages.length === 0 ? (
          <div style={{ textAlign: 'center', paddingTop: '20vh' }}>
            <RobotOutlined style={{ fontSize: 48, color: token.colorTextQuaternary, marginBottom: 16 }} />
            <div style={{ fontSize: 14, color: token.colorTextTertiary }}>{t('workbench.genericChatEmpty')}</div>
          </div>
        ) : (
          <>
            <MessageList
              messages={normalizedMessages}
              loadingConversationId={loading ? (conversationId ?? null) : null}
              activeConversationId={conversationId ?? null}
              chatContainerRef={chatContainerRef}
              onCopy={handleCopy}
              onDeleteMessage={noop}
              onRegenerate={noop}
              onSwitchModelRegenerate={noop}
              onEditAndResubmit={noop}
              onToggleSegment={onToggleSegment ?? noop}
              onSwitchBranch={noop}
              onOpenComparison={noop}
              getToolDisplayName={getToolDisplayName}
              providers={providers}
              contextStats={contextStats}
              hideMessageActions
            />
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {chatError && (
        <div style={{ padding: '4px 16px', color: token.colorError, fontSize: 12, flexShrink: 0 }}>{chatError}</div>
      )}

      <ChatInput
        onSend={handleSend}
        onStop={onStop}
        isStreaming={isStreaming}
        placeholder={placeholder || t('workbench.inputPlaceholder')}
        providers={providers}
        attachedImages={attachedImages}
        onImagesChange={setAttachedImages}
        selectedModels={[]}
        onModelsChange={noop}
        selectedCollectionIds={[]}
        onSelectedCollectionIdsChange={noop}
        allCollections={[]}
        minimalMode={false}
        onMinimalModeChange={noop}
        canToggleMinimalMode={false}
        hideToolbar
        conversationId={conversationId}
      />
    </div>
  )
}

export default GenericChatView
