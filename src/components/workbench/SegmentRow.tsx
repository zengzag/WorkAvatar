import type { ReactNode } from 'react'
import { theme } from 'antd'
import { DownOutlined, RightOutlined } from '@ant-design/icons'
import PreviewLine from './PreviewLine'

/**
 * 消息分段行头（思考/工具/委托/过程组/清单共用）：
 * 统一折叠箭头、图标、标题、单行摘要、耗时与状态的字号与留白。
 */
export const SegmentRow: React.FC<{
  expanded: boolean
  icon: ReactNode
  title: ReactNode
  /** 单行摘要（工具参数、指令、实时进度等） */
  detail?: string
  /** 标题颜色覆盖（失败态使用错误色） */
  titleColor?: string
  /** 右侧元信息（耗时、步数、tokens 等） */
  meta?: ReactNode
  /** 行尾状态（成功/失败/执行中） */
  status?: ReactNode
  onClick?: () => void
}> = ({ expanded, icon, title, detail, titleColor, meta, status, onClick }) => {
  const { token } = theme.useToken()

  return (
    <div className="wa-seg-row" onClick={onClick}>
      {expanded ? (
        <DownOutlined style={{ fontSize: 10, color: token.colorTextQuaternary, flexShrink: 0 }} />
      ) : (
        <RightOutlined style={{ fontSize: 10, color: token.colorTextQuaternary, flexShrink: 0 }} />
      )}
      <span style={{ display: 'inline-flex', flexShrink: 0, fontSize: 12, color: token.colorTextTertiary }}>
        {icon}
      </span>
      <span className="wa-seg-row-title" style={titleColor ? { color: titleColor } : undefined}>
        {title}
      </span>
      {detail && (
        <PreviewLine
          text={detail}
          fontSize={11}
          lineHeight={18}
          color={token.colorTextQuaternary}
        />
      )}
      <div style={{
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
        minWidth: 0,
      }}>
        {meta && <span className="wa-seg-row-meta">{meta}</span>}
        {status}
      </div>
    </div>
  )
}

export default SegmentRow
