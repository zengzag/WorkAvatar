import { Typography, Tooltip, App, Image, theme } from 'antd'
import {
  LoadingOutlined,
  CloseCircleOutlined,
  CopyOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback, useRef, memo, type ReactNode } from 'react'
import type { MessageSegment } from './types'
import { useAutoFollowScroll } from '../../hooks/useAutoFollowScroll'
import { formatDuration } from '../../utils/format'
import { getToolIconKey } from '../../utils/tool-display'
import { getCategoryIcon } from '../common/tool-category-icons'
import { summarizeToolCall } from '../../utils/tool-call-summary'
import SegmentRow from './SegmentRow'

const { Text } = Typography

function highlightJson(
  json: string,
  colors: {
    key: string
    string: string
    number: string
    boolean: string
    null: string
    bracket: string
  }
): ReactNode[] {
  const parts: ReactNode[] = []
  const regex = /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|(true|false)\b|(null)\b|([{}[\]:,])/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let keyIndex = 0

  while ((match = regex.exec(json)) !== null) {
    if (match.index > lastIndex) {
      parts.push(json.slice(lastIndex, match.index))
    }

    if (match[1] !== undefined) {
      parts.push(
        <span key={`k${keyIndex++}`} style={{ color: colors.key }}>
          {match[1]}
        </span>
      )
    } else if (match[2] !== undefined) {
      parts.push(
        <span key={`s${keyIndex++}`} style={{ color: colors.string }}>
          {match[2]}
        </span>
      )
    } else if (match[3] !== undefined) {
      parts.push(
        <span key={`n${keyIndex++}`} style={{ color: colors.number }}>
          {match[3]}
        </span>
      )
    } else if (match[4] !== undefined) {
      parts.push(
        <span key={`b${keyIndex++}`} style={{ color: colors.boolean }}>
          {match[4]}
        </span>
      )
    } else if (match[5] !== undefined) {
      parts.push(
        <span key={`nl${keyIndex++}`} style={{ color: colors.null }}>
          {match[5]}
        </span>
      )
    } else if (match[6] !== undefined) {
      parts.push(
        <span key={`br${keyIndex++}`} style={{ color: colors.bracket }}>
          {match[6]}
        </span>
      )
    }

    lastIndex = regex.lastIndex
  }

  if (lastIndex < json.length) {
    parts.push(json.slice(lastIndex))
  }

  return parts
}

function useElapsedTime(startTime: number | undefined, isComplete: boolean, completedAt?: number): string | null {
  const [elapsed, setElapsed] = useState<number | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fallbackRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!startTime) return

    if (isComplete) {
      if (!completedAt && !fallbackRef.current) {
        fallbackRef.current = Date.now()
      }
      const endTime = completedAt ?? fallbackRef.current ?? Date.now()
      const finalTime = (endTime - startTime) / 1000
      setElapsed(finalTime)
      return
    }

    // 用 1 秒间隔的 setInterval 替代 60fps rAF，避免多个并行工具调用时的高频重渲染
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
  return formatDuration(elapsed)
}

