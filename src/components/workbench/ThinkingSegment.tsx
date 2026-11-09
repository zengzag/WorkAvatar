import { theme } from 'antd'
import { BulbOutlined, LoadingOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useState, useEffect, useRef, useMemo, memo } from 'react'
import type { MessageSegment } from './types'
import { useAutoFollowScroll } from '../../hooks/useAutoFollowScroll'
import { formatDuration } from '../../utils/format'
import SegmentRow from './SegmentRow'

const HIGHLIGHT_PATTERNS = /^(→|•|※|结论:|Result:|Therefore|So\s)/i

function isHighlightLine(line: string): boolean {
  return HIGHLIGHT_PATTERNS.test(line.trim())
}

const ThoughtLine: React.FC<{
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

const ThinkingSegmentInner: React.FC<{
  seg: MessageSegment
  isStreaming: boolean
  onToggle: () => void
}> = ({ seg, isStreaming, onToggle }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [elapsed, setElapsed] = useState(0)
  const { containerRef: contentRef, onScroll: contentOnScroll } = useAutoFollowScroll<HTMLDivElement>()
  const fallbackRef = useRef<number | undefined>(undefined)
  const [contentExpanded, setContentExpanded] = useState(false)
  const [contentOverflow, setContentOverflow] = useState(false)

  const lines = useMemo(() => (seg.content ? seg.content.split('\n') : []), [seg.content])

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
    if (contentRef.current) {
      setContentOverflow(contentRef.current.scrollHeight > 240)
    }
  }, [lines, contentExpanded])

  const isExpanded = !seg.collapsed
  const duration = seg.timestamp ? elapsed : 0
  const durationText = duration > 0 ? t('workbench.executionTime', { time: formatDuration(duration) }) : ''
  const content = seg.content || ''

  const header = (
    <SegmentRow
      expanded={isExpanded}
      icon={<BulbOutlined />}
      title={t('workbench.thinkingProcess')}
      detail={!isExpanded && isStreaming ? content : undefined}
      meta={durationText || undefined}
      status={isStreaming
        ? <LoadingOutlined spin style={{ fontSize: 11, color: token.colorTextTertiary }} />
        : undefined}
      onClick={onToggle}
    />
  )

  if (isExpanded) {
    return (
      <div data-testid="thinking-segment" style={{ marginBottom: 2 }}>
        {header}
        <div className="wa-seg-body">
          <div
            ref={contentRef}
            onScroll={contentOnScroll}
            className="wa-detail-block"
            style={{
              maxHeight: contentExpanded ? 'none' : 220,
              overflowY: contentExpanded ? 'visible' : 'auto',
            }}
          >
            {lines.map((line, i) => (
              <div key={`${i}-${line.slice(0, 12)}`} style={{ fontSize: 12, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                <ThoughtLine line={line} token={token} />
              </div>
            ))}
          </div>
          {contentOverflow && !isStreaming && (
            <div
              onClick={() => setContentExpanded(v => !v)}
              style={{
                textAlign: 'center',
                padding: '4px 0',
                cursor: 'pointer',
                color: token.colorPrimary,
                fontSize: 11,
                userSelect: 'none',
              }}
            >
              {contentExpanded ? t('workbench.showLess') : t('workbench.showMore')}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div data-testid="thinking-segment" style={{ marginBottom: 2 }}>
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
