import { Typography, theme, Tooltip } from 'antd'
import { BarChartOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { Fragment, memo } from 'react'
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

/** Token 数粗略格式化：9,634 → 9.6K；2,340,123 → 2.3M */
const formatCompactNumber = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
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

  if (tokenUsage.totalTokens === undefined) {
    if (tokenUsage.totalChars === undefined) return null
    return (
      <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
        {t('workbench.outputChars')}: {formatNumber(tokenUsage.totalChars)}
      </Text>
    )
  }

  const { promptTokens, completionTokens, cachedTokens } = tokenUsage
  // 部分供应商不返回 total，用输入+输出兜底
  const totalTokens = tokenUsage.totalTokens > 0
    ? tokenUsage.totalTokens
    : (promptTokens ?? 0) + (completionTokens ?? 0)

  const details: Array<[string, string]> = []
  if (promptTokens !== undefined) {
    details.push([t('workbench.promptTokens'), formatNumber(promptTokens)])
  }
  if (completionTokens !== undefined) {
    details.push([t('workbench.completionTokens'), formatNumber(completionTokens)])
  }
  if (cachedTokens != null && cachedTokens > 0) {
    details.push([t('workbench.cachedTokens'), formatNumber(cachedTokens)])
    details.push([
      t('workbench.cacheHitRate'),
      `${promptTokens ? ((cachedTokens / promptTokens) * 100).toFixed(1) : '0.0'}%`,
    ])
  }

  return (
    <Tooltip
      title={details.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '2px 16px', fontSize: 12 }}>
          {details.map(([label, value]) => (
            <Fragment key={label}>
              <span style={{ color: token.colorTextTertiary }}>{label}</span>
              <span style={{ color: token.colorText, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{value}</span>
            </Fragment>
          ))}
        </div>
      ) : undefined}
    >
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: token.colorTextTertiary,
        cursor: 'default',
      }}>
        <BarChartOutlined style={{ fontSize: 12 }} />
        <span>{t('workbench.usage')}</span>
        <span style={{ color: token.colorTextSecondary, fontVariantNumeric: 'tabular-nums' }}>
          {formatCompactNumber(totalTokens)}
        </span>
      </span>
    </Tooltip>
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

  const renderSegment = (seg: MessageSegment, idx: number): React.ReactNode => {
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
      if (seg.toolName === 'todo_write') {
        return (
          <TodoListSegment
            key={seg.id}
            seg={seg}
            onToggle={() => onToggleSegment(msgId, seg.id)}
            getToolDisplayName={getToolDisplayName}
            defaultCollapsed={idx !== lastTodoIdx}
            isActive={idx === activeTodoIdx}
          />
        )
      }
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
      return <AnswerSegment key={seg.id} seg={seg} isError={isError} />
    }
    return waitSeg(seg)
  }

  // 渲染一段连续的非正文段；并行的 delegation 段横排为一组卡片
  const renderRun = (run: MessageSegment[], startIdx: number): React.ReactNode[] => {
    const nodes: React.ReactNode[] = []
    let k = 0
    while (k < run.length) {
      const s = run[k]
      if (s.type === 'delegation' && s.groupRunId && s.parallelTotal && s.parallelTotal > 1) {
        const group: MessageSegment[] = [s]
        let m = k + 1
        while (m < run.length && run[m].type === 'delegation' && run[m].groupRunId === s.groupRunId) {
          group.push(run[m])
          m++
        }
        nodes.push(
          <div
            key={`grp_${s.groupRunId}`}
            style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}
          >
            {group.map(x => (
              <div key={x.id} style={{ minWidth: 0 }}>
                {waitSeg(x)}
              </div>
            ))}
          </div>
        )
        k = m
        continue
      }
      nodes.push(renderSegment(s, startIdx + k))
      k++
    }
    return nodes
  }

  // 正文单独展示；连续的非正文段（思考/工具调用/待办/子代理）合并为一个过程组
  let i = 0
  while (i < segments.length) {
    const seg = segments[i]
    if (seg.type === 'answer') {
      items.push(renderSegment(seg, i))
      i++
      continue
    }
    let j = i + 1
    while (j < segments.length && segments[j].type !== 'answer') j++
    const run = segments.slice(i, j)
    if (run.length >= 2) {
      items.push(
        <WorkProcessGroup
          key={`proc_${run[0].id}`}
          segments={run}
          getToolDisplayName={getToolDisplayName}
          isLastRun={j >= segments.length}
          streaming={isStreaming}
        >
          {renderRun(run, i)}
        </WorkProcessGroup>
      )
    } else {
      items.push(...renderRun(run, i))
    }
    i = j
  }
  return <div style={{ position: 'relative', paddingLeft: 0 }}>{items}</div>
}

export const SegmentList = memo(SegmentListInner)
