import { Typography, Button, Space, Popconfirm, theme, Input, Popover, Tag, App, Image, Tooltip } from 'antd'
import {
  RobotOutlined,
  UserOutlined,
  CopyOutlined,
  DeleteOutlined,
  ReloadOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
  LeftOutlined,
  RightOutlined,
  SwapOutlined,
  SearchOutlined,
  CompressOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useTranslation } from 'react-i18next'
import { useState, useCallback, useMemo, memo, useRef, useEffect } from 'react'
import type { MessageWithThought } from './types'
import { ensureSegments } from './types'
import { markdownComponents } from './markdown-components'
import { resolveModelLabel, TokenUsageDisplay, SegmentList } from './message-shared'
import GeneratedFilesBar from './GeneratedFilesBar'
import { getProviderModels, DOMESTIC_PROVIDERS, LOCAL_PROVIDERS } from '../../utils/llm'
import type { PluginMessageActionInfo } from '../../../electron/shared/channels/plugin'
import { PluginViewSlot } from '../../plugins/view-slot'

const { Text } = Typography

const ModelSwitchPopover: React.FC<{
  providers: any[]
  onSelect: (providerId: string, modelId: string) => void
}> = ({ providers, onSelect }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [searchText, setSearchText] = useState('')

  const filteredProviderModels = useMemo(() => {
    const search = searchText.toLowerCase()
    return providers.map((provider: any) => {
      const models = getProviderModels(provider).filter(m => (m.category || 'chat') === 'chat')
      const filtered = search
        ? models.filter(m =>
            m.name.toLowerCase().includes(search) ||
            m.model.toLowerCase().includes(search) ||
            provider.name.toLowerCase().includes(search)
          )
        : models
      return { provider, models: filtered }
    }).filter(group => group.models.length > 0)
  }, [providers, searchText])

  const content = (
    <div style={{ width: 280, maxHeight: 360, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Input
        placeholder={t('workbench.searchModel')}
        prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        allowClear
        variant="borderless"
        size="small"
        style={{ background: token.colorFillQuaternary, borderRadius: 6 }}
      />
      <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {filteredProviderModels.map(({ provider, models }) => {
          const isDomestic = DOMESTIC_PROVIDERS.has(provider.provider_type)
          const isLocal = LOCAL_PROVIDERS.has(provider.provider_type)
          return (
            <div key={provider.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', fontSize: 11, fontWeight: 600, color: token.colorTextTertiary }}>
                <RobotOutlined style={{ fontSize: 10 }} />
                <span>{provider.name}</span>
                {isDomestic && <Tag color="red" style={{ fontSize: 8, lineHeight: '12px', padding: '0 2px', margin: 0 }}>{t('llmSelector.domestic')}</Tag>}
                {isLocal && <Tag color="green" style={{ fontSize: 8, lineHeight: '12px', padding: '0 2px', margin: 0 }}>{t('llmSelector.local')}</Tag>}
              </div>
              {models.map((model) => (
                <div
                  key={`${provider.id}-${model.model}`}
                  onClick={() => onSelect(provider.id, model.model)}
                  style={{
                    padding: '4px 6px 4px 18px',
                    borderRadius: 4,
                    cursor: 'pointer',
                    fontSize: 12,
                    color: token.colorText,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = token.colorBgTextHover }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                >
                  {model.name}
                </div>
              ))}
            </div>
          )
        })}
        {filteredProviderModels.length === 0 && (
          <div style={{ padding: '16px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12 }}>
            {t('workbench.noMatchingModel')}
          </div>
        )}
      </div>
    </div>
  )

  return (
    <Popover content={content} trigger="click" placement="bottomLeft" arrow={false} styles={{ container: { padding: 8 } }}>
      <Button type="text" size="small" icon={<SwapOutlined style={{ fontSize: 12 }} />}
        title={t('workbench.switchModelRegenerate')} />
    </Popover>
  )
}

const formatNum = (n: number | undefined | null): string => {
  if (n === undefined || n === null) return ''
  return n.toLocaleString('en-US')
}

const ContextUsageInline: React.FC<{
  stats?: any
  isCompacting: boolean
  onCompact?: () => void
}> = ({ stats, isCompacting, onCompact }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const tokenCount = stats?.actualPromptTokens ?? stats?.estimatedTokens ?? 0
  const maxTokens = stats?.maxTokens ?? 0
  const percent = maxTokens > 0 ? Math.round((tokenCount / maxTokens) * 100) : 0

  const percentColor = percent > 80 ? token.colorError : percent > 50 ? token.colorWarning : token.colorTextTertiary

  return (
    <Tooltip
      title={
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 12, color: token.colorTextTertiary }}>
            {formatNum(tokenCount)} / {formatNum(maxTokens)}
          </Text>
          <Button
            type="text"
            size="small"
            icon={<CompressOutlined style={{ fontSize: 12 }} />}
            onClick={onCompact}
            loading={isCompacting}
            disabled={isCompacting || !onCompact}
            style={{ fontSize: 12, height: 22, padding: '0 4px', color: token.colorText }}>
            {t('workbench.compact', { defaultValue: '压缩' })}
          </Button>
        </div>
      }
    >
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
      }}>
        <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
          {t('workbench.contextUsage', { defaultValue: '上下文' })}:
        </Text>
        <Text style={{ fontSize: 11, color: percentColor, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
          {percent}%
        </Text>
      </div>
    </Tooltip>
  )
}

const MessageBubble: React.FC<{
  msg: MessageWithThought
  onCopy: (content: string) => void
  onDeleteMessage: (msgId: string) => void
  onRegenerate: (msgId: string) => void
  onSwitchModelRegenerate: (msgId: string, providerId: string, modelId: string) => void
  onEditAndResubmit: (msgId: string, newContent: string) => void
  onToggleSegment: (msgId: string, segId: string) => void
  onSwitchBranch: (msgId: string, branchIndex: number) => void
  onOpenComparison: (msgId: string) => void
  getToolDisplayName: (name: string) => string
  providers: any[]
  isLastAssistantMessage?: boolean
  contextStats?: any
  isCompacting?: boolean
  onCompact?: () => void
  /** 隐藏消息操作按钮（重生成/切换模型/删除/编辑等），用于不支持这些能力的轻量对话视图 */
  hideMessageActions?: boolean
}> = ({ msg, onCopy, onDeleteMessage, onRegenerate, onSwitchModelRegenerate, onEditAndResubmit, onToggleSegment, onSwitchBranch, onOpenComparison, getToolDisplayName, providers, isLastAssistantMessage, contextStats, isCompacting, onCompact, hideMessageActions }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { message: messageApi } = App.useApp()
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const bubbleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isEditing && bubbleRef.current) {
      bubbleRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [isEditing])

  const handleStartEdit = useCallback(() => {
    setEditValue(msg.content)
    setIsEditing(true)
  }, [msg.content])

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false)
    setEditValue('')
  }, [])

  const handleSubmitEdit = useCallback(() => {
    if (editValue.trim()) {
      onEditAndResubmit(msg.id, editValue.trim())
    }
    setIsEditing(false)
    setEditValue('')
  }, [editValue, msg.id, onEditAndResubmit])

  const branchCount = msg.branches?.length ?? 0
  const hasBranches = branchCount > 0
  const branchIndex = msg.activeBranchIndex ?? branchCount
  const totalBranches = branchCount + 1
  const showBranchContent = hasBranches && branchIndex < branchCount

  const branchData = showBranchContent && msg.branches ? msg.branches[branchIndex] : null
  const displayContent = branchData ? branchData.content : msg.content
  const displaySegments = branchData ? (branchData.segments) : msg.segments
  const displayThought = branchData ? branchData.thought : msg.thought
  const displayTokenUsage = branchData ? branchData.tokenUsage : msg.tokenUsage
  const displayIsError = branchData ? branchData.isError : msg.isError
  const displayIsStreaming = !showBranchContent && msg.isStreaming

  const hasComparisonBranches = hasBranches && (
    msg.branches!.some(b => b.comparisonProviderId || b.comparisonModelId) ||
    msg.comparisonProviderId ||
    msg.comparisonModelId
  )

  const currentBranchModelLabel = useMemo(() => {
    const currentBranch = branchData || { comparisonProviderId: msg.comparisonProviderId, comparisonModelId: msg.comparisonModelId }
    const label = resolveModelLabel(currentBranch, providers)
    return label || null
  }, [branchData, msg.comparisonProviderId, msg.comparisonModelId, providers])

  const displayMsg = useMemo(() =>
    msg.role === 'assistant'
      ? ensureSegments({ ...msg, content: displayContent, segments: displaySegments, thought: displayThought, isError: displayIsError, isStreaming: displayIsStreaming })
      : msg
  , [msg, displayContent, displaySegments, displayThought, displayIsError, displayIsStreaming])

  // 插件贡献的对话消息快捷操作（通用插件能力，如笔记插件"保存到笔记"）
  const [messageActions, setMessageActions] = useState<PluginMessageActionInfo[]>([])
  useEffect(() => {
    let cancelled = false
    window.electronAPI.plugin.listMessageActions()
      .then(list => { if (!cancelled) setMessageActions(list) })
      .catch(() => { if (!cancelled) setMessageActions([]) })
    return () => { cancelled = true }
  }, [])

  const runMessageAction = useCallback(async (action: PluginMessageActionInfo) => {
    if (!displayContent) return
    const resolveText = (text: string) => t(text, { ns: action.pluginId, defaultValue: text })
    try {
      const res = await window.electronAPI.plugin.invoke<{ success?: string; error?: string }>(
        action.pluginId, `message-action:${action.id}`, { content: displayContent, messageId: msg.id })
      if (res?.error) messageApi.error(resolveText(res.error))
      else if (res?.success) messageApi.success(resolveText(res.success))
    } catch (err: any) {
      messageApi.error(err?.message || String(err))
    }
  }, [displayContent, msg.id, messageApi, t])

  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <div
        ref={bubbleRef}
        style={{
          width: '100%',
          maxWidth: 'min(92%, 820px)',
          display: 'flex',
          gap: 10,
          flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
          alignItems: 'flex-start',
        }}
      >
        <div style={{
          width: 30,
          height: 30,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          background: msg.role === 'assistant' ? token.colorPrimaryBg : token.colorInfoBg,
        }}>
          {msg.role === 'assistant'
            ? <RobotOutlined style={{ color: token.colorPrimary, fontSize: 15 }} />
            : <UserOutlined style={{ color: token.colorPrimary, fontSize: 15 }} />}
        </div>

        <div style={{
          maxWidth: '88%',
          minWidth: 0,
          width: msg.role === 'assistant' || isEditing ? '100%' : undefined,
          ...(msg.role === 'user' ? { marginLeft: -10 } : { marginRight: -10 }),
        }}>
        {msg.role === 'user' && (
          <div>
            {isEditing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Input.TextArea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  autoSize={{ minRows: 3, maxRows: 15 }}
                  style={{
                    fontSize: 15,
                    lineHeight: 1.6,
                    borderRadius: 8,
                    width: '100%',
                  }}
                  onPressEnter={(e) => {
                    if (!e.shiftKey) {
                      e.preventDefault()
                      handleSubmitEdit()
                    }
                  }}
                />
                <Space size={4} style={{ justifyContent: 'flex-end', display: 'flex' }}>
                  <Button type="text" size="small" icon={<CloseOutlined />} onClick={handleCancelEdit} />
                  <Button type="primary" size="small" icon={<CheckOutlined />} onClick={handleSubmitEdit} />
                </Space>
              </div>
            ) : (
              <div style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: token.colorInfoBg,
                color: token.colorText,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                lineHeight: 1.6,
              }}>
                <Text style={{ color: token.colorText, fontSize: 15 }}>{msg.content}</Text>
                {msg.images && msg.images.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                    <Image.PreviewGroup items={msg.images}>
                      {msg.images.map((img, i) => (
                        <Image
                          key={img}
                          src={img}
                          alt={`upload-${i}`}
                          style={{
                            maxWidth: 220,
                            maxHeight: 160,
                            borderRadius: 4,
                            border: `1px solid ${token.colorBorderSecondary}`,
                            objectFit: 'contain',
                            background: token.colorBgLayout,
                          }}
                          preview={{}}
                        />
                      ))}
                    </Image.PreviewGroup>
                  </div>
                )}
              </div>
            )}
            {!msg.isStreaming && !isEditing && (
              <Space size={4} style={{ marginTop: 2, marginLeft: 2, justifyContent: 'flex-end', display: 'flex' }}>
                {msg.content && (
                  <Button type="text" size="small" icon={<CopyOutlined style={{ fontSize: 12 }} />}
                    onClick={() => onCopy(msg.content)} />
                )}
                {!hideMessageActions && (
                  <>
                    <Button type="text" size="small" icon={<EditOutlined style={{ fontSize: 12 }} />}
                      onClick={handleStartEdit} title={t('workbench.editMessage')} />
                    <Popconfirm title={t('workbench.confirmDeleteMsg')} onConfirm={() => onDeleteMessage(msg.id)}
                      okText={t('common.confirm')} cancelText={t('common.cancel')}>
                      <Button type="text" size="small" danger icon={<DeleteOutlined style={{ fontSize: 12 }} />} />
                    </Popconfirm>
                  </>
                )}
              </Space>
            )}
          </div>
        )}

        {msg.role === 'assistant' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {displayMsg.isStreaming && (!displayMsg.segments || displayMsg.segments.length === 0) && (
              <div style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: token.colorBgContainer,
                lineHeight: 1.6,
              }}>
                <Text style={{ color: token.colorTextQuaternary, fontSize: 15 }}>{t('workbench.thinking')}</Text>
              </div>
            )}

            {displayMsg.segments && displayMsg.segments.length > 0 && (
              <SegmentList
                segments={displayMsg.segments}
                msgId={msg.id}
                isError={!!displayIsError}
                onToggleSegment={onToggleSegment}
                getToolDisplayName={getToolDisplayName}
              />
            )}

            {(!displayMsg.segments || displayMsg.segments.length === 0) && displayContent && !displayIsStreaming && (
              <div style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: token.colorBgContainer,
                lineHeight: 1.6,
                wordBreak: 'break-word',
                border: displayIsError ? `1px solid ${token.colorError}` : 'none',
              }}>
                <div className="markdown-content" style={{ fontSize: 15, color: token.colorText }}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={markdownComponents}
                  >
                    {displayContent}
                  </ReactMarkdown>
                </div>
              </div>
            )}

            {!displayIsStreaming && displaySegments && (
              <GeneratedFilesBar segments={displaySegments} />
            )}

            {!displayIsStreaming && displayMsg.isAborted && (
              <div style={{ marginTop: 2, marginLeft: 2 }}>
                <Tag color="warning" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0 }}>
                  {t('workbench.msgAborted')}
                </Tag>
              </div>
            )}

            {!displayIsStreaming && (
              <Space size={4} style={{ marginTop: 2, marginLeft: 2 }}>
                {!hideMessageActions && hasBranches && (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 2,
                      padding: '0 4px',
                      borderRadius: 4,
                      background: token.colorBgTextHover,
                      fontSize: 11,
                    }}
                  >
                    <Button type="text" size="small" icon={<LeftOutlined style={{ fontSize: 9 }} />}
                      disabled={branchIndex === 0}
                      onClick={() => onSwitchBranch(msg.id, branchIndex - 1)}
                      style={{ padding: '0 2px', minWidth: 16, height: 16 }} />
                    <Text
                      style={{
                        fontSize: 11,
                        color: hasComparisonBranches ? token.colorPrimary : token.colorTextSecondary,
                        userSelect: 'none',
                        cursor: hasComparisonBranches ? 'pointer' : 'default',
                      }}
                      onClick={() => { if (hasComparisonBranches) onOpenComparison(msg.id) }}
                    >
                      {branchIndex + 1}/{totalBranches}
                    </Text>
                    <Button type="text" size="small" icon={<RightOutlined style={{ fontSize: 9 }} />}
                      disabled={branchIndex >= branchCount}
                      onClick={() => onSwitchBranch(msg.id, branchIndex + 1)}
                      style={{ padding: '0 2px', minWidth: 16, height: 16 }} />
                  </div>
                )}
                {displayContent && (
                  <Button type="text" size="small" icon={<CopyOutlined style={{ fontSize: 12 }} />}
                    onClick={() => onCopy(displayContent)} />
                )}
                {displayContent && !displayIsError && messageActions
                  .filter(a => (a.target ?? 'assistant') === msg.role || a.target === 'all')
                  .map(action => (
                    <Button
                      key={`${action.pluginId}:${action.id}`}
                      type="text"
                      size="small"
                      icon={action.icon ? <span dangerouslySetInnerHTML={{ __html: action.icon }} style={{ display: 'inline-flex' }} /> : undefined}
                      title={t(action.title, { ns: action.pluginId, defaultValue: action.title })}
                      onClick={() => runMessageAction(action)}
                    />
                  ))}
                {/* 插件视图注入点：消息气泡操作区 */}
                <PluginViewSlot view="message.bubble" context={{ role: msg.role, content: displayContent, messageId: msg.id }} />
                {!hideMessageActions && (
                  <>
                    <Button type="text" size="small" icon={<ReloadOutlined style={{ fontSize: 12 }} />}
                      onClick={() => onRegenerate(msg.id)} title={t('workbench.regenerate')} />
                    <ModelSwitchPopover
                      providers={providers}
                      onSelect={(providerId, modelId) => onSwitchModelRegenerate(msg.id, providerId, modelId)}
                    />
                    <Popconfirm title={t('workbench.confirmDeleteMsg')} onConfirm={() => onDeleteMessage(msg.id)}
                      okText={t('common.confirm')} cancelText={t('common.cancel')}>
                      <Button type="text" size="small" danger icon={<DeleteOutlined style={{ fontSize: 12 }} />} />
                    </Popconfirm>
                  </>
                )}
              </Space>
            )}
            {!displayIsStreaming && (
              <div style={{
                marginTop: 4,
                marginLeft: 2,
                display: 'flex',
                gap: 16,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}>
                {currentBranchModelLabel && (
                  <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0, cursor: 'pointer' }}
                    onClick={() => onOpenComparison(msg.id)}>
                    {currentBranchModelLabel}
                  </Tag>
                )}
                <TokenUsageDisplay tokenUsage={displayTokenUsage} />
                {isLastAssistantMessage && (
                  <ContextUsageInline
                    stats={contextStats}
                    isCompacting={!!isCompacting}
                    onCompact={onCompact}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
    </div>
  )
}

export default memo(MessageBubble, (prev, next) => {
  return prev.msg === next.msg
    && prev.providers === next.providers
    && prev.isLastAssistantMessage === next.isLastAssistantMessage
    && prev.contextStats === next.contextStats
    && prev.isCompacting === next.isCompacting
    && prev.onCompact === next.onCompact
})
