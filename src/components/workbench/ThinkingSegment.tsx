import { Typography, theme } from 'antd'
import { BulbOutlined, DownOutlined, RightOutlined } from '@ant-design/icons'
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
  const previewRef = useRef<HTMLDivElement>(null)
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
      setStepsOverflow(stepsWrapperRef.current.scrollHeight > 240)
    }
  }, [steps, stepsExpanded])

  // 折叠态预览：单行横向滚动跟随最新思考内容
  useEffect(() => {
    const el = previewRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [seg.content])

  const isExpanded = !seg.collapsed
  const duration = seg.timestamp ? elapsed : 0
  const durationText = duration > 0 ? t('workbench.thoughtFor', { time: duration.toFixed(1) }) : ''
  const content = seg.content || ''

  const header = (
    <div
      onClick={onToggle}
      style={{
        padding: '5px 0',
        cursor: 'pointer',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {isExpanded ? (
        <DownOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />
      ) : (
        <RightOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />
      )}
      <BulbOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
      <Text style={{ fontSize: 12, color: token.colorTextSecondary }}>
        {t('workbench.thinkingProcess')}
      </Text>
      {isStreaming && (
        <span className="cursor-blink" style={{ color: token.colorTextQuaternary }}>▊</span>
      )}
      {!isExpanded && isStreaming && content && (
        <div
          ref={previewRef}
          className="dm-preview-line"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            lineHeight: '18px',
            color: token.colorTextQuaternary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          {content}
        </div>
      )}
      {durationText && (
        <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>
          {durationText}
        </Text>
      )}
    </div>
  )

  if (isExpanded) {
    return (
      <div style={{ marginBottom: 2 }}>
        {header}
        <div style={{ position: 'relative' }}>
          {/* 竖线与展开 icon 同列，从 icon 正下方延伸贯穿内容区 */}
          <div style={{ position: 'absolute', left: 4, top: 0, bottom: 0, width: 2, background: token.colorBorder, borderRadius: 1 }} />
          <div style={{ position: 'relative', padding: '0 10px 10px 24px' }}>
          <div
            ref={stepsWrapperRef}
            onScroll={stepsOnScroll}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              background: token.colorBgLayout,
              borderRadius: 8,
              padding: '10px 12px',
              maxHeight: stepsExpanded ? 'none' : 220,
              overflowY: stepsExpanded ? 'visible' : 'auto',
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
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 2 }}>
      {header}
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
