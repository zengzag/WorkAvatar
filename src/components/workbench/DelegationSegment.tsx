import { Typography, Tag, theme, Tooltip } from 'antd'
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
import { useMemo, useState, useEffect, useRef } from 'react'
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

  const accentColor = isError ? token.colorError : isCancelled ? token.colorTextSecondary : isDone ? token.colorSuccess : token.colorPrimary
  const accentBorder = isError ? token.colorErrorBorder : isCancelled ? token.colorBorder : isDone ? token.colorSuccessBorder : token.colorPrimaryBorder
  const headerBg = isError ? token.colorErrorBg : isCancelled ? token.colorFillQuaternary : isDone ? token.colorSuccessBg : token.colorPrimaryBg

  const duration = useElapsedTime(seg.timestamp, !isRunning, seg.completedAt)
  const usage: TokenUsage | undefined = seg.delegationTokenUsage
  const totalTokens = usage?.totalTokens

  const statusTag = useMemo(() => {
    if (isError) {
      return <Tag color="error" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0 }}>
        <CloseCircleOutlined /> {t('workbench.delegationFailed')}
      </Tag>
    }
    if (isCancelled) {
      return <Tag style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0 }}>
        <ClockCircleOutlined /> {t('workbench.runCancelled')}
      </Tag>
    }
    if (isDone) {
      return <Tag color="success" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0 }}>
        <CheckCircleOutlined /> {t('workbench.delegationCompleted')}
      </Tag>
    }
    if (isQueued) {
      return <Tag color="warning" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0 }}>
        <ClockCircleOutlined /> {t('workbench.runQueued')}
      </Tag>
    }
    return <Tag color="processing" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0 }}>
      <LoadingOutlined spin /> {t('workbench.delegationRunning')}
    </Tag>
  }, [isError, isCancelled, isDone, isQueued, t])

  const subSegments = seg.subSegments || []
  const instruction = seg.instruction || ''
  const summary = seg.resultSummary || seg.runResult?.summary || ''
  const hasSubContent = subSegments.length > 0

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          borderRadius: 8,
          border: `1px solid ${accentBorder}`,
          borderLeft: `3px solid ${accentColor}`,
          background: token.colorBgLayout,
          overflow: 'hidden',
        }}
      >
        {/* 头部 */}
        <div
          onClick={() => onToggle(msgId, seg.id)}
          style={{
            padding: '6px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            userSelect: 'none',
            background: `linear-gradient(90deg, ${headerBg} 0%, transparent 100%)`,
          }}
        >
          {isExpanded ? (
            <DownOutlined style={{ fontSize: 10, color: token.colorTextSecondary }} />
          ) : (
            <RightOutlined style={{ fontSize: 10, color: token.colorTextSecondary }} />
          )}
          <TeamOutlined style={{ fontSize: 13, color: accentColor, flexShrink: 0 }} />
          <Text strong style={{
            fontSize: 13,
            color: token.colorText,
            flex: '1 1 auto',
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {t('workbench.delegationTo')} {seg.targetEmployeeName || t('workbench.delegationUnknown')}
          </Text>
          {instruction && (
            <Tooltip title={instruction}>
              <Text style={{
                fontSize: 11,
                color: token.colorTextTertiary,
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
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {seg.runGroupIndex === 0 && seg.parallelTotal && seg.parallelTotal > 1 && (
              <Tag style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0 }}>
                {t('workbench.runGroupTotal', { count: seg.parallelTotal })}
              </Tag>
            )}
            {duration !== null && (
              <Text type="secondary" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
                <ClockCircleOutlined style={{ fontSize: 10 }} />
                {t('workbench.executionTime', { time: duration })}
              </Text>
            )}
            {totalTokens !== undefined && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {formatNumber(totalTokens)} tokens
              </Text>
            )}
            {statusTag}
          </div>
        </div>

        {/* 折叠态：结果摘要 / 错误信息 */}
        {!isExpanded && (() => {
          const foldText = (isError || isCancelled) ? (seg.toolError || summary) : summary
          if (!foldText) return null
          return (
            <div style={{
              padding: '4px 12px 6px 28px',
              fontSize: 12,
              color: isError ? token.colorError : token.colorTextSecondary,
              lineHeight: 1.5,
            }}>
              {foldText.length > 150 ? foldText.slice(0, 150) + '…' : foldText}
            </div>
          )
        })()}

        {/* 展开态：子员工执行流 */}
        {isExpanded && (
          <div
            style={{
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              padding: '8px 12px 8px 24px',
              background: token.colorFillQuaternary,
            }}
          >
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
        )}
      </div>
    </div>
  )
}

export const DelegationSegment = DelegationSegmentInner
