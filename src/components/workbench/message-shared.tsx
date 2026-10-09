import { Typography, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { memo } from 'react'
import type { MessageSegment, TokenUsage } from './types'
import ThinkingSegment from './ThinkingSegment'
import ToolCallSegment from './ToolCallSegment'
import TodoListSegment from './TodoListSegment'
import AnswerSegment from './AnswerSegment'
import WorkProcessGroup from './WorkProcessGroup'
import { DelegationSegment } from './DelegationSegment'

const { Text } = Typography

const formatNumber = (n: number | undefined | null): string => {
  if (n === undefined || n === null) return ''
  return n.toLocaleString('en-US')
}

/**
 * 根据 comparisonProviderId + comparisonModelId 解析模型显示名。
 * 兼容 msg 与 branch 两种来源（只要带这两个字段即可）。
 */
export function resolveModelLabel(
  ids: { comparisonProviderId?: string; comparisonModelId?: string },
  providers: any[]
): string {
  if (!ids.comparisonProviderId || !ids.comparisonModelId) return ''
  // providers 可能尚未加载完成（undefined/非数组）→ 直接回退模型 id
  if (!Array.isArray(providers)) return ids.comparisonModelId
  const provider = providers.find((p: any) => p.id === ids.comparisonProviderId)
  if (!provider) return ids.comparisonModelId
  let parsed: any
  try { parsed = provider.models_json ? JSON.parse(provider.models_json) : [] } catch { parsed = [] }
  // 解析结果可能是对象/null/字符串，非数组时 find 会抛 TypeError → 非法时按空列表兜底
  const models: any[] = Array.isArray(parsed) ? parsed : []
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
        {t('workbench.outputChars')}: {formatNumber(tokenUsage.totalChars)}
      </Text>
    )
  }

  if (tokenUsage.totalTokens === undefined) return null

  return (
    <>
      {tokenUsage.promptTokens !== undefined && (
        <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
          {t('workbench.promptTokens')}: {formatNumber(tokenUsage.promptTokens)}
          {tokenUsage.cachedTokens != null && tokenUsage.cachedTokens > 0 && (
            <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
              {' '}({t('workbench.cachedTokens')}: {formatNumber(tokenUsage.cachedTokens)})
            </Text>
          )}
        </Text>
      )}
      {tokenUsage.completionTokens !== undefined && (
        <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
          {t('workbench.completionTokens')}: {formatNumber(tokenUsage.completionTokens)}
        </Text>
      )}
    </>
  )
}

/**
 * 消息分段列表（thinking / tool_call / answer）渲染。
 * 从 MessageBubble / MultiChatPanel 抽取的共享逻辑。
 */
// React.memo 避免父组件 providers 变化时重渲染代码块（语法高亮是性能大头）
const SegmentListInner: React.FC<{
  segments: MessageSegment[]
  msgId: string
  isError: boolean
  onToggleSegment: (msgId: string, segId: string) => void
  getToolDisplayName: (name: string) => string
  /** 所属消息/子运行是否仍在流式输出（仅流式中的最新 todo 快照允许转圈） */
  isStreaming?: boolean
}> = ({ segments, msgId, isError, onToggleSegment, getToolDisplayName, isStreaming = false }) => {
  const items: React.ReactNode[] = []

  // todo_write 段以任务清单卡片渲染；同一消息多次更新时仅最后一次默认展开
  let lastTodoIdx = -1
  for (let j = segments.length - 1; j >= 0; j--) {
    if (segments[j].type === 'tool_call' && segments[j].toolName === 'todo_write') {
      lastTodoIdx = j
      break
    }
  }
  // 仅流式中的最新 todo 快照视为活跃（历史快照与已结束消息的 in_progress 项不转圈）
  const activeTodoIdx = isStreaming ? lastTodoIdx : -1

  const waitSeg = (seg: MessageSegment) => (
    <DelegationSegment
      key={seg.id}
      seg={seg}
      msgId={msgId}
      onToggle={onToggleSegment}
      getToolDisplayName={getToolDisplayName}
    />
  )

  // 可参与「过程分组」的段：思考与普通工具调用（待办清单卡片单独展示，作为分组边界）
  const isGroupable = (s: MessageSegment) =>
    s.type === 'thinking' || (s.type === 'tool_call' && s.toolName !== 'todo_write')

  let i = 0
  while (i < segments.length) {
    const seg = segments[i]
    // 并行组：连续且同 groupRunId 的 delegation 段横排为一组卡片
    if (seg.type === 'delegation' && seg.groupRunId && seg.parallelTotal && seg.parallelTotal > 1) {
      const group: MessageSegment[] = [seg]
      let j = i + 1
      while (j < segments.length) {
        const s = segments[j]
        if (s.type === 'delegation' && s.groupRunId === seg.groupRunId) {
          group.push(s)
          j++
        } else {
          break
        }
      }
      items.push(
        <div
          key={`grp_${seg.groupRunId}`}
          style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}
        >
          {group.map(s => (
            <div key={s.id} style={{ minWidth: 0 }}>
              {waitSeg(s)}
            </div>
          ))}
        </div>
      )
      i = j
      continue
    }
    // 过程分组：连续 2 段以上的思考/工具调用合并为一个折叠项
    if (isGroupable(seg)) {
      let j = i + 1
      while (j < segments.length && isGroupable(segments[j])) j++
      if (j - i >= 2) {
        const run = segments.slice(i, j)
        items.push(
          <WorkProcessGroup
            key={`proc_${run[0].id}`}
            segments={run}
            msgId={msgId}
            onToggleSegment={onToggleSegment}
            getToolDisplayName={getToolDisplayName}
          />
        )
        i = j
        continue
      }
    }
    if (seg.type === 'thinking') {
      items.push(
        <ThinkingSegment
          key={seg.id}
          seg={seg}
          isStreaming={!!seg.isStreaming}
          onToggle={() => onToggleSegment(msgId, seg.id)}
        />
      )
    } else if (seg.type === 'tool_call') {
      if (seg.toolName === 'todo_write') {
        items.push(
          <TodoListSegment
            key={seg.id}
            seg={seg}
            onToggle={() => onToggleSegment(msgId, seg.id)}
            getToolDisplayName={getToolDisplayName}
            defaultCollapsed={i !== lastTodoIdx}
            isActive={i === activeTodoIdx}
          />
        )
      } else {
        items.push(
          <ToolCallSegment
            key={seg.id}
            seg={seg}
            onToggle={() => onToggleSegment(msgId, seg.id)}
            getToolDisplayName={getToolDisplayName}
          />
        )
      }
    } else if (seg.type === 'answer') {
      items.push(
        <AnswerSegment
          key={seg.id}
          seg={seg}
          isError={isError}
        />
      )
    } else if (seg.type === 'delegation') {
      items.push(waitSeg(seg))
    }
    i++
  }
  return <div style={{ position: 'relative', paddingLeft: 0 }}>{items}</div>
}

export const SegmentList = memo(SegmentListInner)
