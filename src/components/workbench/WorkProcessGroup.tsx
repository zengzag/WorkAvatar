import { theme, Typography } from 'antd'
import { DownOutlined, RightOutlined, LoadingOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { memo, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageSegment } from './types'
import { formatDuration } from '../../utils/format'
import ThinkingSegment from './ThinkingSegment'
import ToolCallSegment from './ToolCallSegment'
import PreviewLine from './PreviewLine'

const { Text } = Typography

/** 该步骤是否仍在进行（思考流式输出 / 工具未完成） */
function isStepActive(seg: MessageSegment): boolean {
  if (seg.type === 'thinking') return !!seg.isStreaming
  if (seg.type === 'tool_call') return !seg.toolError && !seg.isToolComplete
  return false
}

/**
 * 过程分组：把「无正文」时交替出现的思考与工具调用合并为一个可折叠项，
 * 默认折叠，仅在头部展示用时/步数与实时进度，便于用户聚焦核心输出。
 */
const WorkProcessGroupInner: React.FC<{
  segments: MessageSegment[]
  msgId: string
  onToggleSegment: (msgId: string, segId: string) => void
  getToolDisplayName: (name: string) => string
}> = ({ segments, msgId, onToggleSegment, getToolDisplayName }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const active = useMemo(() => segments.some(isStepActive), [segments])

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])

  const startTs = segments[0]?.timestamp
  const lastSeg = segments[segments.length - 1]
  const endTs = active ? now : (lastSeg?.completedAt ?? lastSeg?.timestamp)
  const durationSec = startTs && endTs && endTs > startTs ? (endTs - startTs) / 1000 : 0
  const durationText = durationSec > 0 ? t('workbench.executionTime', { time: formatDuration(durationSec) }) : ''

  // 折叠态预览：仅运行中展示最后一个活动步骤的进度，避免完成后造成噪音
  const previewText = useMemo(() => {
    if (!active) return ''
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]
      if (!isStepActive(seg)) continue
      if (seg.type === 'thinking') return seg.content || ''
      if (seg.type === 'tool_call' && seg.toolName) {
        const name = getToolDisplayName(seg.toolName)
        const progress = seg.toolProgress?.[seg.toolProgress.length - 1]
        const detail = progress ? [progress.action, progress.detail].filter(Boolean).join(' — ') : ''
        return detail ? `${name} — ${detail}` : name
      }
    }
    return ''
  }, [active, segments, getToolDisplayName])

  const showPreview = !open && !!previewText

  return (
    <div style={{ marginBottom: 2 }}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{
          padding: '5px 0',
          cursor: 'pointer',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {open ? (
          <DownOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />
        ) : (
          <RightOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />
        )}
        <ThunderboltOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
        <Text style={{ fontSize: 12, color: token.colorTextSecondary, flexShrink: 0 }}>
          {t('workbench.workProcess')}
        </Text>
        {showPreview && (
          <PreviewLine text={previewText} fontSize={12} lineHeight={18} color={token.colorTextQuaternary} />
        )}
        <Text style={{ fontSize: 11, color: token.colorTextQuaternary, flexShrink: 0, marginLeft: showPreview ? 0 : 'auto' }}>
          {durationText ? `${durationText} · ` : ''}
          {t('workbench.workProcessSteps', { count: segments.length })}
        </Text>
        {active && (
          <LoadingOutlined spin style={{ fontSize: 11, color: token.colorTextTertiary, flexShrink: 0 }} />
        )}
      </div>

      {open && (
        <div
          style={{
            marginLeft: 4,
            paddingLeft: 12,
            borderLeft: `2px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {segments.map(seg =>
            seg.type === 'thinking' ? (
              <ThinkingSegment
                key={seg.id}
                seg={seg}
                isStreaming={!!seg.isStreaming}
                onToggle={() => onToggleSegment(msgId, seg.id)}
              />
            ) : (
              <ToolCallSegment
                key={seg.id}
                seg={seg}
                onToggle={() => onToggleSegment(msgId, seg.id)}
                getToolDisplayName={getToolDisplayName}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}

const WorkProcessGroup = memo(WorkProcessGroupInner, (prev, next) =>
  prev.segments === next.segments &&
  prev.msgId === next.msgId &&
  prev.onToggleSegment === next.onToggleSegment &&
  prev.getToolDisplayName === next.getToolDisplayName
)

export default WorkProcessGroup
