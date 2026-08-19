import { Typography, theme } from 'antd'
import { BulbOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useState, useEffect, useRef, useMemo, memo } from 'react'
import type { MessageSegment } from './types'
import { useAutoFollowScroll } from '../../hooks/useAutoFollowScroll'

const { Text } = Typography

const HIGHLIGHT_PATTERNS = /^(→|•|※|结论:|Result:|Therefore|So\s)/i

function parseSteps(content: string): string[] {
  const numberedSplit = content.split(/\n\n+/)
  const steps: string[] = []
  for (const block of numberedSplit) {
    const trimmed = block.trim()
    if (!trimmed) continue
    steps.push(trimmed)
  }
  return steps.length > 0 ? steps : [content]
}

function isHighlightLine(line: string): boolean {
  return HIGHLIGHT_PATTERNS.test(line.trim())
}

function stripStepPrefix(text: string): string {
  return text.replace(/^(?:Step\s*\d+[:.]\s*|\d+[.)]\s*)/i, '')
}

const StepLine: React.FC<{
  line: string
  token: any
}> = ({ line, token }) => {
  const highlighted = isHighlightLine(line)
  if (highlighted) {
    return (
      <span style={{
        color: token.colorPrimary,
        fontWeight: 500,
      }}>
        {line}
      </span>
    )
  }
  return <span>{line}</span>
}

const StepBlock: React.FC<{
  stepIndex: number
  content: string
  token: any
}> = ({ stepIndex, content, token }) => {
  const displayContent = stripStepPrefix(content)
  const lines = displayContent.split('\n')

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <div style={{
        flexShrink: 0,
        width: 22,
        height: 22,
        borderRadius: 6,
        background: `linear-gradient(135deg, ${token.colorPrimary}, ${token.colorPrimaryHover || token.colorPrimary})`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 1,
      }}>
        <Text style={{ fontSize: 10, color: '#fff', fontWeight: 600, lineHeight: '22px' }}>
          {stepIndex + 1}
        </Text>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {lines.map((line, i) => (
          <div key={`${i}-${line.slice(0, 12)}`} style={{ fontSize: 12, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            <StepLine line={line} token={token} />
          </div>
        ))}
      </div>
    </div>
  )
}

const ThinkingSegmentInner: React.FC<{
  seg: MessageSegment
  isStreaming: boolean
  onToggle: () => void
}> = ({ seg, isStreaming, onToggle }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [elapsed, setElapsed] = useState(0)
  const { containerRef: stepsWrapperRef, onScroll: stepsOnScroll } = useAutoFollowScroll<HTMLDivElement>()
  const fallbackRef = useRef<number | undefined>(undefined)
  const [stepsExpanded, setStepsExpanded] = useState(false)
  const [stepsOverflow, setStepsOverflow] = useState(false)

  const steps = useMemo(() => {
    if (!seg.content) return []
    return parseSteps(seg.content)
  }, [seg.content])

  useEffect(() => {
    if (!seg.timestamp) return
    if (!isStreaming) return
    const interval = setInterval(() => {
      setElapsed(((Date.now() - seg.timestamp!) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [seg.timestamp, isStreaming])

  useEffect(() => {
    if (!isStreaming && seg.timestamp) {
      if (!seg.completedAt && !fallbackRef.current) {
        fallbackRef.current = Date.now()
      }
      const endTime = seg.completedAt ?? fallbackRef.current ?? Date.now()
      setElapsed(((endTime - seg.timestamp) / 1000))
    }
  }, [isStreaming, seg.timestamp, seg.completedAt])

  useEffect(() => {
    if (stepsWrapperRef.current) {
      setStepsOverflow(stepsWrapperRef.current.scrollHeight > 320)
    }
  }, [steps, stepsExpanded])

  const duration = seg.timestamp ? elapsed : 0
  const durationText = duration > 0 ? t('workbench.thoughtFor', { time: duration.toFixed(1) }) : ''

  const gradientBg = `linear-gradient(135deg, ${token.colorPrimaryBg}, ${token.colorBgLayout})`

  return (
    <div style={{ marginBottom: 0 }}>
      <div
        style={{
          borderRadius: 8,
          background: gradientBg,
          border: `1px solid ${token.colorPrimaryBorder}`,
          borderLeft: `3px solid ${token.colorPrimary}`,
          overflow: 'hidden',
        }}
      >
        <div
          onClick={() => {
            if (!isStreaming) {
              onToggle()
            }
          }}
          style={{
            padding: '8px 14px',
            cursor: isStreaming ? 'default' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <BulbOutlined style={{ color: token.colorPrimary, fontSize: 13 }} />
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 500 }}>
            {t('workbench.thinkingProcess')}
          </Text>
          {isStreaming && (
            <span className="cursor-blink" style={{ color: token.colorPrimary }}>▊</span>
          )}
          {durationText && (
            <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
              {durationText}
            </Text>
          )}
          {!isStreaming && (
            <Text style={{ fontSize: 11, color: token.colorPrimary, marginLeft: 'auto' }}>
              {seg.collapsed ? t('workbench.expand') : t('workbench.collapse')}
            </Text>
          )}
        </div>
        {!seg.collapsed && (
          <div
            style={{
              padding: '0 14px 10px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div
              ref={stepsWrapperRef}
              onScroll={stepsOnScroll}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                maxHeight: stepsExpanded ? 'none' : 300,
                overflowY: stepsExpanded ? 'visible' : 'auto',
                paddingRight: 4,
              }}
            >
              {steps.map((step, i) => (
                <StepBlock
                  key={`${i}-${step.slice(0, 12)}`}
                  stepIndex={i}
                  content={step}
                  token={token}
                />
              ))}
            </div>
            {stepsOverflow && !isStreaming && (
              <div
                onClick={() => setStepsExpanded(v => !v)}
                style={{
                  textAlign: 'center',
                  padding: '4px 0',
                  cursor: 'pointer',
                  color: token.colorPrimary,
                  fontSize: 11,
                  userSelect: 'none',
                }}
              >
                {stepsExpanded ? t('workbench.showLess') : t('workbench.showMore')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// React.memo 避免父组件 state 变化导致未变化的思考段重渲染（A#12）
const ThinkingSegment = memo(ThinkingSegmentInner, (prev, next) =>
  prev.seg === next.seg &&
  prev.isStreaming === next.isStreaming &&
  prev.onToggle === next.onToggle
)

export default ThinkingSegment
