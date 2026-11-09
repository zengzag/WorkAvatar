import { theme } from 'antd'
import { LoadingOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageSegment } from './types'
import { formatDuration } from '../../utils/format'
import { useAutoFollowScroll } from '../../hooks/useAutoFollowScroll'
import SegmentRow from './SegmentRow'

/** 该步骤是否仍在进行（思考流式输出 / 工具未完成 / 子代理运行中） */
function isStepActive(seg: MessageSegment): boolean {
  if (seg.type === 'thinking') return !!seg.isStreaming
  if (seg.type === 'tool_call') return !seg.toolError && !seg.isToolComplete
  if (seg.type === 'delegation') return seg.delegationStatus === 'queued' || seg.delegationStatus === 'streaming'
  return false
}

/**
 * 过程分组：把「无正文」时交替出现的思考、工具调用、待办、子代理合并为一个可折叠项。
 * 执行中默认展开、结束后自动收起；头部展示用时/步数与实时进度，便于用户聚焦核心输出。
 */
const WorkProcessGroupInner: React.FC<{
  segments: MessageSegment[]
  getToolDisplayName: (name: string) => string
  /** 该过程组是否属于所属消息的最后一组（仍在流式时视为执行中） */
  isLastRun?: boolean
  /** 所属消息是否仍在流式输出 */
  streaming?: boolean
  children: ReactNode
}> = ({ segments, getToolDisplayName, isLastRun = false, streaming = false, children }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  const { containerRef: contentScrollRef, onScroll: contentOnScroll } = useAutoFollowScroll<HTMLDivElement>()

  const hasActive = useMemo(() => segments.some(isStepActive), [segments])
  // 执行中：任一步骤在跑，或本组是流式消息的末组（等待下一轮 LLM 输出也算执行中，避免来回闪动）
  const running = hasActive || (isLastRun && streaming)

  const [open, setOpen] = useState(running)
  const prevRunningRef = useRef(running)

  // 执行中默认展开，结束后自动收起（用户手动切换在状态不变时保持不变）
  useEffect(() => {
    if (prevRunningRef.current === running) return
    prevRunningRef.current = running
    setOpen(running)
  }, [running])

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  const startTs = segments[0]?.timestamp
  const lastSeg = segments[segments.length - 1]
  const endTs = running ? now : (lastSeg?.completedAt ?? lastSeg?.timestamp)
  const durationSec = startTs && endTs && endTs > startTs ? (endTs - startTs) / 1000 : 0
  const durationText = durationSec > 0 ? t('workbench.executionTime', { time: formatDuration(durationSec) }) : ''

  // 折叠态预览：仅运行中展示最后一个活动步骤的进度，避免完成后造成噪音
  const previewText = useMemo(() => {
    if (!running) return ''
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]
      if (!isStepActive(seg)) continue
      if (seg.type === 'thinking') return seg.content || ''
      if (seg.type === 'delegation') {
        return `${t('workbench.delegationTo')} ${seg.targetEmployeeName || t('workbench.delegationUnknown')}`
      }
      if (seg.type === 'tool_call' && seg.toolName) {
        const name = getToolDisplayName(seg.toolName)
        const progress = seg.toolProgress?.[seg.toolProgress.length - 1]
        const detail = progress ? [progress.action, progress.detail].filter(Boolean).join(' — ') : ''
        return detail ? `${name} — ${detail}` : name
      }
    }
    return ''
  }, [running, segments, getToolDisplayName, t])

  return (
    <div style={{ marginBottom: 2 }}>
      <SegmentRow
        expanded={open}
        icon={<ThunderboltOutlined />}
        title={t('workbench.workProcess')}
        detail={!open ? previewText : undefined}
        meta={`${durationText ? `${durationText} · ` : ''}${t('workbench.workProcessSteps', { count: segments.length })}`}
        status={running
          ? <LoadingOutlined spin style={{ fontSize: 11, color: token.colorTextTertiary }} />
          : undefined}
        onClick={() => setOpen(v => !v)}
      />

      {open && (
        <div
          ref={contentScrollRef}
          onScroll={contentOnScroll}
          className="wa-seg-body"
          style={{
            maxHeight: 420,
            // 块流布局：子项恒为容器宽度，长 token 由 word-break 断行（flex 下 min-width:auto
            // 会被长 URL/长串撑宽，导致底部横向滚动条随流式内容反复出现消失而闪烁）
            overflowX: 'hidden',
            overflowY: 'auto',
            overscrollBehavior: 'contain',
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

const WorkProcessGroup = memo(WorkProcessGroupInner, (prev, next) =>
  prev.segments === next.segments &&
  prev.getToolDisplayName === next.getToolDisplayName &&
  prev.isLastRun === next.isLastRun &&
  prev.streaming === next.streaming
)

export default WorkProcessGroup