const ToolCallSegmentInner: React.FC<{
  seg: MessageSegment
  onToggle: () => void
  getToolDisplayName: (name: string) => string
}> = ({ seg, onToggle, getToolDisplayName }) => {
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const { t } = useTranslation()
  const { containerRef: argsScrollRef, onScroll: argsOnScroll } = useAutoFollowScroll<HTMLPreElement>()
  const { containerRef: progressScrollRef, onScroll: progressOnScroll } = useAutoFollowScroll<HTMLDivElement>()
  const isArgsStreaming = !!seg.isToolArgsStreaming
  // toolError 优先级最高：用户停止生成 / LLM 中断 / 工具异常时展示已取消或失败态
  const isToolError = !!seg.toolError
  const isToolPending = !seg.isToolComplete && !isToolError
  const isExpanded = !seg.collapsed

  const duration = useElapsedTime(seg.timestamp, !!seg.isToolComplete, seg.completedAt)

  const resultStr = seg.toolResult !== undefined
    ? (typeof seg.toolResult === 'string' ? seg.toolResult : JSON.stringify(seg.toolResult, null, 2))
    : ''
  const argsStr = isArgsStreaming
    ? (seg.toolArgsRaw || '')
    : (seg.toolArgs !== undefined
        ? (typeof seg.toolArgs === 'string' ? seg.toolArgs : JSON.stringify(seg.toolArgs, null, 2))
        // 取消/失败时 toolArgs 可能为空（JSON 不完整无法解析），回退到 raw 展示已生成部分
        : (seg.toolArgsRaw || ''))

  // 行摘要：执行中优先展示实时进度，结束后展示本次调用的目标（文件名/命令/查询词）
  const lastProgress = seg.toolProgress && seg.toolProgress.length > 0
    ? seg.toolProgress[seg.toolProgress.length - 1]
    : null
  const argsSummary = summarizeToolCall(seg.toolName, seg.toolArgs ?? seg.toolArgsRaw)
  const previewText = isArgsStreaming
    ? argsSummary
    : (isToolError || seg.isToolComplete)
      ? ''
      : [lastProgress?.action, lastProgress?.detail].filter(Boolean).join(' — ')
  const rowDetail = previewText || argsSummary

  const jsonColors = {
    key: token.colorPrimary,
    string: token.colorSuccess,
    number: token.colorWarning,
    boolean: token.colorInfo,
    null: token.colorTextQuaternary,
    bracket: token.colorTextSecondary,
  }

  const isLikelyJson = (str: string) => {
    const trimmed = str.trim()
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
           (trimmed.startsWith('[') && trimmed.endsWith(']'))
  }

  const renderHighlighted = (str: string) => {
    if (isLikelyJson(str)) {
      return highlightJson(str, jsonColors)
    }
    return str
  }

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      message.success(t('common.copied'))
    } catch {
      message.error(t('common.copyFailed'))
    }
  }, [t])

  // 工具进度步骤的类型颜色/图标，放在 map 外部避免每次迭代重建（A#13）
  const typeColors: Record<string, string> = {
    info: token.colorTextTertiary,
    llm: token.colorInfo,
    search: token.colorPrimary,
    read: token.colorWarning,
    plan: token.colorSuccessActive,
    result: token.colorSuccess,
  }
  const typeIcons: Record<string, string> = {
    info: '•',
    llm: '🤖',
    search: '🔍',
    read: '📄',
    plan: '📋',
    result: '✓',
  }

  // 状态指示：仅失败保留醒目提示，其余状态不额外显示图标
  const statusEl = isToolError ? (
    <Tooltip title={seg.toolError} placement="topRight">
      <span style={{
        marginLeft: 'auto',
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: token.colorError,
        maxWidth: 240,
      }}>
        <CloseCircleOutlined style={{ flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{seg.toolError}</span>
      </span>
    </Tooltip>
  ) : isArgsStreaming || isToolPending ? (
    <span style={{
      marginLeft: 'auto',
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontSize: 11,
      color: token.colorTextTertiary,
    }}>
      <LoadingOutlined spin />
      {isArgsStreaming ? t('workbench.generatingArgs') : t('workbench.executing')}
    </span>
  ) : null

  const header = (
    <SegmentRow
      expanded={isExpanded}
      icon={getCategoryIcon(seg.toolName ? getToolIconKey(seg.toolName) : undefined)}
      title={seg.toolName ? getToolDisplayName(seg.toolName) : t('workbench.toolCall')}
      titleColor={isToolError ? token.colorError : undefined}
      detail={rowDetail}
      meta={
        <>
          {seg.parallelTotal && seg.parallelTotal > 1 && (
            <span>{t('workbench.runGroupTotal', { count: seg.parallelTotal })}</span>
          )}
          {duration !== null && <span>{t('workbench.executionTime', { time: duration })}</span>}
        </>
      }
      status={statusEl}
      onClick={onToggle}
    />
  )

  if (isExpanded) {
    return (
      <div style={{ marginBottom: 2, containerType: 'inline-size' }}>
        {header}
        <div className="wa-seg-body">
            {argsStr && (
              <div style={{ marginBottom: seg.toolResult !== undefined ? 10 : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {isArgsStreaming
                      ? t('workbench.generatingArgs')
                      : t('workbench.inputParams')}
                  </Text>
                  {!isArgsStreaming && (
                    <Tooltip title={t('common.copy')}>
                      <CopyOutlined
                        onClick={(e) => { e.stopPropagation(); handleCopy(argsStr) }}
                        style={{ fontSize: 11, color: token.colorTextQuaternary, cursor: 'pointer' }}
                      />
                    </Tooltip>
                  )}
                </div>
                <pre ref={argsScrollRef} onScroll={argsOnScroll} className="wa-detail-block" style={{
                  margin: 0,
                  maxHeight: 140,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}>
                  {isArgsStreaming ? argsStr : renderHighlighted(argsStr)}
                </pre>
              </div>
            )}
            {seg.toolProgress && seg.toolProgress.length > 0 && (
              <div style={{ marginBottom: seg.toolResult !== undefined ? 10 : 0 }}>
                <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
                  {t('workbench.toolProgress')}
                </Text>
                <div ref={progressScrollRef} onScroll={progressOnScroll} className="wa-detail-block" style={{
                  maxHeight: 140,
                  overflow: 'auto',
                  fontSize: 11,
                }}>
                  {seg.toolProgress.map((step: any, i: number) => {
                    return (
                      <div
                        key={`${i}-${step.action || ''}`}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 6,
                          padding: '2px 0',
                          borderBottom: i < seg.toolProgress!.length - 1 ? `1px solid ${token.colorBorderSecondary}` : 'none',
                        }}
                      >
                        <span style={{ color: typeColors[step.type] || token.colorTextTertiary, flexShrink: 0 }}>
                          {typeIcons[step.type] || '•'}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {step.phase && (
                            <span style={{ color: typeColors[step.type] || token.colorTextTertiary, fontWeight: 500 }}>
                              [{step.phase}]
                            </span>
                          )}
                          <span style={{ color: token.colorTextSecondary, marginLeft: step.phase ? 4 : 0 }}>
                            {step.action}
                          </span>
                          {step.detail && (
                            <span style={{ color: token.colorTextTertiary, marginLeft: 4 }}>— {step.detail}</span>
                          )}
                          {step.durationMs !== undefined && (
                            <span style={{ color: token.colorTextQuaternary, marginLeft: 6 }}>{step.durationMs}ms</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {seg.toolResult !== undefined && (
              <div>
                {seg.toolResultImages && seg.toolResultImages.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <Image.PreviewGroup>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {seg.toolResultImages.map((url, i) => (
                          <Image
                            key={i}
                            src={url}
                            height={90}
                            style={{ borderRadius: 6, border: `1px solid ${token.colorBorderSecondary}` }}
                          />
                        ))}
                      </div>
                    </Image.PreviewGroup>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>{t('workbench.outputResult')}</Text>
                  <Tooltip title={t('common.copy')}>
                    <CopyOutlined
                      onClick={(e) => { e.stopPropagation(); handleCopy(resultStr) }}
                      style={{ fontSize: 11, color: token.colorTextQuaternary, cursor: 'pointer' }}
                    />
                  </Tooltip>
                </div>
                <pre className="wa-detail-block" style={{
                  margin: 0,
                  maxHeight: 220,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}>
                  {renderHighlighted(resultStr)}
                </pre>
              </div>
            )}
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="tool-call-segment"
      data-tool-name={seg.toolName || ''}
      data-status={seg.toolIsError || seg.toolError ? 'error' : 'ok'}
      style={{ marginBottom: 2, containerType: 'inline-size' }}
    >
      {header}
    </div>
  )
}

// React.memo 避免父组件 state 变化导致未变化的工具调用段重渲染（A#12）
const ToolCallSegment = memo(ToolCallSegmentInner, (prev, next) =>
  prev.seg === next.seg &&
  prev.onToggle === next.onToggle &&
  prev.getToolDisplayName === next.getToolDisplayName
)

export default ToolCallSegment
