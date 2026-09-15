import { Typography, Tooltip, theme } from 'antd'
import {
  DownOutlined,
  RightOutlined,
  TeamOutlined,
  LoadingOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useState, useRef, useEffect } from 'react'
import type { MessageSegment, TokenUsage } from './types'
import { SegmentList } from './message-shared'

const { Text } = Typography

const formatNumber = (n: number | undefined | null): string => {
  if (n === undefined || n === null) return ''
  return n.toLocaleString('en-US')
}

function useElapsedTime(startTime: number | undefined, isComplete: boolean, completedAt?: number): string | null {
  const [elapsed, setElapsed] = useState<number | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!startTime) return
    if (isComplete) {
      const endTime = completedAt ?? Date.now()
      setElapsed((endTime - startTime) / 1000)
      return
    }
    setElapsed((Date.now() - startTime) / 1000)
    intervalRef.current = setInterval(() => {
      setElapsed((Date.now() - startTime) / 1000)
    }, 1000)
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [startTime, isComplete, completedAt])

  if (elapsed === null) return null
  return elapsed < 10 ? elapsed.toFixed(1) : Math.round(elapsed).toString()
}

const DelegationSegmentInner: React.FC<{
  seg: MessageSegment
  msgId: string
  onToggle: (msgId: string, segId: string) => void
  getToolDisplayName: (name: string) => string
}> = ({ seg, msgId, onToggle, getToolDisplayName }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const isExpanded = !seg.collapsed
  const status = seg.delegationStatus || 'streaming'

  const isError = status === 'failed' || status === 'timed_out'
  const isCancelled = status === 'cancelled'
  const isQueued = status === 'queued'
  const isDone = status === 'completed'
  const isRunning = !isError && !isCancelled && !isDone

  const duration = useElapsedTime(seg.timestamp, !isRunning, seg.completedAt)
  const usage: TokenUsage | undefined = seg.delegationTokenUsage
  const totalTokens = usage?.totalTokens

  // 状态指示：图标 + 弱色文本，仅失败保留醒目色
  const statusEl = isError ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: token.colorError }}>
      <CloseCircleOutlined /> {t('workbench.delegationFailed')}
    </span>
  ) : isCancelled ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: token.colorTextTertiary }}>
      <ClockCircleOutlined /> {t('workbench.runCancelled')}
    </span>
  ) : isDone ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: token.colorTextQuaternary }}>
      <CheckCircleOutlined /> {t('workbench.delegationCompleted')}
    </span>
  ) : isQueued ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: token.colorTextTertiary }}>
      <ClockCircleOutlined /> {t('workbench.runQueued')}
    </span>
  ) : (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: token.colorTextTertiary }}>
      <LoadingOutlined spin /> {t('workbench.delegationRunning')}
    </span>
  )

  const subSegments = seg.subSegments || []
  const instruction = seg.instruction || ''
  const summary = seg.resultSummary || seg.runResult?.summary || ''
  const hasSubContent = subSegments.length > 0

  // 折叠态预览：单行横向滚动跟随子员工最新输出
  const previewRef = useRef<HTMLDivElement>(null)
  const lastContentful = [...subSegments].reverse().find(
    s => (s.type === 'thinking' || s.type === 'answer') && s.content
  )
  const preview = isRunning ? (lastContentful?.content || '') : ''
  useEffect(() => {
    const el = previewRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [preview])

  const header = (
    <div
      onClick={() => onToggle(msgId, seg.id)}
      style={{
        padding: '5px 0',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {isExpanded ? (
        <DownOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />
      ) : (
        <RightOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />
      )}
      <TeamOutlined style={{ fontSize: 12, color: token.colorTextTertiary, flexShrink: 0 }} />
      <Text style={{
        fontSize: 12,
        color: token.colorTextSecondary,
        flex: '1 1 auto',
        minWidth: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {t('workbench.delegationTo')}{' '}
        <span style={{ color: token.colorText, fontWeight: 500 }}>
          {seg.targetEmployeeName || t('workbench.delegationUnknown')}
        </span>
      </Text>
      {instruction && (
        <Tooltip title={instruction}>
          <Text style={{
            fontSize: 11,
            color: token.colorTextQuaternary,
            maxWidth: 260,
            flexShrink: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            · {instruction}
          </Text>
        </Tooltip>
      )}
          {!isExpanded && isRunning && preview && (
            <div
              ref={previewRef}
              className="dm-preview-line"
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 11,
                color: token.colorTextQuaternary,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
              }}
            >
              {preview}
            </div>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {seg.runGroupIndex === 0 && seg.parallelTotal && seg.parallelTotal > 1 && (
          <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
            {t('workbench.runGroupTotal', { count: seg.parallelTotal })}
          </Text>
        )}
        {duration !== null && (
          <Text style={{ fontSize: 11, color: token.colorTextQuaternary, display: 'flex', alignItems: 'center', gap: 3 }}>
            <ClockCircleOutlined style={{ fontSize: 10 }} />
            {t('workbench.executionTime', { time: duration })}
          </Text>
        )}
        {totalTokens !== undefined && (
          <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
            {formatNumber(totalTokens)} tokens
          </Text>
        )}
        {statusEl}
      </div>
    </div>
  )

  if (isExpanded) {
    return (
      <div style={{ marginBottom: 2 }}>
        {header}
        <div style={{ position: 'relative' }}>
          {/* 竖线与展开 icon 同列，从 icon 正下方延伸贯穿内容区 */}
          <div style={{ position: 'absolute', left: 4, top: 0, bottom: 0, width: 2, background: token.colorBorder, borderRadius: 1 }} />
          <div style={{ position: 'relative', padding: '0 10px 8px 24px' }}>
          {hasSubContent ? (
            <>
              <SegmentList
                segments={subSegments}
                msgId={`${msgId}_del_${seg.id}`}
                isError={false}
                onToggleSegment={(_subMsgId, subSegId) => {
                  onToggle(msgId, `${seg.id}__sub__${subSegId}`)
                }}
                getToolDisplayName={getToolDisplayName}
              />
              {usage && (usage.promptTokens !== undefined || usage.completionTokens !== undefined) && (
                <div style={{
                  marginTop: 6,
                  fontSize: 11,
                  color: token.colorTextQuaternary,
                  borderTop: `1px solid ${token.colorBorderSecondary}`,
                  paddingTop: 6,
                  display: 'flex',
                  gap: 12,
                }}>
                  <span>{t('workbench.delegationSubCost')}:</span>
                  {usage.promptTokens !== undefined && <span>input {formatNumber(usage.promptTokens)}</span>}
                  {usage.completionTokens !== undefined && <span>output {formatNumber(usage.completionTokens)}</span>}
                  {usage.cachedTokens !== undefined && usage.cachedTokens > 0 && <span>cache {formatNumber(usage.cachedTokens)}</span>}
                </div>
              )}
              {/* 失败时在子段下方补充错误详情 */}
              {(isError || isCancelled) && seg.toolError && (
                <div style={{
                  marginTop: 6,
                  padding: '6px 10px',
                  fontSize: 12,
                  color: token.colorError,
                  background: token.colorErrorBg,
                  borderRadius: 4,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {seg.toolError}
                </div>
              )}
            </>
          ) : (isError || isCancelled) && seg.toolError ? (
            <div style={{
              padding: '6px 10px',
              fontSize: 12,
              color: token.colorError,
              background: token.colorErrorBg,
              borderRadius: 4,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {seg.toolError}
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {isRunning ? t('workbench.delegationWaiting') : t('workbench.delegationNoOutput')}
            </Text>
          )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 2 }}>
      {header}
      {/* 折叠态：失败/取消显示错误信息 */}
      {(() => {
        if (!isError && !isCancelled) return null
        const errText = seg.toolError || summary
        if (!errText) return null
        return (
          <div style={{
            padding: '0 10px 5px 18px',
            fontSize: 12,
            lineHeight: '18px',
            color: token.colorError,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>
            {errText.length > 150 ? errText.slice(0, 150) + '…' : errText}
          </div>
        )
      })()}
    </div>
  )
}

export const DelegationSegment = DelegationSegmentInner
