import { Typography, Button, Space, Popconfirm, theme, Input, Popover, Tag } from 'antd'
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
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useTranslation } from 'react-i18next'
import { useState, useCallback, useMemo, memo } from 'react'
import type { MessageWithThought } from './types'
import { ensureSegments } from './types'
import ThinkingSegment from './ThinkingSegment'
import ToolCallSegment from './ToolCallSegment'
import AnswerSegment from './AnswerSegment'
import CodeBlock from './CodeBlock'
import { getProviderModels } from '../../utils/llm'

const { Text } = Typography

const DOMESTIC_PROVIDERS = new Set(['deepseek', 'qwen', 'zhipu', 'volcengine', 'moonshot', 'yi'])
const LOCAL_PROVIDERS = new Set(['lmstudio', 'openai-compatible'])

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
}> = ({ msg, onCopy, onDeleteMessage, onRegenerate, onSwitchModelRegenerate, onEditAndResubmit, onToggleSegment, onSwitchBranch, onOpenComparison, getToolDisplayName, providers }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')

  const handleStartEdit = useCallback(() => {
    setEditValue(msg.content)
    setIsEditing(true)
  }, [msg.content])

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false)
    setEditValue('')
  }, [])

  const handleSubmitEdit = useCallback(() => {
    if (editValue.trim() && editValue.trim() !== msg.content) {
      onEditAndResubmit(msg.id, editValue.trim())
    }
    setIsEditing(false)
    setEditValue('')
  }, [editValue, msg.id, msg.content, onEditAndResubmit])

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
    if (!hasBranches) return null
    const currentBranch = branchData || { comparisonProviderId: msg.comparisonProviderId, comparisonModelId: msg.comparisonModelId }
    if (!currentBranch.comparisonProviderId || !currentBranch.comparisonModelId) return null
    const provider = providers.find((p: any) => p.id === currentBranch.comparisonProviderId)
    if (!provider) return currentBranch.comparisonModelId
    let models: any[] = []
    try { models = provider.models_json ? JSON.parse(provider.models_json) : [] } catch { models = [] }
    const model = models.find((m: any) => m.model === currentBranch.comparisonModelId)
    return model?.name || currentBranch.comparisonModelId
  }, [hasBranches, branchData, msg.comparisonProviderId, msg.comparisonModelId, providers])

  const displayMsg = useMemo(() =>
    msg.role === 'assistant'
      ? ensureSegments({ ...msg, content: displayContent, segments: displaySegments, thought: displayThought, isError: displayIsError, isStreaming: displayIsStreaming })
      : msg
  , [msg, displayContent, displaySegments, displayThought, displayIsError, displayIsStreaming])

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
            {isEditing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Input.TextArea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  autoSize={{ minRows: 1, maxRows: 5 }}
                  style={{
                    fontSize: 14,
                    lineHeight: 1.7,
                    borderRadius: 12,
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
                padding: '10px 16px',
                borderRadius: 12,
                background: token.colorPrimary,
                color: '#fff',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                lineHeight: 1.7,
              }}>
                <Text style={{ color: '#fff', fontSize: 14 }}>{msg.content}</Text>
                {msg.images && msg.images.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                    {msg.images.map((img, i) => (
                      <img
                        key={i}
                        src={img}
                        alt={`upload-${i}`}
                        style={{
                          maxWidth: 200,
                          maxHeight: 150,
                          borderRadius: 6,
                          objectFit: 'cover',
                          border: '1px solid rgba(255,255,255,0.3)',
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
            {!msg.isStreaming && !isEditing && (
              <Space size={4} style={{ marginTop: 2, marginLeft: 2, justifyContent: 'flex-end', display: 'flex' }}>
                <Button type="text" size="small" icon={<EditOutlined style={{ fontSize: 12 }} />}
                  onClick={handleStartEdit} title={t('workbench.editMessage')} />
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
                        isError={!!displayIsError}
                      />
                    )
                  }

                  return null
                })}
              </div>
            )}

            {(!displayMsg.segments || displayMsg.segments.length === 0) && displayContent && !displayIsStreaming && (
              <div style={{
                padding: '10px 16px',
                borderRadius: 12,
                background: token.colorBgLayout,
                lineHeight: 1.7,
                wordBreak: 'break-word',
                border: displayIsError ? '1px solid #ff4d4f' : 'none',
              }}>
                <div className="markdown-content" style={{ fontSize: 14, color: token.colorText }}>
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

            {!displayIsStreaming && (
              <Space size={4} style={{ marginTop: 2, marginLeft: 2 }}>
                {hasBranches && (
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
                {currentBranchModelLabel && (
                  <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0, cursor: 'pointer' }}
                    onClick={() => onOpenComparison(msg.id)}>
                    {currentBranchModelLabel}
                  </Tag>
                )}
                {displayContent && (
                  <Button type="text" size="small" icon={<CopyOutlined style={{ fontSize: 12 }} />}
                    onClick={() => onCopy(displayContent)} />
                )}
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
              </Space>
            )}
            {!displayIsStreaming && (
              <div style={{
                marginTop: 4,
                marginLeft: 2,
                display: 'flex',
                gap: 8,
                alignItems: 'center',
              }}>
                {displayTokenUsage && displayTokenUsage.totalTokens === undefined && displayTokenUsage.totalChars !== undefined ? (
                  <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
                    {t('workbench.outputChars')}: {displayTokenUsage.totalChars}
                  </Text>
                ) : null}
                {displayTokenUsage && displayTokenUsage.totalTokens !== undefined ? (
                  <>
                    {displayTokenUsage.promptTokens !== undefined && (
                      <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
                        {t('workbench.promptTokens')}: {displayTokenUsage.promptTokens}
                      </Text>
                    )}
                    {displayTokenUsage.completionTokens !== undefined && (
                      <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
                        {t('workbench.completionTokens')}: {displayTokenUsage.completionTokens}
                      </Text>
                    )}
                    {displayTokenUsage.totalTokens !== undefined && (
                      <Text style={{ fontSize: 11, color: token.colorTextTertiary }}>
                        {t('workbench.totalTokens')}: {displayTokenUsage.totalTokens}
                      </Text>
                    )}
                  </>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(MessageBubble, (prev, next) => {
  return prev.msg === next.msg && prev.providers === next.providers
})
