import { Typography, Tag, theme, Tooltip, App } from 'antd'
import {
  DownOutlined,
  RightOutlined,
  CodeOutlined,
  LoadingOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback, useRef, memo, type ReactNode } from 'react'
import type { MessageSegment } from './types'

const { Text } = Typography

const TRUNCATE_THRESHOLD = 500

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
  return elapsed < 10 ? elapsed.toFixed(1) : Math.round(elapsed).toString()
}

const ToolCallSegmentInner: React.FC<{
  seg: MessageSegment
  onToggle: () => void
  getToolDisplayName: (name: string) => string
}> = ({ seg, onToggle, getToolDisplayName }) => {
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const { t } = useTranslation()
  const [resultExpanded, setResultExpanded] = useState(false)
  const isArgsStreaming = !!seg.isToolArgsStreaming
  // toolError 优先级最高：用户停止生成 / LLM 中断 / 工具异常时展示已取消或失败态
  const isToolError = !!seg.toolError
  const isToolPending = !seg.isToolComplete && !isToolError
  const isExpanded = !seg.collapsed

  // 统一计算边框/背景/图标色，避免多层三元嵌套（cancelled > argsStreaming > pending > success）
  const accentColor = isToolError
    ? token.colorError
    : isArgsStreaming
      ? token.colorInfo
      : isToolPending
        ? token.colorPrimary
        : token.colorSuccess
  const accentBorder = isToolError
    ? token.colorErrorBorder
    : isArgsStreaming
      ? token.colorInfoBorder
      : isToolPending
        ? token.colorPrimaryBorder
        : token.colorSuccessBorder
  const headerBg = isToolError
    ? token.colorErrorBg
    : isArgsStreaming
      ? token.colorInfoBg
      : isToolPending
        ? token.colorPrimaryBg
        : token.colorSuccessBg

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

  const isResultLong = resultStr.length > TRUNCATE_THRESHOLD
  const displayResult = isResultLong && !resultExpanded
    ? resultStr.slice(0, TRUNCATE_THRESHOLD)
    : resultStr

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
        <div
          onClick={onToggle}
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
          <CodeOutlined style={{ fontSize: 13, color: accentColor }} />
          <Text strong style={{ fontSize: 13, color: token.colorText }}>
            {seg.toolName ? getToolDisplayName(seg.toolName) : t('workbench.toolCall')}
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>({seg.toolName})</Text>
          {duration !== null && (
            <Text type="secondary" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
              <ClockCircleOutlined style={{ fontSize: 10 }} />
              {t('workbench.executionTime', { time: duration })}
            </Text>
          )}
          {isToolError ? (
            <Tag color="error" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', marginLeft: 'auto' }}>
              <CloseCircleOutlined /> {seg.toolError}
            </Tag>
          ) : isArgsStreaming ? (
            <Tag color="processing" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', marginLeft: 'auto' }}>
              <LoadingOutlined spin /> {t('workbench.generatingArgs')}
            </Tag>
          ) : isToolPending ? (
            <Tag color="processing" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', marginLeft: 'auto' }}>
              <LoadingOutlined spin /> {t('workbench.executing')}
            </Tag>
          ) : (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              {resultStr && (
                <Text type="secondary" style={{ fontSize: 10 }}>
                  {t('workbench.outputChars')}: {resultStr.length}
                </Text>
              )}
              <Tag color="success" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px' }}>
                <CheckCircleOutlined /> {t('workbench.completed')}
              </Tag>
            </div>
          )}
        </div>
        {isExpanded && (
          <div
            style={{
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              padding: '8px 12px',
            }}
          >
            {argsStr && (
              <div style={{ marginBottom: seg.toolResult !== undefined ? 10 : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {isArgsStreaming
                      ? t('workbench.generatingArgs')
                      : t('workbench.inputParams')}
                  </Text>
                  {!isArgsStreaming && (
                    <Tooltip title={t('common.copied')}>
                      <CopyOutlined
                        onClick={(e) => { e.stopPropagation(); handleCopy(argsStr) }}
                        style={{ fontSize: 11, color: token.colorTextQuaternary, cursor: 'pointer' }}
                      />
                    </Tooltip>
                  )}
                  {isArgsStreaming && (
                    <Text type="secondary" style={{ fontSize: 10 }}>
                      {argsStr.length} chars
                    </Text>
                  )}
                </div>
                <pre style={{
                  margin: 0,
                  padding: '8px 10px',
                  background: isArgsStreaming ? token.colorInfoBg : token.colorBgContainer,
                  borderRadius: 6,
                  fontSize: 12,
                  lineHeight: 1.6,
                  maxHeight: 200,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  border: `1px solid ${isArgsStreaming ? token.colorInfoBorder : token.colorBorderSecondary}`,
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
                <div style={{
                  padding: '6px 10px',
                  background: token.colorPrimaryBg,
                  borderRadius: 6,
                  fontSize: 11,
                  lineHeight: 1.6,
                  maxHeight: 200,
                  overflow: 'auto',
                  border: `1px solid ${token.colorPrimaryBorder}`,
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>{t('workbench.outputResult')}</Text>
                  <Tooltip title={t('common.copied')}>
                    <CopyOutlined
                      onClick={(e) => { e.stopPropagation(); handleCopy(resultStr) }}
                      style={{ fontSize: 11, color: token.colorTextQuaternary, cursor: 'pointer' }}
                    />
                  </Tooltip>
                </div>
                <pre style={{
                  margin: 0,
                  padding: '8px 10px',
                  background: token.colorSuccessBg,
                  borderRadius: 6,
                  fontSize: 12,
                  lineHeight: 1.6,
                  maxHeight: resultExpanded ? 600 : 300,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  border: `1px solid ${token.colorSuccessBorder}`,
                }}>
                  {renderHighlighted(displayResult)}
                </pre>
                {isResultLong && (
                  <div
                    onClick={(e) => { e.stopPropagation(); setResultExpanded(v => !v) }}
                    style={{
                      textAlign: 'center',
                      padding: '4px 0',
                      cursor: 'pointer',
                      color: token.colorPrimary,
                      fontSize: 11,
                      userSelect: 'none',
                    }}
                  >
                    {resultExpanded ? t('workbench.showLess') : t('workbench.showMore')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
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
