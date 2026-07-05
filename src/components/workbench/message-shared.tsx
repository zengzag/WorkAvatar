import { Typography, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import type { MessageSegment, TokenUsage } from './types'
import ThinkingSegment from './ThinkingSegment'
import ToolCallSegment from './ToolCallSegment'
import AnswerSegment from './AnswerSegment'

const { Text } = Typography

/**
 * 根据 comparisonProviderId + comparisonModelId 解析模型显示名。
 * 兼容 msg 与 branch 两种来源（只要带这两个字段即可）。
 */
export function resolveModelLabel(
  ids: { comparisonProviderId?: string; comparisonModelId?: string },
  providers: any[]
): string {
  if (!ids.comparisonProviderId || !ids.comparisonModelId) return ''
  const provider = providers.find((p: any) => p.id === ids.comparisonProviderId)
  if (!provider) return ids.comparisonModelId
  let models: any[] = []
  try { models = provider.models_json ? JSON.parse(provider.models_json) : [] } catch { models = [] }
  const model = models.find((m: any) => m.model === ids.comparisonModelId)
  return model?.name || ids.comparisonModelId
}

/**
 * Token 用量展示块。从 MessageBubble / MultiChatPanel 抽取的共享逻辑。
 */
export const TokenUsageDisplay: React.FC<{ tokenUsage: TokenUsage | undefined }> = ({ tokenUsage }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  if (!tokenUsage) return null

  if (tokenUsage.totalTokens === undefined && tokenUsage.totalChars !== undefined) {
    return (
      <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
        {t('workbench.outputChars')}: {tokenUsage.totalChars}
      </Text>
    )
  }

  if (tokenUsage.totalTokens === undefined) return null

  return (
    <>
      {tokenUsage.promptTokens !== undefined && (
        <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
          {t('workbench.promptTokens')}: {tokenUsage.promptTokens}
          {tokenUsage.cachedTokens != null && tokenUsage.cachedTokens > 0 && (
            <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
              {' '}({t('workbench.cachedTokens')}: {tokenUsage.cachedTokens})
            </Text>
          )}
        </Text>
      )}
      {tokenUsage.completionTokens !== undefined && (
        <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
          {t('workbench.completionTokens')}: {tokenUsage.completionTokens}
        </Text>
      )}
    </>
  )
}

/**
 * 消息分段列表（thinking / tool_call / answer）渲染。
 * 从 MessageBubble / MultiChatPanel 抽取的共享逻辑。
 */
export const SegmentList: React.FC<{
  segments: MessageSegment[]
  msgId: string
  isError: boolean
  onToggleSegment: (msgId: string, segId: string) => void
  getToolDisplayName: (name: string) => string
}> = ({ segments, msgId, isError, onToggleSegment, getToolDisplayName }) => {
  return (
    <div style={{ position: 'relative', paddingLeft: 0 }}>
      {segments.map((seg) => {
        if (seg.type === 'thinking') {
          return (
            <ThinkingSegment
              key={seg.id}
              seg={seg}
              isStreaming={!!seg.isStreaming}
              onToggle={() => onToggleSegment(msgId, seg.id)}
            />
          )
        }
        if (seg.type === 'tool_call') {
          return (
            <ToolCallSegment
              key={seg.id}
              seg={seg}
              onToggle={() => onToggleSegment(msgId, seg.id)}
              getToolDisplayName={getToolDisplayName}
            />
          )
        }
        if (seg.type === 'answer') {
          return (
            <AnswerSegment
              key={seg.id}
              seg={seg}
              isError={isError}
            />
          )
        }
        return null
      })}
    </div>
  )
}
