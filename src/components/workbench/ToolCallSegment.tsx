import { Typography, Tag, theme, Tooltip, message } from 'antd'
import {
  DownOutlined,
  RightOutlined,
  CodeOutlined,
  LoadingOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
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
  const rafRef = useRef<number | null>(null)
  const fallbackRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!startTime) return

    let stopped = false

    if (isComplete) {
      if (!completedAt && !fallbackRef.current) {
        fallbackRef.current = Date.now()
      }
      const endTime = completedAt ?? fallbackRef.current ?? Date.now()
      const finalTime = (endTime - startTime) / 1000
      setElapsed(finalTime)
      return
    }

    const tick = () => {
      if (stopped) return
      setElapsed((Date.now() - startTime) / 1000)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      stopped = true
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [startTime, isComplete, completedAt])

  if (elapsed === null) return null
  return elapsed < 10 ? elapsed.toFixed(1) : Math.round(elapsed).toString()
}

const ToolCallSegment: React.FC<{
  seg: MessageSegment
  onToggle: () => void
  getToolDisplayName: (name: string) => string
}> = ({ seg, onToggle, getToolDisplayName }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [resultExpanded, setResultExpanded] = useState(false)
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined)
  const contentRef = useRef<HTMLDivElement>(null)
  const isToolPending = !seg.isToolComplete
  const isExpanded = !seg.collapsed

  const duration = useElapsedTime(seg.timestamp, !!seg.isToolComplete, seg.completedAt)

  const resultStr = seg.toolResult !== undefined
    ? (typeof seg.toolResult === 'string' ? seg.toolResult : JSON.stringify(seg.toolResult, null, 2))
    : ''
  const argsStr = seg.toolArgs !== undefined
    ? (typeof seg.toolArgs === 'string' ? seg.toolArgs : JSON.stringify(seg.toolArgs, null, 2))
    : ''

  const isResultLong = resultStr.length > TRUNCATE_THRESHOLD
  const displayResult = isResultLong && !resultExpanded
    ? resultStr.slice(0, TRUNCATE_THRESHOLD)
    : resultStr

  const jsonColors = {
    key: token.colorPrimary,
    string: '#52c41a',
    number: '#fa8c16',
    boolean: '#722ed1',
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

  useEffect(() => {
    if (isExpanded && contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight)
    }
  }, [isExpanded, argsStr, resultStr, resultExpanded])

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          borderRadius: 8,
          border: `1px solid ${isToolPending ? token.colorPrimaryBorder : token.colorSuccessBorder}`,
          borderLeft: `3px solid ${isToolPending ? token.colorPrimary : token.colorSuccess}`,
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
            background: isToolPending
              ? `linear-gradient(90deg, ${token.colorPrimaryBg} 0%, transparent 100%)`
              : `linear-gradient(90deg, ${token.colorSuccessBg} 0%, transparent 100%)`,
          }}
        >
          {isExpanded ? (
            <DownOutlined style={{ fontSize: 10, color: token.colorTextSecondary }} />
          ) : (
            <RightOutlined style={{ fontSize: 10, color: token.colorTextSecondary }} />
          )}
          <CodeOutlined style={{ fontSize: 13, color: isToolPending ? token.colorPrimary : token.colorSuccess }} />
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
          {isToolPending ? (
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
        <div
          style={{
            overflow: 'hidden',
            transition: isExpanded
              ? 'max-height 0.25s ease-in, opacity 0.2s ease-in'
              : 'max-height 0.2s ease-out, opacity 0.15s ease-out',
            maxHeight: isExpanded ? (contentHeight ?? 2000) : 0,
            opacity: isExpanded ? 1 : 0,
          }}
        >
          <div
            ref={contentRef}
            style={{
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              padding: '8px 12px',
            }}
          >
            {argsStr && (
              <div style={{ marginBottom: seg.toolResult !== undefined ? 10 : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>{t('workbench.inputParams')}</Text>
                  <Tooltip title={t('common.copied')}>
                    <CopyOutlined
                      onClick={(e) => { e.stopPropagation(); handleCopy(argsStr) }}
                      style={{ fontSize: 11, color: token.colorTextQuaternary, cursor: 'pointer' }}
                    />
                  </Tooltip>
                </div>
                <pre style={{
                  margin: 0,
                  padding: '8px 10px',
                  background: token.colorBgContainer,
                  borderRadius: 6,
                  fontSize: 12,
                  lineHeight: 1.6,
                  maxHeight: 200,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  border: `1px solid ${token.colorBorderSecondary}`,
                }}>
                  {renderHighlighted(argsStr)}
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
                    const typeColors: Record<string, string> = {
                      info: token.colorTextTertiary,
                      llm: '#722ed1',
                      search: '#1677ff',
                      read: '#fa8c16',
                      plan: '#13c2c2',
                      result: '#52c41a',
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
                      <div
                        key={i}
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
        </div>
      </div>
    </div>
  )
}

export default ToolCallSegment
